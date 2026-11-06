// Agent: a long-running worker with real jobs. Each job is a report about QueueYield's live market,
// run as a model call in a GPU slot it booked from the provider (paid through x402). When a job
// would miss its deadline it buys an earlier slot on Arkiv; slots it can spare it lists for sale.
//
//   pnpm agent --as AGENT_A --role urgent --port 4101
//   roles: urgent (tight deadlines, buys) | digest (loose, sells) | report (medium)
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
  ProviderProfile,
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
  hashscan,
  hbarPayer,
  hederaClient,
  jobHash,
  need,
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
    role: { type: "string" }, // urgent | digest | report
    port: { type: "string", default: "4100" }, // swap endpoint
    url: { type: "string" }, // public base URL of the swap endpoint (default http://localhost:<port>)
    "no-trade": { type: "boolean", default: false }, // baseline: book and run jobs, never buy or sell
    "max-booking": { type: "string", default: "300000000" }, // x402 cap per booking (3 HBAR); pricier slots are skipped
    minutes: { type: "string" }, // stop taking new work after this long, finish what's booked, then exit
    fresh: { type: "boolean", default: false }, // forget saved state and stats (start of a fleet run)
  },
});
const cfg = ROLES[o.role ?? ""];
if (!o.as || !cfg) {
  console.error(`usage: agent --as AGENT_X --role ${Object.keys(ROLES).join("|")} [--port n] [--no-trade]`);
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
const payer = hbarPayer(me.id, me.key, BigInt(o["max-booking"]!));

// Friendly names for every agent in .env, used in reports and logs.
const names: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  const m = k.match(/^AGENT_([A-Z0-9]+)_ID$/);
  if (m && v) names[v] = `Agent ${m[1]}`;
}

// ---- provider, discovered on Arkiv; only a profile written by the provider's own key counts ----
const providerId = need("PROVIDER_ID");
names[providerId] = "Provider";
const profile = (
  await reader.select().from(ProviderProfile).where(eq("provider", providerId)).ownedBy((await accountEvm(providerId)) as `0x${string}`).limit(1).fetch()
).entities[0];
if (!profile) throw new Error(`no provider profile for ${providerId} on Arkiv; is the provider running?`);
const tokenId = profile.token_id.value;
const topicId = profile.topic_id.value;
const bookingUrl = profile.booking_url.value;
const SLOT = Number(profile.slot_seconds.value);
const NOT_BEFORE = CUTOFF_SECONDS + SWAP_VALID_SECONDS; // a swap signed now must settle before the cutoff

// ---- state, saved so a restart doesn't forget queued work or listings ----
type JobState = {
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
  slots: Record<string, number>; // serial -> start, slots this agent holds that haven't run
  jobs: Record<string, JobState>; // jobHash -> state
  listings: Record<string, Listing>; // serial -> live Arkiv offer
  lastSeq: number;
  stats: { booked: number; met: number; late: number; failed: number; bought: number; sold: number; spent: string; earned: string; refunded?: string };
};
const DIR = fileURLToPath(new URL(`../../../data/agents/${o.as}`, import.meta.url));
const STATE_FILE = `${DIR}/state.json`;
mkdirSync(`${DIR}/outputs`, { recursive: true });
const state: State = existsSync(STATE_FILE) && !o.fresh
  ? JSON.parse(readFileSync(STATE_FILE, "utf8"))
  : { slots: {}, jobs: {}, listings: {}, lastSeq: -1, stats: { booked: 0, met: 0, late: 0, failed: 0, bought: 0, sold: 0, spent: "0", earned: "0" } };
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
if (o.fresh) {
  // Starting over: jobs an earlier run left queued at the provider would take this run's slots.
  const cleared = await postPaid(`${bookingUrl}/jobs/clear`, signRequest("clear", me.id, me.key, "all"));
  if (cleared.status !== 200) throw new Error(`could not clear old jobs: ${cleared.status} ${cleared.body.error}`);
  if (cleared.body.cleared) say(`cleared ${cleared.body.cleared} job(s) left queued by an earlier run`);
}
const addTo = (k: "spent" | "earned", v: bigint | string) => (state.stats[k] = (BigInt(state.stats[k]) + BigInt(v)).toString());

