// End-to-end check of the agent host as a wallet user would use it (run `pnpm host` first).
// AGENT_D's account plays the user's HashPack wallet: it signs in with a wallet-format signature,
// creates its agent, grants it an HBAR allowance, hands it a task and reads the checked result.
import { AccountAllowanceApproveTransaction, Hbar } from "@hiero-ledger/sdk";
import { proto } from "@hiero-ledger/proto";
import { hederaClient, parseKey, role } from "@qy/shared";

const HOST = process.env.HOST_URL ?? "http://localhost:4100";
const user = role(process.env.AS ?? "AGENT_D");
const other = role("AGENT_C");
function expect(label: string, ok: boolean, got: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label} ${got}`);
  if (!ok) process.exitCode = 1;
}
const api = async (path: string, init: { body?: unknown; token?: string } = {}) => {
  const res = await fetch(`${HOST}${path}`, {
    method: init.body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: res.status, body: (await res.json()) as any };
};
/** What HashPack returns from signMessage: a SignatureMap over the prefixed message. */
function walletSign(message: string, key: string) {
  const k = parseKey(key);
  const sig = k.sign(Buffer.from("\x19Hedera Signed Message:\n" + message.length + message));
  const map = proto.SignatureMap.encode({ sigPair: [{ pubKeyPrefix: k.publicKey.toBytesRaw(), ECDSASecp256k1: sig }] }).finish();
  return Buffer.from(map).toString("base64");
}

expect("API needs a session (401)", (await api("/api/me")).status === 401);
const { message } = (await api("/api/auth/challenge", { body: { account: user.id } })).body;
const forged = await api("/api/auth/verify", { body: { account: user.id, message, signatureMap: walletSign(message, other.key) } });
expect("sign-in signed by another key is refused (401)", forged.status === 401, forged.body.error);
const again = (await api("/api/auth/challenge", { body: { account: user.id } })).body.message;
const signin = await api("/api/auth/verify", { body: { account: user.id, message: again, signatureMap: walletSign(again, user.key) } });
expect("wallet-signed sign-in works", signin.status === 200, signin.body.account);
const token = signin.body.token;
expect("a used sign-in message can't be replayed (401)", (await api("/api/auth/verify", { body: { account: user.id, message: again, signatureMap: walletSign(again, user.key) } })).status === 401);

const created = await api("/api/agent", { token, body: {} });
expect("agent created (or already there)", created.status === 200, created.body.id);
const agentId = created.body.id;

// The user grants the agent its budget from their own wallet: 3 HBAR it may spend.
const wallet = hederaClient(user.id, user.key);
await (await new AccountAllowanceApproveTransaction().approveHbarAllowance(user.id, agentId, new Hbar(3)).execute(wallet)).getReceipt(wallet);
wallet.close();
await new Promise((r) => setTimeout(r, 6000)); // Mirror Node catches up
const me = await api("/api/me", { token });
expect("allowance visible to the host", BigInt(me.body.agent?.allowance ?? 0) > 0n, `${Number(me.body.agent?.allowance) / 1e8} HBAR`);

const market = await api("/api/market");
expect("market lists providers", market.body.providers?.length > 0, market.body.providers?.map((p: any) => p.name).join(", "));

const submitted = await api("/api/tasks", {
  token,
  body: { label: "host check", task: "Answer in one sentence.", input: "What does a GPU slot marketplace do?", withinSeconds: 600, maxPay: "20000000", minComp: "5000000" },
});
expect("task booked through the host", submitted.status === 200, `${submitted.body.providerName} #${submitted.body.serial}, ${submitted.body.error ?? submitted.body.note}`);

const wait = (submitted.body.start + 30) * 1000 - Date.now() + 25_000;
console.log(`waiting ${Math.round(wait / 1000)}s for the slot to run and the result to arrive...`);
await new Promise((r) => setTimeout(r, Math.max(0, wait)));
const listed = (await api("/api/tasks", { token })).body.tasks.find((x: any) => x.jobHash === submitted.body.jobHash);
expect("task listed from the database", !!listed, listed?.status);
const t = (await api(`/api/tasks/${submitted.body.jobHash}`, { token })).body.task;
expect("result delivered and checked", t?.status === "done" && !!t.result, t ? `${t.status}, ${t.onTime ? "on time" : "late"}: ${String(t.result).slice(0, 80)}` : "missing");
expect("private record keeps the instruction", t?.task === "Answer in one sentence.");
expect("public record mirrored to Arkiv", !!t?.arkivKey, t?.arkivKey);
const peek = await api(`/api/tasks/${submitted.body.jobHash}`, { token: "0.0.1.9999999999.forged" });
expect("another session can't read it (401)", peek.status === 401);
const after = (await api("/api/me", { token })).body.agent;
expect("the agent drew on the allowance", BigInt(after.allowance) < BigInt(me.body.agent.allowance), `${Number(after.allowance) / 1e8} HBAR left`);
