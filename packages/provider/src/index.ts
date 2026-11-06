// Provider: sells execution slots as HTS NFTs and runs whichever job belongs to each slot's
// current owner when the slot starts.
import { ExpirationTime } from "@arkiv-network/sdk";
import { Hbar, TransferTransaction } from "@hiero-ledger/sdk";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader, decodePaymentSignatureHeader } from "@x402/core/http";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { eq } from "@arkiv-network/sdk/query";
import { u64 } from "@arkiv-network/sdk/schema";
import {
  HBAR,
  MIRROR,
  type HcsEvent,
  HttpError,
  NETWORK,
  ProviderProfile,
  type Res,
  arkivReader,
  arkivWriter,
  decodeSlot,
  evmKey,
  hashscan,
  hederaClient,
  jobHash,
  nftOwner,
  need,
  parseJob,
  postEvent,
  role,
  serve,
  sha256,
  slotInfo,
  tokenNfts,
  verifyRequest,
} from "@qy/shared";
import { ensureInfra, issueSlot } from "./chain.js";
import { LLM_BASE_URL, LLM_MODEL, runJob, warmUp } from "./runner.js";
import { bookingPrice } from "./pricing.js";
import { PROVIDER_NAME, clearQueue, dequeue, enqueue, loadResult, nextJob, paid, queues, savePaid, saveResult } from "./store.js";

const PORT = Number(process.env.PROVIDER_PORT ?? 4000);
const BOOKING_URL = process.env.PROVIDER_URL ?? `http://localhost:${PORT}`;
const SLOT_SECONDS = Number(process.env.SLOT_SECONDS ?? 30);
const WORKERS = Number(process.env.WORKERS ?? 2); // slots per start time = jobs run in parallel
const LEAD_SECONDS = Number(process.env.LEAD_SECONDS ?? 120); // earliest bookable start, leaves time to trade
// The floor must cover what one booking costs the provider on Hedera. Measured on testnet: mint
// ~0.21 HBAR + transfer ~0.008 + three HCS messages ~0.016, about 1.6 US cents. Fees are set in USD,
// so the floor is too, converted with the network's own exchange rate (PRICE_FLOOR in tinybars overrides).
const PRICE_FLOOR_CENTS = Number(process.env.PRICE_FLOOR_CENTS ?? 2.5);
const PRICE_WINDOW = Number(process.env.PRICE_WINDOW_SECONDS ?? 300); // how far ahead "near-term" capacity counts
const STALE_SECONDS = Number(process.env.STALE_SECONDS ?? 600); // drop queued jobs this far past their deadline
const MAX_QUEUE = 20; // queued jobs per account; bookings are paid, this just bounds memory
const KILL_MARGIN_MS = 1500; // a job is killed this long before its slot ends, so the next slot starts on a free worker

const P = role(PROVIDER_NAME);
const T = role(PROVIDER_NAME === "PROVIDER" ? "TREASURY" : `${PROVIDER_NAME}_TREASURY`);
const client = hederaClient(P.id, P.key);
const { tokenId, topicId } = await ensureInfra(client, P, T);
console.log(`provider ${P.id}  token ${hashscan("token", tokenId)}  topic ${hashscan("topic", topicId)}`);

/** HCS logging never blocks or breaks the caller; failures are only printed. */
function log(event: HcsEvent) {
  console.log(event);
  postEvent(client, topicId, P.id, P.key, event).catch((e) => console.error("HCS post failed:", e.message));
}

async function floorTinybars(): Promise<bigint> {
  if (process.env.PRICE_FLOOR) return BigInt(process.env.PRICE_FLOOR);
  const r = ((await (await fetch(`${MIRROR}/network/exchangerate`)).json()) as any).current_rate; // cent_equivalent cents = hbar_equivalent HBAR
  return BigInt(Math.ceil(((PRICE_FLOOR_CENTS * r.hbar_equivalent) / r.cent_equivalent) * 1e8));
}
let PRICE_FLOOR = await floorTinybars();
setInterval(() => floorTinybars().then((f) => (PRICE_FLOOR = f)).catch(() => {}), 3600_000).unref();
console.log(`booking floor ${PRICE_FLOOR} tinybars (${PRICE_FLOOR_CENTS} US cents)`);

