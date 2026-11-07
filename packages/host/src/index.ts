// The agent host: runs every user's agent in one process on a shared view of the market, behind the
// HTTP API the React app uses. Stateless apart from Postgres (private record) and Arkiv (public
// record): agent keys are derived from HOST_SECRET, so any instance can run any agent.
//
//   pnpm host     HOST_URL=http://<lan-ip>:4100 lets agents on other machines reach the ones here;
//                 DATABASE_URL=postgres://... uses a Postgres server instead of the embedded one.
import { AccountCreateTransaction, Hbar, PrivateKey, TransferTransaction } from "@hiero-ledger/sdk";
import { createAgent, type Agent, type State, type TaskEvent } from "@qy/agent/agent";
import { Hub } from "@qy/agent/hub";
import { ROLES } from "@qy/agent/workloads";
import { ENV_PATH, HttpError, MIRROR, type LoggedEvent, arkivReader, evmKey, hederaClient, need, readEvents, runLimit, serve, trackRecord } from "@qy/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { challenge, keyChallenge, session, useAuthSecret, verify, verifyKey } from "./auth.js";
import { startEscrow } from "./escrow.js";
import { DATA_DIR, openDb, schema } from "./db/index.js";
import type { JobSpec } from "./db/schema.js";
import { allowanceLeft, balanceOf, ensureFunds, sweep } from "./funding.js";
import { agentKey, sessionKey } from "./keys.js";
import { publishAgent, publishTask, renewAgent, updateTask, writerFor } from "./mirror.js";

const { users, agents, tasks, schedules } = schema;
const PORT = Number(process.env.HOST_PORT ?? process.env.PORT ?? 4100); // PORT: what hosting platforms set
const HOST_URL = process.env.HOST_URL ?? `http://localhost:${PORT}`;
const AGENT_START_HBAR = 1; // sponsored float, so a new agent can pay its first network fees
const AGENT_START_TGLM = "0.02"; // Arkiv gas for its offers and public task records
const NEW_USER_HBAR = 5; // testnet HBAR a new email user starts with, to pay fees and set a budget
const NEW_ACCOUNTS_PER_HOUR = 30;
const newAccounts: number[] = [];
const toppedUp = new Set<string>(); // shortcut: forgotten on restart, so an empty account can be topped up once per restart

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
const operatorId = need("HEDERA_OPERATOR_ID");
const operator = hederaClient(operatorId, operatorKey);
const hostWriter = writerFor(operatorKey); // the host's identity on Arkiv
const names: Record<string, string> = {};
const hub = new Hub(`${DATA_DIR}/hub.json`);

// Each provider's signed log, read incrementally from the Mirror Node, for public track records.
// shortcut: the newest 5,000 events per provider are kept in memory; a long-lived host would page older
// history into Postgres.
const logs = new Map<string, { events: LoggedEvent[]; lastSeq: number; at: number; pending?: Promise<void> }>();
async function recordOf(providerId: string) {
  const p = hub.known(providerId);
  if (!p) throw new HttpError(404, "unknown provider");
  let log = logs.get(p.topicId);
  if (!log) logs.set(p.topicId, (log = { events: [], lastSeq: 0, at: 0 }));
  if (Date.now() - log.at > 30_000) {
    const l = log;
    l.pending ??= (async () => {
      for (let page = 0; page < 50; page++) {
        const batch = await readEvents(p.topicId, l.lastSeq, 100);
        if (!batch.length) break;
        l.events.push(...batch);
        l.lastSeq = batch.at(-1)!.seq;
      }
      l.events = l.events.slice(-5000);
      l.at = Date.now();
    })().finally(() => (l.pending = undefined));
    await l.pending;
  }
  return trackRecord(log.events, p.id);
}
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
      escrow: escrow.id,
      onTask: (e) => void onTask(e).catch((err) => console.error(`task ${e.jobHash}:`, err.message)),
    },
    hub,
  );
  agent.start();
  hosted.set(id, { agent, owner, key, client });
  return agent;
}

