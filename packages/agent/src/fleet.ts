// Run N agents together against every live provider, then report how many deadlines were met.
//
//   pnpm fleet --agents 3 --minutes 8              agents trade slots
//   pnpm fleet --agents 3 --minutes 8 --no-trade   baseline: same workloads, no trading
//   pnpm fleet --agents 5 --offset 5 --host 192.168.1.20   a second laptop: agents F..J, reachable on the LAN
//
// Agents are AGENT_A, AGENT_B, ... from .env (create more with `pnpm setup:accounts --agents N`).
// Roles cycle through --mix. Each agent stops taking work after --minutes, finishes what it booked,
// and exits; the summary is written to data/fleet/.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { arkivReader, findProviders, readEvents } from "@qy/shared";
import { ROLES } from "./workloads.js";

const { values: o } = parseArgs({
  options: {
    agents: { type: "string", default: "3" },
    minutes: { type: "string", default: "8" },
    mix: { type: "string", default: "urgent,digest,report" },
    "no-trade": { type: "boolean", default: false },
    offset: { type: "string", default: "0" }, // skip this many agents (so two laptops run different ones)
    host: { type: "string" }, // this machine's LAN address, so agents on other machines can reach ours
  },
});
const mix = o.mix!.split(",");
for (const r of mix) if (!ROLES[r]) throw new Error(`unknown role ${r}`);

const available = Object.keys(process.env)
  .map((k) => k.match(/^AGENT_([A-Z0-9]+)_ID$/)?.[1])
  .filter((x): x is string => !!x)
  .sort();
const n = Number(o.agents);
const offset = Number(o.offset);
if (available.length < offset + n) throw new Error(`only ${available.length} agents in .env; run pnpm setup:accounts --agents ${offset + n}`);

// Fail fast if no provider is up, rather than report an empty run.
const providers = (await findProviders(arkivReader())).entities;
const reachable = [];
for (const p of providers) if (await fetch(p.booking_url.value).then(() => true, () => false)) reachable.push(p);
if (!reachable.length) throw new Error("no live provider is reachable; start one with pnpm provider");
console.log(`providers: ${reachable.map((p) => `${p.name.value} (${p.model.value}) at ${p.booking_url.value}`).join(", ")}`);

const agentEntry = fileURLToPath(new URL("./index.ts", import.meta.url));
const startedAt = Math.floor(Date.now() / 1000);
const stats: any[] = [];

const runs = available.slice(offset, offset + n).map((letter, i) => {
  const port = 4101 + offset + i;
  const args = ["--as", `AGENT_${letter}`, "--role", mix[(offset + i) % mix.length], "--port", String(port), "--minutes", o.minutes!, "--fresh"];
  if (o.host) args.push("--url", `http://${o.host}:${port}`);
  if (o["no-trade"]) args.push("--no-trade");
  const child = spawn(process.execPath, ["--import", "tsx", agentEntry, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  const onLine = (buf: Buffer) => {
    for (const l of buf.toString().split("\n")) {
      if (!l.trim()) continue;
      if (l.startsWith("STATS ")) stats.push(JSON.parse(l.slice(6)));
      else console.log(l);
    }
  };
  child.stdout.on("data", onLine);
  child.stderr.on("data", onLine);
  return new Promise<void>((done) => child.on("exit", () => done()));
});
console.log(`fleet: ${n} agents (${mix.join(", ")}), ${o["no-trade"] ? "NO trading (baseline)" : "trading"}, taking work for ${o.minutes} min, then draining`);
process.on("SIGINT", () => process.exit(130)); // children get the signal too
await Promise.all(runs);

// ---- summary: agent stats, cross-checked with the signed log ----
const log = [];
for (const topicId of new Set(reachable.map((p) => p.topic_id.value))) {
  for (let seq = 0, batch; ; ) {
    batch = await readEvents(topicId, seq, 100);
    if (!batch.length) break;
    log.push(...batch.filter((x) => x.ts >= startedAt));
    seq = batch.at(-1)!.seq;
  }
}

const delivered = log.filter((x) => x.e.type === "delivered");
const trades = log.filter((x) => x.e.type === "trade");
const sum = (k: string) => stats.reduce((a, s) => a + Number(s[k]), 0);
const finished = sum("met") + sum("late") + sum("failed");
const summary = {
  startedAt: new Date(startedAt * 1000).toISOString(),
  trading: !o["no-trade"],
  agents: stats,
  totals: {
    jobsBooked: sum("booked"),
    onTime: sum("met"),
    late: sum("late"),
    failed: sum("failed"),
    onTimeRate: finished ? +(sum("met") / finished).toFixed(3) : null,
    trades: trades.length,
    tradeVolumeTinybars: trades.reduce((a, t) => a + BigInt(t.e.type === "trade" ? t.e.price : 0), 0n).toString(),
    deliveredOnHcs: delivered.length,
  },
};
console.log("\nrole     agent      booked  on time  late  failed  bought  sold");
for (const s of stats)
  console.log(`${s.role.padEnd(8)} ${s.as.padEnd(10)} ${String(s.booked).padStart(6)} ${String(s.met).padStart(8)} ${String(s.late).padStart(5)} ${String(s.failed).padStart(7)} ${String(s.bought).padStart(7)} ${String(s.sold).padStart(5)}`);
const t = summary.totals;
console.log(`\non time ${t.onTime}/${finished} (${t.onTimeRate === null ? "-" : `${Math.round(t.onTimeRate * 100)}%`}), ${t.trades} trades, ${Number(t.tradeVolumeTinybars) / 1e8} HBAR traded, ${t.deliveredOnHcs} deliveries signed on HCS`);
const dir = fileURLToPath(new URL("../../../data/fleet", import.meta.url));
mkdirSync(dir, { recursive: true });
const file = `${dir}/${summary.startedAt.replace(/[:.]/g, "-")}-${summary.trading ? "trading" : "baseline"}.json`;
writeFileSync(file, JSON.stringify(summary, null, 2));
console.log(`summary saved to ${file}`);

