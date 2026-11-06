// The agent host: one process running every user's agent on a shared view of the market, behind an
// HTTP API for the web app. Users sign in with their wallet; each gets one agent with its own Hedera
// account, funded just in time from an HBAR allowance the user grants it.
//
//   pnpm host            (HOST_URL=http://<lan-ip>:4100 so agents on other machines can reach ours)
import { AccountCreateTransaction, Hbar, PrivateKey } from "@hiero-ledger/sdk";
import { createAgent, type Agent } from "@qy/agent/agent";
import { Hub } from "@qy/agent/hub";
import { ROLES } from "@qy/agent/workloads";
import { ENV_PATH, HttpError, arkivReader, arkivWriter, evmKey, hederaClient, need, serve } from "@qy/shared";
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { challenge, session, useAuthSecret, verify } from "./auth.js";
import { DATA_DIR, agentOf, allAgents, saveAgent, useSecret } from "./db.js";
import { allowanceLeft, balanceOf, ensureFunds, sweep } from "./funding.js";

const PORT = Number(process.env.HOST_PORT ?? 4100);
const HOST_URL = process.env.HOST_URL ?? `http://localhost:${PORT}`;
const AGENT_START_HBAR = 1; // sponsored float, so a new agent can pay its first network fees
const AGENT_START_TGLM = "0.02"; // Arkiv gas for its offers and trade records

// One secret encrypts agent keys and signs sessions; created on first run.
if (!process.env.HOST_SECRET) {
  process.env.HOST_SECRET = randomBytes(32).toString("hex");
  appendFileSync(ENV_PATH, `\nHOST_SECRET=${process.env.HOST_SECRET}\n`);
  console.log("created HOST_SECRET in .env: keep it, it decrypts every hosted agent's key");
}
useSecret(process.env.HOST_SECRET);
useAuthSecret(process.env.HOST_SECRET);

const operator = hederaClient(need("HEDERA_OPERATOR_ID"), need("HEDERA_OPERATOR_KEY"));
const operatorArkiv = arkivWriter(evmKey(need("HEDERA_OPERATOR_KEY")));
const names: Record<string, string> = {};
const hub = new Hub(`${DATA_DIR}/hub.json`);
await hub.refreshProviders();
const providerNames = () => {
  for (const p of hub.live.values()) names[p.id] = p.name;
};
providerNames();

// ---- hosted agents ----
type Hosted = { agent: Agent; owner: string; client: ReturnType<typeof hederaClient> };
const hosted = new Map<string, Hosted>(); // agent account -> agent

async function run(id: string, owner: string, key: string) {
  const client = hederaClient(id, key);
  names[id] = `agent of ${owner}`;
  const agent = await createAgent(
    {
      id,
      key,
      label: `${owner}'s agent`,
      role: ROLES.assistant,
      dir: `${DATA_DIR}/agents/${id}`,
      baseUrl: `${HOST_URL}/agents/${id}`,
      names,
      fund: (amount) => ensureFunds(client, id, owner, amount),
    },
    hub,
  );
  agent.start();
  hosted.set(id, { agent, owner, client });
  return agent;
}

for (const a of allAgents()) await run(a.id, a.owner, a.key);
console.log(`host: ${hosted.size} agent(s) running, ${hub.live.size} provider(s) live`);

/** A new agent for `owner`: its own account (alias key, auto-associates slot NFTs) and Arkiv gas. */
async function createFor(owner: string) {
  const key = PrivateKey.generateECDSA();
  const receipt = await (
    await new AccountCreateTransaction().setECDSAKeyWithAlias(key).setInitialBalance(new Hbar(AGENT_START_HBAR)).setMaxAutomaticTokenAssociations(-1).execute(operator)
  ).getReceipt(operator);
  const id = receipt.accountId!.toString();
  const der = key.toStringDer();
  const hash = await operatorArkiv.sendTransaction({ to: privateKeyToAccount(evmKey(der)).address, value: parseEther(AGENT_START_TGLM) });
  await arkivReader().waitForTransactionReceipt({ hash });
  saveAgent(id, owner, der);
  await run(id, owner, der);
  console.log(`created agent ${id} for ${owner}`);
  return id;
}

const mine = (headers: Record<string, unknown>) => {
  const account = session(headers);
  const row = agentOf(account);
  return { account, row, h: row ? hosted.get(row.id) : undefined };
};
const tinybars = (x: unknown, name: string) => {
  if (typeof x !== "string" || !/^\d{1,15}$/.test(x)) throw new HttpError(400, `${name} must be tinybars as a digit string`);
  return BigInt(x);
};
const creating = new Set<string>();

await serve(PORT, {
  "GET /api/health": async () => ({ body: { ok: true, agents: hosted.size, providers: hub.live.size } }),

  // ---- sign in ----
  "POST /api/auth/challenge": async ({ body }) => ({ body: challenge(body?.account) }),
  "POST /api/auth/verify": async ({ body }) => ({ body: await verify(body) }),

  // ---- my agent ----
  "GET /api/me": async ({ headers }) => {
    const { account, row, h } = mine(headers);
    if (!row || !h) return { body: { account, agent: null } };
    const [balance, allowance] = await Promise.all([balanceOf(h.client, row.id), allowanceLeft(account, row.id)]);
    return { body: { account, agent: { id: row.id, balance: balance.toString(), allowance: allowance.toString(), stats: h.agent.state.stats } } };
  },
  "POST /api/agent": async ({ headers }) => {
    const { account, row } = mine(headers);
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
    const { h } = mine(headers);
    if (!h) throw new HttpError(404, "create your agent first");
    const within = Number(body?.withinSeconds);
    if (!Number.isInteger(within) || within < 60 || within > 86_400) throw new HttpError(400, "withinSeconds must be 60..86400");
    if (typeof body.task !== "string" || typeof body.label !== "string" || (body.input !== undefined && typeof body.input !== "string")) throw new HttpError(400, "label, task and input must be text");
    const r = await h.agent.submitTask({
      task: body.task,
      input: body.input,
      label: body.label.slice(0, 100),
      deadline: Math.floor(Date.now() / 1000) + within,
      maxTokens: body.maxTokens === undefined ? undefined : Number(body.maxTokens),
      maxPay: tinybars(body.maxPay, "maxPay"),
      minComp: tinybars(body.minComp, "minComp"),
    });
    return { body: r };
  },
  "GET /api/tasks": async ({ headers }) => {
    const { h } = mine(headers);
    return { body: { tasks: h ? h.agent.listTasks() : [] } };
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
