// Provider: sells places in its GPU queue. A booking (paid through x402) gets a ticket; workers take
// the next ticket the moment they're free, so no capacity sits idle waiting for a clock slot. When a
// ticket's turn comes, the provider runs its owner's most urgent job. Tickets are only minted as NFTs
// when someone wants to trade one; until then the owner is recorded here and in the signed log.
import { ExpirationTime } from "@arkiv-network/sdk";
import { eq } from "@arkiv-network/sdk/query";
import { u64 } from "@arkiv-network/sdk/schema";
import { Hbar, TransferTransaction } from "@hiero-ledger/sdk";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import {
  EventBatcher,
  HBAR,
  type HcsEvent,
  HttpError,
  MIRROR,
  NETWORK,
  ProviderProfile,
  type Res,
  arkivReader,
  arkivWriter,
  evmKey,
  hashscan,
  hederaClient,
  jobHash,
  need,
  nftOwner,
  parseJob,
  role,
  serve,
  sha256,
  slotInfo,
  verifyRequest,
} from "@qy/shared";
import { ensureInfra, issueSlot } from "./chain.js";
import { bookingPrice } from "./pricing.js";
import { LLM_BASE_URL, LLM_MODEL, runJob, warmUp } from "./runner.js";
import { PROVIDER_NAME, type Ticket, clearQueue, counter, dequeue, enqueue, loadResult, nextJob, queues, saveResult, saveTickets, tickets } from "./store.js";

const PORT = Number(process.env.PROVIDER_PORT ?? 4000);
const BOOKING_URL = process.env.PROVIDER_URL ?? `http://localhost:${PORT}`;
const WORKERS = Number(process.env.WORKERS ?? 2); // jobs that run at the same time
const MAX_RUN_SECONDS = Number(process.env.MAX_RUN_SECONDS ?? 30); // a job is cut off after this
// The floor covers what serving one booking costs on Hedera (two batched log entries and the payment),
// with margin. Fees are set in USD, so the floor is too (PRICE_FLOOR in tinybars overrides).
const PRICE_FLOOR_CENTS = Number(process.env.PRICE_FLOOR_CENTS ?? 2.5);
// Turning a ticket into an NFT costs a mint and a transfer, about 1.5 US cents; whoever trades pays it.
const TOKENIZE_CENTS = Number(process.env.TOKENIZE_CENTS ?? 2);
const PRICE_WINDOW = Number(process.env.PRICE_WINDOW_SECONDS ?? 300); // how much queued work counts as "busy"
const STALE_SECONDS = Number(process.env.STALE_SECONDS ?? 600); // drop queued jobs this far past their deadline
const MAX_QUEUE = 20; // queued jobs per account; bookings are paid, this just bounds memory

const P = role(PROVIDER_NAME);
const T = role(PROVIDER_NAME === "PROVIDER" ? "TREASURY" : `${PROVIDER_NAME}_TREASURY`);
const client = hederaClient(P.id, P.key);
const { tokenId, topicId } = await ensureInfra(client, P, T);
console.log(`provider ${P.id}  token ${hashscan("token", tokenId)}  topic ${hashscan("topic", topicId)}`);

// Every event goes out in signed batches: one HCS fee per batch, not per event.
const batcher = new EventBatcher(client, topicId, P.id, P.key);
function log(event: HcsEvent) {
  console.log(event);
  batcher.add(event);
}

async function cents(c: number): Promise<bigint> {
  const r = ((await (await fetch(`${MIRROR}/network/exchangerate`)).json()) as any).current_rate; // cent_equivalent cents = hbar_equivalent HBAR
  return BigInt(Math.ceil(((c * r.hbar_equivalent) / r.cent_equivalent) * 1e8));
}
const prices = async () => ({ floor: process.env.PRICE_FLOOR ? BigInt(process.env.PRICE_FLOOR) : await cents(PRICE_FLOOR_CENTS), tokenize: await cents(TOKENIZE_CENTS) });
let PRICES = await prices();
setInterval(() => prices().then((p) => (PRICES = p)).catch(() => {}), 3600_000).unref();
console.log(`booking floor ${PRICES.floor} tinybars, tokenizing ${PRICES.tokenize} per ticket`);

console.log(`model ${LLM_MODEL} at ${LLM_BASE_URL}: loading...`);
console.log(`model ready in ${await warmUp()}ms`);