console.log(`model ${LLM_MODEL} at ${LLM_BASE_URL}: loading...`);
console.log(`model ready in ${await warmUp()}ms`);

const facilitator = new HTTPFacilitatorClient({ url: need("X402_FACILITATOR_URL") });
const x402 = new x402ResourceServer(facilitator).register(NETWORK, new ExactHederaScheme());
await x402.initialize();

// ---- schedule: start time -> serials (null = reserved while minting) ----
const slots = new Map<number, (number | null)[]>();
const now = () => Math.floor(Date.now() / 1000);

function place(start: number, serial: number | null) {
  if (!slots.has(start)) {
    slots.set(start, []);
    setTimeout(() => dispatch(start), Math.max(0, start * 1000 - Date.now()));
  }
  slots.get(start)!.push(serial);
}

/**
 * Current booking price, from how full every slot between now and PRICE_WINDOW past the earliest
 * bookable start is. Slots already booked inside the lead time count too: they're live demand.
 */
function price(): bigint {
  const end = Math.ceil((now() + LEAD_SECONDS) / SLOT_SECONDS) * SLOT_SECONDS + PRICE_WINDOW;
  let booked = 0;
  for (const [start, list] of slots) if (start > now() && start < end) booked += list.length;
  return bookingPrice(booked, Math.ceil((end - now()) / SLOT_SECONDS) * WORKERS, PRICE_FLOOR);
}

/** Earliest bookable start with a free worker. */
function nextFree(): number {
  let start = Math.ceil((now() + LEAD_SECONDS) / SLOT_SECONDS) * SLOT_SECONDS;
  while ((slots.get(start)?.length ?? 0) >= WORKERS) start += SLOT_SECONDS;
  return start;
}

/** Reserve the earliest start with a free worker. Synchronous, so concurrent bookings can't collide. */
function reserve(): number {
  const start = nextFree();
  place(start, null);
  return start;
}

function settle(start: number, serial: number | null) {
  const list = slots.get(start)!;
  list.splice(list.indexOf(null), 1);
  if (serial !== null) list.push(serial);
}

async function dispatch(start: number) {
  const serials = (slots.get(start) ?? []).filter((s): s is number => s !== null);
  slots.delete(start);
  await Promise.all(serials.map((serial) => runSlot(serial, start)));
}

async function runSlot(serial: number, start: number) {
  let owner: string;
  try {
    owner = (await slotInfo(client, tokenId, serial)).owner; // consensus, so a swap just before start counts
  } catch (e) {
    // Consensus didn't answer in time: the Mirror Node is a few seconds behind but far better than idling.
    console.error(`slot #${serial}: ${(e as Error).message}; using the Mirror Node`);
    try {
      owner = await nftOwner(tokenId, serial);
    } catch (e2) {
      return console.error(`slot #${serial}: owner lookup failed`, e2);
    }
  }
  // A job long past its deadline has lost its slot somewhere (provider downtime, a crashed owner).
  // Running it first would push the owner's live work out of this slot, so drop it and say so.
  for (const q of queues.get(owner) ?? []) {
    if (q.job.deadline < now() - STALE_SECONDS) {
      dequeue(owner, q.hash);
      log({ type: "expired", owner, jobHash: q.hash, deadline: q.job.deadline });
    }
  }
  const p = nextJob(owner);
  log({ type: "dispatch", serial, start, owner, jobHash: p?.hash ?? null });
  if (!p) return; // owner has nothing queued: the slot idles
  dequeue(owner, p.hash);

  const t0 = Date.now();
  try {
    const limit = (start + SLOT_SECONDS) * 1000 - KILL_MARGIN_MS - Date.now();
    if (limit <= 0) throw new Error("missed: the provider dispatched after the slot ended");
    const r = await runJob(p.job, limit);
    const ms = Date.now() - t0;
    saveResult(p.hash, { owner, text: r.text, tokens: r.tokens, model: LLM_MODEL, ms });
    log({ type: "done", serial, owner, jobHash: p.hash, ok: true, result: "ok", resultHash: sha256(r.text), tokens: r.tokens, ms });
  } catch (e) {
    const reason = (e as Error).message;
    log({ type: "done", serial, owner, jobHash: p.hash, ok: false, result: reason, resultHash: null, tokens: 0, ms: Date.now() - t0 });
    // A job that overran its own slot is the owner's doing. Anything else (late dispatch, model
    // server down) is the provider breaking the contract: pay the slot's price back to its holder.
    const sale = paid[serial];
    if (!reason.startsWith("timeout") && sale) {
      delete paid[serial];
      savePaid();
      await refund(owner, BigInt(sale.amount), sale.paymentTx, `provider failed slot #${serial}: ${reason}`);
    }
  }
}

