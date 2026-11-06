// Agent: a long-running worker with real jobs, in a market of many providers. Each job is a model
// call. The agent picks a provider per job from the live offers on Arkiv (like a Golem requestor
// choosing among Offers), books a slot there through x402, and when a job would miss its deadline it
// buys an earlier slot at that provider from another agent. Slots it can spare it offers for swaps.
//
//   pnpm agent --as AGENT_A --role urgent --port 4101 [--model smollm2:135m]
//   roles: assistant (user tasks only) | urgent (tight deadlines) | digest (loose) | report (medium)
import { ExpirationTime } from "@arkiv-network/sdk";
import { eq } from "@arkiv-network/sdk/query";
import { u64 } from "@arkiv-network/sdk/schema";
import type { PaymentRequired } from "@x402/core/types";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  CUTOFF_SECONDS,
  HBAR,
  HttpError,
  type Job,
  type LoggedEvent,
  MAX_INPUT_CHARS,
  MIRROR,
  NETWORK,
  type Res,
  SWAP_VALID_SECONDS,
  SlotOffer,
  type SwapTerms,
  Trade,
  accountEvm,
  arkivReader,
  arkivWriter,
  buildSwap,
  checkSwap,
  evmKey,
  findOffers,
  findProviders,
  hashscan,
  hbarPayer,
  hederaClient,
  jobHash,
  parseKey,
  postEvent,
  postPaid,
  readEvents,
  role,
  serve,
  sha256,
  signRequest,
  slotInfo,
  verifyRequest,
} from "@qy/shared";
import { askPrice, atRisk, buyPlan, feasible, latestReplacement, withinBudget, worthListing } from "./policy.js";
import { type Market, ROLES, type Task } from "./workloads.js";

const { values: o } = parseArgs({
  options: {
    as: { type: "string" }, // role prefix in .env, e.g. AGENT_A
    role: { type: "string" }, // assistant | urgent | digest | report
    port: { type: "string", default: "4100" }, // swap and task endpoint
    url: { type: "string" }, // base URL other machines use to reach this agent (default http://localhost:<port>)
    model: { type: "string" }, // only use providers running this model
    "no-trade": { type: "boolean", default: false }, // baseline: book and run jobs, never buy or sell
    "max-booking": { type: "string", default: "300000000" }, // x402 cap per booking (3 HBAR); pricier providers are skipped
    minutes: { type: "string" }, // stop taking new work after this long, finish what's booked, then exit
    fresh: { type: "boolean", default: false }, // forget saved state and stats (start of a fleet run)
  },
});
const cfg = ROLES[o.role ?? ""];
if (!o.as || !cfg) {
  console.error(`usage: agent --as AGENT_X --role ${Object.keys(ROLES).join("|")} [--port n] [--url http://host:port] [--model m] [--no-trade]`);
  process.exit(2);
}

const now = () => Math.floor(Date.now() / 1000);
const me = role(o.as);
const tag = `[${o.as.replace("AGENT_", "")}:${o.role}]`;
const say = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), tag, ...a);
const client = hederaClient(me.id, me.key);
const reader = arkivReader();
const writer = arkivWriter(evmKey(me.key));
const trading = !o["no-trade"];
const port = Number(o.port);
const baseUrl = o.url ?? `http://localhost:${port}`;
const maxBooking = BigInt(o["max-booking"]!);
const payer = hbarPayer(me.id, me.key, maxBooking);
const NOT_BEFORE = CUTOFF_SECONDS + SWAP_VALID_SECONDS; // a swap signed now must settle before the cutoff
const isAccount = (s: unknown): s is string => typeof s === "string" && /^0\.0\.\d+$/.test(s);

// Friendly names for agents in .env; providers are named by their own profiles.
const names: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  const m = k.match(/^AGENT_([A-Z0-9]+)_ID$/);
  if (m && v) names[v] = `Agent ${m[1]}`;
}

