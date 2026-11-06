// Run one agent from the command line (the fleet runs several of these; the host runs many agents in
// one process instead).
//
//   pnpm agent --as AGENT_A --role urgent --port 4101 [--url http://<lan-ip>:4101] [--model smollm2:135m]
//   roles: assistant (user tasks only) | urgent (tight deadlines) | digest (loose) | report (medium)
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { HttpError, role, serve, sha256, verifyRequest } from "@qy/shared";
import { createAgent, fileStore } from "./agent.js";
import { Hub } from "./hub.js";
import { ROLES } from "./workloads.js";

const { values: o } = parseArgs({
  options: {
    as: { type: "string" }, // role prefix in .env, e.g. AGENT_A
    role: { type: "string" }, // assistant | urgent | digest | report
    port: { type: "string", default: "4100" }, // swap and task endpoint
    url: { type: "string" }, // base URL other machines use to reach this agent (default http://localhost:<port>)
    model: { type: "string" }, // only use providers running this model
    "no-trade": { type: "boolean", default: false }, // baseline: book and run jobs, never buy or sell
    "max-booking": { type: "string", default: "300000000" }, // x402 cap per booking (3 HBAR)
    minutes: { type: "string" }, // stop taking new work after this long, finish what's booked, then exit
    fresh: { type: "boolean", default: false }, // forget saved state and stats (start of a fleet run)
  },
});
const cfg = ROLES[o.role ?? ""];
if (!o.as || !cfg) {
  console.error(`usage: agent --as AGENT_X --role ${Object.keys(ROLES).join("|")} [--port n] [--url http://host:port] [--model m] [--no-trade]`);
  process.exit(2);
}

const me = role(o.as);
const port = Number(o.port);
const dir = fileURLToPath(new URL(`../../../data/agents/${o.as}`, import.meta.url));
const names: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  const m = k.match(/^AGENT_([A-Z0-9]+)_ID$/);
  if (m && v) names[v] = `Agent ${m[1]}`;
}

const hub = new Hub(`${dir}/hub.json`, o.model);
await hub.refreshProviders();
if (!hub.live.size) throw new Error(`no live providers on Arkiv${o.model ? ` running ${o.model}` : ""}; start one with pnpm provider`);
for (const p of hub.live.values()) names[p.id] = p.name;
console.log(`market: ${[...hub.live.values()].map((p) => `${p.name} (${p.model}, ${Number(p.price) / 1e8} HBAR)`).join(", ")}`);

const stats = (s: object) => console.log(`STATS ${JSON.stringify({ as: o.as, role: o.role, trading: !o["no-trade"], ...s })}`);
const agent = await createAgent(
  {
    id: me.id,
    key: me.key,
    label: `${o.as.replace("AGENT_", "")}:${o.role}`,
    role: cfg,
    store: fileStore(`${dir}/state.json`),
    dir,
    baseUrl: o.url ?? `http://localhost:${port}`,
    names,
    trading: !o["no-trade"],
    maxBooking: BigInt(o["max-booking"]!),
    fresh: o.fresh,
    minutes: o.minutes ? Number(o.minutes) : undefined,
    onFinish: (s) => (stats(s), process.exit(0)),
  },
  hub,
);

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

await serve(port, {
  "POST /offers/:provider/:serial/swap": ({ params, body }) => agent.swap(params.provider, Number(params.serial), body),
  // Body: { spec: { task, input?, label, deadline, maxTokens?, maxPay, minComp }, account, ts, sig } signed over sha256(JSON of spec).
  "POST /tasks": async ({ body }) => {
    const spec = body?.spec;
    await owner("task", sha256(JSON.stringify(spec ?? null)), body);
    if (spec.input !== undefined && typeof spec.input !== "string") throw new HttpError(400, "input must be text");
    return { body: await agent.submitTask({ ...spec, maxPay: tinybars(spec.maxPay, "maxPay"), minComp: tinybars(spec.minComp, "minComp") }) };
  },
  "POST /tasks/list": async ({ body }) => {
    await owner("tasks", "list", body);
    return { body: { agent: me.id, tasks: agent.listTasks() } };
  },
});

hub.start((e) => console.error("hub:", e.message));
agent.start();
const stop = () => (stats(agent.state.stats), process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