// Rebuild upcoming slots from the NFTs themselves, so a restart loses nothing.
for (const nft of await tokenNfts(tokenId)) {
  const { s } = decodeSlot(nft.metadata);
  if (!nft.deleted && s > now() - SLOT_SECONDS) place(s, nft.serial_number);
}
console.log(`restored ${[...slots.values()].flat().length} upcoming slots, ${[...queues.values()].flat().length} queued jobs`);

// ---- HTTP ----
const requirements = (amount: bigint) =>
  x402.buildPaymentRequirements({ scheme: "exact", network: NETWORK, payTo: P.id, price: { asset: HBAR, amount: amount.toString() }, maxTimeoutSeconds: 120 });

/** Paid but the slot couldn't be minted: the provider is the trusted party here, so it pays back. */
async function refund(to: string, amount: bigint, paymentTx: string, reason: string) {
  try {
    const tx = await new TransferTransaction()
      .addHbarTransfer(P.id, Hbar.fromTinybars((-amount).toString()))
      .addHbarTransfer(to, Hbar.fromTinybars(amount.toString()))
      .execute(client);
    await tx.getReceipt(client);
    log({ type: "refund", buyer: to, amount: amount.toString(), paymentTx, refundTx: tx.transactionId.toString(), reason });
  } catch (e) {
    console.error(`REFUND FAILED: owe ${to} ${amount} tinybars for ${paymentTx}`, e);
  }
}

async function authed(action: string, body: any) {
  let job;
  try {
    job = parseJob(body?.job);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  const hash = jobHash(job);
  try {
    return { job, hash, account: await verifyRequest(action, hash, body) };
  } catch (e) {
    throw new HttpError(401, (e as Error).message);
  }
}

await serve(PORT, {
  /**
   * Buy a slot through x402: without a PAYMENT-SIGNATURE header this answers 402 with the current
   * price; with one it verifies and settles the HBAR payment, then mints a slot NFT to the payer
   * and stores the job privately. Every check that can fail runs before any money moves.
   */
  "POST /book": async ({ body, headers }): Promise<Res> => {
    const { job, hash, account } = await authed("book", body);
    const queued = queues.get(account) ?? [];
    if (queued.some((q) => q.hash === hash)) throw new HttpError(409, "this job is already booked");
    if (queued.length >= MAX_QUEUE) throw new HttpError(429, `at most ${MAX_QUEUE} queued jobs per account`);

    const quote = price();
    const header = headers["payment-signature"];
    let payload = null;
    try {
      if (typeof header === "string") payload = decodePaymentSignatureHeader(header);
    } catch {
      throw new HttpError(400, "malformed PAYMENT-SIGNATURE header");
    }
    if (!payload || BigInt(payload.accepted?.amount ?? 0) < quote) {
      // Price may have risen since the client's quote: no settle happened, so just quote again.
      const required = await x402.createPaymentRequiredResponse(await requirements(quote), { url: `${BOOKING_URL}/book` });
      return { status: 402, body: { error: "payment required", price: quote.toString(), floor: PRICE_FLOOR.toString(), nextFree: nextFree() }, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required) } };
    }

    // Queue synchronously so a parallel /book of the same job gets 409 and can't double-pay.
    enqueue(account, { job, hash });
    const start = reserve();
    let settled;
    try {
      // Requirements are rebuilt server-side at the client's (>= quote) amount; only that may match.
      const match = x402.findMatchingRequirements(await requirements(BigInt(payload.accepted.amount)), payload);
      if (!match) throw new HttpError(402, "payment does not match the offered terms");
      const verified = await x402.verifyPayment(payload, match);
      if (!verified.isValid) throw new HttpError(402, `payment invalid: ${verified.invalidReason}`);
      if (verified.payer !== account) throw new HttpError(403, `payment is from ${verified.payer}, request is signed by ${account}`);
      settled = await x402.settlePayment(payload, match);
      if (!settled.success) throw new HttpError(402, `payment failed: ${settled.errorReason}`);
    } catch (e) {
      settle(start, null);
      dequeue(account, hash);
      throw e;
    }

    let issued;
    try {
      issued = await issueSlot(client, tokenId, T, account, { s: start, h: hash });
    } catch (e) {
      settle(start, null);
      dequeue(account, hash);
      await refund(account, BigInt(payload.accepted.amount), settled.transaction, (e as Error).message);
      throw e;
    }
    settle(start, issued.serial);
    paid[issued.serial] = { amount: payload.accepted.amount, paymentTx: settled.transaction };
    savePaid();
    log({ type: "booked", serial: issued.serial, start, owner: account, jobHash: hash, price: payload.accepted.amount });
    return {
      body: { serial: issued.serial, start, tokenId, topicId, price: payload.accepted.amount, paymentTx: settled.transaction, transferTx: issued.transferTx },
      headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settled) },
    };
  },

  /** Drop all of the caller's queued jobs, e.g. when an agent starts over. Its slots stay its own. */
  "POST /jobs/clear": async ({ body }) => {
    let account;
    try {
      account = await verifyRequest("clear", "all", body);
    } catch (e) {
      throw new HttpError(401, (e as Error).message);
    }
    return { body: { cleared: clearQueue(account) } };
  },

  /** The job's result, only for the account that booked it. Its sha256 is in the job's `done` event. */
  "POST /results": async ({ body }) => {
    const hash = String(body?.jobHash ?? "");
    let account;
    try {
      account = await verifyRequest("result", hash, body);
    } catch (e) {
      throw new HttpError(401, (e as Error).message);
    }
    const r = loadResult(hash);
    if (!r) throw new HttpError(404, "no result for this job (yet)");
    if (r.owner !== account) throw new HttpError(403, "only the job's owner can read its result");
    return { body: { jobHash: hash, text: r.text, tokens: r.tokens, model: r.model, ms: r.ms } };
  },
});
console.log(`listening on ${BOOKING_URL}`);