const facilitator = new HTTPFacilitatorClient({ url: need("X402_FACILITATOR_URL") });
const x402 = new x402ResourceServer(facilitator).register(NETWORK, new ExactHederaScheme());
await x402.initialize();

// ---- the queue ----
const now = () => Math.floor(Date.now() / 1000);
const pending = () =>
  Object.entries(tickets)
    .filter(([, t]) => t.status === "queued")
    .map(([n]) => Number(n))
    .sort((a, b) => a - b);
let running = 0;
let avgRunMs = 4000; // moving average of real run times, for estimates

/** When the ticket at queue position `i` (0 = next) should start: jobs run WORKERS at a time. */
const etaAt = (i: number) => now() + Math.ceil((Math.floor((i + running) / WORKERS) * avgRunMs) / 1000);
const nextFree = () => etaAt(pending().length);

/** Booking price: the floor, rising with how much work is already queued (capped at 16x). */
function price(): bigint {
  const capacity = Math.max(1, WORKERS * Math.ceil((PRICE_WINDOW * 1000) / avgRunMs));
  return bookingPrice(pending().length + running, capacity, PRICES.floor);
}

/** Start queued tickets on every free worker. Work-conserving: no worker waits for a clock. */
function pump() {
  for (const n of pending()) {
    if (running >= WORKERS) return;
    tickets[n].status = "running";
    running++;
    saveTickets();
    runTicket(n)
      .catch((e) => console.error(`ticket #${n}:`, e))
      .finally(() => {
        running--;
        tickets[n].status = "done";
        saveTickets();
        pump();
      });
  }
}

/** Whoever holds the ticket now: the NFT's holder once it's tokenized (asked of consensus), else the booker. */
async function holder(t: Ticket): Promise<string> {
  if (t.serial === undefined) return t.owner;
  try {
    return (await slotInfo(client, tokenId, t.serial)).owner; // consensus, so a swap just before it runs counts
  } catch (e) {
    console.error(`NFT #${t.serial}: ${(e as Error).message}; using the Mirror Node`);
    return nftOwner(tokenId, t.serial);
  }
}

const runningJobs = new Set<string>(); // hashes being run right now, so they can't be booked again meanwhile
async function runTicket(n: number) {
  const t = tickets[n];
  const owner = await holder(t);
  // A job long past its deadline lost its ticket somewhere (provider downtime, a crashed owner).
  // Running it first would push the owner's live work back, so drop it and say so.
  for (const q of queues.get(owner) ?? []) {
    if (q.job.deadline < now() - STALE_SECONDS) {
      dequeue(owner, q.hash);
      log({ type: "expired", owner, jobHash: q.hash, deadline: q.job.deadline });
    }
  }
  const p = nextJob(owner);
  log({ type: "dispatch", ticket: n, owner, jobHash: p?.hash ?? null });
  if (!p) return; // the holder has nothing queued: the worker moves straight on
  dequeue(owner, p.hash);
  runningJobs.add(p.hash);

  const t0 = Date.now();
  try {
    const r = await runJob(p.job, MAX_RUN_SECONDS * 1000);
    const ms = Date.now() - t0;
    avgRunMs = Math.round(avgRunMs * 0.8 + ms * 0.2);
    saveResult(p.hash, { owner, text: r.text, tokens: r.tokens, model: LLM_MODEL, ms });
    log({ type: "done", ticket: n, owner, jobHash: p.hash, ok: true, result: "ok", resultHash: sha256(r.text), tokens: r.tokens, ms });
  } catch (e) {
    const reason = (e as Error).message;
    log({ type: "done", ticket: n, owner, jobHash: p.hash, ok: false, result: reason.slice(0, 120), resultHash: null, tokens: 0, ms: Date.now() - t0 });
    // Running past the time limit is the job's doing. Anything else (model server down, a crash)
    // is the provider failing the ticket: pay its price back to whoever holds it.
    if (!reason.startsWith("timeout")) await refund(owner, BigInt(t.price), t.paymentTx, `provider failed ticket #${n}: ${reason}`);
  } finally {
    runningJobs.delete(p.hash);
  }
}

// Tickets that were running when the provider stopped never finished: run them again first.
for (const t of Object.values(tickets)) if (t.status === "running") t.status = "queued";
saveTickets();
console.log(`restored ${pending().length} queued ticket(s), ${[...queues.values()].flat().length} queued job(s)`);

