// End-to-end check against a running provider: auth failures, paid booking (x402), demand pricing,
// binding, dispatch, the slot-end kill and the signed HCS log.
// Run `pnpm provider` first with WORKERS=2 (default); LEAD_SECONDS=40 keeps it quick.
import { PublicKey } from "@hiero-ledger/sdk";
import { MIRROR, accountKey, hbarPayer, type Job, jobHash, nftOwner, postPaid, role, signRequest } from "@qy/shared";

const URL = process.env.PROVIDER_URL ?? "http://localhost:4000";
const A = role("AGENT_A");
const B = role("AGENT_B");
const C = role("AGENT_C");

const FLOOR = BigInt(process.env.PRICE_FLOOR ?? 10_000_000);

/** Signed POST; with `pay`, answers a 402 by paying through x402 (capped at 1 HBAR). */
async function call(path: string, action: string, who: { id: string; key: string }, job: Job, opts: { tamper?: boolean; pay?: boolean } = {}) {
  const signed = signRequest(action, who.id, who.key, jobHash(job));
  if (opts.tamper) signed.sig = signed.sig.replace(/^../, "00");
  return postPaid(`${URL}${path}`, { job, ...signed }, opts.pay ? hbarPayer(who.id, who.key, 100_000_000n) : undefined);
}
function expect(label: string, got: number, want: number) {
  console.log(`${got === want ? "PASS" : "FAIL"}  ${label}: ${got}`);
  if (got !== want) process.exitCode = 1;
}

const jobB: Job = { kind: "cpu", seconds: 5, label: "B flexible batch" };
const jobA: Job = { kind: "cpu", seconds: 5, label: "A routine" };
const urgent: Job = { kind: "cpu", seconds: 3, label: "A urgent" };
const overrun: Job = { kind: "cpu", seconds: 60, label: "C overruns its slot" };

expect("bad job rejected", (await call("/book", "book", B, { ...jobB, seconds: 999 })).status, 400);
expect("tampered signature rejected", (await call("/book", "book", B, jobB, { tamper: true })).status, 401);
expect("signing as someone else rejected", (await call("/book", "book", { id: B.id, key: A.key }, jobB)).status, 401);
expect("bind without a slot rejected", (await call("/bind", "bind", C, jobB)).status, 403);

const quote = await call("/book", "book", B, jobB);
expect("unpaid booking gets 402", quote.status, 402);
expect("idle price is the floor (1=yes)", Number(BigInt(quote.body.price) === FLOOR), 1);

const b = await call("/book", "book", B, jobB, { pay: true });
expect("B books (paid)", b.status, 200);
const a = await call("/book", "book", A, jobA, { pay: true });
expect("A books (paid)", a.status, 200);
expect("A double-book rejected before paying", (await call("/book", "book", A, jobA, { pay: true })).status, 409);
// B and A filled one start time (2 workers), so the next booking costs double.
const cQuote = await call("/book", "book", C, overrun);
expect("price doubled after a start filled (1=yes)", Number(BigInt(cQuote.body.price) === FLOOR * 2n), 1);
const c = await call("/book", "book", C, overrun, { pay: true });
expect("C books at the doubled price", c.status, 200);
expect("A binds urgent job", (await call("/bind", "bind", A, urgent)).status, 200);
console.log("B slot", b.body, "\nA slot", a.body);

const { tokenId, topicId } = a.body;
console.log("owner of A's slot on Mirror:", await nftOwner(tokenId, a.body.serial).catch(() => "(not yet indexed)"));

const last = Math.max(a.body.start, b.body.start, c.body.start);
const wait = (last + Number(process.env.SLOT_SECONDS ?? 30)) * 1000 - Date.now() + 10_000; // past slot end: the kill lands there
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
for (const { e, ok } of events.slice(-12)) console.log(ok ? "sig✓" : "sig✗", JSON.stringify(e));
expect("all HCS signatures valid (0 = bad count)", events.filter((x) => !x.ok).length, 0);
const doneFor = (h: string) => events.some(({ e }) => e.type === "done" && e.jobHash === h && e.ok);
expect("A's urgent job ran (1=yes)", Number(doneFor(jobHash(urgent))), 1);
expect("B's job ran (1=yes)", Number(doneFor(jobHash(jobB))), 1);
const killed = events.some(({ e }) => e.type === "done" && e.jobHash === jobHash(overrun) && !e.ok && e.result.startsWith("timeout"));
expect("C's overrunning job was killed at slot end (1=yes)", Number(killed), 1);
