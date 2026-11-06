// Provider: sells places in its GPU queue. A booking (paid through x402) gets a ticket with a size
// (max tokens), a hard run-time limit and a promised `startBy`: the provider starts it by then or pays
// it back. Workers take tickets the moment they're free (earliest promise first), so nothing idles
// on a clock. A reservation is a ticket bought ahead for later, its job attached afterwards. When a
// ticket's turn comes, the provider runs its holder's most urgent job that fits. Tickets are only
// minted as NFTs when someone wants to trade one.
import { ExpirationTime } from "@arkiv-network/sdk";
import { eq } from "@arkiv-network/sdk/query";
import { u64 } from "@arkiv-network/sdk/schema";
import { Hbar, TransferTransaction } from "@hiero-ledger/sdk";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import {
  CUTOFF_SECONDS,
  EventBatcher,
  SWAP_VALID_SECONDS,
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
  ownedSerials,
  parseJob,
  role,
  serve,
  sha256,
  slotInfo,
  verifyRequest,
} from "@qy/shared";
import { ensureInfra, issueSlot } from "./chain.js";
import { bookingPrice } from "./pricing.js";
import { LLM_BASE_URL, LLM_MODEL, calibrate, runJob, warmUp } from "./runner.js";
import { type Planned, type Speed, broken, byPromise, canStart, maxTokensWithin, promiseFor, runLimit } from "./schedule.js";
import { PROVIDER_NAME, type Ticket, clearQueue, counter, dequeue, enqueue, loadResult, nextJob, queues, saveResult, saveTickets, tickets } from "./store.js";

const PORT = Number(process.env.PROVIDER_PORT ?? 4000);
const BOOKING_URL = process.env.PROVIDER_URL ?? `http://localhost:${PORT}`;
const WORKERS = Number(process.env.WORKERS ?? 2); // jobs that run at the same time
const MAX_RUN_SECONDS = Number(process.env.MAX_RUN_SECONDS ?? 30); // no ticket's run limit is longer
const GRACE_SECONDS = 3; // a ticket starting later than startBy + this is refunded
// Tokenizing locks a ticket from starting this long, so a swap can't race the ticket starting.
const TRADE_LOCK_SECONDS = SWAP_VALID_SECONDS + CUTOFF_SECONDS + 15;
const RESERVE_HORIZON = Number(process.env.RESERVE_HORIZON_SECONDS ?? 3600); // how far ahead tickets are sold
// The floor covers what serving one booking costs on Hedera (the payment, a share of a batched log
// message and of an escrow payout), with margin. Nothing is minted per booking any more. Fees are set
// in USD, so the floor is too (PRICE_FLOOR in tinybars overrides).
const PRICE_FLOOR_CENTS = Number(process.env.PRICE_FLOOR_CENTS ?? 0.5);
// Turning a ticket into an NFT for a trade: a fresh mint plus transfer is about 2 US cents; reissuing a
// returned NFT (rewrite its metadata, transfer it) about 0.2. Whoever trades pays it.
const TOKENIZE_CENTS = Number(process.env.TOKENIZE_CENTS ?? 2);
const REISSUE_CENTS = Number(process.env.REISSUE_CENTS ?? 0.2);
// Bookings are paid into this escrow, which pays the provider once a ticket starts on time and refunds
// the buyer otherwise. Without one, the provider takes payment and owes refunds itself.
const ESCROW = process.env.ESCROW_ID ?? "";
const PRICE_WINDOW = Number(process.env.PRICE_WINDOW_SECONDS ?? 300); // how much queued work counts as "busy"
const STALE_SECONDS = Number(process.env.STALE_SECONDS ?? 600); // drop queued jobs this far past their deadline
const MAX_QUEUE = 20; // queued jobs per account; bookings are paid, this just bounds memory