// ---- state, saved so a restart doesn't forget queued work, listings or providers in use ----
type Provider = { id: string; name: string; tokenId: string; topicId: string; bookingUrl: string; slot: number; model: string; price: string; nextFree: number };
type JobState = {
  provider: string;
  label: string;
  deadline: number;
  status: "queued" | "running" | "done" | "failed";
  serial?: number;
  lateCost?: string; // most the owner pays (tinybars) to move this job earlier
  minAsk?: string; // least the owner accepts (tinybars) to let this job wait
  fromUser?: boolean; // handed in through POST /tasks
  met?: boolean;
  file?: string; // delivered result, relative to the agent's data folder
};
type Listing = { key: `0x${string}`; latestOk: number; price: string };
type State = {
  v: 2;
  providers: Record<string, Provider>; // every provider this agent has worked with
  slots: Record<string, number>; // "provider:serial" -> start, slots held that haven't run
  jobs: Record<string, JobState>; // jobHash -> state
  listings: Record<string, Listing>; // "provider:serial" -> live Arkiv offer
  lastSeq: Record<string, number>; // HCS topic -> last sequence number read
  stats: { booked: number; met: number; late: number; failed: number; bought: number; sold: number; spent: string; earned: string; refunded?: string };
};
const DIR = fileURLToPath(new URL(`../../../data/agents/${o.as}`, import.meta.url));
const STATE_FILE = `${DIR}/state.json`;
mkdirSync(`${DIR}/outputs`, { recursive: true });
const loaded = existsSync(STATE_FILE) && !o.fresh ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : null;
const state: State =
  loaded?.v === 2 // earlier single-provider state can't be mapped onto providers: start clean
    ? loaded
    : { v: 2, providers: {}, slots: {}, jobs: {}, listings: {}, lastSeq: {}, stats: { booked: 0, met: 0, late: 0, failed: 0, bought: 0, sold: 0, spent: "0", earned: "0" } };
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
const addTo = (k: "spent" | "earned", v: bigint | string) => (state.stats[k] = (BigInt(state.stats[k]) + BigInt(v)).toString());
const slotKey = (provider: string, serial: number) => `${provider}:${serial}`;
const splitKey = (key: string) => {
  const [provider, serial] = key.split(":");
  return { provider, serial: Number(serial) };
};

// ---- the market of providers, discovered on Arkiv ----
const evmCache = new Map<string, Promise<string>>();
const evmOf = (id: string) => {
  if (!evmCache.has(id)) evmCache.set(id, accountEvm(id).catch(() => (evmCache.delete(id), "")));
  return evmCache.get(id)!;
};
/** Live providers, refreshed from Arkiv. Only profiles written by the provider's own key count. */
let live = new Map<string, Provider>();
async function refreshProviders() {
  const next = new Map<string, Provider>();
  for (const r of (await findProviders(reader, o.model)).entities) {
    const id = r.provider.value;
    if (!isAccount(id) || r.$owner.toLowerCase() !== (await evmOf(id))) continue; // someone posing as a provider
    const p: Provider = {
      id,
      name: r.name.value,
      tokenId: r.token_id.value,
      topicId: r.topic_id.value,
      bookingUrl: r.booking_url.value,
      slot: Number(r.slot_seconds.value),
      model: r.model.value,
      price: r.price_now.value.toString(),
      nextFree: Number(r.next_free.value),
    };
    next.set(id, p);
    names[id] = p.name;
  }
  live = next;
}
const known = (id: string) => live.get(id) ?? state.providers[id];

/** Providers in order of preference: cheapest that can still meet the deadline, then soonest free. */
function rankProviders(deadline: number): Provider[] {
  const affordable = [...live.values()].filter((p) => BigInt(p.price) <= maxBooking);
  const byPrice = (a: Provider, b: Provider) => Number(BigInt(a.price) - BigInt(b.price));
  const inTime = affordable.filter((p) => p.nextFree + p.slot <= deadline).sort(byPrice);
  const late = affordable.filter((p) => !inTime.includes(p)).sort((a, b) => a.nextFree - b.nextFree || byPrice(a, b));
  return [...inTime, ...late];
}

await refreshProviders();
if (!live.size) throw new Error(`no live providers on Arkiv${o.model ? ` running ${o.model}` : ""}; start one with pnpm provider`);
say(`market: ${[...live.values()].map((p) => `${p.name} (${p.model}, ${Number(p.price) / 1e8} HBAR)`).join(", ")}`);

