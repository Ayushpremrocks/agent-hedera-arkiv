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
  need,
  ownedSerials,
  parseJob,
  postEvent,
  role,
  serve,
  slotInfo,
  tokenNfts,
  verifyRequest,
} from "@qy/shared";
import { ensureInfra, issueSlot } from "./chain.js";
import { runJob } from "./runner.js";
import { pending, savePending } from "./store.js";

const PORT = Number(process.env.PROVIDER_PORT ?? 4000);
const BOOKING_URL = process.env.PROVIDER_URL ?? `http://localhost:${PORT}`;
const SLOT_SECONDS = Number(process.env.SLOT_SECONDS ?? 30);
const WORKERS = Number(process.env.WORKERS ?? 2); // slots per start time = jobs run in parallel
const LEAD_SECONDS = Number(process.env.LEAD_SECONDS ?? 120); // earliest bookable start, leaves time to trade
const PRICE_FLOOR = BigInt(process.env.PRICE_FLOOR ?? 10_000_000); // tinybars (0.1 HBAR), covers mint + transfer fees
const PRICE_WINDOW = Number(process.env.PRICE_WINDOW_SECONDS ?? 300); // how far ahead "near-term" capacity counts
const KILL_MARGIN_MS = 1500; // a job is killed this long before its slot ends, so the next slot starts on a free worker

const P = role("PROVIDER");
const T = role("TREASURY");
const client = hederaClient(P.id, P.key);
const { tokenId, topicId } = await ensureInfra(client, P, T);
console.log(`provider ${P.id}  token ${hashscan("token", tokenId)}  topic ${hashscan("topic", topicId)}`);

/** HCS logging never blocks or breaks the caller; failures are only printed. */
function log(event: HcsEvent) {
  console.log(event);
  postEvent(client, topicId, P.id, P.key, event).catch((e) => console.error("HCS post failed:", e.message));
}

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
 * Booking price: the floor, doubled for every start time already full in the near-term window.
 * Idle capacity stays cheap; hoarding it gets exponentially expensive, whoever's accounts do it.
 */
function price(): bigint {
  const horizon = now() + LEAD_SECONDS + PRICE_WINDOW;
  let full = 0;
  for (const [start, list] of slots) if (start <= horizon && list.length >= WORKERS) full++;
  return PRICE_FLOOR << BigInt(full);
}

/** Reserve the earliest start with a free worker. Synchronous, so concurrent bookings can't collide. */
function reserve(): number {
  let start = Math.ceil((now() + LEAD_SECONDS) / SLOT_SECONDS) * SLOT_SECONDS;
  while ((slots.get(start)?.length ?? 0) >= WORKERS) start += SLOT_SECONDS;
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
    return console.error(`slot #${serial}: owner lookup failed`, e);
  }
  const p = pending.get(owner);
  log({ type: "dispatch", serial, start, owner, jobHash: p?.hash ?? null });
  if (!p) return; // owner never bound a job: the slot idles
  pending.delete(owner);
  savePending();

  const t0 = Date.now();
  try {
    const limit = (start + SLOT_SECONDS) * 1000 - KILL_MARGIN_MS - Date.now();
    const r = await runJob(p.job, `${serial}:${p.hash}`, Math.max(0, limit));
    log({ type: "done", serial, owner, jobHash: p.hash, ok: true, result: `${r.digest}/${r.iterations}`, ms: Date.now() - t0 });
  } catch (e) {
    log({ type: "done", serial, owner, jobHash: p.hash, ok: false, result: (e as Error).message, ms: Date.now() - t0 });
  }
}

// Rebuild upcoming slots from the NFTs themselves, so a restart loses nothing.
for (const nft of await tokenNfts(tokenId)) {
  const { s } = decodeSlot(nft.metadata);
  if (!nft.deleted && s > now() - SLOT_SECONDS) place(s, nft.serial_number);
}
console.log(`restored ${[...slots.values()].flat().length} upcoming slots, ${pending.size} pending jobs`);

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
    if (pending.has(account)) throw new HttpError(409, "account already has a pending job; use /bind to replace it");

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
      return { status: 402, body: { error: "payment required", price: quote.toString() }, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required) } };
    }

    // Claim synchronously so a parallel /book from the same account gets 409 and can't double-pay.
    pending.set(account, { job, hash });
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
      pending.delete(account);
      throw e;
    }

    let issued;
    try {
      issued = await issueSlot(client, tokenId, T, account, { s: start, h: hash });
    } catch (e) {
      settle(start, null);
      pending.delete(account);
      await refund(account, BigInt(payload.accepted.amount), settled.transaction, (e as Error).message);
      throw e;
    }
    settle(start, issued.serial);
    savePending();
    log({ type: "booked", serial: issued.serial, start, owner: account, jobHash: hash });
    return {
      body: { serial: issued.serial, start, tokenId, topicId, price: payload.accepted.amount, paymentTx: settled.transaction, transferTx: issued.transferTx },
      headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settled) },
    };
  },

  /** Replace the caller's pending job. Only accounts currently holding a slot may bind. */
  "POST /bind": async ({ body }) => {
    const { job, hash, account } = await authed("bind", body);
    const held = await ownedSerials(account, tokenId);
    if (!held.length) throw new HttpError(403, "account holds no slot");
    pending.set(account, { job, hash });
    savePending();
    log({ type: "bound", account, jobHash: hash });
    return { body: { jobHash: hash, slots: held } };
  },
});
console.log(`listening on ${BOOKING_URL}`);

// Publish (or refresh) the provider profile on Arkiv so agents can discover token, topic and URL.
const writer = arkivWriter(evmKey(P.key));
const profile = { provider: P.id, token_id: tokenId, topic_id: topicId, slot_seconds: u64(SLOT_SECONDS), booking_url: BOOKING_URL };
const existing = (
  await arkivReader().select({ $key: true }).from(ProviderProfile).where(eq("provider", P.id)).ownedBy(writer.account.address).limit(1).fetch()
).entities[0];
if (existing) {
  await writer.patchEntity(ProviderProfile, existing.$key, { set: profile });
  await writer.extendEntity({ entityKey: existing.$key, expiration: ExpirationTime.fromDays(7) });
} else {
  await writer.createEntity(ProviderProfile, profile, { expiration: ExpirationTime.fromDays(7) });
}
console.log("provider profile on Arkiv:", existing ? `updated ${existing.$key}` : "created");
