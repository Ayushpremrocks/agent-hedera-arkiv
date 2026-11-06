// The agent host: runs every user's agent in one process on a shared view of the market, behind the
// HTTP API the React app uses. Stateless apart from Postgres (private record) and Arkiv (public
// record): agent keys are derived from HOST_SECRET, so any instance can run any agent.
//
//   pnpm host     HOST_URL=http://<lan-ip>:4100 lets agents on other machines reach the ones here;
//                 DATABASE_URL=postgres://... uses a Postgres server instead of the embedded one.
import { AccountCreateTransaction, Hbar, PrivateKey } from "@hiero-ledger/sdk";
import { createAgent, type Agent, type State, type TaskEvent } from "@qy/agent/agent";
import { Hub } from "@qy/agent/hub";
import { ROLES } from "@qy/agent/workloads";
import { ENV_PATH, HttpError, arkivReader, evmKey, hederaClient, need, serve } from "@qy/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { challenge, session, useAuthSecret, verify } from "./auth.js";
import { DATA_DIR, openDb, schema } from "./db/index.js";
import { allowanceLeft, balanceOf, ensureFunds, sweep } from "./funding.js";
import { agentKey, sessionKey } from "./keys.js";
import { publishAgent, publishTask, renewAgent, updateTask, writerFor } from "./mirror.js";

const { users, agents, tasks } = schema;
const PORT = Number(process.env.HOST_PORT ?? 4100);
const HOST_URL = process.env.HOST_URL ?? `http://localhost:${PORT}`;
const AGENT_START_HBAR = 1; // sponsored float, so a new agent can pay its first network fees
const AGENT_START_TGLM = "0.02"; // Arkiv gas for its offers and public task records

// The master secret derives every agent key and the session key; created on first run.
if (!process.env.HOST_SECRET) {
  process.env.HOST_SECRET = randomBytes(32).toString("hex");
  appendFileSync(ENV_PATH, `\nHOST_SECRET=${process.env.HOST_SECRET}\n`);
  console.log("created HOST_SECRET in .env: every hosted agent's key is derived from it, keep it safe");
}
const MASTER = process.env.HOST_SECRET;
useAuthSecret(sessionKey(MASTER));

const { db, where } = await openDb();
console.log(`database: ${where}`);
const operatorKey = need("HEDERA_OPERATOR_KEY");
const operator = hederaClient(need("HEDERA_OPERATOR_ID"), operatorKey);
const hostWriter = writerFor(operatorKey); // the host's identity on Arkiv
const names: Record<string, string> = {};
const hub = new Hub(`${DATA_DIR}/hub.json`);
await hub.refreshProviders();
const providerNames = () => {
  for (const p of hub.live.values()) names[p.id] = p.name;
};
providerNames();

// ---- hosted agents ----
type Hosted = { agent: Agent; owner: string; key: string; client: ReturnType<typeof hederaClient> };
const hosted = new Map<string, Hosted>(); // agent account -> agent
const now = () => Math.floor(Date.now() / 1000);

/** The agent's working state lives in its row; writes are coalesced so a busy agent isn't chatty. */
function rowStore(id: string) {
  let pending: State | null = null;
  let timer: NodeJS.Timeout | null = null;
  return {
    load: async () => ((await db.select({ state: agents.state }).from(agents).where(eq(agents.id, id)))[0]?.state as State | null) ?? null,
    save: (s: State) => {
      pending = s;
      timer ??= setTimeout(async () => {
        timer = null;
        const snapshot = JSON.parse(JSON.stringify(pending));
        await db.update(agents).set({ state: snapshot }).where(eq(agents.id, id)).catch((e) => console.error(`save ${id}:`, e.message));
      }, 500);
    },
  };
}