// Bookings are paid into this escrow; providers on this machine read ESCROW_ID from .env.
const escrow = await startEscrow({
  key: agentKey(MASTER, "escrow", 0),
  operator,
  dataDir: DATA_DIR,
  live: () => [...hub.live.keys()],
  known: (id) => hub.known(id),
  readLog: async (id) => {
    await recordOf(id);
    return logs.get(hub.known(id)!.topicId)?.events ?? [];
  },
});
if (process.env.ESCROW_ID !== escrow.id) {
  appendFileSync(ENV_PATH, `
ESCROW_ID=${escrow.id}
`);
  process.env.ESCROW_ID = escrow.id;
}
console.log(`escrow ${escrow.id}: holds every booking until its ticket starts on time`);

for (const a of await db.select().from(agents)) {
  await run(a.id, a.owner, a.keyIndex);
  if (a.arkivKey) renewAgent(hostWriter, a.arkivKey as `0x${string}`);
}
console.log(`host: ${hosted.size} agent(s) running, ${hub.live.size} provider(s) live`);

/** A new agent for `owner`: an account for its derived key (auto-associates slot NFTs), Arkiv gas, public record. */
async function createFor(owner: string) {
  const key = agentKey(MASTER, owner, 0);
  // The key is derived, so the account may already exist on Hedera (e.g. the database was lost): adopt it.
  const alias = PrivateKey.fromStringDer(key).publicKey.toEvmAddress();
  const found = await fetch(`${MIRROR}/accounts/0x${alias}`).then((r) => (r.ok ? (r.json() as Promise<{ account?: string }>) : null));
  let id = found?.account;
  if (!id) {
    const receipt = await (
      await new AccountCreateTransaction()
        .setECDSAKeyWithAlias(PrivateKey.fromStringDer(key))
        .setInitialBalance(new Hbar(AGENT_START_HBAR))
        .setMaxAutomaticTokenAssociations(-1)
        .execute(operator)
    ).getReceipt(operator);
    id = receipt.accountId!.toString();
    const hash = await hostWriter.sendTransaction({ to: privateKeyToAccount(evmKey(key)).address, value: parseEther(AGENT_START_TGLM) });
    await arkivReader().waitForTransactionReceipt({ hash });
  }
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
const isAccount = (x: unknown): x is string => typeof x === "string" && /^0\.0\.\d+$/.test(x);
const MAX_INPUT = 16_000;

/** Check what every job shares, whether booked alone or on a schedule. */
function jobSpec(body: any): JobSpec {
  const within = Number(body?.withinSeconds);
  if (!Number.isInteger(within) || within < 60 || within > 86_400) throw new HttpError(400, "withinSeconds must be 60..86400");
  if (typeof body?.task !== "string" || !body.task.trim()) throw new HttpError(400, "task must be text");
  if (body.input !== undefined && typeof body.input !== "string") throw new HttpError(400, "input must be text");
  if (body.provider !== undefined && !isAccount(body.provider)) throw new HttpError(400, "provider must be a Hedera account id");
  const maxTokens = body.maxTokens === undefined ? 300 : Number(body.maxTokens);
  if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new HttpError(400, "maxTokens must be a positive integer");
  return {
    task: body.task.slice(0, 4000),
    input: body.input?.slice(0, MAX_INPUT),
    withinSeconds: within,
    maxTokens,
    maxPay: tinybars(body.maxPay, "maxPay").toString(),
    minComp: tinybars(body.minComp, "minComp").toString(),
    provider: body.provider,
  };
}

/**
 * Book one job for a user's agent and keep its private parts (instruction, input) and its
 * schedule with it. The booking event inserts the row asynchronously, so wait for it before updating.
 */
async function bookFor(agent: Agent, owner: string, spec: JobSpec, label: string, deadline: number, link: { scheduleId?: string } = {}) {
  const r = await agent.submitTask({
    task: spec.task,
    input: spec.input,
    label: label.slice(0, 100),
    deadline,
    maxTokens: spec.maxTokens,
    maxPay: BigInt(spec.maxPay),
    minComp: BigInt(spec.minComp),
    provider: spec.provider,
  });
  for (let i = 0; i < 20; i++) {
    const done = await db
      .update(tasks)
      .set({ task: spec.task, input: spec.input ?? "", maxPay: spec.maxPay, minComp: spec.minComp, ...link })
      .where(and(eq(tasks.jobHash, r.jobHash), eq(tasks.owner, owner)))
      .returning({ jobHash: tasks.jobHash });
    if (done.length) break;
    await new Promise((res) => setTimeout(res, 250));
  }
  return r;
}

/**
 * Recurring jobs. Each run's capacity is reserved ahead (providers sell reservations up to an hour out),
 * at today's price; when the run comes, the job is attached to that reservation. Runs missed while the
 * host was down are skipped, not piled up.
 */
const RESERVE_LEAD = 45 * 60;
async function tickSchedules() {
  for (const s of await db.select().from(schedules).where(eq(schedules.active, true))) {
    const h = hosted.get(s.agentId);
    if (!h) continue;
    const t = now();
    if (s.reservedFor !== s.nextRun && s.nextRun - t <= RESERVE_LEAD && s.nextRun - t >= 60) {
      const r = await h.agent.reserve(s.nextRun + 20, s.spec.maxTokens, s.spec.provider).catch((e: Error) => ({ error: e.message }));
      await db
        .update(schedules)
        .set({ reservedFor: s.nextRun, lastError: "error" in r ? `couldn't reserve ahead: ${r.error}` : null })
        .where(eq(schedules.id, s.id));
    }
    if (t < s.nextRun) continue;
    let lastError: string | null = null;
    try {
      await bookFor(h.agent, s.owner, s.spec, `${s.label} · run ${s.runsDone + 1}`, t + s.spec.withinSeconds, { scheduleId: s.id });
    } catch (e) {
      lastError = (e as Error).message.slice(0, 300);
    }
    let next = s.nextRun + s.every;
    while (next <= t) next += s.every;
    const runsLeft = s.runsLeft - 1;
    await db.update(schedules).set({ runsDone: s.runsDone + 1, runsLeft, nextRun: next, active: runsLeft > 0, lastError }).where(eq(schedules.id, s.id));
  }
}

await serve(PORT, {
  "GET /api/health": async () => ({ body: { ok: true, agents: hosted.size, providers: hub.live.size } }),

  // ---- the escrow: its account and what it holds, paid out and refunded ----
  "GET /api/escrow": async () => ({ body: { account: escrow.id, ...escrow.stats() } }),
  "GET /api/escrow/:provider/:ticket": async ({ params }) => {
    const e = escrow.entry(params.provider, Number(params.ticket));
    if (!e) throw new HttpError(404, "the escrow has no record of that ticket (yet)");
    return { body: e };
  },

  // ---- sign in ----
  "POST /api/auth/challenge": async ({ body }) => ({ body: challenge(body?.account) }),
  // Email sign-in (Magic): prove the key, get the Hedera account for it (created and funded once if new).
  "POST /api/auth/key-challenge": async ({ body }) => ({ body: keyChallenge(body?.publicKey) }),
  "POST /api/auth/key-account": async ({ body }) => {
    const key = verifyKey(body);
    const found = await fetch(`${MIRROR}/accounts?account.publickey=${key.toStringRaw()}&limit=1`).then((r) => (r.ok ? (r.json() as Promise<any>) : null));
    let account: string | undefined = found?.accounts?.[0]?.account;
    // shortcut: in-memory hourly cap on funded accounts (new or topped up); a real deployment needs per-email limits.
    const allowance = () => {
      if (newAccounts.filter((t) => t > now() - 3600).length >= NEW_ACCOUNTS_PER_HOUR) throw new HttpError(429, "too many new accounts this hour; try again later");
      newAccounts.push(now());
    };
    // Magic may already have made an account for this key, with no HBAR: fund it once, like a new one.
    if (account && BigInt(found.accounts[0].balance?.balance ?? 0) < 100_000_000n && !toppedUp.has(account)) {
      allowance();
      toppedUp.add(account);
      await (await new TransferTransaction().addHbarTransfer(operatorId, new Hbar(-NEW_USER_HBAR)).addHbarTransfer(account, new Hbar(NEW_USER_HBAR)).execute(operator)).getReceipt(operator);
      console.log(`funded email user ${account} with ${NEW_USER_HBAR} HBAR`);
    }
    if (!account) {
      allowance();
      const receipt = await (await new AccountCreateTransaction().setKeyWithoutAlias(key).setInitialBalance(new Hbar(NEW_USER_HBAR)).execute(operator)).getReceipt(operator);
      account = receipt.accountId!.toString();
      // /auth/verify reads the key from the Mirror Node, which lags consensus by a few seconds
      for (let i = 0; i < 20 && !(await fetch(`${MIRROR}/accounts/${account}`)).ok; i++) await new Promise((r) => setTimeout(r, 1000));
      console.log(`created user account ${account} for an email sign-in`);
    }
    return { body: { account } };
  },
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
    if (typeof body?.label !== "string") throw new HttpError(400, "label must be text");
    const spec = jobSpec(body);
    return { body: await bookFor(h.agent, account, spec, body.label, now() + spec.withinSeconds) };
  },

  // ---- recurring jobs ----
  "POST /api/schedules": async ({ headers, body }) => {
    const { account, h, row } = await mine(headers);
    if (!h || !row) throw new HttpError(404, "create your agent first");
    const every = Number(body?.every);
    const runs = Number(body?.runs);
    const startIn = Number(body?.startIn ?? 0);
    if (!Number.isInteger(every) || every < 300 || every > 7 * 86_400) throw new HttpError(400, "every must be 300..604800 seconds");
    if (!Number.isInteger(runs) || runs < 1 || runs > 100) throw new HttpError(400, "runs must be 1..100");
    if (!Number.isInteger(startIn) || startIn < 0 || startIn > 86_400) throw new HttpError(400, "startIn must be 0..86400 seconds");
    if (typeof body.label !== "string" || !body.label.trim()) throw new HttpError(400, "label must be text");
    const spec = jobSpec(body);
    if (spec.withinSeconds > every) throw new HttpError(400, "each run's deadline must come before the next run starts");
    const id = randomBytes(8).toString("hex");
    await db.insert(schedules).values({ id, owner: account, agentId: row.id, label: body.label.slice(0, 80), spec, every, runsLeft: runs, nextRun: now() + startIn });
    return { body: { id } };
  },
  "GET /api/schedules": async ({ headers }) => {
    const account = session(headers);
    const rows = await db.select().from(schedules).where(eq(schedules.owner, account)).orderBy(desc(schedules.createdAt));
    return { body: { schedules: rows.map(({ spec, ...s }) => ({ ...s, task: spec.task.slice(0, 200), withinSeconds: spec.withinSeconds, maxTokens: spec.maxTokens })) } };
  },
  "GET /api/schedules/:id": async ({ headers, params }) => {
    const account = session(headers);
    const s = (await db.select().from(schedules).where(and(eq(schedules.id, params.id), eq(schedules.owner, account))))[0];
    if (!s) throw new HttpError(404, "no such schedule");
    const runs = await db
      .select({ jobHash: tasks.jobHash, label: tasks.label, status: tasks.status, onTime: tasks.onTime, deadline: tasks.deadline, finishedAt: tasks.finishedAt, price: tasks.price, createdAt: tasks.createdAt })
      .from(tasks)
      .where(and(eq(tasks.scheduleId, s.id), eq(tasks.owner, account)))
      .orderBy(desc(tasks.createdAt))
      .limit(30);
    return { body: { schedule: s, runs } };
  },
  "POST /api/schedules/:id": async ({ headers, params, body }) => {
    const account = session(headers);
    const s = (await db.select().from(schedules).where(and(eq(schedules.id, params.id), eq(schedules.owner, account))))[0];
    if (!s) throw new HttpError(404, "no such schedule");
    if (body?.delete === true) {
      await db.delete(schedules).where(eq(schedules.id, s.id));
      return { body: { deleted: true } };
    }
    if (typeof body?.active !== "boolean") throw new HttpError(400, "send { active: true | false } or { delete: true }");
    if (body.active && s.runsLeft < 1) throw new HttpError(409, "this schedule has no runs left");
    await db.update(schedules).set({ active: body.active, nextRun: body.active ? Math.max(s.nextRun, now()) : s.nextRun }).where(eq(schedules.id, s.id));
    return { body: { active: body.active } };
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
        scheduleId: tasks.scheduleId,
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
    const settlement = t.providerId && t.serial !== null ? escrow.entry(t.providerId, t.serial) : null;
    return { body: { task: t, provider: hub.known(t.providerId ?? "") ?? null, settlement } };
  },

  // ---- estimate for the new-task form: what it costs and whether it starts in time on its own ----
  "GET /api/quote": async ({ headers }) => {
    session(headers);
    const TOKENS = 300; // the agent's default task size
    const providers = [...hub.live.values()].filter((p) => p.maxTokens >= TOKENS).sort((a, b) => Number(BigInt(a.price) - BigInt(b.price)));
    if (!providers.length) throw new HttpError(503, "no provider is online right now");
    const cheapest = providers[0];
    // Guaranteed numbers, not estimates: the start each provider promises now, and the job's hard run limit.
    const soonest = [...providers].sort((a, b) => a.nextFree + runLimit(TOKENS, a) - (b.nextFree + runLimit(TOKENS, b)))[0];
    return { body: { price: cheapest.price, startBy: soonest.nextFree, runSeconds: runLimit(TOKENS, soonest), providers: providers.length, at: now() } };
  },

  // ---- the market, for the UI ----
  "GET /api/market": async () => ({
    body: { providers: await Promise.all([...hub.live.values()].map(async (p) => ({ ...p, record: await recordOf(p.id).catch(() => null) }))) },
  }),

  // ---- one provider, public: profile, track record from its signed log, recent events ----
  "GET /api/providers/:id": async ({ params }) => {
    const p = hub.known(params.id);
    if (!p) throw new HttpError(404, "no provider with that account has been seen on Arkiv");
    const record = await recordOf(p.id);
    const recent = (logs.get(p.topicId)?.events ?? []).slice(-40).reverse();
    return { body: { provider: p, online: hub.live.has(p.id), record, recent, escrow: { account: escrow.id, ...escrow.stats(p.id) } } };
  },

  // ---- swaps from other agents (anywhere) into a hosted agent's slots ----
  "POST /agents/:id/offers/:provider/:serial/swap": async ({ params, body }) => {
    const h = hosted.get(params.id);
    if (!h) throw new HttpError(404, "no such agent here");
    return h.agent.swap(params.provider, Number(params.serial), body);
  },
});
console.log(`host API on ${HOST_URL}`);

hub.start((e) => console.error("hub:", e.message));
let scheduling = false;
setInterval(() => {
  if (scheduling) return;
  scheduling = true;
  tickSchedules()
    .catch((e) => console.error("schedules:", e.message))
    .finally(() => (scheduling = false));
}, 15_000);
setInterval(providerNames, 30_000);

// Earnings and refunds don't sit with the agent: return them to the owner when it's idle.
setInterval(async () => {
  for (const [id, h] of hosted) {
    if (h.agent.busy()) continue;
    const back = await sweep(h.client, id, h.owner).catch((e) => (console.error(`sweep ${id}:`, e.message), 0n));
    if (back) console.log(`returned ${back} tinybars from agent ${id} to ${h.owner}`);
  }
}, 120_000);