if (o.fresh) {
  // Starting over: jobs an earlier run left queued would take this run's slots.
  for (const p of live.values()) {
    const cleared = await postPaid(`${p.bookingUrl}/jobs/clear`, signRequest("clear", me.id, me.key, "all")).catch(() => null);
    if (cleared?.body?.cleared) say(`cleared ${cleared.body.cleared} job(s) left queued at ${p.name}`);
  }
}

/** One provider's upcoming slots and pending deadlines: the inputs to every decision there. */
function schedule(provider: string) {
  const slots = Object.entries(state.slots)
    .map(([key, start]) => ({ ...splitKey(key), start }))
    .filter((s) => s.provider === provider && s.start > now());
  const deadlines = Object.values(state.jobs)
    .filter((j) => j.provider === provider && j.status === "queued")
    .map((j) => j.deadline);
  return { slots, starts: slots.map((s) => s.start), deadlines };
}
const queuedAt = (provider: string) => Object.values(state.jobs).filter((j) => j.provider === provider && j.status === "queued");
const activeProviders = () => new Set([...Object.keys(state.slots).map((k) => splitKey(k).provider), ...Object.values(state.jobs).filter((j) => j.status === "queued" || j.status === "running").map((j) => j.provider)]);

/** Budget for buying an earlier slot: the most any at-risk job's owner will pay to be on time. */
function buyBudget(provider: string, starts: number[], deadlines: number[]) {
  const risky = new Set(atRisk(starts, deadlines, known(provider).slot));
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

// ---- the logs: what ran, what finished, what's worth an alert (one HCS topic per provider) ----
let history: LoggedEvent[] = [];
const triggers: LoggedEvent[] = [];
const toDeliver: { provider: string; ev: LoggedEvent }[] = [];

async function pollLogs() {
  for (const id of new Set([...live.keys(), ...activeProviders()])) {
    const p = known(id);
    if (!p) continue;
    if (state.lastSeq[p.topicId] === undefined) {
      // First look at this provider: take recent history as context, act only on what comes next.
      const latest = Number(((await (await fetch(`${MIRROR}/topics/${p.topicId}/messages?order=desc&limit=1`)).json()) as any).messages[0]?.sequence_number ?? 0);
      history.push(...(await readEvents(p.topicId, Math.max(0, latest - 50))));
      state.lastSeq[p.topicId] = latest;
      continue;
    }
    for (const ev of await readEvents(p.topicId, state.lastSeq[p.topicId])) {
      history.push(ev);
      state.lastSeq[p.topicId] = ev.seq;
      handle(p.id, ev);
    }
  }
  history = history.sort((a, b) => a.ts - b.ts).slice(-300);
  save();
}

function handle(provider: string, ev: LoggedEvent) {
  if (cfg.trigger?.(ev, me.id)) triggers.push(ev);
  const e = ev.e;
  if (ev.by !== provider) return; // only the provider's own signed messages say what ran
  if (e.type === "refund" && e.buyer === me.id) {
    state.stats.refunded = (BigInt(state.stats.refunded ?? "0") + BigInt(e.amount)).toString();
    return say(`refunded ${e.amount} tinybars by ${known(provider).name}: ${e.reason}`);
  }
  if ((e.type !== "dispatch" && e.type !== "done" && e.type !== "expired") || e.owner !== me.id) return;
  if (e.type === "expired") {
    const job = state.jobs[e.jobHash];
    if (job?.status === "queued") {
      job.status = "failed";
      state.stats.failed++;
      say(`job "${job.label}" expired unrun`);
    }
  } else if (e.type === "dispatch") {
    delete state.slots[slotKey(provider, e.serial)];
    const job = e.jobHash ? state.jobs[e.jobHash] : undefined;
    if (job) Object.assign(job, { status: "running", serial: e.serial });
  } else if (state.jobs[e.jobHash]) {
    if (e.ok) toDeliver.push({ provider, ev });
    else {
      Object.assign(state.jobs[e.jobHash], { status: "failed" });
      state.stats.failed++;
      say(`job "${state.jobs[e.jobHash].label}" failed in ${known(provider).name} slot #${e.serial}: ${e.result}`);
    }
  }
}

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
  const file = `${DIR}/outputs/${new Date(done.ts * 1000).toISOString().replace(/[:.]/g, "-")}-${job.label.replace(/[^a-z0-9]+/gi, "-")}.md`;
  writeFileSync(
    file,
    `# ${job.label}\n\nRan on ${p.name} in slot #${done.e.serial}, finished ${new Date(done.ts * 1000).toISOString()}, ` +
      `deadline ${new Date(job.deadline * 1000).toISOString()} (${met ? "on time" : `late by ${done.ts - job.deadline}s`}). ` +
      `${res.body.tokens} tokens from ${res.body.model}. Result sha256 ${done.e.resultHash}, checked against HCS.\n\n${res.body.text}\n`,
  );
  await locked(async () => {
    Object.assign(job, { status: "done", met, file: file.slice(DIR.length + 1) });
    if (met) state.stats.met++;
    else state.stats.late++;
    save();
  });
  say(`${met ? "ON TIME" : "LATE"} "${job.label}" (${p.name} #${done.e.serial}) -> ${file.slice(DIR.length + 1)}`);
  await postEvent(client, p.topicId, me.id, me.key, {
    type: "delivered",
    jobHash: hash,
    serial: done.e.serial,
    label: job.label,
    deadline: job.deadline,
    finishedAt: done.ts,
    met,
  }).catch((e) => say("HCS delivered:", e.message));
}