/** Record every step of a task privately (Postgres) and publicly (Arkiv, written by the agent). */
function taskHook(agentId: string, owner: string, key: string) {
  const writer = writerFor(key);
  const arkivKey = async (jobHash: string) => (await db.select({ k: tasks.arkivKey }).from(tasks).where(eq(tasks.jobHash, jobHash)))[0]?.k;
  const publicView = async (jobHash: string) => {
    const t = (await db.select().from(tasks).where(eq(tasks.jobHash, jobHash)))[0];
    return t && { owner, agent: agentId, jobHash, status: t.status, deadline: t.deadline, provider: t.providerId ?? "", serial: t.serial ?? 0, resultHash: t.resultHash ?? undefined, onTime: t.onTime, finishedAt: t.finishedAt ?? undefined };
  };
  return async (e: TaskEvent) => {
    const touch = { updatedAt: new Date() };
    if (e.kind === "booked") {
      const row = { jobHash: e.jobHash, owner, agentId, label: e.label, deadline: e.deadline, providerId: e.provider, providerName: e.providerName, serial: e.serial, start: e.start, price: e.price, status: "queued" };
      await db.insert(tasks).values(row).onConflictDoUpdate({ target: tasks.jobHash, set: { ...row, ...touch } });
      publishTask(writer, { owner, agent: agentId, jobHash: e.jobHash, status: "queued", deadline: e.deadline, provider: e.provider, serial: e.serial }).then(
        (k) => k && db.update(tasks).set({ arkivKey: k }).where(eq(tasks.jobHash, e.jobHash)),
      );
      return;
    }
    if (e.kind === "moved") await db.update(tasks).set({ serial: e.serial, start: e.start, rushPaid: e.paid, ...touch }).where(eq(tasks.jobHash, e.jobHash));
    if (e.kind === "running") await db.update(tasks).set({ status: "running", serial: e.serial, ...touch }).where(eq(tasks.jobHash, e.jobHash));
    if (e.kind === "done")
      await db
        .update(tasks)
        .set({ status: "done", serial: e.serial, result: e.result, resultHash: e.resultHash, tokens: e.tokens, model: e.model, onTime: e.onTime, finishedAt: e.finishedAt, ...touch })
        .where(eq(tasks.jobHash, e.jobHash));
    if (e.kind === "failed") await db.update(tasks).set({ status: "failed", failure: e.reason, ...touch }).where(eq(tasks.jobHash, e.jobHash));
    const view = await publicView(e.jobHash);
    if (view) updateTask(writer, () => arkivKey(e.jobHash), view);
  };
}

async function run(id: string, owner: string, keyIndex: number) {
  const key = agentKey(MASTER, owner, keyIndex);
  const client = hederaClient(id, key);
  names[id] = `agent of ${owner}`;
  const onTask = taskHook(id, owner, key);
  const agent = await createAgent(
    {
      id,
      key,
      label: `${owner}'s agent`,
      role: ROLES.assistant,
      store: rowStore(id),
      baseUrl: `${HOST_URL}/agents/${id}`,
      names,
      fund: (amount) => ensureFunds(client, id, owner, amount),
      onTask: (e) => void onTask(e).catch((err) => console.error(`task ${e.jobHash}:`, err.message)),
    },
    hub,
  );
  agent.start();
  hosted.set(id, { agent, owner, key, client });
  return agent;
}

for (const a of await db.select().from(agents)) {
  await run(a.id, a.owner, a.keyIndex);
  if (a.arkivKey) renewAgent(hostWriter, a.arkivKey as `0x${string}`);
}
console.log(`host: ${hosted.size} agent(s) running, ${hub.live.size} provider(s) live`);

/** A new agent for `owner`: an account for its derived key (auto-associates slot NFTs), Arkiv gas, public record. */
async function createFor(owner: string) {
  const key = agentKey(MASTER, owner, 0);
  const receipt = await (
    await new AccountCreateTransaction()
      .setECDSAKeyWithAlias(PrivateKey.fromStringDer(key))
      .setInitialBalance(new Hbar(AGENT_START_HBAR))
      .setMaxAutomaticTokenAssociations(-1)
      .execute(operator)
  ).getReceipt(operator);
  const id = receipt.accountId!.toString();
  const hash = await hostWriter.sendTransaction({ to: privateKeyToAccount(evmKey(key)).address, value: parseEther(AGENT_START_TGLM) });
  await arkivReader().waitForTransactionReceipt({ hash });
  await db.insert(agents).values({ id, owner, keyIndex: 0 });
  publishAgent(hostWriter, owner, id).then((k) => k && db.update(agents).set({ arkivKey: k }).where(eq(agents.id, id)));
  await run(id, owner, 0);
  console.log(`created agent ${id} for ${owner}`);
  return id;
}

async function mine(headers: Record<string, unknown>) {
  const account = session(headers);
  const row = (await db.select().from(agents).where(eq(agents.owner, account)))[0];
  return { account, row, h: row ? hosted.get(row.id) : undefined };
}
const tinybars = (x: unknown, name: string) => {
  if (typeof x !== "string" || !/^\d{1,15}$/.test(x)) throw new HttpError(400, `${name} must be tinybars as a digit string`);
  return BigInt(x);
};
const creating = new Set<string>();