// Advertise on Arkiv, like a Golem Offer: identity, model, capacity, current price, next free start.
// Renewed every PROFILE_REFRESH seconds with a short expiry, so if this provider stops, its offer
// lapses on its own and agents stop sending it work.
const PROFILE_REFRESH = Number(process.env.PROFILE_REFRESH_SECONDS ?? 30);
const PROFILE_TTL = 10 * 60;
const writer = arkivWriter(evmKey(P.key));
const profile = () => ({
  provider: P.id,
  name: process.env.PROVIDER_LABEL ?? PROVIDER_NAME,
  token_id: tokenId,
  topic_id: topicId,
  slot_seconds: u64(SLOT_SECONDS),
  booking_url: BOOKING_URL,
  model: LLM_MODEL,
  workers: u64(WORKERS),
  price_now: u64(price()),
  next_free: u64(nextFree()),
});
// Start from a fresh entity: Arkiv refuses to move an expiry earlier, so an old long-lived profile
// couldn't be put on the short renew-or-lapse lifetime.
const old = await arkivReader().select({ $key: true }).from(ProviderProfile).where(eq("provider", P.id)).ownedBy(writer.account.address).fetch();
for (const e of old.entities) await writer.deleteEntity({ entityKey: e.$key }).catch(() => {});
let profileKey: `0x${string}` | undefined;
async function advertise() {
  if (profileKey) {
    try {
      await writer.patchEntity(ProviderProfile, profileKey, { set: profile() });
      await writer.extendEntity({ entityKey: profileKey, expiration: ExpirationTime.fromSeconds(PROFILE_TTL) });
      return;
    } catch (e) {
      console.error(`profile ${profileKey} could not be renewed (${(e as Error).message}); creating a new one`);
    }
  }
  profileKey = (await writer.createEntity(ProviderProfile, profile(), { expiration: ExpirationTime.fromSeconds(PROFILE_TTL) })).entityKey;
}
await advertise();
console.log(`provider profile on Arkiv: ${profileKey} (${LLM_MODEL}, ${WORKERS} workers, refreshed every ${PROFILE_REFRESH}s)`);
setInterval(() => advertise().catch((e) => console.error("Arkiv profile refresh failed:", e.message)), PROFILE_REFRESH * 1000);
