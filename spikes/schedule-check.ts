// Live check of recurring jobs through the host (run `pnpm host` and a provider first).
// AGENT_D plays the wallet user, as in host-check. Takes about 7 minutes: a schedule's runs are 5 minutes apart.
import { AccountAllowanceApproveTransaction, Hbar } from "@hiero-ledger/sdk";
import { proto } from "@hiero-ledger/proto";
import { hederaClient, parseKey, role } from "@qy/shared";

const HOST = process.env.HOST_URL ?? "http://localhost:4100";
const user = role(process.env.AS ?? "AGENT_D");
const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));
const now = () => Math.floor(Date.now() / 1000);
function expect(label: string, ok: boolean, got: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label} ${got}`);
  if (!ok) process.exitCode = 1;
}
let token = "";
const api = async (path: string, body?: unknown) => {
  const res = await fetch(`${HOST}/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};
/** Poll `get` until `done` holds or `secs` pass; returns the last value. */
async function until<T>(secs: number, get: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
  const end = Date.now() + secs * 1000;
  let v = await get();
  while (!done(v) && Date.now() < end) await sleep(5), (v = await get());
  return v;
}

// ---- sign in as a wallet would, create the agent, give it a budget ----
const { message } = (await api("/auth/challenge", { account: user.id })).body;
const k = parseKey(user.key);
const sig = k.sign(Buffer.from("\x19Hedera Signed Message:\n" + message.length + message));
const signatureMap = Buffer.from(proto.SignatureMap.encode({ sigPair: [{ pubKeyPrefix: k.publicKey.toBytesRaw(), ECDSASecp256k1: sig }] }).finish()).toString("base64");
token = (await api("/auth/verify", { account: user.id, message, signatureMap })).body.token;
const agentId = (await api("/agent", {})).body.id;
expect("signed in, agent ready", !!token && !!agentId, agentId);
const wallet = hederaClient(user.id, user.key);
await (await new AccountAllowanceApproveTransaction().approveHbarAllowance(user.id, agentId, new Hbar(5)).execute(wallet)).getReceipt(wallet);
wallet.close();
await until(30, () => api("/me"), (r) => BigInt(r.body.agent?.allowance ?? 0) > 0n);

const job = { task: "Answer in one short sentence.", withinSeconds: 600, maxTokens: 256, maxPay: "0", minComp: "2000000" };

// ---- validation at the boundary ----
expect("schedule due after its next run refused (400)", (await api("/schedules", { ...job, label: "x", input: "q", every: 300, runs: 2 })).status === 400);
expect("schedule more often than 5 min refused (400)", (await api("/schedules", { ...job, withinSeconds: 120, label: "x", input: "q", every: 60, runs: 2 })).status === 400);

// ---- a schedule: two runs, five minutes apart; the second runs on the place reserved ahead ----
const sch = await api("/schedules", { ...job, withinSeconds: 240, label: "schedule check", input: "Say hello.", every: 300, runs: 2 });
expect("schedule accepted", sch.status === 200, sch.body.id ?? sch.body.error);
const first = await until(60, () => api(`/schedules/${sch.body.id}`), (r) => r.body.schedule.runsDone >= 1);
expect("first run booked right away", first.body.runs.length === 1, first.body.runs[0]?.label);
const reserved = await until(60, () => api(`/schedules/${sch.body.id}`), (r) => r.body.schedule.reservedFor === r.body.schedule.nextRun);
expect("next run's place reserved ahead", reserved.body.schedule.reservedFor === reserved.body.schedule.nextRun && !reserved.body.schedule.lastError, reserved.body.schedule.lastError ?? `for ${reserved.body.schedule.nextRun - now()}s from now`);

// meanwhile: pause, resume and delete on another schedule (its first run is an hour out: nothing books)
const other = await api("/schedules", { ...job, label: "pause check", input: "q", every: 3600, runs: 3, startIn: 3600 });
expect("paused", (await api(`/schedules/${other.body.id}`, { active: false })).body.active === false && (await api(`/schedules/${other.body.id}`)).body.schedule.active === false);
expect("resumed", (await api(`/schedules/${other.body.id}`, { active: true })).body.active === true);
await api(`/schedules/${other.body.id}`, { delete: true });
expect("deleted", (await api(`/schedules/${other.body.id}`)).status === 404);

console.log(`waiting ${reserved.body.schedule.nextRun + 30 - now()}s for the second run...`);
const second = await until(reserved.body.schedule.nextRun + 90 - now(), () => api(`/schedules/${sch.body.id}`), (r) => r.body.schedule.runsDone >= 2);
const s2 = second.body.schedule;
expect("second run booked, schedule finished", s2.runsDone === 2 && s2.runsLeft === 0 && s2.active === false, `${s2.runsDone} runs, ${s2.lastError ?? "no error"}`);
const run2 = second.body.runs.find((r: any) => r.label.endsWith("run 2"));
expect("second run used the reserved place (no new booking charge)", run2?.price === "0", run2?.price);

const runs = await until(180, () => api(`/schedules/${sch.body.id}`), (r) => r.body.runs.every((t: any) => t.status === "done" || t.status === "failed"));
expect("both scheduled runs delivered", runs.body.runs.length === 2 && runs.body.runs.every((t: any) => t.status === "done"), runs.body.runs.map((t: any) => `${t.label}: ${t.status}`).join(", "));
