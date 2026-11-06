// Live demonstration of dani.ai's guarantees, one narrated scenario at a time, against a running
// provider and host on Hedera testnet. Every claim it prints is checked (PASS / FAIL) and linked.
//
//   pnpm demo                       all scenarios except `refund` and `load`
//   pnpm demo guarantee payg        pick scenarios: guarantee payg reserve nft refund load
//
// `refund` breaks promises on purpose: start the provider with DEMO_FAULTS=1 first.
// `load` floods the model server from outside for a minute (the GPU fan will spin up).
import { spawnSync } from "node:child_process";
import {
  type Job,
  type LoggedEvent,
  MIRROR,
  hashscan,
  hbarPayer,
  hederaClient,
  jobHash,
  postPaid,
  readEvents,
  returnTicket,
  role,
  sha256,
  signRequest,
  slotInfo,
  waitForOwner,
} from "@qy/shared";

const URL = process.env.PROVIDER_URL ?? "http://localhost:4000";
const HOST = process.env.HOST_URL ?? "http://localhost:4100";
const A = role("AGENT_A");
const now = () => Math.floor(Date.now() / 1000);
const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));
const hb = (t: string | bigint | null | undefined) => (t === null || t === undefined ? "-" : `${(Number(t) / 1e8).toFixed(4)} HBAR`);
const run = now();
let failures = 0;