// ---- HTTP ----
const requirements = (amount: bigint) =>
  x402.buildPaymentRequirements({ scheme: "exact", network: NETWORK, payTo: P.id, price: { asset: HBAR, amount: amount.toString() }, maxTimeoutSeconds: 120 });

/** Charge through x402: no header answers 402 with `quote`; with a matching payment it settles. */
async function charge(headers: Record<string, unknown>, quote: bigint, account: string, url: string, extra: object): Promise<{ status: 402; res: Res } | { status: 200; amount: string; tx: string; settled: any }> {
  const header = headers["payment-signature"];
  let payload = null;
  try {
    if (typeof header === "string") payload = decodePaymentSignatureHeader(header);
  } catch {
    throw new HttpError(400, "malformed PAYMENT-SIGNATURE header");
  }
  if (!payload || BigInt(payload.accepted?.amount ?? 0) < quote) {
    // The price may have risen since the client's quote: nothing settled, so just quote again.
    const required = await x402.createPaymentRequiredResponse(await requirements(quote), { url });
    return { status: 402, res: { status: 402, body: { error: "payment required", price: quote.toString(), ...extra }, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required) } } };
  }
  // Requirements are rebuilt server-side at the client's (>= quote) amount; only that may match.
  const match = x402.findMatchingRequirements(await requirements(BigInt(payload.accepted.amount)), payload);
  if (!match) throw new HttpError(402, "payment does not match the offered terms");
  const verified = await x402.verifyPayment(payload, match);
  if (!verified.isValid) throw new HttpError(402, `payment invalid: ${verified.invalidReason}`);
  if (verified.payer !== account) throw new HttpError(403, `payment is from ${verified.payer}, request is signed by ${account}`);
  const settled = await x402.settlePayment(payload, match);
  if (!settled.success) throw new HttpError(402, `payment failed: ${settled.errorReason}`);
  return { status: 200, amount: payload.accepted.amount, tx: settled.transaction, settled };
}

/** Paid for something the provider couldn't deliver: the provider is trusted here, so it pays back. */
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

async function signed(action: string, subject: string, body: any) {
  try {
    return await verifyRequest(action, subject, body);
  } catch (e) {
    throw new HttpError(401, (e as Error).message);
  }
}