// ---- new work ----
async function market(): Promise<Market> {
  const rows = (await reader.select().from(SlotOffer).limit(100).fetch()).entities;
  const offers = rows.map((r) => ({
    serial: Number(r.slot_serial.value),
    start: Number(r.slot_start.value),
    latestOk: Number(r.latest_ok_start.value),
    price: r.min_price.value,
    seller: r.seller.value,
  }));
  return { me: me.id, names, events: history, offers: offers.filter((x) => x.start > now()) };
}

type Terms = { deadline?: number; lateCost?: bigint; minAsk?: bigint; fromUser?: boolean };

/** Pick a provider and book a slot there for a task. Returns the booking, or an error message. */
async function startJob(t: Task, terms: Terms = {}) {
  const deadline = terms.deadline ?? now() + cfg.deadlineIn;
  const job: Job = { kind: "llm", task: t.task, input: t.input.slice(-MAX_INPUT_CHARS), maxTokens: t.maxTokens, deadline, label: t.label };
  const hash = jobHash(job);
  const request = { job, ...signRequest("book", me.id, me.key, hash) };
  // Arkiv profiles are up to a refresh old, so ask the top candidates for a live quote (an unpaid
  // /book answers 402 with today's price and next free start) and book the best, like Golem's
  // negotiation step. A provider that doesn't answer has gone offline before its offer expired.
  const quoted = (
    await Promise.all(
      rankProviders(deadline)
        .slice(0, 3)
        .map(async (c) => {
          const q = await postPaid(`${c.bookingUrl}/book`, request, undefined, 0, 5000).catch(() => null);
          return q?.status === 402 && q.body.price ? { ...c, price: String(q.body.price), nextFree: Number(q.body.nextFree ?? c.nextFree) } : null;
        }),
    )
  ).filter((c): c is Provider => !!c && BigInt(c.price) <= maxBooking);
  const byPrice = (a: Provider, b: Provider) => Number(BigInt(a.price) - BigInt(b.price));
  // If no provider can start in time on its own, go where an earlier slot is already on offer for a
  // swap: slots only trade within one provider, so that's the only place a late booking can be fixed.
  const budget = terms.lateCost ?? cfg.lateCost;
  const swappable = async (c: Provider) =>
    trading &&
    (await findOffers(reader, c.id, { myStart: c.nextFree, myLatest: deadline - c.slot, notBefore: now() + NOT_BEFORE + 15, budget }))
      .entities.some((r) => r.seller.value !== me.id);
  const late = quoted.filter((c) => c.nextFree + c.slot > deadline);
  const rescue = new Set<string>();
  for (const c of late) if (await swappable(c).catch(() => false)) rescue.add(c.id);
  const ranked = [
    ...quoted.filter((c) => c.nextFree + c.slot <= deadline).sort(byPrice),
    ...late.filter((c) => rescue.has(c.id)).sort(byPrice),
    ...late.filter((c) => !rescue.has(c.id)).sort((a, b) => a.nextFree - b.nextFree || byPrice(a, b)),
  ];
  if (rescue.size) say(`no provider can start "${t.label}" in time; ${[...rescue].map((id) => known(id).name).join(", ")} has an earlier slot on offer`);
  let p: Provider | undefined;
  let booked: { status: number; body: any } = { status: 0, body: { error: `no live provider quoted within ${maxBooking} tinybars` } };
  for (p of ranked) {
    booked = await postPaid(`${p.bookingUrl}/book`, { job, ...signRequest("book", me.id, me.key, hash) }, payer).catch((e) => ({ status: 0, body: { error: e.message } }));
    if (booked.status === 200) break;
    say(`could not book "${t.label}" at ${p.name}: ${booked.status} ${booked.body.error}`);
  }
  if (booked.status !== 200 || !p) return { error: String(booked.body.error) };
  const { serial, start, price } = booked.body as { serial: number; start: number; price: string };
  await locked(async () => {
    state.providers[p.id] = p;
    state.slots[slotKey(p.id, serial)] = start;
    state.jobs[hash] = {
      provider: p.id,
      label: t.label,
      deadline: job.deadline,
      status: "queued",
      lateCost: (terms.lateCost ?? cfg.lateCost).toString(),
      minAsk: (terms.minAsk ?? cfg.minAsk).toString(),
      fromUser: terms.fromUser,
    };
    state.stats.booked++;
    addTo("spent", price);
    save();
  });
  const fits = start + p.slot <= job.deadline;
  say(`booked ${p.name} #${serial} (${p.model}) for "${t.label}" at ${price} tinybars, starts in ${start - now()}s, due in ${job.deadline - now()}s${fits ? "" : " (too late on its own)"}`);
  return { provider: p.id, providerName: p.name, jobHash: hash, serial, start, price, slotSeconds: p.slot };
}