/** Upcoming slots and the deadlines of jobs that haven't started: the inputs to every decision. */
function schedule() {
  const slots = Object.entries(state.slots)
    .map(([serial, start]) => ({ serial: Number(serial), start }))
    .filter((s) => s.start > now());
  const deadlines = Object.values(state.jobs)
    .filter((j) => j.status === "queued")
    .map((j) => j.deadline);
  return { slots, starts: slots.map((s) => s.start), deadlines };
}

const queued = () => Object.values(state.jobs).filter((j) => j.status === "queued");
/** Budget for buying an earlier slot: the most any at-risk job's owner will pay to be on time. */
function buyBudget(starts: number[], deadlines: number[]) {
  const risky = new Set(atRisk(starts, deadlines, SLOT));
  return queued()
    .filter((j) => risky.has(j.deadline))
    .reduce((m, j) => (BigInt(j.lateCost ?? cfg.lateCost) > m ? BigInt(j.lateCost ?? cfg.lateCost) : m), 0n);
}
/** Least this agent asks to wait: the highest minimum any of its waiting jobs' owners set. */
function askFloor() {
  return queued().reduce((m, j) => (BigInt(j.minAsk ?? cfg.minAsk) > m ? BigInt(j.minAsk ?? cfg.minAsk) : m), cfg.minAsk);
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

// ---- the log: what ran, what finished, what's worth an alert ----
let history: LoggedEvent[] = [];
const triggers: LoggedEvent[] = [];
const toDeliver: LoggedEvent[] = [];

if (state.lastSeq < 0) {
  const latest = Number(((await (await fetch(`${MIRROR}/topics/${topicId}/messages?order=desc&limit=1`)).json()) as any).messages[0]?.sequence_number ?? 0);
  history = await readEvents(topicId, Math.max(0, latest - 100)); // context for the first reports
  state.lastSeq = latest; // start fresh: older events were before this agent existed
  save();
}

async function pollLog() {
  const events = await readEvents(topicId, state.lastSeq);
  for (const ev of events) {
    history.push(ev);
    state.lastSeq = ev.seq;
    if (cfg.trigger?.(ev, me.id)) triggers.push(ev);
    const e = ev.e;
    if (ev.by === providerId && e.type === "refund" && e.buyer === me.id) {
      state.stats.refunded = (BigInt(state.stats.refunded ?? "0") + BigInt(e.amount)).toString();
      say(`refunded ${e.amount} tinybars: ${e.reason}`);
    }
    // Only the provider's own signed messages say what ran.
    if (ev.by !== providerId || (e.type !== "dispatch" && e.type !== "done" && e.type !== "expired") || e.owner !== me.id) continue;
    if (e.type === "expired") {
      const job = state.jobs[e.jobHash];
      if (job?.status === "queued") {
        job.status = "failed";
        state.stats.failed++;
        say(`job "${job.label}" expired unrun`);
      }
      continue;
    }
    if (e.type === "dispatch") {
      delete state.slots[e.serial];
      const job = e.jobHash ? state.jobs[e.jobHash] : undefined;
      if (job) Object.assign(job, { status: "running", serial: e.serial });
    } else if (state.jobs[e.jobHash]) {
      if (e.ok) toDeliver.push(ev);
      else {
        Object.assign(state.jobs[e.jobHash], { status: "failed" });
        state.stats.failed++;
        say(`job "${state.jobs[e.jobHash].label}" failed in slot #${e.serial}: ${e.result}`);
      }
    }
  }
  history = history.slice(-300);
  save();
}

/** Fetch a finished job's result, check it against the hash the provider logged, and keep it. */
async function deliver(done: LoggedEvent) {
  if (done.e.type !== "done") return;
  const hash = done.e.jobHash;
  const job = state.jobs[hash];
  const res = await postPaid(`${bookingUrl}/results`, { jobHash: hash, ...signRequest("result", me.id, me.key, hash) });
  if (res.status !== 200) throw new Error(`result for "${job.label}": ${res.status} ${res.body.error}`);
  if (sha256(res.body.text) !== done.e.resultHash) throw new Error(`result for "${job.label}" doesn't match the hash on HCS`);

  const met = done.ts <= job.deadline;
  const file = `${DIR}/outputs/${new Date(done.ts * 1000).toISOString().replace(/[:.]/g, "-")}-${job.label.replace(/[^a-z0-9]+/gi, "-")}.md`;
  writeFileSync(
    file,
    `# ${job.label}\n\nRan in slot #${done.e.serial}, finished ${new Date(done.ts * 1000).toISOString()}, ` +
      `deadline ${new Date(job.deadline * 1000).toISOString()} (${met ? "on time" : `late by ${done.ts - job.deadline}s`}). ` +
      `${res.body.tokens} tokens from ${res.body.model}. Result sha256 ${done.e.resultHash}, checked against HCS.\n\n${res.body.text}\n`,
  );
  await locked(async () => {
    Object.assign(job, { status: "done", met, file: file.slice(DIR.length + 1) });
    if (met) state.stats.met++;
    else state.stats.late++;
    save();
  });
  say(`${met ? "ON TIME" : "LATE"} "${job.label}" (slot #${done.e.serial}) -> ${file.slice(DIR.length + 1)}`);
  await postEvent(client, topicId, me.id, me.key, {
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
  const rows = (await reader.select().from(SlotOffer).where(eq("provider", providerId)).limit(50).fetch()).entities;
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

/** Book a slot for a task. Returns the booking, or an error message if the provider refused. */
async function startJob(t: Task, terms: Terms = {}) {
  const deadline = terms.deadline ?? now() + cfg.deadlineIn;
  const job: Job = { kind: "llm", task: t.task, input: t.input.slice(-MAX_INPUT_CHARS), maxTokens: t.maxTokens, deadline, label: t.label };
  const hash = jobHash(job);
  const booked = await postPaid(`${bookingUrl}/book`, { job, ...signRequest("book", me.id, me.key, hash) }, payer);
  if (booked.status !== 200) {
    say(`could not book "${t.label}": ${booked.status} ${booked.body.error}`);
    return { error: `${booked.status} ${booked.body.error}` };
  }
  const { serial, start, price } = booked.body as { serial: number; start: number; price: string };
  await locked(async () => {
    state.slots[serial] = start;
    state.jobs[hash] = {
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
  const fits = start + SLOT <= job.deadline;
  say(`booked #${serial} for "${t.label}" at ${price} tinybars, starts in ${start - now()}s, due in ${job.deadline - now()}s${fits ? "" : " (too late on its own)"}`);
  return { jobHash: hash, serial, start, price };
}

// ---- buying: behind schedule, swap the latest slot for an earlier one ----
let lastShortfall = 0;
async function buy() {
  const { slots, starts, deadlines } = schedule();
  const plan = buyPlan(starts, deadlines, SLOT);
  if (!plan) return;
  const give = slots.find((s) => s.start === plan.giveStart)!;
  if (give.start < now() + CUTOFF_SECONDS) return; // too close to start to trade
  if (plan.latestStart < now() + NOT_BEFORE) return; // no tradeable slot could start early enough any more
  const budget = buyBudget(starts, deadlines);
  if (!budget) return;
  const { entities } = await findOffers(reader, providerId, { myStart: give.start, myLatest: plan.latestStart, notBefore: now() + NOT_BEFORE, budget });
  const candidates = entities.filter((r) => r.seller.value !== me.id);
  for (const row of candidates) {
    try {
      const { sellerSerial, start, price, swapTx } = await take(row, give.serial, plan.latestStart, budget);
      delete state.slots[give.serial];
      state.slots[sellerSerial] = start;
      await unlist(give.serial);
      state.stats.bought++;
      addTo("spent", price);
      save();
      say(`BOUGHT #${sellerSerial} (starts in ${start - now()}s) from ${names[row.seller.value] ?? row.seller.value} for ${price} tinybars, gave #${give.serial}: ${hashscan("transaction", swapTx)}`);
      return;
    } catch (e) {
      say(`skipped offer #${row.slot_serial.value}: ${(e as Error).message}`);
    }
  }
  // Say it once per shortfall, not every tick.
  if (!candidates.length && lastShortfall !== plan.latestStart) {
    lastShortfall = plan.latestStart;
    say(`behind schedule: need a slot starting by ${plan.latestStart - now()}s from now, none for sale within ${budget} tinybars`);
  }
}

async function take(row: Awaited<ReturnType<typeof findOffers>>["entities"][number], giveSerial: number, latestStart: number, budget: bigint) {
  const seller = row.seller.value;
  const endpoint = row.endpoint.value;
  const sellerSerial = Number(row.slot_serial.value);
  // Arkiv rows are claims: check who wrote it and what Hedera says before signing anything.
  if (row.$owner.toLowerCase() !== (await accountEvm(seller))) throw new Error("offer was not written by the seller it names");
  const slot = await slotInfo(client, tokenId, sellerSerial);
  if (slot.owner !== seller) throw new Error("seller no longer holds it");
  if (slot.meta.s !== Number(row.slot_start.value) || slot.meta.s > latestStart) throw new Error("slot start on Hedera doesn't match the offer");

  const ask = await postPaid(endpoint, { buyer: me.id, buyerSerial: giveSerial });
  if (ask.status !== 402) throw new Error(`seller refused (${ask.status}): ${ask.body.error}`);
  const quote = ask.body.accepts?.[0];
  if (quote?.scheme !== "qy-atomic-swap" || quote.payTo !== seller || quote.extra?.sellerSerial !== sellerSerial) throw new Error("seller quoted different terms");
  const price = BigInt(quote.amount);
  if (!withinBudget(price, budget)) throw new Error(`price ${price} over budget ${budget}`);

  const tx = await buildSwap(client, { tokenId, seller, sellerSerial, buyer: me.id, buyerSerial: giveSerial, price }).sign(parseKey(me.key));
  const res = await postPaid(endpoint, { buyer: me.id, buyerSerial: giveSerial, tx: Buffer.from(tx.toBytes()).toString("base64") });
  if (res.status !== 200) throw new Error(`swap failed (${res.status}): ${res.body.error}`);
  return { sellerSerial, start: slot.meta.s, price: price.toString(), swapTx: res.body.swapTx as string };
}

// ---- selling: keep one Arkiv offer per slot this agent can spare ----
async function unlist(serial: number) {
  const l = state.listings[serial];
  if (!l) return;
  delete state.listings[serial];
  await writer.deleteEntity({ entityKey: l.key }).catch(() => {}); // it may have expired already
}

async function reconcileListings() {
  const { slots, starts, deadlines } = schedule();
  const want = new Map<number, Listing & { start: number }>();
  slots.forEach((s, i) => {
    if (s.start < now() + NOT_BEFORE + 5) return; // a buyer couldn't settle in time
    const latest = latestReplacement(starts, deadlines, i, SLOT);
    if (latest === null) return;
    const latestOk = Math.min(latest, now() + 3600); // spare slot: accepts anything this hour
    const slack = latestOk - s.start;
    if (!worthListing(slack, SLOT)) return;
    want.set(s.serial, { key: "0x", latestOk, price: askPrice(slack, askFloor(), SLOT).toString(), start: s.start });
  });

  for (const [serial, l] of Object.entries(state.listings)) {
    const w = want.get(Number(serial));
    // Re-list only on a real change, Arkiv writes aren't free.
    if (!w || w.price !== l.price || Math.abs(w.latestOk - l.latestOk) >= SLOT) await unlist(Number(serial));
    else want.delete(Number(serial));
  }
  for (const [serial, w] of want) {
    const { entityKey } = await writer.createEntity(
      SlotOffer,
      {
        provider: providerId,
        slot_serial: u64(serial),
        slot_start: u64(w.start),
        latest_ok_start: u64(w.latestOk),
        min_price: u64(BigInt(w.price)),
        seller: me.id,
        endpoint: `${baseUrl}/offers/${serial}/swap`,
        job_hash: "",
      },
      { expiration: ExpirationTime.atDate(new Date((w.start - CUTOFF_SECONDS) * 1000)) },
    );
    state.listings[serial] = { key: entityKey, latestOk: w.latestOk, price: w.price };
    say(`listed #${serial} (starts in ${w.start - now()}s) for ${w.price} tinybars, swaps into slots up to ${w.latestOk - now()}s from now`);
  }
  save();
}

// ---- the swap endpoint buyers call ----
await serve(port, {
  // Busy agents answer at once instead of queueing the buyer: two agents buying from each other
  // at the same moment would otherwise each wait on the other forever.
  "POST /offers/:serial/swap": async ({ params, body }) => {
    if (inFlight) throw new HttpError(409, "busy, try again shortly");
    return locked(() => swap(Number(params.serial), body));
  },
  "POST /tasks": ({ body }) => acceptTask(body),
  "POST /tasks/list": ({ body }) => listTasks(body),
});

// ---- the user's side: hand the agent a task, read back what it delivered ----

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
  if (!Number.isInteger(spec.deadline) || spec.deadline < now() + SLOT) throw new HttpError(400, `deadline must be unix seconds at least ${SLOT}s from now`);
  if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new HttpError(400, "maxTokens must be a positive integer");
  const terms = { deadline: spec.deadline, lateCost: tinybars(spec.maxPay, "maxPay"), minAsk: tinybars(spec.minComp, "minComp"), fromUser: true };
  const r = await startJob({ task: spec.task, input: spec.input ?? "", label: spec.label, maxTokens }, terms);
  if ("error" in r) throw new HttpError(502, `provider refused the booking: ${r.error}`);
  const onItsOwn = r.start + SLOT <= spec.deadline;
  return { body: { ...r, deadline: spec.deadline, note: onItsOwn ? "its own slot meets the deadline" : "its own slot is too late; the agent will try to buy an earlier one" } };
}

/** Every task the user handed in, with its status and, once delivered, the checked result. */
async function listTasks(body: any): Promise<Res> {
  await owner("tasks", "list", body);
  const tasks = Object.entries(state.jobs)
    .filter(([, j]) => j.fromUser)
    .map(([hash, j]) => ({
      jobHash: hash,
      label: j.label,
      deadline: j.deadline,
      status: j.status,
      slot: j.serial ?? null,
      onTime: j.met ?? null,
      result: j.file ? readFileSync(`${DIR}/${j.file}`, "utf8") : null,
    }));
  return { body: { agent: me.id, tasks } };
}

async function swap(serial: number, body: any): Promise<Res> {
  const listing = state.listings[serial];
  const start = state.slots[serial];
  if (!trading || !listing || start === undefined) throw new HttpError(410, "offer no longer available");
  if (now() > start - CUTOFF_SECONDS) throw new HttpError(410, "my slot starts too soon to trade");
  const buyer = String(body?.buyer ?? "");
  const buyerSerial = Number(body?.buyerSerial);
  if (!/^0\.0\.\d+$/.test(buyer) || !Number.isInteger(buyerSerial)) throw new HttpError(400, "need buyer and buyerSerial");

  // Ask consensus, not Arkiv or the Mirror Node: who holds what, and when the buyer's slot runs.
  const [mine, theirs] = await Promise.all([slotInfo(client, tokenId, serial), slotInfo(client, tokenId, buyerSerial)]);
  if (mine.owner !== me.id) {
    await unlist(serial);
    throw new HttpError(410, "I no longer hold this slot");
  }
  if (theirs.owner !== buyer) throw new HttpError(403, `${buyer} does not hold slot #${buyerSerial}`);
  if (theirs.meta.s < now() + CUTOFF_SECONDS) throw new HttpError(422, `slot #${buyerSerial} starts too soon to trade`);
  // Re-check against today's jobs, not the listing: new work may have arrived since it was written.
  const { slots, deadlines } = schedule();
  const after = slots.map((s) => (s.serial === serial ? theirs.meta.s : s.start));
  if (!feasible(after, deadlines, SLOT)) throw new HttpError(422, `slot #${buyerSerial} (starts ${theirs.meta.s}) would make me miss a deadline`);

  const price = BigInt(listing.price);
  const terms: SwapTerms = { tokenId, seller: me.id, sellerSerial: serial, buyer, buyerSerial, price };
  if (!body.tx) {
    // x402-shaped quote. Payment isn't a separate transfer: it rides inside the swap transaction.
    const required: PaymentRequired = {
      x402Version: 2,
      resource: { url: `${baseUrl}/offers/${serial}/swap`, description: `swap into slot #${serial}`, mimeType: "application/json" },
      accepts: [
        { scheme: "qy-atomic-swap", network: NETWORK, asset: HBAR, amount: price.toString(), payTo: me.id, maxTimeoutSeconds: SWAP_VALID_SECONDS, extra: { tokenId, sellerSerial: serial, buyerSerial } },
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
  delete state.slots[serial];
  state.slots[buyerSerial] = theirs.meta.s;
  await unlist(serial);
  state.stats.sold++;
  addTo("earned", price);
  save();
  say(`SOLD #${serial} to ${names[buyer] ?? buyer} for ${price} tinybars, took #${buyerSerial} (starts in ${theirs.meta.s - now()}s): ${hashscan("transaction", swapTx)}`);

  // The trade already settled on Hedera; bookkeeping failures are logged, never returned as errors.
  const hcsSeq = await postEvent(client, topicId, me.id, me.key, { type: "trade", sellerSerial: serial, buyerSerial, seller: me.id, buyer, price: price.toString(), swapTx }).catch(
    (e) => (say("HCS:", e.message), ""),
  );
  await writer
    .createEntity(
      Trade,
      { provider: providerId, seller_serial: u64(serial), buyer_serial: u64(buyerSerial), price: u64(price), swap_tx: swapTx, hcs_seq: hcsSeq },
      { expiration: ExpirationTime.fromDays(1) },
    )
    .catch((e) => say("Arkiv trade:", e.message));
  return { body: { swapTx, hcsSeq, hashscan: hashscan("transaction", swapTx) } };
}

// ---- main loop ----
const stopTakingWorkAt = o.minutes ? now() + Math.round(Number(o.minutes) * 60) : Infinity;
let nextRoutine = now() + Math.floor(Math.random() * Math.min(60, cfg.every)); // stagger agents
let lastTriggered = 0;
const TRIGGER_GAP = 60; // at most one event-driven job a minute

async function tick() {
  await locked(pollLog);
  for (const ev of toDeliver.splice(0)) await deliver(ev).catch((e) => say("delivery failed:", e.message));

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

say(`${me.id} ready: ${trading ? "trading" : "NOT trading (baseline)"}, swap endpoint ${baseUrl}, outputs in data/agents/${o.as}/outputs`);
const loop = async () => {
  await tick().catch((e) => say("tick error:", (e as Error).message));
  setTimeout(loop, 5000);
};
loop();

/** Take listings down and print the run's numbers on one parseable line. */
async function finish() {
  await locked(async () => {
    for (const serial of Object.keys(state.listings)) await unlist(Number(serial));
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
