// End-to-end check against a running provider: auth failures, booking, binding, dispatch and
// the signed HCS log. Run `pnpm provider` first (LEAD_SECONDS=40 keeps it quick).
import { PublicKey } from "@hiero-ledger/sdk";
import { MIRROR, accountKey, type Job, jobHash, nftOwner, role, signRequest } from "@qy/shared";

const URL = process.env.PROVIDER_URL ?? "http://localhost:4000";
const A = role("AGENT_A");
const B = role("AGENT_B");
const C = role("AGENT_C");

async function call(path: string, action: string, who: { id: string; key: string }, job: Job, tamper = false) {
  const signed = signRequest(action, who.id, who.key, jobHash(job));
  if (tamper) signed.sig = signed.sig.replace(/^../, "00");
  const res = await fetch(`${URL}${path}`, { method: "POST", body: JSON.stringify({ job, ...signed }) });
  return { status: res.status, body: (await res.json()) as any };
}
function expect(label: string, got: number, want: number) {
  console.log(`${got === want ? "PASS" : "FAIL"}  ${label}: ${got}`);
  if (got !== want) process.exitCode = 1;
}

const jobB: Job = { kind: "cpu", seconds: 5, label: "B flexible batch" };
const jobA: Job = { kind: "cpu", seconds: 5, label: "A routine" };
const urgent: Job = { kind: "cpu", seconds: 3, label: "A urgent" };

expect("bad job rejected", (await call("/book", "book", B, { ...jobB, seconds: 999 })).status, 400);
expect("tampered signature rejected", (await call("/book", "book", B, jobB, true)).status, 401);
expect("signing as someone else rejected", (await call("/book", "book", { id: B.id, key: A.key }, jobB)).status, 401);
expect("bind without a slot rejected", (await call("/bind", "bind", C, jobB)).status, 403);

const b = await call("/book", "book", B, jobB);
expect("B books", b.status, 200);
const a = await call("/book", "book", A, jobA);
expect("A books", a.status, 200);
expect("A double-book rejected", (await call("/book", "book", A, jobA)).status, 409);
expect("A binds urgent job", (await call("/bind", "bind", A, urgent)).status, 200);
console.log("B slot", b.body, "\nA slot", a.body);

const { tokenId, topicId } = a.body;
console.log("owner of A's slot on Mirror:", await nftOwner(tokenId, a.body.serial).catch(() => "(not yet indexed)"));

const last = Math.max(a.body.start, b.body.start);
const wait = last * 1000 - Date.now() + 15_000;
console.log(`waiting ${Math.round(wait / 1000)}s for both slots to run...`);
await new Promise((r) => setTimeout(r, wait));

type Env = { body: string; by: string; sig: string };
const msgs = (await (await fetch(`${MIRROR}/topics/${topicId}/messages?limit=100`)).json()) as any;
const events: { e: any; ok: boolean }[] = [];
for (const m of msgs.messages) {
  const env: Env = JSON.parse(Buffer.from(m.message, "base64").toString());
  const ok = PublicKey.fromStringECDSA(await accountKey(env.by)).verify(new TextEncoder().encode(env.body), Buffer.from(env.sig, "hex"));
  events.push({ e: JSON.parse(env.body), ok });
}
for (const { e, ok } of events.slice(-8)) console.log(ok ? "sig✓" : "sig✗", JSON.stringify(e));
expect("all HCS signatures valid (0 = bad count)", events.filter((x) => !x.ok).length, 0);
const doneFor = (h: string) => events.some(({ e }) => e.type === "done" && e.jobHash === h && e.ok);
expect("A's urgent job ran (1=yes)", Number(doneFor(jobHash(urgent))), 1);
expect("B's job ran (1=yes)", Number(doneFor(jobHash(jobB))), 1);