// ---- buying: behind schedule at a provider, swap the latest slot there for an earlier one ----
const lastShortfall = new Map<string, number>();
async function buy() {
  for (const provider of activeProviders()) {
    const p = known(provider);
    if (!p) continue;
    const { slots, starts, deadlines } = schedule(provider);
    const plan = buyPlan(starts, deadlines, p.slot);
    if (!plan) continue;
    const give = slots.find((s) => s.start === plan.giveStart)!;
    if (give.start < now() + CUTOFF_SECONDS || plan.latestStart < now() + NOT_BEFORE) continue; // too late to trade
    const budget = buyBudget(provider, starts, deadlines);
    if (!budget) continue;
    const { entities } = await findOffers(reader, provider, { myStart: give.start, myLatest: plan.latestStart, notBefore: now() + NOT_BEFORE, budget });
    const candidates = entities.filter((r) => r.seller.value !== me.id);
    let bought = false;
    for (const row of candidates) {
      try {
        const { sellerSerial, start, price, swapTx } = await take(p, row, give.serial, plan.latestStart, budget);
        delete state.slots[slotKey(provider, give.serial)];
        state.slots[slotKey(provider, sellerSerial)] = start;
        await unlist(slotKey(provider, give.serial));
        state.stats.bought++;
        addTo("spent", price);
        save();
        say(`BOUGHT ${p.name} #${sellerSerial} (starts in ${start - now()}s) from ${names[row.seller.value] ?? row.seller.value} for ${price} tinybars, gave #${give.serial}: ${hashscan("transaction", swapTx)}`);
        bought = true;
        break;
      } catch (e) {
        say(`skipped offer ${p.name} #${row.slot_serial.value}: ${(e as Error).message}`);
      }
    }
    // Say it once per shortfall, not every tick.
    if (!bought && !candidates.length && lastShortfall.get(provider) !== plan.latestStart) {
      lastShortfall.set(provider, plan.latestStart);
      say(`behind schedule at ${p.name}: need a slot starting by ${plan.latestStart - now()}s from now, none offered within ${budget} tinybars`);
    }
  }
}

