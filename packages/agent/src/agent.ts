// One agent: a worker with real jobs in a market of many providers. It picks a provider per job from
// live offers (with fresh quotes), books a slot through x402, buys an earlier slot from another agent
// when a deadline is at risk, and offers slots it can spare. Many agents can share one process and
// one Hub; the CLI (index.ts) runs one, the host (packages/host) runs many.
import { ExpirationTime } from "@arkiv-network/sdk";
import { u64 } from "@arkiv-network/sdk/schema";
import type { PaymentRequired } from "@x402/core/types";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  CUTOFF_SECONDS,
  HBAR,
  HttpError,
  type Job,
  type LoggedEvent,
  MAX_INPUT_CHARS,
  NETWORK,
  type Res,
  SWAP_VALID_SECONDS,
  SlotOffer,
  type SwapTerms,
  Trade,
  arkivWriter,
  buildSwap,
  checkSwap,
  evmKey,
  findOffers,
  hashscan,
  hbarPayer,
  hederaClient,
  jobHash,
  parseKey,
  postEvent,
  postPaid,
  returnTicket,
  runLimit,
  sha256,
  signRequest,
  slotInfo,
} from "@qy/shared";
import type { Hub, Provider } from "./hub.js";
import { askPrice, atRisk, buyPlan, feasible, latestReplacement, withinBudget, worthListing } from "./policy.js";
import { type Market, type Role, type Task } from "./workloads.js";

export type AgentOptions = {
  id: string; // Hedera account
  key: string; // its private key
  label: string; // short name for logs, e.g. "A:urgent"
  role: Role;
  /** Where the agent's working state is kept: a JSON file for the CLI, a database row for the host. */
  store: Store;
  dir?: string; // if set, delivered results are also written here as markdown files (the CLI's view)
  baseUrl: string; // where other agents reach this agent's swap endpoint, ending before /offers/...
  names: Record<string, string>; // friendly names for accounts, shared and extended by the agent
  trading?: boolean; // false: book and run jobs, never buy or offer slots
  maxBooking?: bigint; // most it pays for one booking (tinybars)
  fresh?: boolean; // forget saved state and clear jobs left queued at providers
  minutes?: number; // stop taking new work after this long, finish what's booked, then call onFinish
  onFinish?: (stats: State["stats"]) => void;
  /** Called before the agent spends `amount` tinybars, so a host can top its account up first. */
  fund?: (amount: bigint) => Promise<void>;
  /** Only book providers whose bookings are paid into this escrow, so every refund is backed. */
  escrow?: string;
  log?: (line: string) => void;
  /** Lifecycle of every job, for a host to record (database) and publish (Arkiv). */
  onTask?: (e: TaskEvent) => void;
};

export type Store = { load(): Promise<State | null>; save(s: State): void };
export type TaskEvent =
  | { kind: "booked"; jobHash: string; label: string; deadline: number; provider: string; providerName: string; serial: number; start: number; price: string; fromUser: boolean }
  | { kind: "moved"; jobHash: string; serial: number; start: number; paid: string } // bought an earlier slot for `paid` tinybars
  | { kind: "running"; jobHash: string; serial: number }
  | { kind: "done"; jobHash: string; serial: number; result: string; resultHash: string; tokens: number; model: string; finishedAt: number; onTime: boolean }
  | { kind: "failed"; jobHash: string; reason: string };

/** The CLI's store: one JSON file. */
export function fileStore(path: string): Store {
  return {
    load: async () => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null),
    save: (s) => writeFileSync(path, JSON.stringify(s, null, 2)),
  };
}

type JobState = {
  provider: string;
  label: string;
  deadline: number;
  status: "queued" | "running" | "done" | "failed";
  serial?: number;
  lateCost?: string; // most the owner pays (tinybars) to move this job earlier
  minAsk?: string; // least the owner accepts (tinybars) to let this job wait
  fromUser?: boolean; // handed in by the agent's user
  met?: boolean;
  file?: string; // delivered result, relative to the agent's dir
  createdAt?: number;
  maxTokens?: number; // the job's size: it needs a ticket at least this big
};
type Listing = { key: `0x${string}`; latestOk: number; price: string };
export type State = {
  v: 5;
  slots: Record<string, number>; // "provider:ticket" -> its promised startBy, for tickets held that haven't run
  sizes: Record<string, number>; // "provider:ticket" -> its size (max tokens)
  jobs: Record<string, JobState>; // jobHash -> state
  listings: Record<string, Listing>; // "provider:ticket" -> live Arkiv offer
  stats: { booked: number; met: number; late: number; failed: number; bought: number; sold: number; spent: string; earned: string; refunded?: string; reserved?: number };
};
export type TaskSpec = { task: string; input?: string; label: string; deadline: number; maxTokens?: number; maxPay: bigint; minComp: bigint };

const now = () => Math.floor(Date.now() / 1000);
// Delivery is judged by the consensus time of the provider's `done` message, which lands after the job
// ends: up to one batch interval (4s) plus consensus. Plans finish this much before the deadline.
const LOG_SLACK = 10;
const NOT_BEFORE = CUTOFF_SECONDS + SWAP_VALID_SECONDS; // a swap signed now must settle before the cutoff
const isAccount = (s: unknown): s is string => typeof s === "string" && /^0\.0\.\d+$/.test(s);
const slotKey = (provider: string, serial: number) => `${provider}:${serial}`;
const splitKey = (key: string) => {
  const [provider, serial] = key.split(":");
  return { provider, serial: Number(serial) };
};