await serve(PORT, {
  /**
   * Buy a place in the queue through x402: without a PAYMENT-SIGNATURE header this answers 402 with
   * the current price and the estimated start; with one it settles the payment and issues a ticket.
   * Every check that can fail runs before any money moves. Nothing is minted.
   */
  "POST /book": async ({ body, headers }): Promise<Res> => {
    let job;
    try {
      job = parseJob(body?.job);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    const hash = jobHash(job);
    const account = await signed("book", hash, body);
    const queued = queues.get(account) ?? [];
    // Jobs start at once now, so "already booked" also means "already ran": its result is waiting.
    if (queued.some((q) => q.hash === hash) || runningJobs.has(hash) || loadResult(hash)) throw new HttpError(409, "this job is already booked");
    if (queued.length >= MAX_QUEUE) throw new HttpError(429, `at most ${MAX_QUEUE} queued jobs per account`);

    // Queue the job first so a parallel /book of the same job gets 409 and can't double-pay.
    const quoted = { floor: PRICES.floor.toString(), nextFree: nextFree(), runSeconds: Math.ceil(avgRunMs / 1000) };
    if (!headers["payment-signature"]) {
      const quote = await charge(headers, price(), account, `${BOOKING_URL}/book`, quoted);
      if (quote.status === 402) return quote.res;
    }
    enqueue(account, { job, hash });
    let paid;
    try {
      paid = await charge(headers, price(), account, `${BOOKING_URL}/book`, quoted);
    } catch (e) {
      dequeue(account, hash);
      throw e;
    }
    if (paid.status === 402) {
      dequeue(account, hash);
      return paid.res;
    }
    const n = counter.next++;
    tickets[n] = { owner: account, price: paid.amount, paymentTx: paid.tx, status: "queued" };
    saveTickets();
    const position = pending().indexOf(n);
    log({ type: "booked", ticket: n, owner: account, jobHash: hash, price: paid.amount });
    pump();
    return {
      body: { ticket: n, position, eta: etaAt(position), runSeconds: Math.ceil(avgRunMs / 1000), tokenId, topicId, price: paid.amount, paymentTx: paid.tx },
      headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader(paid.settled) },
    };
  },

  /** The queue as it stands: every ticket waiting or running, its estimated start, and its NFT if traded. */
  "GET /queue": async () => {
    const list = pending();
    return {
      body: {
        workers: WORKERS,
        runSeconds: Math.ceil(avgRunMs / 1000),
        maxRunSeconds: MAX_RUN_SECONDS,
        tickets: [
          ...Object.entries(tickets)
            .filter(([, t]) => t.status === "running")
            .map(([n, t]) => ({ ticket: Number(n), status: "running", eta: now(), serial: t.serial ?? null })),
          ...list.map((n, i) => ({ ticket: n, status: "queued", eta: etaAt(i), serial: tickets[n].serial ?? null })),
        ],
      },
    };
  },

  /**
   * Turn queued tickets into NFTs so they can be swapped, minted to whoever holds each ticket now.
   * Paid through x402 by the caller (the one who wants to trade), who must hold one of them.
   * Body: { tickets: number[], account, ts, sig } signed over the ticket list.
   */
  "POST /tickets/tokenize": async ({ body, headers }): Promise<Res> => {
    const list: number[] = Array.isArray(body?.tickets) ? body.tickets.map(Number) : [];
    if (!list.length || list.length > 2 || list.some((n) => !Number.isInteger(n) || !tickets[n])) throw new HttpError(400, "tickets must list one or two known tickets");
    const account = await signed("tokenize", list.join(","), body);
    for (const n of list) if (tickets[n].status !== "queued") throw new HttpError(410, `ticket #${n} has already started`);
    const owners = await Promise.all(list.map((n) => holder(tickets[n])));
    if (!owners.includes(account)) throw new HttpError(403, "you must hold one of the tickets");
    const todo = list.filter((n) => tickets[n].serial === undefined);
    const serials = () => Object.fromEntries(list.map((n) => [n, tickets[n].serial]));
    if (!todo.length) return { body: { serials: serials(), price: "0" } };

    const paid = await charge(headers, PRICES.tokenize * BigInt(todo.length), account, `${BOOKING_URL}/tickets/tokenize`, { tickets: todo });
    if (paid.status === 402) return paid.res;
    try {
      for (const n of todo) {
        const owner = owners[list.indexOf(n)];
        const issued = await issueSlot(client, tokenId, T, owner, { t: n });
        tickets[n].serial = issued.serial;
        saveTickets();
        log({ type: "tokenized", ticket: n, serial: issued.serial, owner });
      }
    } catch (e) {
      await refund(account, BigInt(paid.amount), paid.tx, `tokenizing failed: ${(e as Error).message}`);
      throw e;
    }
    return { body: { serials: serials(), price: paid.amount, paymentTx: paid.tx } };
  },

  /** Drop all of the caller's queued jobs, e.g. when an agent starts over. Its tickets stay its own. */
  "POST /jobs/clear": async ({ body }) => ({ body: { cleared: clearQueue(await signed("clear", "all", body)) } }),

  /** The job's result, only for the account that booked it. Its sha256 is in the job's `done` event. */
  "POST /results": async ({ body }) => {
    const hash = String(body?.jobHash ?? "");
    const account = await signed("result", hash, body);
    const r = loadResult(hash);
    if (!r) throw new HttpError(404, "no result for this job (yet)");
    if (r.owner !== account) throw new HttpError(403, "only the job's owner can read its result");
    return { body: { jobHash: hash, text: r.text, tokens: r.tokens, model: r.model, ms: r.ms } };
  },
});
console.log(`listening on ${BOOKING_URL}`);
pump();
setInterval(pump, 2000).unref(); // safety net: pick up anything a finished worker didn't

// Advertise on Arkiv, like a Golem Offer: identity, model, capacity, current price, next estimated
// start. Renewed every PROFILE_REFRESH seconds with a short expiry, so if this provider stops, its
// offer lapses on its own and agents stop sending it work.
const PROFILE_REFRESH = Number(process.env.PROFILE_REFRESH_SECONDS ?? 30);
const PROFILE_TTL = 10 * 60;
const writer = arkivWriter(evmKey(P.key));
const profile = () => ({
  provider: P.id,
  name: process.env.PROVIDER_LABEL ?? PROVIDER_NAME,
  token_id: tokenId,
  topic_id: topicId,
  run_seconds: u64(Math.ceil(avgRunMs / 1000)),
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