async function take(p: Provider, row: Awaited<ReturnType<typeof findOffers>>["entities"][number], giveSerial: number, latestStart: number, budget: bigint) {
  const seller = row.seller.value;
  const endpoint = row.endpoint.value;
  const sellerSerial = Number(row.slot_serial.value);
  // Arkiv rows are claims: check who wrote it and what Hedera says before signing anything.
  if (row.$owner.toLowerCase() !== (await evmOf(seller))) throw new Error("offer was not written by the seller it names");
  const slot = await slotInfo(client, p.tokenId, sellerSerial);
  if (slot.owner !== seller) throw new Error("seller no longer holds it");
  if (slot.meta.s !== Number(row.slot_start.value) || slot.meta.s > latestStart) throw new Error("slot start on Hedera doesn't match the offer");

  const ask = await postPaid(endpoint, { buyer: me.id, buyerSerial: giveSerial });
  if (ask.status !== 402) throw new Error(`seller refused (${ask.status}): ${ask.body.error}`);
  const quote = ask.body.accepts?.[0];
  if (quote?.scheme !== "qy-atomic-swap" || quote.payTo !== seller || quote.extra?.sellerSerial !== sellerSerial || quote.extra?.tokenId !== p.tokenId)
    throw new Error("seller quoted different terms");
  const price = BigInt(quote.amount);
  if (!withinBudget(price, budget)) throw new Error(`price ${price} over budget ${budget}`);

  const tx = await buildSwap(client, { tokenId: p.tokenId, seller, sellerSerial, buyer: me.id, buyerSerial: giveSerial, price }).sign(parseKey(me.key));
  const res = await postPaid(endpoint, { buyer: me.id, buyerSerial: giveSerial, tx: Buffer.from(tx.toBytes()).toString("base64") });
  if (res.status !== 200) throw new Error(`swap failed (${res.status}): ${res.body.error}`);
  return { sellerSerial, start: slot.meta.s, price: price.toString(), swapTx: res.body.swapTx as string };
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
    const p = known(provider);
    if (!p) continue;
    const { slots, starts, deadlines } = schedule(provider);
    slots.forEach((s, i) => {
      if (s.start < now() + NOT_BEFORE + 5) return; // a buyer couldn't settle in time
      const latest = latestReplacement(starts, deadlines, i, p.slot);
      if (latest === null) return;
      const latestOk = Math.min(latest, now() + 3600); // spare slot: accepts anything this hour
      const slack = latestOk - s.start;
      if (!worthListing(slack, p.slot)) return;
      want.set(slotKey(provider, s.serial), { key: "0x", latestOk, price: askPrice(slack, askFloor(provider), p.slot).toString(), start: s.start, provider, serial: s.serial });
    });
  }
  for (const [key, l] of Object.entries(state.listings)) {
    const w = want.get(key);
    // Re-list only on a real change, Arkiv writes aren't free.
    if (!w || w.price !== l.price || Math.abs(w.latestOk - l.latestOk) >= known(w.provider).slot) await unlist(key);
    else want.delete(key);
  }
  for (const [key, w] of want) {
    const { entityKey } = await writer.createEntity(
      SlotOffer,
      {
        provider: w.provider,
        slot_serial: u64(w.serial),
        slot_start: u64(w.start),
        latest_ok_start: u64(w.latestOk),
        min_price: u64(BigInt(w.price)),
        seller: me.id,
        endpoint: `${baseUrl}/offers/${w.provider}/${w.serial}/swap`,
        job_hash: "",
      },
      { expiration: ExpirationTime.atDate(new Date((w.start - CUTOFF_SECONDS) * 1000)) },
    );
    state.listings[key] = { key: entityKey, latestOk: w.latestOk, price: w.price };
    say(`offered ${known(w.provider).name} #${w.serial} (starts in ${w.start - now()}s) for ${w.price} tinybars, swaps into slots up to ${w.latestOk - now()}s from now`);
  }
  save();
}

// ---- endpoints: swaps from other agents, tasks and results for this agent's user ----
await serve(port, {
  // Busy agents answer at once instead of queueing the buyer: two agents buying from each other
  // at the same moment would otherwise each wait on the other forever.
  "POST /offers/:provider/:serial/swap": async ({ params, body }) => {
    if (inFlight) throw new HttpError(409, "busy, try again shortly");
    return locked(() => swap(params.provider, Number(params.serial), body));
  },
  "POST /tasks": ({ body }) => acceptTask(body),
  "POST /tasks/list": ({ body }) => listTasks(body),
});

/** Only this agent's own account (its user holds the key) may give it work or read its results. */
async function owner(action: string, subject: string, body: any) {
  let account;
  try {
    account = await verifyRequest(action, subject, body ?? {});
  } catch (e) {
    throw new HttpError(401, (e as Error).message);
  }
  if (account !== me.id) throw new HttpError(403, "only this agent's own account can do that");
}