const say = (s: string) => console.log(`   ${s}`);
const head = (s: string) => console.log(`\n== ${s} ${"=".repeat(Math.max(0, 70 - s.length))}`);
function check(label: string, ok: boolean, detail = "") {
  console.log(`   ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

// ---- calls ----
const pay = () => hbarPayer(A.id, A.key, 2_000_000_000n);
const job = (label: string, task: string, maxTokens: number): Job => ({ kind: "llm", task, input: `${label} (demo ${run})`, maxTokens, deadline: now() + 900, label });
const book = (j: Job) => postPaid(`${URL}/book`, { job: j, ...signRequest("book", A.id, A.key, jobHash(j)) }, pay());
const reserve = (maxTokens: number, notBefore: number) =>
  postPaid(`${URL}/reserve`, { maxTokens, notBefore, ...signRequest("reserve", A.id, A.key, `${maxTokens}@${notBefore}`) }, pay());
const attach = (j: Job) => postPaid(`${URL}/jobs`, { job: j, ...signRequest("job", A.id, A.key, jobHash(j)) });
const tokenize = (tickets: number[]) => postPaid(`${URL}/tickets/tokenize`, { tickets, ...signRequest("tokenize", A.id, A.key, tickets.join(",")) }, pay());
const result = (hash: string) => postPaid(`${URL}/results`, { jobHash: hash, ...signRequest("result", A.id, A.key, hash) });
const queue = async () => (await (await fetch(`${URL}/queue`)).json()) as { maxTokens: number; speed: { tps: number }; escrow: string | null };
/** This provider's account, as the market lists it (the escrow records settlements by provider). */
async function providerId(): Promise<string> {
  const list = ((await (await fetch(`${HOST}/api/market`)).json()) as any).providers as { id: string; bookingUrl: string }[];
  const p = list.find((x) => x.bookingUrl === URL) ?? list[0];
  if (!p) throw new Error("no provider is listed on the market yet");
  return p.id;
}
type Settlement = { status: string; deposit: string; charged: string | null; returned: string | null; reason: string | null; tx: string | null };

/** The provider's signed log, newest events included, for one ticket's start and result. */
async function events(topicId: string): Promise<LoggedEvent[]> {
  const latest = Number(((await (await fetch(`${MIRROR}/topics/${topicId}/messages?order=desc&limit=1`)).json()) as any).messages[0].sequence_number);
  const out: LoggedEvent[] = [];
  for (let seq = Math.max(0, latest - 80), b; (b = await readEvents(topicId, seq, 100)).length; seq = b.at(-1)!.seq) out.push(...b);
  return out;
}
async function waitForEvents(topicId: string, ticket: number, timeoutS = 240) {
  for (let t = 0; t < timeoutS; t += 6) {
    const evs = await events(topicId);
    const dispatch = evs.find((x) => x.e.type === "dispatch" && x.e.ticket === ticket);
    const done = evs.find((x) => x.e.type === "done" && x.e.ticket === ticket);
    if (dispatch && (done || (dispatch.e.type === "dispatch" && dispatch.e.jobHash === null))) return { dispatch, done };
    await sleep(6);
  }
  return { dispatch: undefined, done: undefined };
}
/** Wait for the escrow keeper to settle a ticket (it reads the log every 20 seconds). */
async function settlement(provider: string, ticket: number, timeoutS = 180): Promise<Settlement | null> {
  for (let t = 0; t < timeoutS; t += 10) {
    const r = await fetch(`${HOST}/api/escrow/${provider}/${ticket}`);
    if (r.ok) {
      const s = (await r.json()) as Settlement;
      if (s.status !== "held") return s;
    }
    await sleep(10);
  }
  return null;
}
function showSettlement(s: Settlement | null) {
  if (!s) return say("escrow: not settled yet");
  say(`escrow: deposit ${hb(s.deposit)}, provider kept ${hb(s.charged)}, returned to buyer ${hb(s.returned)}  (${s.reason})`);
  if (s.tx) say(`payout transaction: ${hashscan("transaction", s.tx)}`);
}

// ---- scenarios ----
const SCENARIOS: Record<string, () => Promise<void>> = {
  /** A booking gets a promised start; it starts by then, runs, and its result is proven. */
  async guarantee() {
    head("1. A guaranteed start, a verified result, settled by escrow");
    const j = job("guarantee", "Explain in two sentences why deadlines matter for AI agents.", 200);
    const b = await book(j);
    if (b.status !== 200) return check("booking accepted", false, `${b.status} ${b.body.error}`);
    say(`booked ticket #${b.body.ticket}: starts by ${new Date(b.body.startBy * 1000).toLocaleTimeString()} (promised), run limit ${b.body.limit}s`);
    say(`deposit ${hb(b.body.price)} paid into escrow: ${hashscan("transaction", b.body.paymentTx)}`);
    const { dispatch, done } = await waitForEvents(b.body.topicId, b.body.ticket);
    const late = dispatch ? dispatch.ts - b.body.startBy : NaN;
    check("started by its promise (Hedera timestamp)", late <= 13, dispatch ? `${late.toFixed(0)}s vs promise` : "no start seen");
    const d = done?.e.type === "done" ? done.e : null;
    check("job finished", !!d?.ok, d ? `${d.tokens} tokens in ${(d.ms / 1000).toFixed(1)}s` : "no result");
    const r = await result(jobHash(j));
    check("result matches the fingerprint the provider signed on Hedera", r.status === 200 && sha256(r.body.text) === d?.resultHash);
    say(`result: "${String(r.body.text ?? "").slice(0, 110).replace(/\s+/g, " ")}..."`);
    const s = await settlement(await providerId(), b.body.ticket).catch(() => null);
    showSettlement(s);
    check("escrow paid the provider: promise kept", s?.status === "released" || s?.status === "partial", s?.status);
  },

  /** Pay as you go: deposit the band the job could reach, pay the band it used. */
  async payg() {
    head("2. Pay as you go: priced by the size band actually used");
    const q = await queue();
    const j = job("payg", "Reply with the single word OK.", q.maxTokens);
    const b = await book(j);
    if (b.status !== 200) return check("booking accepted", false, `${b.status} ${b.body.error}`);
    const bands = b.body.bands as [number, string][];
    say(`this provider's prices: ${bands.map(([u, t]) => `up to ${u} tokens ${hb(t)}`).join(", ")}`);
    say(`job declared up to ${q.maxTokens} tokens, so it deposits the top band: ${hb(b.body.price)}`);
    const { done } = await waitForEvents(b.body.topicId, b.body.ticket);
    const d = done?.e.type === "done" ? done.e : null;
    say(`it actually used ${d?.tokens ?? "?"} tokens`);
    const s = await settlement(await providerId(), b.body.ticket);
    showSettlement(s);
    check("charged only the smallest band, the rest returned", !!s && BigInt(s.charged ?? "-1") <= BigInt(bands[0][1]) && BigInt(s.returned ?? "0") > 0n);
  },

  /** Capacity bought ahead for later, its job attached afterwards. */
  async reserve() {
    head("3. Reserve capacity ahead, attach the job later");
    const at = now() + 45;
    const r = await reserve(150, at);
    if (r.status !== 200) return check("reservation accepted", false, `${r.status} ${r.body.error}`);
    say(`reserved ticket #${r.body.ticket} for ${new Date(at * 1000).toLocaleTimeString()}, promised to start by ${new Date(r.body.startBy * 1000).toLocaleTimeString()}`);
    const j = job("reserve", "Give one tip for writing a clear deadline.", 150);
    check("job attached to the reservation (free)", (await attach(j)).status === 200);
    const { dispatch, done } = await waitForEvents(r.body.topicId, r.body.ticket);
    check("it waited for its reserved time", !!dispatch && dispatch.ts >= at, dispatch ? `started ${dispatch.ts - at}s after it was due` : "no start");
    check("and ran the attached job", dispatch?.e.type === "dispatch" && dispatch.e.jobHash === jobHash(j) && done?.e.type === "done" && done.e.ok);
  },

  /** A ticket becomes an NFT only when traded; a returned NFT is reissued instead of minted. */
  async nft() {
    head("4. Tickets become NFTs only for trades, and NFTs are reused");
    const first = (await reserve(50, now() + 40)).body; // starts in 40s: long enough to trade, short enough to wait for
    if (!first?.ticket) return check("reservation accepted", false);
    const t1 = await tokenize([first.ticket]);
    const serial = Number(t1.body.serials?.[first.ticket]);
    check("tokenized: the ticket is now an NFT the holder owns", t1.status === 200 && serial > 0, `NFT #${serial} for ${hb(t1.body.price)}, locked for trading ${t1.body.lockedUntil - now()}s`);
    if (!(serial > 0)) return;
    say(`NFT on HashScan: ${hashscan("token", first.tokenId)}/${serial}`);
    const client = hederaClient(A.id, A.key);
    const treasury = ((await (await fetch(`${MIRROR}/tokens/${first.tokenId}`)).json()) as any).treasury_account_id as string;
    // An agent hands the NFT back once its ticket has started (never before: the waiting ticket still owns it).
    const started = await waitForEvents(first.topicId, first.ticket);
    say(`ticket #${first.ticket} started${started.dispatch ? "" : " (not seen yet)"}; its holder returns the NFT`);
    await returnTicket(client, first.tokenId, serial, A.id);
    await waitForOwner(first.tokenId, serial, treasury);
    say("the holder hands the NFT back to the provider's treasury");
    const second = (await reserve(50, now() + 120)).body;
    const t2 = await tokenize([second.ticket]);
    const reused = Number(t2.body.serials?.[second.ticket]);
    const trade = ((await (await fetch(`${URL}/queue`)).json()) as any).tradePrices as { mint: string; reissue: string };
    check(
      "the next trade reuses that NFT, for a fraction of a mint",
      t2.status === 200 && reused === serial && t2.body.price === trade.reissue,
      `NFT #${reused} for ${hb(t2.body.price)}; minting a new one costs ${hb(trade.mint)}`,
    );
    const info = await slotInfo(client, first.tokenId, serial);
    check("its metadata now names the new ticket", info.meta.t === second.ticket, JSON.stringify(info.meta));
  },

  /** Broken promises: the escrow credits a late start and refunds one that's badly late. */
  async refund() {
    head("5. A broken promise: credit for a late start, refund when badly late");
    const P = role("PROVIDER");
    const pause = (seconds: number) => postPaid(`${URL}/admin/pause`, { seconds, ...signRequest("pause", P.id, P.key, String(seconds)) });
    const provider = await providerId();
    for (const [lateBy, expect] of [
      [18, "a 25% credit (13 to 30s late)"],
      [75, "a full refund (over 60s late)"],
    ] as const) {
      // Stall first, so the ticket can't start the instant it's sold; then end the stall on cue.
      const p = await pause(300);
      if (p.status !== 200) return check("provider paused (needs DEMO_FAULTS=1)", false, `${p.status} ${p.body.error}`);
      const b = await book(job(`refund ${lateBy}`, "Reply with one word.", 20));
      if (b.status !== 200) return check("booking accepted", false, `${b.status} ${b.body.error}`);
      const hold = Math.max(1, b.body.startBy - now() + lateBy);
      await pause(hold);
      say(`ticket #${b.body.ticket}: provider made to stall ${hold}s, so it starts about ${lateBy}s after its promise; expected: ${expect}`);
      const s = await settlement(provider, b.body.ticket, 240);
      showSettlement(s);
      check(`escrow applied ${expect}`, lateBy < 60 ? s?.status === "partial" : s?.status === "refunded", s?.reason ?? "");
    }
  },

  /** Outside load on the same GPU: jobs overrun their limit but are never killed. */
  async load() {
    head("6. Outside load on the GPU: jobs slow down, nobody's job is killed");
    say("running spikes/contention-check.ts with 8 outside generations on the same model server...");
    const r = spawnSync("node", ["--import", "tsx", "spikes/contention-check.ts"], { env: { ...process.env, FLOOD: "8" }, encoding: "utf8", timeout: 600_000 });
    const lines = String(r.stdout).split("\n").filter((l) => l.startsWith("ticket #") || l.startsWith("SUMMARY"));
    lines.forEach((l) => say(l));
    check("every job finished, none killed", /8\/8 finished, 0 killed/.test(String(r.stdout)));
    const q = await queue();
    say(`the provider lowered its promised speed to ${q.speed.tps} tokens/s; it recovers within 10 minutes of the load ending`);
  },
};

const pick = process.argv.slice(2);
const order = pick.length ? pick : ["guarantee", "payg", "reserve", "nft"];
for (const name of order) {
  const s = SCENARIOS[name];
  if (!s) {
    console.log(`unknown scenario "${name}"; choose from: ${Object.keys(SCENARIOS).join(", ")}`);
    process.exit(2);
  }
  await s().catch((e) => check(`${name} ran`, false, (e as Error).message));
}
console.log(`\n${failures ? `${failures} check(s) FAILED` : "every check passed"}`);
process.exit(failures ? 1 : 0);