const P = role(PROVIDER_NAME);
const T = role(PROVIDER_NAME === "PROVIDER" ? "TREASURY" : `${PROVIDER_NAME}_TREASURY`);
const client = hederaClient(P.id, P.key);
const { tokenId, topicId } = await ensureInfra(client, P, T);
console.log(`provider ${P.id}  token ${hashscan("token", tokenId)}  topic ${hashscan("topic", topicId)}`);
console.log(ESCROW ? `bookings are paid into escrow ${ESCROW}` : "no ESCROW_ID: bookings are paid to this provider, which owes refunds itself");

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
const prices = async () => ({
  floor: process.env.PRICE_FLOOR ? BigInt(process.env.PRICE_FLOOR) : await cents(PRICE_FLOOR_CENTS),
  tokenize: await cents(TOKENIZE_CENTS),
  reissue: await cents(REISSUE_CENTS),
});
let PRICES = await prices();
setInterval(() => prices().then((p) => (PRICES = p)).catch(() => {}), 3600_000).unref();
console.log(`booking floor ${PRICES.floor} tinybars, tokenizing ${PRICES.tokenize} per ticket`);

console.log(`model ${LLM_MODEL} at ${LLM_BASE_URL}: loading...`);
console.log(`model ready in ${await warmUp()}ms`);
// Worst-case speed, measured with every worker busy; SPEED_TPS / STARTUP_MS override it.
const SPEED: Speed = process.env.SPEED_TPS
  ? { tps: Number(process.env.SPEED_TPS), startupMs: Number(process.env.STARTUP_MS ?? 1000) }
  : await calibrate(WORKERS);
SPEED.tps = Math.max(1, Math.floor(SPEED.tps));
console.log(`worst-case speed ${SPEED.tps} tokens/s + ${SPEED.startupMs}ms startup; largest job ${maxTokensWithin(MAX_RUN_SECONDS, SPEED)} tokens`);

const facilitator = new HTTPFacilitatorClient({ url: need("X402_FACILITATOR_URL") });
const x402 = new x402ResourceServer(facilitator).register(NETWORK, new ExactHederaScheme());
await x402.initialize();

// ---- the queue ----
const now = () => Math.floor(Date.now() / 1000);
const pending = () =>
  Object.entries(tickets)
    .filter(([, t]) => t.status === "queued")
    .map(([n]) => Number(n));
const runningTickets = () => Object.values(tickets).filter((t) => t.status === "running");
let avgRunMs = 4000; // moving average of real run times, for pricing only

const asPlanned = (n: number): Planned => ({ id: n, limit: tickets[n].limit, notBefore: tickets[n].notBefore, startBy: tickets[n].startBy });
/** Latest moment each worker is free: a running job's kill time, or now. */
const busyUntil = () => runningTickets().map((t) => Math.max(now(), Math.ceil(t.killAt ?? now() + t.limit)));
const freeTimes = () => [...busyUntil(), ...Array(Math.max(0, WORKERS - runningTickets().length)).fill(now())];
/** The promise a ticket sold now (or reserved for `notBefore`) would get: behind everything already sold. */
const promiseNow = (limit: number, notBefore = now()) => promiseFor(freeTimes(), pending().map(asPlanned), limit, notBefore);

/** Booking price: the floor, rising with how much work is already queued (capped at 16x). */
function price(): bigint {
  const capacity = Math.max(1, WORKERS * Math.ceil((PRICE_WINDOW * 1000) / avgRunMs));
  return bookingPrice(pending().length + runningTickets().length, capacity, PRICES.floor);
}

// Ticket NFTs returned to the treasury (agents hand them back once their ticket has started), not yet
// reissued. `claimed` stops two concurrent trades taking the same one.
const claimed = new Set<number>();
async function freeSerials() {
  const inUse = new Set(pending().flatMap((n) => (tickets[n].serial === undefined ? [] : [tickets[n].serial!])));
  const held = await ownedSerials(T.id, tokenId).catch(() => []);
  return held.filter((s) => !inUse.has(s) && !claimed.has(s));
}

/** Pay back a ticket's price once: its promise was missed or the provider failed it. */
async function refundTicket(n: number, reason: string) {
  const t = tickets[n];
  if (ESCROW || t.refunded) return; // with an escrow, the escrow refunds from the payment it holds
  t.refunded = true;
  saveTickets();
  await refund(await holder(t), BigInt(t.price), t.paymentTx, reason, n);
}

/**
 * Start tickets on free workers, earliest promise first. A ticket may jump ahead of an early
 * reservation that isn't due yet only if that keeps every promise (see canStart).
 */