const tinybars = (x: unknown, name: string) => {
  if (typeof x !== "string" || !/^\d{1,15}$/.test(x)) throw new HttpError(400, `${name} must be tinybars as a digit string`);
  return BigInt(x);
};

/**
 * Body: { spec: { task, input?, label, deadline (unix s), maxTokens?, maxPay, minComp }, account, ts, sig }
 * signed over sha256(JSON of spec). maxPay: most to pay to run earlier; minComp: least to accept to wait.
 */
async function acceptTask(body: any): Promise<Res> {
  const spec = body?.spec;
  await owner("task", sha256(JSON.stringify(spec ?? null)), body);
  if (typeof spec.task !== "string" || !spec.task || typeof spec.label !== "string" || !spec.label) throw new HttpError(400, "task and label are required");
  if (spec.input !== undefined && typeof spec.input !== "string") throw new HttpError(400, "input must be text");
  const maxTokens = spec.maxTokens ?? 300;
  if (!Number.isInteger(spec.deadline) || spec.deadline < now() + 30) throw new HttpError(400, "deadline must be unix seconds at least 30s from now");
  if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new HttpError(400, "maxTokens must be a positive integer");
  const terms = { deadline: spec.deadline, lateCost: tinybars(spec.maxPay, "maxPay"), minAsk: tinybars(spec.minComp, "minComp"), fromUser: true };
  const r = await startJob({ task: spec.task, input: spec.input ?? "", label: spec.label, maxTokens }, terms);
  if ("error" in r) throw new HttpError(502, `could not book: ${r.error}`);
  const onItsOwn = r.start + r.slotSeconds <= spec.deadline;
  return { body: { ...r, deadline: spec.deadline, note: onItsOwn ? "its own slot meets the deadline" : "its own slot is too late; the agent will try to buy an earlier one" } };
}

/** Every task the user handed in, with its status and, once delivered, the checked result. */
async function listTasks(body: any): Promise<Res> {
  await owner("tasks", "list", body);
  const tasks = Object.entries(state.jobs)
    .filter(([, j]) => j.fromUser)
    .map(([hash, j]) => ({
      jobHash: hash,
      provider: known(j.provider)?.name ?? j.provider,
      label: j.label,
      deadline: j.deadline,
      status: j.status,
      slot: j.serial ?? null,
      onTime: j.met ?? null,
      result: j.file ? readFileSync(`${DIR}/${j.file}`, "utf8") : null,
    }));
  return { body: { agent: me.id, tasks } };
}