await serve(PORT, {
  "GET /api/health": async () => ({ body: { ok: true, agents: hosted.size, providers: hub.live.size } }),

  // ---- sign in ----
  "POST /api/auth/challenge": async ({ body }) => ({ body: challenge(body?.account) }),
  "POST /api/auth/verify": async ({ body }) => {
    const r = await verify(body);
    await db.insert(users).values({ account: r.account }).onConflictDoUpdate({ target: users.account, set: { lastSeenAt: new Date() } });
    return { body: r };
  },

  // ---- my agent ----
  "GET /api/me": async ({ headers }) => {
    const { account, row, h } = await mine(headers);
    if (!row || !h) return { body: { account, agent: null } };
    // Balances come from the Mirror Node; if it's down, say so instead of failing the whole page.
    const [balance, allowance] = await Promise.allSettled([balanceOf(h.client, row.id), allowanceLeft(account, row.id)]);
    const value = (r: PromiseSettledResult<bigint>) => (r.status === "fulfilled" ? r.value.toString() : null);
    const mirrorDown = balance.status === "rejected" || allowance.status === "rejected";
    return {
      body: { account, mirrorDown, agent: { id: row.id, arkivKey: row.arkivKey, balance: value(balance), allowance: value(allowance), stats: h.agent.state.stats } },
    };
  },
  "POST /api/agent": async ({ headers }) => {
    const { account, row } = await mine(headers);
    if (row) return { body: { id: row.id, existing: true } };
    if (creating.has(account)) throw new HttpError(409, "your agent is being created");
    creating.add(account);
    try {
      return { body: { id: await createFor(account), existing: false } };
    } finally {
      creating.delete(account);
    }
  },

  // ---- tasks ----
  // Body: { label, task, input?, withinSeconds, maxTokens?, maxPay, minComp } (tinybars as digit strings)
  "POST /api/tasks": async ({ headers, body }) => {
    const { account, h, row } = await mine(headers);
    if (!h || !row) throw new HttpError(404, "create your agent first");
    const within = Number(body?.withinSeconds);
    if (!Number.isInteger(within) || within < 60 || within > 86_400) throw new HttpError(400, "withinSeconds must be 60..86400");
    if (typeof body.task !== "string" || typeof body.label !== "string" || (body.input !== undefined && typeof body.input !== "string")) throw new HttpError(400, "label, task and input must be text");
    const maxPay = tinybars(body.maxPay, "maxPay");
    const minComp = tinybars(body.minComp, "minComp");
    const r = await h.agent.submitTask({
      task: body.task,
      input: body.input,
      label: body.label.slice(0, 100),
      deadline: now() + within,
      maxTokens: body.maxTokens === undefined ? undefined : Number(body.maxTokens),
      maxPay,
      minComp,
    });
    // The booking event already created the row; add the private parts only the user should see.
    await db
      .update(tasks)
      .set({ task: body.task, input: body.input ?? "", maxPay: maxPay.toString(), minComp: minComp.toString() })
      .where(and(eq(tasks.jobHash, r.jobHash), eq(tasks.owner, account)));
    return { body: r };
  },
  "GET /api/tasks": async ({ headers }) => {
    const account = session(headers);
    const rows = await db
      .select({
        jobHash: tasks.jobHash,
        label: tasks.label,
        status: tasks.status,
        deadline: tasks.deadline,
        providerName: tasks.providerName,
        serial: tasks.serial,
        start: tasks.start,
        onTime: tasks.onTime,
        finishedAt: tasks.finishedAt,
        failure: tasks.failure,
        price: tasks.price,
        rushPaid: tasks.rushPaid,
        preview: sql<string | null>`left(${tasks.result}, 240)`,
        createdAt: tasks.createdAt,
      })
      .from(tasks)
      .where(eq(tasks.owner, account))
      .orderBy(desc(tasks.createdAt))
      .limit(50);
    return { body: { tasks: rows } };
  },
  "GET /api/tasks/:jobHash": async ({ headers, params }) => {
    const account = session(headers);
    const t = (await db.select().from(tasks).where(and(eq(tasks.jobHash, params.jobHash), eq(tasks.owner, account))))[0];
    if (!t) throw new HttpError(404, "no such task");
    return { body: { task: t, provider: hub.known(t.providerId ?? "") ?? null } };
  },

  // ---- estimate for the new-task form: what it costs and whether it starts in time on its own ----
  "GET /api/quote": async ({ headers }) => {
    session(headers);
    const providers = [...hub.live.values()].sort((a, b) => Number(BigInt(a.price) - BigInt(b.price)));
    if (!providers.length) throw new HttpError(503, "no provider is online right now");
    const cheapest = providers[0];
    const soonest = [...providers].sort((a, b) => a.nextFree - b.nextFree)[0];
    return { body: { price: cheapest.price, soonestStart: soonest.nextFree, slotSeconds: soonest.slot, providers: providers.length, at: now() } };
  },

  // ---- the market, for the UI ----
  "GET /api/market": async () => ({ body: { providers: [...hub.live.values()] } }),

  // ---- swaps from other agents (anywhere) into a hosted agent's slots ----
  "POST /agents/:id/offers/:provider/:serial/swap": async ({ params, body }) => {
    const h = hosted.get(params.id);
    if (!h) throw new HttpError(404, "no such agent here");
    return h.agent.swap(params.provider, Number(params.serial), body);
  },
});
console.log(`host API on ${HOST_URL}`);

hub.start((e) => console.error("hub:", e.message));
setInterval(providerNames, 30_000);

// Earnings and refunds don't sit with the agent: return them to the owner when it's idle.
setInterval(async () => {
  for (const [id, h] of hosted) {
    if (h.agent.busy()) continue;
    const back = await sweep(h.client, id, h.owner).catch((e) => (console.error(`sweep ${id}:`, e.message), 0n));
    if (back) console.log(`returned ${back} tinybars from agent ${id} to ${h.owner}`);
  }
}, 120_000);