function pump() {
  for (const n of pending()) if (now() > tickets[n].startBy + GRACE_SECONDS) refundTicket(n, `ticket #${n} missed its startBy`);
  for (;;) {
    const idle = WORKERS - runningTickets().length;
    if (idle <= 0) return;
    const queue = pending().map(asPlanned).sort(byPromise);
    const next = queue.find((t) => canStart(now(), busyUntil(), idle, queue, t));
    if (!next) return;
    const n = next.id;
    // The limit counts from here, not from when the model call starts (looking up the holder takes time).
    Object.assign(tickets[n], { status: "running", startedAt: now(), killAt: Date.now() / 1000 + tickets[n].limit });
    saveTickets();
    if (now() > tickets[n].startBy + GRACE_SECONDS) refundTicket(n, `ticket #${n} started after its startBy`);
    runTicket(n)
      .catch((e) => console.error(`ticket #${n}:`, e))
      .finally(() => {
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
  const p = nextJob(owner, t.maxTokens);
  log({ type: "dispatch", ticket: n, owner, jobHash: p?.hash ?? null });
  if (!p) return; // the holder has nothing queued that fits: the worker moves straight on
  dequeue(owner, p.hash);
  runningJobs.add(p.hash);

  const t0 = Date.now();
  try {
    const r = await runJob(p.job, Math.max(1, (t.killAt ?? Date.now() / 1000 + t.limit) * 1000 - Date.now()));
    const ms = Date.now() - t0;
    avgRunMs = Math.round(avgRunMs * 0.8 + ms * 0.2);
    // shortcut: speed only ever goes down (never back up) once a job runs slower; restart to re-measure.
    const seen = r.tokens >= 32 ? r.tokens / Math.max(0.001, (ms - SPEED.startupMs) / 1000) : Infinity;
    if (seen < SPEED.tps) {
      SPEED.tps = Math.max(1, Math.floor(seen));
      console.log(`slower than promised: worst-case speed now ${SPEED.tps} tokens/s`);
    }
    saveResult(p.hash, { owner, text: r.text, tokens: r.tokens, model: LLM_MODEL, ms });
    log({ type: "done", ticket: n, owner, jobHash: p.hash, ok: true, result: "ok", resultHash: sha256(r.text), tokens: r.tokens, ms });
  } catch (e) {
    const reason = (e as Error).message;
    log({ type: "done", ticket: n, owner, jobHash: p.hash, ok: false, result: reason.slice(0, 120), resultHash: null, tokens: 0, ms: Date.now() - t0 });
    // The job fit its ticket at the promised speed, so a timeout is the provider being slower than it
    // promised, like any other failure (model server down, a crash): pay the ticket back.
    if (reason.startsWith("timeout")) SPEED.tps = Math.max(1, Math.floor(SPEED.tps * 0.8));
    await refundTicket(n, `provider failed ticket #${n}: ${reason}`);
  } finally {
    runningJobs.delete(p.hash);
  }
}

// Tickets that were running when the provider stopped never finished: run them again first.
// (Their promise may already be missed: provider downtime is the provider's fault, so pump refunds.)
for (const t of Object.values(tickets)) {
  if (t.status === "running") t.status = "queued";
  if (t.startBy === undefined && t.status === "queued") {
    // a ticket from before promises existed: give it the largest size and promise it now
    Object.assign(t, { maxTokens: maxTokensWithin(MAX_RUN_SECONDS, SPEED), limit: MAX_RUN_SECONDS, notBefore: 0, startBy: now() });
  }
}
saveTickets();
console.log(`restored ${pending().length} queued ticket(s), ${[...queues.values()].flat().length} queued job(s)`);

// ---- HTTP ----
const requirements = (amount: bigint, payTo: string) =>
  x402.buildPaymentRequirements({ scheme: "exact", network: NETWORK, payTo, price: { asset: HBAR, amount: amount.toString() }, maxTimeoutSeconds: 120 });

/** Charge through x402: no header answers 402 with `quote`; with a matching payment it settles. */
async function charge(headers: Record<string, unknown>, quote: bigint, account: string, url: string, extra: object, payTo = P.id): Promise<{ status: 402; res: Res } | { status: 200; amount: string; tx: string; settled: any }> {
  const header = headers["payment-signature"];
  let payload = null;
  try {
    if (typeof header === "string") payload = decodePaymentSignatureHeader(header);
  } catch {
    throw new HttpError(400, "malformed PAYMENT-SIGNATURE header");
  }
  if (!payload || BigInt(payload.accepted?.amount ?? 0) < quote) {
    // The price may have risen since the client's quote: nothing settled, so just quote again.
    const required = await x402.createPaymentRequiredResponse(await requirements(quote, payTo), { url });
    return { status: 402, res: { status: 402, body: { error: "payment required", price: quote.toString(), ...extra }, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required) } } };
  }
  // Requirements are rebuilt server-side at the client's (>= quote) amount; only that may match.
  const match = x402.findMatchingRequirements(await requirements(BigInt(payload.accepted.amount), payTo), payload);
  if (!match) throw new HttpError(402, "payment does not match the offered terms");
  const verified = await x402.verifyPayment(payload, match);
  if (!verified.isValid) throw new HttpError(402, `payment invalid: ${verified.invalidReason}`);
  if (verified.payer !== account) throw new HttpError(403, `payment is from ${verified.payer}, request is signed by ${account}`);
  const settled = await x402.settlePayment(payload, match);
  if (!settled.success) throw new HttpError(402, `payment failed: ${settled.errorReason}`);
  return { status: 200, amount: payload.accepted.amount, tx: settled.transaction, settled };
}

/** Paid for something the provider couldn't deliver: the provider is trusted here, so it pays back. */
async function refund(to: string, amount: bigint, paymentTx: string, reason: string, ticket?: number) {
  try {
    const tx = await new TransferTransaction()
      .addHbarTransfer(P.id, Hbar.fromTinybars((-amount).toString()))
      .addHbarTransfer(to, Hbar.fromTinybars(amount.toString()))
      .execute(client);
    await tx.getReceipt(client);
    log({ type: "refund", buyer: to, amount: amount.toString(), paymentTx, refundTx: tx.transactionId.toString(), reason, ...(ticket !== undefined ? { ticket } : {}) });
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

/** Record a paid ticket with its promise: behind everything already sold, so no other promise moves. */
function issue(owner: string, paid: { amount: string; tx: string }, maxTokens: number, limit: number, notBefore: number) {
  const n = counter.next++;
  tickets[n] = { owner, price: paid.amount, paymentTx: paid.tx, status: "queued", maxTokens, limit, notBefore, startBy: promiseNow(limit, notBefore) };
  saveTickets();
  return n;
}

const ticketView = (n: number) => {
  const t = tickets[n];
  return { ticket: n, status: t.status, startBy: t.startBy, startedAt: t.startedAt ?? null, limit: t.limit, maxTokens: t.maxTokens, notBefore: t.notBefore, serial: t.serial ?? null };
};

await serve(PORT, {
  /**
   * Buy a place in the queue through x402: without a PAYMENT-SIGNATURE header this answers 402 with
   * the price and the startBy it would promise; with one it settles and issues the ticket, sized for
   * the job. Every check that can fail runs before any money moves. Nothing is minted.
   */
  "POST /book": async ({ body, headers }): Promise<Res> => {
    let job;
    try {
      job = parseJob(body?.job);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    const limit = runLimit(job.maxTokens, SPEED);
    if (limit > MAX_RUN_SECONDS) throw new HttpError(400, `at most ${maxTokensWithin(MAX_RUN_SECONDS, SPEED)} tokens fit in one job here`);
    const hash = jobHash(job);
    const account = await signed("book", hash, body);
    const queued = queues.get(account) ?? [];
    // Jobs start at once now, so "already booked" also means "already ran": its result is waiting.
    if (queued.some((q) => q.hash === hash) || runningJobs.has(hash) || loadResult(hash)) throw new HttpError(409, "this job is already booked");
    if (queued.length >= MAX_QUEUE) throw new HttpError(429, `at most ${MAX_QUEUE} queued jobs per account`);

    const terms = () => ({ floor: PRICES.floor.toString(), startBy: promiseNow(limit), limit, maxTokens: job.maxTokens });
    if (!headers["payment-signature"]) {
      const quote = await charge(headers, price(), account, `${BOOKING_URL}/book`, terms(), ESCROW || P.id);
      if (quote.status === 402) return quote.res;
    }
    // Queue the job first so a parallel /book of the same job gets 409 and can't double-pay.
    enqueue(account, { job, hash });
    let paid;
    try {
      paid = await charge(headers, price(), account, `${BOOKING_URL}/book`, terms(), ESCROW || P.id);
    } catch (e) {
      dequeue(account, hash);
      throw e;
    }
    if (paid.status === 402) {
      dequeue(account, hash);
      return paid.res;
    }
    const n = issue(account, paid, job.maxTokens, limit, now());
    log({ type: "booked", ticket: n, owner: account, jobHash: hash, price: paid.amount, startBy: tickets[n].startBy, maxTokens: job.maxTokens, paymentTx: paid.tx });
    pump();
    return {
      body: { ...ticketView(n), tokenId, topicId, price: paid.amount, paymentTx: paid.tx },
      headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader(paid.settled) },
    };
  },

  /**
   * Reserve capacity ahead: a ticket of `maxTokens` that won't start before `notBefore`, with no job
   * yet (attach one later with POST /jobs). Like /book it's paid through x402 and gets a promised
   * startBy. Holders who no longer need it can resell it like any ticket.
   * Body: { maxTokens, notBefore, account, ts, sig } signed (action "reserve") over "maxTokens@notBefore".
   */
  "POST /reserve": async ({ body, headers }): Promise<Res> => {
    const maxTokens = Number(body?.maxTokens);
    const notBefore = Number(body?.notBefore);
    if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new HttpError(400, "maxTokens must be a positive integer");
    if (!Number.isInteger(notBefore) || notBefore < now() || notBefore > now() + RESERVE_HORIZON)
      throw new HttpError(400, `notBefore must be between now and ${RESERVE_HORIZON}s from now`);
    const limit = runLimit(maxTokens, SPEED);
    if (limit > MAX_RUN_SECONDS) throw new HttpError(400, `at most ${maxTokensWithin(MAX_RUN_SECONDS, SPEED)} tokens fit in one job here`);
    const account = await signed("reserve", `${maxTokens}@${notBefore}`, body);
    const terms = () => ({ floor: PRICES.floor.toString(), startBy: promiseNow(limit, notBefore), limit, maxTokens, notBefore });
    const paid = await charge(headers, price(), account, `${BOOKING_URL}/reserve`, terms(), ESCROW || P.id);
    if (paid.status === 402) return paid.res;
    const n = issue(account, paid, maxTokens, limit, notBefore);
    log({ type: "booked", ticket: n, owner: account, jobHash: "", price: paid.amount, startBy: tickets[n].startBy, maxTokens, notBefore, paymentTx: paid.tx });
    pump();
    return {
      body: { ...ticketView(n), tokenId, topicId, price: paid.amount, paymentTx: paid.tx },
      headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader(paid.settled) },
    };
  },

  /**
   * Queue a job to run on a ticket the caller holds (or will hold): the job runs when one of the
   * caller's tickets that is big enough starts. Free; the ticket was paid for.
   * Body: { job, account, ts, sig } signed (action "job") over the job hash.
   */
  "POST /jobs": async ({ body }): Promise<Res> => {
    let job;
    try {
      job = parseJob(body?.job);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    const hash = jobHash(job);
    const account = await signed("job", hash, body);
    const queued = queues.get(account) ?? [];
    if (queued.some((q) => q.hash === hash) || runningJobs.has(hash) || loadResult(hash)) throw new HttpError(409, "this job is already queued");
    if (queued.length >= MAX_QUEUE) throw new HttpError(429, `at most ${MAX_QUEUE} queued jobs per account`);
    enqueue(account, { job, hash });
    return { body: { jobHash: hash, queued: queued.length + 1 } };
  },

  /** The queue as it stands: every ticket waiting or running, its promise, size and NFT if traded. */
  "GET /queue": async () => ({
    body: {
      workers: WORKERS,
      speed: SPEED,
      maxRunSeconds: MAX_RUN_SECONDS,
      maxTokens: maxTokensWithin(MAX_RUN_SECONDS, SPEED),
      escrow: ESCROW || null,
      graceSeconds: GRACE_SECONDS,
      tickets: Object.keys(tickets)
        .map(Number)
        .filter((n) => tickets[n].status !== "done")
        .sort((a, b) => tickets[a].startBy - tickets[b].startBy || a - b)
        .map(ticketView),
    },
  }),

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
    // Lock both from starting until the swap can settle, but only if that breaks no other promise.
    const lockUntil = (n: number) => Math.min(tickets[n].startBy, now() + TRADE_LOCK_SECONDS);
    const queue = pending().map(asPlanned);
    const locked = queue.map((t) => (list.includes(t.id) ? { ...t, notBefore: Math.max(t.notBefore, lockUntil(t.id)) } : t));
    if (broken(freeTimes(), locked.sort(byPromise)) > broken(freeTimes(), queue.sort(byPromise)))
      throw new HttpError(409, "the queue is too tight to hold these tickets for a trade right now");
    if (list.some((n) => lockUntil(n) < now() + SWAP_VALID_SECONDS)) throw new HttpError(410, "a ticket starts too soon to trade");
    const lock = () => {
      for (const n of list) tickets[n].notBefore = Math.max(tickets[n].notBefore, lockUntil(n));
      saveTickets();
    };
    const todo = list.filter((n) => tickets[n].serial === undefined);
    const serials = () => Object.fromEntries(list.map((n) => [n, tickets[n].serial]));
    if (!todo.length) {
      lock();
      return { body: { serials: serials(), price: "0", lockedUntil: Math.min(...list.map((n) => tickets[n].notBefore)) } };
    }

    // Returned NFTs sitting in the treasury are rewritten and reissued; only the rest are minted.
    const reuse = (await freeSerials()).slice(0, todo.length);
    for (const s of reuse) claimed.add(s);
    const cost = PRICES.reissue * BigInt(reuse.length) + PRICES.tokenize * BigInt(todo.length - reuse.length);
    let paid;
    try {
      paid = await charge(headers, cost, account, `${BOOKING_URL}/tickets/tokenize`, { tickets: todo, reissued: reuse.length });
    } finally {
      if (!paid || paid.status === 402) for (const s of reuse) claimed.delete(s);
    }
    if (paid.status === 402) return paid.res;
    // Lock before minting: a mint takes seconds and the ticket must not start meanwhile.
    if (list.some((n) => tickets[n].status !== "queued")) {
      await refund(account, BigInt(paid.amount), paid.tx, "a ticket started while tokenizing was paid for");
      throw new HttpError(410, "a ticket started meanwhile; payment refunded");
    }
    lock();
    try {
      for (const [i, n] of todo.entries()) {
        const owner = owners[list.indexOf(n)];
        const issued = await issueSlot(client, tokenId, T, owner, { t: n }, reuse[i]);
        if (reuse[i] !== undefined) claimed.delete(reuse[i]);
        tickets[n].serial = issued.serial;
        saveTickets();
        log({ type: "tokenized", ticket: n, serial: issued.serial, owner });
      }
    } catch (e) {
      await refund(account, BigInt(paid.amount), paid.tx, `tokenizing failed: ${(e as Error).message}`);
      throw e;
    }
    return { body: { serials: serials(), price: paid.amount, paymentTx: paid.tx, lockedUntil: Math.min(...list.map((n) => tickets[n].notBefore)) } };
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

// Advertise on Arkiv, like a Golem Offer: identity, model, capacity, speed, current price and the
// startBy a booking would get now. Renewed every PROFILE_REFRESH seconds with a short expiry, so if this provider stops, its
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
  tps: u64(SPEED.tps),
  startup_ms: u64(SPEED.startupMs),
  max_tokens: u64(maxTokensWithin(MAX_RUN_SECONDS, SPEED)),
  escrow: ESCROW,
  booking_url: BOOKING_URL,
  model: LLM_MODEL,
  workers: u64(WORKERS),
  price_now: u64(price()),
  next_free: u64(promiseNow(0)),
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