async function swap(provider: string, serial: number, body: any): Promise<Res> {
  const key = slotKey(provider, serial);
  const listing = state.listings[key];
  const start = state.slots[key];
  const p = known(provider);
  if (!trading || !listing || start === undefined || !p) throw new HttpError(410, "offer no longer available");
  if (now() > start - CUTOFF_SECONDS) throw new HttpError(410, "my slot starts too soon to trade");
  const buyer = String(body?.buyer ?? "");
  const buyerSerial = Number(body?.buyerSerial);
  if (!isAccount(buyer) || !Number.isInteger(buyerSerial)) throw new HttpError(400, "need buyer and buyerSerial");

  // Ask consensus, not Arkiv or the Mirror Node: who holds what, and when the buyer's slot runs.
  const [mine, theirs] = await Promise.all([slotInfo(client, p.tokenId, serial), slotInfo(client, p.tokenId, buyerSerial)]);
  if (mine.owner !== me.id) {
    await unlist(key);
    throw new HttpError(410, "I no longer hold this slot");
  }
  if (theirs.owner !== buyer) throw new HttpError(403, `${buyer} does not hold ${p.name} slot #${buyerSerial}`);
  if (theirs.meta.s < now() + CUTOFF_SECONDS) throw new HttpError(422, `slot #${buyerSerial} starts too soon to trade`);
  // Re-check against today's jobs, not the listing: new work may have arrived since it was written.
  const { slots, deadlines } = schedule(provider);
  const after = slots.map((s) => (s.serial === serial ? theirs.meta.s : s.start));
  if (!feasible(after, deadlines, p.slot)) throw new HttpError(422, `slot #${buyerSerial} (starts ${theirs.meta.s}) would make me miss a deadline`);

  const price = BigInt(listing.price);
  const terms: SwapTerms = { tokenId: p.tokenId, seller: me.id, sellerSerial: serial, buyer, buyerSerial, price };
  if (!body.tx) {
    // x402-shaped quote. Payment isn't a separate transfer: it rides inside the swap transaction.
    const required: PaymentRequired = {
      x402Version: 2,
      resource: { url: `${baseUrl}/offers/${provider}/${serial}/swap`, description: `swap into ${p.name} slot #${serial}`, mimeType: "application/json" },
      accepts: [
        { scheme: "qy-atomic-swap", network: NETWORK, asset: HBAR, amount: price.toString(), payTo: me.id, maxTimeoutSeconds: SWAP_VALID_SECONDS, extra: { tokenId: p.tokenId, sellerSerial: serial, buyerSerial } },
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
  state.slots[slotKey(provider, buyerSerial)] = theirs.meta.s;
  await unlist(key);
  state.stats.sold++;
  addTo("earned", price);
  save();
  say(`SWAPPED ${p.name} #${serial} to ${names[buyer] ?? buyer} for ${price} tinybars, took #${buyerSerial} (starts in ${theirs.meta.s - now()}s): ${hashscan("transaction", swapTx)}`);

  // The trade already settled on Hedera; bookkeeping failures are logged, never returned as errors.
  const hcsSeq = await postEvent(client, p.topicId, me.id, me.key, { type: "trade", sellerSerial: serial, buyerSerial, seller: me.id, buyer, price: price.toString(), swapTx }).catch(
    (e) => (say("HCS:", e.message), ""),
  );
  await writer
    .createEntity(
      Trade,
      { provider, seller_serial: u64(serial), buyer_serial: u64(buyerSerial), price: u64(price), swap_tx: swapTx, hcs_seq: hcsSeq },
      { expiration: ExpirationTime.fromDays(1) },
    )
    .catch((e) => say("Arkiv trade:", e.message));
  return { body: { swapTx, hcsSeq, hashscan: hashscan("transaction", swapTx) } };
}

// ---- main loop ----
const stopTakingWorkAt = o.minutes ? now() + Math.round(Number(o.minutes) * 60) : Infinity;
let nextRoutine = now() + Math.floor(Math.random() * Math.min(60, cfg.every)); // stagger agents
let lastTriggered = 0;
let lastProviderRefresh = now();
const TRIGGER_GAP = 60; // at most one event-driven job a minute

async function tick() {
  if (now() - lastProviderRefresh >= 30) {
    lastProviderRefresh = now();
    await refreshProviders().catch((e) => say("provider refresh failed:", e.message));
  }
  await locked(pollLogs);
  for (const { provider, ev } of toDeliver.splice(0)) await deliver(provider, ev).catch((e) => say("delivery failed:", e.message));

  if (now() >= stopTakingWorkAt) {
    // Draining: keep trading and delivering until every booked job has finished, then leave.
    const open = Object.values(state.jobs).filter((j) => j.status === "queued" || j.status === "running");
    if (!open.length) return finish();
    // Queued work with no slot left to run in will never run: count it as failed rather than wait.
    // A slot stays in state.slots until its dispatch shows up on HCS, a few seconds after it starts.
    const awaitingDispatch = Object.values(state.slots).some((start) => start > now() - 120);
    if (!open.some((j) => j.status === "running") && !awaitingDispatch) {
      for (const j of open) j.status = "failed";
      state.stats.failed += open.length;
      say(`${open.length} queued job(s) have no slot left; counting them as failed`);
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

  if (trading) {
    await locked(buy);
    await locked(reconcileListings);
  }
}

say(`${me.id} ready: ${trading ? "trading" : "NOT trading (baseline)"}, endpoint ${baseUrl}, outputs in data/agents/${o.as}/outputs`);
const loop = async () => {
  await tick().catch((e) => say("tick error:", (e as Error).message));
  setTimeout(loop, 5000);
};
loop();

/** Take listings down and print the run's numbers on one parseable line. */
async function finish() {
  await locked(async () => {
    for (const key of Object.keys(state.listings)) await unlist(key);
    save();
  });
  stop();
}
function stop() {
  console.log(`STATS ${JSON.stringify({ as: o.as, role: o.role, trading, ...state.stats })}`);
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