export async function createAgent(opts: AgentOptions, hub: Hub) {
  const cfg = opts.role;
  const me = { id: opts.id, key: opts.key };
  const say = opts.log ?? ((line: string) => console.log(new Date().toISOString().slice(11, 19), `[${opts.label}]`, line));
  const client = hederaClient(me.id, me.key);
  const writer = arkivWriter(evmKey(me.key));
  const reader = hub.reader;
  const trading = opts.trading ?? true;
  const maxBooking = opts.maxBooking ?? 300_000_000n;
  const payer = hbarPayer(me.id, me.key, maxBooking);
  const names = opts.names;
  const fund = opts.fund ?? (async () => {});
  const known = (id: string) => hub.known(id)!;

  // ---- state, saved so a restart doesn't forget queued work or listings ----
  if (opts.dir) mkdirSync(`${opts.dir}/outputs`, { recursive: true });
  const loaded = opts.fresh ? null : await opts.store.load();
  const state: State =
    loaded?.v === 5 ? loaded : { v: 5, slots: {}, sizes: {}, jobs: {}, listings: {}, stats: { booked: 0, met: 0, late: 0, failed: 0, bought: 0, sold: 0, spent: "0", earned: "0" } };
  const save = () => opts.store.save(state);
  const emit = (e: TaskEvent) => {
    try {
      opts.onTask?.(e);
    } catch (err) {
      say(`task hook failed: ${(err as Error).message}`);
    }
  };
  const addTo = (k: "spent" | "earned", v: bigint | string) => (state.stats[k] = (BigInt(state.stats[k]) + BigInt(v)).toString());

  if (opts.fresh) {
    // Starting over: jobs an earlier run left queued would take this run's slots.
    for (const p of hub.live.values()) {
      const cleared = await postPaid(`${p.bookingUrl}/jobs/clear`, signRequest("clear", me.id, me.key, "all")).catch(() => null);
      if (cleared?.body?.cleared) say(`cleared ${cleared.body.cleared} job(s) left queued at ${p.name}`);
    }
  }

  /** A job's hard run-time limit at a provider: what the provider kills it at, so the worst case. */
  const runFor = (p: Provider, maxTokens: number) => runLimit(maxTokens, p);

  /**
   * One provider's held tickets (at their promised startBy) and pending deadlines: the inputs to every
   * decision there. `run` is the longest run any waiting job there may take (the worst case for each),
   * `need` the biggest job size, so any ticket swapped in must be at least that big.
   */
  function schedule(provider: string) {
    const p = known(provider);
    const slots = Object.entries(state.slots)
      .map(([key, start]) => ({ ...splitKey(key), start, size: state.sizes[key] ?? 0 }))
      .filter((s) => s.provider === provider);
    const waiting = Object.values(state.jobs).filter((j) => j.provider === provider && j.status === "queued");
    const need = Math.max(0, ...waiting.map((j) => j.maxTokens ?? 300));
    const run = runFor(p, need || 256);
    return { slots, starts: slots.map((s) => s.start), deadlines: waiting.map((j) => j.deadline - LOG_SLACK), run, need };
  }
  const queuedAt = (provider: string) => Object.values(state.jobs).filter((j) => j.provider === provider && j.status === "queued");
  const open = () => Object.values(state.jobs).filter((j) => j.status === "queued" || j.status === "running");
  const activeProviders = () => new Set([...Object.keys(state.slots).map((k) => splitKey(k).provider), ...open().map((j) => j.provider)]);
  for (const id of activeProviders()) if (hub.known(id)) hub.track(hub.known(id)!);

  type QueueEntry = { ticket: number; status: string; startBy: number; notBefore: number; maxTokens: number; serial: number | null };
  /** A provider's queue as it stands: promises, sizes, trade locks, and which tickets are NFTs. */
  async function queueOf(p: Provider): Promise<Map<number, QueueEntry>> {
    const res = await fetch(`${p.bookingUrl}/queue`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`${p.name} queue: ${res.status}`);
    const body = (await res.json()) as { tickets: QueueEntry[] };
    return new Map(body.tickets.map((t) => [t.ticket, t]));
  }
  /** Budget for buying an earlier slot: the most any at-risk job's owner will pay to be on time. */
  function buyBudget(provider: string, starts: number[], deadlines: number[], run: number) {
    const risky = new Set(atRisk(starts, deadlines, run));
    return queuedAt(provider)
      .filter((j) => risky.has(j.deadline))
      .reduce((m, j) => (BigInt(j.lateCost ?? cfg.lateCost) > m ? BigInt(j.lateCost ?? cfg.lateCost) : m), 0n);
  }
  /** Least this agent asks to wait at a provider: the highest minimum its waiting jobs' owners set. */
  function askFloor(provider: string) {
    return queuedAt(provider).reduce((m, j) => (BigInt(j.minAsk ?? cfg.minAsk) > m ? BigInt(j.minAsk ?? cfg.minAsk) : m), cfg.minAsk);
  }

  /** One state change at a time: trading decisions, swaps and log updates never interleave. */
  let chain: Promise<unknown> = Promise.resolve();
  let inFlight = 0;
  function locked<T>(fn: () => Promise<T>): Promise<T> {
    inFlight++;
    const run = chain.then(fn).finally(() => inFlight--);
    chain = run.catch(() => {});
    return run;
  }

  // ---- what the logs say about this agent's work ----
  const triggers: LoggedEvent[] = [];
  const toDeliver: { provider: string; ev: LoggedEvent }[] = [];
  const off = hub.on((provider, ev) => {
    if (cfg.trigger?.(ev, me.id)) triggers.push(ev);
    const e = ev.e;
    if (ev.by !== provider) return; // only the provider's own signed messages say what ran
    if (e.type === "refund" && e.buyer === me.id) {
      state.stats.refunded = (BigInt(state.stats.refunded ?? "0") + BigInt(e.amount)).toString();
      say(`refunded ${e.amount} tinybars by ${known(provider).name}: ${e.reason}`);
      return save();
    }
    if ((e.type !== "dispatch" && e.type !== "done" && e.type !== "expired") || e.owner !== me.id) return;
    if (e.type === "expired") {
      const job = state.jobs[e.jobHash];
      if (job?.status === "queued") {
        job.status = "failed";
        state.stats.failed++;
        say(`job "${job.label}" expired unrun`);
        emit({ kind: "failed", jobHash: e.jobHash, reason: "expired before any slot ran it" });
      }
    } else if (e.type === "dispatch") {
      // A traded ticket's NFT goes back to the treasury once it has started, to be reissued.
      const nft = hub.history.find((x) => x.by === provider && x.e.type === "tokenized" && x.e.ticket === e.ticket);
      const serial = nft?.e.type === "tokenized" ? nft.e.serial : null;
      if (serial !== null) returnTicket(client, known(provider).tokenId, serial, me.id).catch((err) => say(`NFT #${serial} not returned: ${err.message}`));
      delete state.slots[slotKey(provider, e.ticket)];
      delete state.sizes[slotKey(provider, e.ticket)];
      const job = e.jobHash ? state.jobs[e.jobHash] : undefined;
      if (job) {
        Object.assign(job, { status: "running", serial: e.ticket });
        emit({ kind: "running", jobHash: e.jobHash!, serial: e.ticket });
      }
    } else if (state.jobs[e.jobHash]) {
      if (e.ok) toDeliver.push({ provider, ev });
      else {
        Object.assign(state.jobs[e.jobHash], { status: "failed" });
        state.stats.failed++;
        say(`job "${state.jobs[e.jobHash].label}" failed on ${known(provider).name} ticket #${e.ticket}: ${e.result}`);
        emit({ kind: "failed", jobHash: e.jobHash, reason: e.result });
      }
    }
    save();
  });

  /** Fetch a finished job's result, check it against the hash the provider logged, and keep it. */
  async function deliver(provider: string, done: LoggedEvent) {
    if (done.e.type !== "done") return;
    const p = known(provider);
    const hash = done.e.jobHash;
    const job = state.jobs[hash];
    const res = await postPaid(`${p.bookingUrl}/results`, { jobHash: hash, ...signRequest("result", me.id, me.key, hash) });
    if (res.status !== 200) throw new Error(`result for "${job.label}": ${res.status} ${res.body.error}`);
    if (sha256(res.body.text) !== done.e.resultHash) throw new Error(`result for "${job.label}" doesn't match the hash on HCS`);

    const met = done.ts <= job.deadline;
    let file: string | undefined;
    if (opts.dir) {
      file = `outputs/${new Date(done.ts * 1000).toISOString().replace(/[:.]/g, "-")}-${job.label.replace(/[^a-z0-9]+/gi, "-").slice(0, 60)}.md`;
      writeFileSync(
      `${opts.dir}/${file}`,
      `# ${job.label}\n\nRan on ${p.name} as ticket #${done.e.ticket}, finished ${new Date(done.ts * 1000).toISOString()}, ` +
        `deadline ${new Date(job.deadline * 1000).toISOString()} (${met ? "on time" : `late by ${done.ts - job.deadline}s`}). ` +
        `${res.body.tokens} tokens from ${res.body.model}. Result sha256 ${done.e.resultHash}, checked against HCS.\n\n${res.body.text}\n`,
      );
    }
    emit({ kind: "done", jobHash: hash, serial: done.e.ticket, result: res.body.text, resultHash: done.e.resultHash!, tokens: res.body.tokens, model: res.body.model, finishedAt: done.ts, onTime: met });
    await locked(async () => {
      Object.assign(job, { status: "done", met, file });
      if (met) state.stats.met++;
      else state.stats.late++;
      save();
    });
    say(`${met ? "ON TIME" : "LATE"} "${job.label}" (${p.name} ticket #${done.e.ticket})`);
    await postEvent(client, p.topicId, me.id, me.key, { type: "delivered", jobHash: hash, ticket: done.e.ticket, label: job.fromUser ? "" : job.label, deadline: job.deadline, finishedAt: done.ts, met }).catch(
      (e) => say(`HCS delivered: ${e.message}`),
    );
  }

  // ---- new work ----
  async function market(): Promise<Market> {
    const rows = (await reader.select().from(SlotOffer).limit(100).fetch()).entities;
    const offers = rows.map((r) => ({
      serial: Number(r.ticket.value),
      start: Number(r.start_by.value),
      latestOk: Number(r.latest_ok_start.value),
      price: r.min_price.value,
      seller: r.seller.value,
    }));
    return { me: me.id, names, events: hub.history, offers: offers.filter((x) => x.start > now()) };
  }

  /** Providers in order of preference: cheapest whose promise meets the deadline, then soonest free. */
  function rankProviders(deadline: number, tokens: number): Provider[] {
    const affordable = [...hub.live.values()].filter((p) => BigInt(p.price) <= maxBooking && p.maxTokens >= tokens && (!opts.escrow || p.escrow === opts.escrow));
    const byPrice = (a: Provider, b: Provider) => Number(BigInt(a.price) - BigInt(b.price));
    const inTime = affordable.filter((p) => p.nextFree + runFor(p, tokens) + LOG_SLACK <= deadline).sort(byPrice);
    const late = affordable.filter((p) => !inTime.includes(p)).sort((a, b) => a.nextFree - b.nextFree || byPrice(a, b));
    return [...inTime, ...late];
  }

  type Terms = { deadline?: number; lateCost?: bigint; minAsk?: bigint; fromUser?: boolean };

  /** Pick a provider and book a slot there for a task. Returns the booking, or an error message. */
  async function startJob(t: Task, terms: Terms = {}) {
    const deadline = terms.deadline ?? now() + cfg.deadlineIn;
    const job: Job = { kind: "llm", task: t.task, input: t.input.slice(-MAX_INPUT_CHARS), maxTokens: t.maxTokens, deadline, label: t.label };
    const hash = jobHash(job);
    if (await useReservation(job, hash, terms)) return state.jobs[hash] && booking(hash);
    const request = { job, ...signRequest("book", me.id, me.key, hash) };
    // Arkiv profiles are up to a refresh old, so ask the top candidates for a live quote (an unpaid
    // /book answers 402 with today's price and the startBy it would promise) and book the best, like
    // Golem's negotiation step. A provider that doesn't answer has gone offline before its offer expired.
    const quoted = (
      await Promise.all(
        rankProviders(deadline, job.maxTokens)
          .slice(0, 3)
          .map(async (c) => {
            const q = await postPaid(`${c.bookingUrl}/book`, request, undefined, 0, 5000).catch(() => null);
            return q?.status === 402 && q.body.price ? { ...c, price: String(q.body.price), nextFree: Number(q.body.startBy ?? c.nextFree) } : null;
          }),
      )
    ).filter((c): c is Provider => !!c && BigInt(c.price) <= maxBooking);
    const runAt = (c: Provider) => runFor(c, job.maxTokens) + LOG_SLACK; // run limit plus the log's delay
    const byPrice = (a: Provider, b: Provider) => Number(BigInt(a.price) - BigInt(b.price));
    // If no provider can start in time on its own, go where an earlier slot is already on offer for a
    // swap: slots only trade within one provider, so that's the only place a late booking can be fixed.
    const budget = terms.lateCost ?? cfg.lateCost;
    const swappable = async (c: Provider) =>
      trading &&
      (await findOffers(reader, c.id, { myStart: c.nextFree, myLatest: deadline - runAt(c), notBefore: now() + NOT_BEFORE + 15, budget, minTokens: job.maxTokens })).entities.some(
        (r) => r.seller.value !== me.id,
      );
    const late = quoted.filter((c) => c.nextFree + runAt(c) > deadline);
    const rescue = new Set<string>();
    for (const c of late) if (await swappable(c).catch(() => false)) rescue.add(c.id);
    const ranked = [
      ...quoted.filter((c) => c.nextFree + runAt(c) <= deadline).sort(byPrice),
      ...late.filter((c) => rescue.has(c.id)).sort(byPrice),
      ...late.filter((c) => !rescue.has(c.id)).sort((a, b) => a.nextFree - b.nextFree || byPrice(a, b)),
    ];
    if (rescue.size) say(`no provider can start "${t.label}" in time; ${[...rescue].map((id) => known(id).name).join(", ")} has an earlier slot on offer`);
    let p: Provider | undefined;
    let booked: { status: number; body: any } = { status: 0, body: { error: `no live provider quoted within ${maxBooking} tinybars` } };
    for (p of ranked) {
      await fund(BigInt(p.price) * 2n); // quotes can rise a little before payment settles
      booked = await postPaid(`${p.bookingUrl}/book`, { job, ...signRequest("book", me.id, me.key, hash) }, payer, 3, 60_000, opts.escrow).catch((e) => ({ status: 0, body: { error: e.message } }));
      if (booked.status === 200) break;
      say(`could not book "${t.label}" at ${p.name}: ${booked.status} ${booked.body.error}`);
    }
    if (booked.status !== 200 || !p) return { error: String(booked.body.error) };
    // A ticket is a place in the queue the provider promises to start by `startBy`, or refund.
    const { ticket: serial, startBy: start, price } = booked.body as { ticket: number; startBy: number; price: string };
    const chosen = p;
    hub.track(chosen);
    await locked(async () => {
      state.slots[slotKey(chosen.id, serial)] = start;
      state.sizes[slotKey(chosen.id, serial)] = job.maxTokens;
      state.jobs[hash] = {
        maxTokens: job.maxTokens,
        provider: chosen.id,
        label: t.label,
        deadline: job.deadline,
        status: "queued",
        lateCost: (terms.lateCost ?? cfg.lateCost).toString(),
        minAsk: (terms.minAsk ?? cfg.minAsk).toString(),
        fromUser: terms.fromUser,
        createdAt: now(),
      };
      state.stats.booked++;
      addTo("spent", price);
      save();
    });
    emit({ kind: "booked", jobHash: hash, label: t.label, deadline: job.deadline, provider: chosen.id, providerName: chosen.name, serial, start, price, fromUser: !!terms.fromUser });
    const run = runFor(chosen, job.maxTokens);
    const fits = start + run + LOG_SLACK <= job.deadline;
    say(`booked ${chosen.name} ticket #${serial} (${chosen.model}) for "${t.label}" at ${price} tinybars, starts within ${start - now()}s (guaranteed), runs at most ${run}s, due in ${job.deadline - now()}s${fits ? "" : " (too late on its own)"}`);
    return { provider: chosen.id, providerName: chosen.name, jobHash: hash, serial, start, price, slotSeconds: run };
  }

  /** What startJob returns for a job already recorded. */
  function booking(hash: string) {
    const j = state.jobs[hash];
    const p = known(j.provider);
    const key = Object.keys(state.slots)
      .filter((k) => splitKey(k).provider === j.provider)
      .sort((a, b) => state.slots[a] - state.slots[b])[0]; // the provider runs the most urgent job first, on the earliest ticket
    const run = runFor(p, j.maxTokens ?? 300);
    return { provider: p.id, providerName: p.name, jobHash: hash, serial: splitKey(key).serial, start: state.slots[key], price: "0", slotSeconds: run };
  }

  /**
   * Run a new job on a ticket this agent already holds and has no job for (a reservation), if that
   * still meets every deadline there: attaching a job is free, the ticket is already paid for.
   */
  async function useReservation(job: Job, hash: string, terms: Terms): Promise<boolean> {
    for (const provider of activeProviders()) {
      const p = hub.known(provider);
      if (!p) continue;
      const { slots, starts, deadlines, run } = schedule(provider);
      const spare = slots.length > deadlines.length && slots.some((s) => s.size >= job.maxTokens);
      if (!spare || !feasible(starts, [...deadlines, job.deadline - LOG_SLACK], Math.max(run, runFor(p, job.maxTokens)))) continue;
      const res = await postPaid(`${p.bookingUrl}/jobs`, { job, ...signRequest("job", me.id, me.key, hash) }).catch((e) => ({ status: 0, body: { error: e.message } }));
      if (res.status !== 200) {
        say(`could not attach "${job.label}" to my ticket at ${p.name}: ${res.status} ${res.body.error}`);
        continue;
      }
      await locked(async () => {
        state.jobs[hash] = {
          maxTokens: job.maxTokens,
          provider,
          label: job.label,
          deadline: job.deadline,
          status: "queued",
          lateCost: (terms.lateCost ?? cfg.lateCost).toString(),
          minAsk: (terms.minAsk ?? cfg.minAsk).toString(),
          fromUser: terms.fromUser,
          createdAt: now(),
        };
        // It's no longer spare: take it off the market (re-listed by reconcileListings if it still can be).
        for (const s of slots) await unlist(slotKey(provider, s.serial));
        save();
      });
      const b = booking(hash);
      emit({ kind: "booked", jobHash: hash, label: job.label, deadline: job.deadline, provider, providerName: p.name, serial: b.serial, start: b.start, price: "0", fromUser: !!terms.fromUser });
      say(`"${job.label}" runs on a ticket I reserved at ${p.name} (no new booking)`);
      return true;
    }
    return false;
  }

  /** Buy a ticket now for a job that will come at `at`: today's price, a promise for then. */
  async function reserveAhead(at: number, tokens: number) {
    const p = [...hub.live.values()].filter((c) => c.maxTokens >= tokens && BigInt(c.price) <= maxBooking && (!opts.escrow || c.escrow === opts.escrow)).sort((a, b) => Number(BigInt(a.price) - BigInt(b.price)))[0];
    if (!p) return;
    await fund(BigInt(p.price) * 2n);
    const res = await postPaid(`${p.bookingUrl}/reserve`, { maxTokens: tokens, notBefore: at, ...signRequest("reserve", me.id, me.key, `${tokens}@${at}`) }, payer, 3, 60_000, opts.escrow).catch((e) => ({
      status: 0,
      body: { error: e.message },
    }));
    if (res.status !== 200) return say(`could not reserve at ${p.name}: ${res.status} ${res.body.error}`);
    hub.track(p);
    await locked(async () => {
      const key = slotKey(p.id, res.body.ticket);
      state.slots[key] = res.body.startBy;
      state.sizes[key] = tokens;
      state.stats.reserved = (state.stats.reserved ?? 0) + 1;
      addTo("spent", res.body.price);
      save();
    });
    say(`RESERVED ${p.name} ticket #${res.body.ticket} (${tokens} tokens) for ${res.body.price} tinybars, starts ${at - now()}s from now (by ${res.body.startBy - now()}s, guaranteed)`);
  }

  // ---- buying: behind schedule at a provider, swap the latest slot there for an earlier one ----
  const lastShortfall = new Map<string, number>();
  async function buy() {
    for (const provider of activeProviders()) {
      const p = hub.known(provider);
      if (!p) continue;
      const { slots, starts, deadlines, run, need } = schedule(provider);
      const plan = buyPlan(starts, deadlines, run);
      if (!plan) continue;
      const give = slots.find((s) => s.start === plan.giveStart)!;
      if (give.start < now() + CUTOFF_SECONDS || plan.latestStart < now() + NOT_BEFORE) continue; // too late to trade
      const budget = buyBudget(provider, starts, deadlines, run);
      if (!budget) continue;
      const { entities } = await findOffers(reader, provider, { myStart: give.start, myLatest: plan.latestStart, notBefore: now() + NOT_BEFORE, budget, minTokens: need });
      const candidates = entities.filter((r) => r.seller.value !== me.id);
      let bought = false;
      for (const row of candidates) {
        try {
          const { sellerSerial, start, size, price, swapTx } = await take(p, row, give.serial, plan.latestStart, budget, need);
          delete state.slots[slotKey(provider, give.serial)];
          delete state.sizes[slotKey(provider, give.serial)];
          state.slots[slotKey(provider, sellerSerial)] = start;
          state.sizes[slotKey(provider, sellerSerial)] = size;
          await unlist(slotKey(provider, give.serial));
          state.stats.bought++;
          addTo("spent", price);
          save();
          // The provider runs the earliest-deadline job first, so the bought slot serves the most urgent one.
          const urgent = Object.entries(state.jobs)
            .filter(([, j]) => j.provider === provider && j.status === "queued")
            .sort(([, a], [, b]) => a.deadline - b.deadline)[0];
          if (urgent) emit({ kind: "moved", jobHash: urgent[0], serial: sellerSerial, start, paid: price });
          say(`BOUGHT ${p.name} ticket #${sellerSerial} (starts in ~${start - now()}s) from ${names[row.seller.value] ?? row.seller.value} for ${price} tinybars, gave #${give.serial}: ${hashscan("transaction", swapTx)}`);
          bought = true;
          break;
        } catch (e) {
          say(`skipped offer ${p.name} ticket #${row.ticket.value}: ${(e as Error).message}`);
        }
      }
      // Say it once per shortfall, not every tick.
      if (!bought && !candidates.length && lastShortfall.get(provider) !== plan.latestStart) {
        lastShortfall.set(provider, plan.latestStart);
        say(`behind schedule at ${p.name}: need a ticket starting by ${plan.latestStart - now()}s from now, none offered within ${budget} tinybars`);
      }
    }
  }

  /**
   * Buy the seller's queue ticket in exchange for ours. Tickets aren't NFTs until traded, so first we
   * pay the provider to tokenize both (only traded tickets ever cost a mint), then the same atomic
   * swap as always: both NFTs and the price in one transaction.
   */
  async function take(p: Provider, row: Awaited<ReturnType<typeof findOffers>>["entities"][number], giveTicket: number, latestStart: number, budget: bigint, need: number) {
    const seller = row.seller.value;
    const endpoint = row.endpoint.value;
    const sellerTicket = Number(row.ticket.value);
    // Arkiv rows are claims: check who wrote it and what the provider says before paying anything.
    if (row.$owner.toLowerCase() !== (await hub.evmOf(seller))) throw new Error("offer was not written by the seller it names");
    const before = await queueOf(p);
    const theirs = before.get(sellerTicket);
    if (theirs?.status !== "queued" || theirs.startBy > latestStart) throw new Error("that ticket isn't promised early enough");
    if (theirs.maxTokens < need) throw new Error(`that ticket is too small (${theirs.maxTokens} < ${need} tokens)`);

    // Ask the seller first: if it refuses, nothing is tokenized and nothing is paid.
    const ask = await postPaid(endpoint, { buyer: me.id, buyerTicket: giveTicket });
    if (ask.status !== 402 && ask.status !== 409) throw new Error(`seller refused (${ask.status}): ${ask.body.error}`);
    const tickets = [sellerTicket, giveTicket];
    const tok = await postPaid(
      `${p.bookingUrl}/tickets/tokenize`,
      { tickets, ...signRequest("tokenize", me.id, me.key, tickets.join(",")) },
      payer,
    ).catch((e) => ({ status: 0, body: { error: e.message } }));
    if (tok.status !== 200) throw new Error(`could not tokenize the tickets (${tok.status}): ${tok.body.error}`);
    if (tok.body.price && tok.body.price !== "0") addTo("spent", tok.body.price);
    const sellerSerial = Number(tok.body.serials[sellerTicket]);
    const buyerSerial = Number(tok.body.serials[giveTicket]);
    const slot = await slotInfo(client, p.tokenId, sellerSerial);
    if (slot.owner !== seller || slot.meta.t !== sellerTicket) throw new Error("the seller doesn't hold that ticket on Hedera");

    const quoteRes = ask.status === 402 ? ask : await postPaid(endpoint, { buyer: me.id, buyerTicket: giveTicket });
    if (quoteRes.status !== 402) throw new Error(`seller refused (${quoteRes.status}): ${quoteRes.body.error}`);
    const quote = quoteRes.body.accepts?.[0];
    if (quote?.scheme !== "qy-atomic-swap" || quote.payTo !== seller || quote.extra?.sellerTicket !== sellerTicket || quote.extra?.tokenId !== p.tokenId)
      throw new Error("seller quoted different terms");
    const price = BigInt(quote.amount);
    if (!withinBudget(price, budget)) throw new Error(`price ${price} over budget ${budget}`);

    await fund(price + 10_000_000n); // the price, plus the swap's network fee
    const tx = await buildSwap(client, { tokenId: p.tokenId, seller, sellerSerial, buyer: me.id, buyerSerial, price }).sign(parseKey(me.key));
    const res = await postPaid(endpoint, { buyer: me.id, buyerTicket: giveTicket, tx: Buffer.from(tx.toBytes()).toString("base64") });
    if (res.status !== 200) throw new Error(`swap failed (${res.status}): ${res.body.error}`);
    return { sellerSerial: sellerTicket, start: theirs.startBy, size: theirs.maxTokens, price: price.toString(), swapTx: res.body.swapTx as string };
  }

  // ---- offering: keep one Arkiv offer per slot this agent can spare ----
  async function unlist(key: string) {
    const l = state.listings[key];
    if (!l) return;
    delete state.listings[key];
    await writer.deleteEntity({ entityKey: l.key }).catch(() => {}); // it may have expired already
  }

  async function reconcileListings() {
    const want = new Map<string, Listing & { start: number; provider: string; serial: number }>();
    for (const provider of activeProviders()) {
      const p = hub.known(provider);
      if (!p) continue;
      const { slots, starts, deadlines, run } = schedule(provider);
      slots.forEach((s, i) => {
        if (s.start < now() + NOT_BEFORE + 5) return; // a buyer couldn't settle in time
        const latest = latestReplacement(starts, deadlines, i, run);
        if (latest === null) return;
        const latestOk = Math.min(latest, now() + 3600); // spare ticket: accepts anything this hour
        const slack = latestOk - s.start;
        if (!worthListing(slack, run)) return;
        want.set(slotKey(provider, s.serial), { key: "0x", latestOk, price: askPrice(slack, askFloor(provider), run).toString(), start: s.start, provider, serial: s.serial });
      });
    }
    for (const [key, l] of Object.entries(state.listings)) {
      const w = want.get(key);
      // Re-list only on a real change, Arkiv writes aren't free.
      if (!w || w.price !== l.price || Math.abs(w.latestOk - l.latestOk) >= schedule(w.provider).run) await unlist(key);
      else want.delete(key);
    }
    for (const [key, w] of want) {
      const { entityKey } = await writer.createEntity(
        SlotOffer,
        {
          provider: w.provider,
          ticket: u64(w.serial),
          start_by: u64(w.start),
          max_tokens: u64(state.sizes[key] ?? 0),
          latest_ok_start: u64(w.latestOk),
          min_price: u64(BigInt(w.price)),
          seller: me.id,
          endpoint: `${opts.baseUrl}/offers/${w.provider}/${w.serial}/swap`,
          job_hash: "",
        },
        // A ticket may start before its promise, so the offer is short-lived; the seller re-checks anyway.
        { expiration: ExpirationTime.atDate(new Date(Math.max(Math.min(w.start - CUTOFF_SECONDS, now() + 300), now() + 60) * 1000)) },
      );
      state.listings[key] = { key: entityKey, latestOk: w.latestOk, price: w.price };
      say(`offered ${known(w.provider).name} ticket #${w.serial} (starts within ${w.start - now()}s) for ${w.price} tinybars, takes tickets starting up to ${w.latestOk - now()}s from now`);
    }
    save();
  }

  // ---- a swap requested by another agent ----
  async function swap(provider: string, serial: number, body: any): Promise<Res> {
    // Busy agents answer at once instead of queueing the buyer: two agents buying from each other
    // at the same moment would otherwise each wait on the other forever.
    if (inFlight) throw new HttpError(409, "busy, try again shortly");
    return locked(() => swapLocked(provider, serial, body));
  }

  async function swapLocked(provider: string, ticket: number, body: any): Promise<Res> {
    const key = slotKey(provider, ticket);
    const listing = state.listings[key];
    const p = hub.known(provider);
    if (!trading || !listing || state.slots[key] === undefined || !p) throw new HttpError(410, "offer no longer available");
    const buyer = String(body?.buyer ?? "");
    const buyerTicket = Number(body?.buyerTicket);
    if (!isAccount(buyer) || !Number.isInteger(buyerTicket)) throw new HttpError(400, "need buyer and buyerTicket");

    // The provider says where both tickets stand in the queue right now.
    const q = await queueOf(p).catch(() => null);
    const mineQ = q?.get(ticket);
    const theirQ = q?.get(buyerTicket);
    if (!q || mineQ?.status !== "queued") throw new HttpError(410, "my ticket has already started");
    if (theirQ?.status !== "queued") throw new HttpError(422, `ticket #${buyerTicket} isn't waiting in ${p.name}'s queue`);
    if (mineQ.startBy < now() + CUTOFF_SECONDS) throw new HttpError(410, "my ticket starts too soon to trade");
    // Re-check against today's jobs, not the listing: new work may have arrived since it was written.
    const { slots, deadlines, run, need } = schedule(provider);
    if (theirQ.maxTokens < need) throw new HttpError(422, `ticket #${buyerTicket} is too small for my jobs (${theirQ.maxTokens} < ${need} tokens)`);
    const after = slots.map((s) => (s.serial === ticket ? theirQ.startBy : s.start));
    if (!feasible(after, deadlines, run)) throw new HttpError(422, `ticket #${buyerTicket} (start by ${theirQ.startBy}) would make me miss a deadline`);
    const price = BigInt(listing.price);
    // Both tickets must be NFTs for an atomic swap; the buyer pays the provider to tokenize them.
    if (mineQ.serial === null || theirQ.serial === null)
      throw new HttpError(409, "tokenize both tickets first (POST /tickets/tokenize at the provider), then ask again", { price: price.toString() });
    // Tokenizing locks both from starting until the swap can settle; without the lock, mine could start mid-trade.
    if (Math.min(mineQ.notBefore, theirQ.notBefore) < now() + SWAP_VALID_SECONDS)
      throw new HttpError(409, "the tickets aren't locked for a trade: tokenize them again (it's free once minted), then ask again", { price: price.toString() });
    const serial = mineQ.serial;
    const buyerSerial = theirQ.serial;

    // Ask consensus, not the provider or the Mirror Node, who holds each NFT.
    const [mine, theirs] = await Promise.all([slotInfo(client, p.tokenId, serial), slotInfo(client, p.tokenId, buyerSerial)]);
    if (mine.owner !== me.id || mine.meta.t !== ticket) {
      await unlist(key);
      throw new HttpError(410, "I no longer hold this ticket");
    }
    if (theirs.owner !== buyer || theirs.meta.t !== buyerTicket) throw new HttpError(403, `${buyer} does not hold ${p.name} ticket #${buyerTicket}`);
    const terms: SwapTerms = { tokenId: p.tokenId, seller: me.id, sellerSerial: serial, buyer, buyerSerial, price };
    if (!body.tx) {
      // x402-shaped quote. Payment isn't a separate transfer: it rides inside the swap transaction.
      const required: PaymentRequired = {
        x402Version: 2,
        resource: { url: `${opts.baseUrl}/offers/${provider}/${ticket}/swap`, description: `swap into ${p.name} ticket #${ticket}`, mimeType: "application/json" },
        accepts: [
          {
            scheme: "qy-atomic-swap",
            network: NETWORK,
            asset: HBAR,
            amount: price.toString(),
            payTo: me.id,
            maxTimeoutSeconds: SWAP_VALID_SECONDS,
            extra: { tokenId: p.tokenId, sellerTicket: ticket, buyerTicket, sellerSerial: serial, buyerSerial },
          },
        ],
      };
      return { status: 402, body: required, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required) } };
    }

    let tx;
    try {
      tx = checkSwap(Buffer.from(String(body.tx), "base64"), terms);
    } catch (e) {
      throw new HttpError(400, `rejected swap: ${(e as Error).message}`);
    }
    try {
      await (await (await tx.sign(parseKey(me.key))).execute(client)).getReceipt(client);
    } catch (e) {
      throw new HttpError(409, `swap did not settle: ${(e as Error).message}`);
    }
    const swapTx = tx.transactionId!.toString();
    delete state.slots[key];
    delete state.sizes[key];
    state.slots[slotKey(provider, buyerTicket)] = theirQ.startBy;
    state.sizes[slotKey(provider, buyerTicket)] = theirQ.maxTokens;
    await unlist(key);
    state.stats.sold++;
    addTo("earned", price);
    save();
    say(`SWAPPED ${p.name} ticket #${ticket} to ${names[buyer] ?? buyer} for ${price} tinybars, took #${buyerTicket} (starts within ${theirQ.startBy - now()}s): ${hashscan("transaction", swapTx)}`);

    // The trade already settled on Hedera; bookkeeping failures are logged, never returned as errors.
    const hcsSeq = await postEvent(client, p.topicId, me.id, me.key, { type: "trade", sellerTicket: ticket, buyerTicket, seller: me.id, buyer, price: price.toString(), swapTx }).catch(
      (e) => (say(`HCS: ${e.message}`), ""),
    );
    await writer
      .createEntity(Trade, { provider, seller_ticket: u64(ticket), buyer_ticket: u64(buyerTicket), price: u64(price), swap_tx: swapTx, hcs_seq: hcsSeq }, { expiration: ExpirationTime.fromDays(1) })
      .catch((e) => say(`Arkiv trade: ${e.message}`));
    return { body: { swapTx, hcsSeq, hashscan: hashscan("transaction", swapTx) } };
  }

  // ---- the user's side ----
  /** Book a task the user handed in. Throws an HttpError a server can return as is. */
  async function submitTask(spec: TaskSpec) {
    if (!spec.task || !spec.label) throw new HttpError(400, "task and label are required");
    const maxTokens = spec.maxTokens ?? 300;
    if (!Number.isInteger(spec.deadline) || spec.deadline < now() + 30) throw new HttpError(400, "deadline must be unix seconds at least 30s from now");
    if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new HttpError(400, "maxTokens must be a positive integer");
    const r = await startJob({ task: spec.task, input: spec.input ?? "", label: spec.label, maxTokens }, { deadline: spec.deadline, lateCost: spec.maxPay, minAsk: spec.minComp, fromUser: true });
    if ("error" in r) throw new HttpError(502, `could not book: ${r.error}`);
    const onItsOwn = r.start + r.slotSeconds + LOG_SLACK <= spec.deadline;
    return { ...r, deadline: spec.deadline, note: onItsOwn ? "its place in the queue meets the deadline" : "its place in the queue is too late; the agent will try to buy an earlier one" };
  }

  /** Every task the user handed in, newest first, with its status and, once delivered, the result. */
  function listTasks() {
    return Object.entries(state.jobs)
      .filter(([, j]) => j.fromUser)
      .map(([hash, j]) => ({
        jobHash: hash,
        provider: hub.known(j.provider)?.name ?? j.provider,
        label: j.label,
        deadline: j.deadline,
        createdAt: j.createdAt ?? null,
        status: j.status,
        slot: j.serial ?? null,
        onTime: j.met ?? null,
        result: opts.dir && j.file && existsSync(`${opts.dir}/${j.file}`) ? readFileSync(`${opts.dir}/${j.file}`, "utf8").split("\n").slice(4).join("\n").trim() : null,
      }))
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }

  // ---- main loop ----
  const stopTakingWorkAt = opts.minutes ? now() + Math.round(opts.minutes * 60) : Infinity;
  let nextRoutine = now() + Math.floor(Math.random() * Math.min(60, cfg.every)); // stagger agents
  let lastTriggered = 0;
  const TRIGGER_GAP = 60; // at most one event-driven job a minute
  let running = true;

  async function tick() {
    for (const { provider, ev } of toDeliver.splice(0)) await deliver(provider, ev).catch((e) => say(`delivery failed: ${e.message}`));

    if (now() >= stopTakingWorkAt) {
      // Draining: keep trading and delivering until every booked job has finished, then leave.
      const pending = open();
      if (!pending.length) return finish();
      // Queued work with no slot left to run in will never run: count it as failed rather than wait.
      // A slot stays in state.slots until its dispatch shows up on HCS, a few seconds after it starts.
      const awaitingDispatch = Object.values(state.slots).some((start) => start > now() - 120);
      if (!pending.some((j) => j.status === "running") && !awaitingDispatch) {
        for (const j of pending) j.status = "failed";
        state.stats.failed += pending.length;
        say(`${pending.length} queued job(s) have no slot left; counting them as failed`);
        return finish();
      }
      if (trading) await locked(buy);
      return;
    }

    let task: Task | null = null;
    if (triggers.length && now() - lastTriggered >= TRIGGER_GAP) {
      task = cfg.make(await market(), triggers.at(-1));
      triggers.length = 0;
      lastTriggered = now();
    } else if (cfg.every && now() >= nextRoutine) {
      task = cfg.make(await market());
      nextRoutine = now() + cfg.every;
    }
    if (task) await startJob(task);
    // After this job is booked (so it can't take the ticket meant for the next one): reserve for the
    // next routine job, due a little after it's made so it's attached before the ticket can start.
    if (task && cfg.reserveAhead && nextRoutine > now()) await reserveAhead(nextRoutine + 20, cfg.reserveAhead).catch((e) => say(`reserve failed: ${e.message}`));

    if (trading) {
      await locked(buy);
      await locked(reconcileListings);
    }
  }

  /** Take listings down and report the run's numbers. */
  async function finish() {
    running = false;
    await locked(async () => {
      for (const key of Object.keys(state.listings)) await unlist(key);
      save();
    });
    off();
    opts.onFinish?.(state.stats);
  }

  const loop = async () => {
    if (!running) return;
    await tick().catch((e) => say(`tick error: ${(e as Error).message}`));
    if (running) setTimeout(loop, 5000);
  };

  return {
    id: me.id,
    state,
    start: () => {
      say(`${me.id} ready: ${trading ? "trading" : "NOT trading (baseline)"}, endpoint ${opts.baseUrl}`);
      loop();
    },
    stop: () => {
      running = false;
      off();
    },
    swap,
    submitTask,
    listTasks,
    /** Jobs still open: the host waits for these before sweeping funds or stopping. */
    busy: () => open().length > 0 || Object.keys(state.slots).length > 0,
  };
}
export type Agent = Awaited<ReturnType<typeof createAgent>>;
