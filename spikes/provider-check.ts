// End-to-end check against a running provider with the model up: auth failures, paid booking
// (x402), demand pricing, real model jobs, the slot-end kill, private results and the signed log.
// Run the provider first with short slots so the overrun job is reliably cut off:
//   LEAD_SECONDS=40 SLOT_SECONDS=15 pnpm provider
import { type Job, type LoggedEvent, hbarPayer, jobHash, postPaid, readEvents, role, sha256, signRequest } from "@qy/shared";

const URL = process.env.PROVIDER_URL ?? "http://localhost:4000";
const A = role("AGENT_A");
const B = role("AGENT_B");
const C = role("AGENT_C");
const now = () => Math.floor(Date.now() / 1000);

async function book(who: { id: string; key: string }, job: Job, opts: { tamper?: boolean; pay?: boolean } = {}) {
  const signed = signRequest("book", who.id, who.key, jobHash(job));
  if (opts.tamper) signed.sig = signed.sig.replace(/^../, "00");
  return postPaid(`${URL}/book`, { job, ...signed }, opts.pay ? hbarPayer(who.id, who.key, 1_000_000_000n) : undefined);
}
const result = (who: { id: string; key: string }, hash: string) => postPaid(`${URL}/results`, { jobHash: hash, ...signRequest("result", who.id, who.key, hash) });
function expect(label: string, ok: boolean, got: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label} ${got}`);
  if (!ok) process.exitCode = 1;
}
const job = (label: string, task: string, input: string, maxTokens = 120): Job => ({ kind: "llm", task, input, maxTokens, deadline: now() + 600, label });

const jobB = job("B summary", "Summarise in one sentence.", "Agent B booked a GPU slot on QueueYield and listed it for sale on Arkiv.");
const jobA = job("A triage", "Answer in two bullet points.", "A slot was sold for 0.02 HBAR. Is the market getting tighter?");
// Reliably long: about 24s of generation on the small local model, longer than a 15s slot.
const overrun = job("C overrun", "Write the integers from 1 to 3000 separated by commas, with nothing else.", "Start now.", 4096);

expect("bad job rejected (400)", (await book(B, { ...jobB, maxTokens: 999_999 })).status === 400);
expect("tampered signature rejected (401)", (await book(B, jobB, { tamper: true })).status === 401);
expect("signing as someone else rejected (401)", (await book({ id: B.id, key: A.key }, jobB)).status === 401);

const quote = await book(B, jobB);
expect("unpaid booking gets 402", quote.status === 402, quote.status);
const FLOOR = BigInt(quote.body.floor);
expect("idle price is the floor (covers Hedera fees)", BigInt(quote.body.price) === FLOOR, `${quote.body.price} tinybars`);

const b = await book(B, jobB, { pay: true });
expect("B books (paid)", b.status === 200, b.status);
const a = await book(A, jobA, { pay: true });
expect("A books (paid)", a.status === 200, a.status);
expect("booking the same job twice rejected before paying (409)", (await book(A, jobA, { pay: true })).status === 409);
const later = await book(C, overrun);
expect("price rose as capacity filled", BigInt(later.body.price) > FLOOR, later.body.price);
const c = await book(C, overrun, { pay: true });
expect("C books its overrunning job", c.status === 200, c.status);
const { topicId } = a.body;

const ready = (hash: string) => result(A, hash);
expect("results aren't there before the job runs (404)", (await ready(jobHash(jobA))).status === 404);

const slotSeconds = Number(process.env.SLOT_SECONDS ?? 15);
const wait = (Math.max(a.body.start, b.body.start, c.body.start) + slotSeconds) * 1000 - Date.now() + 10_000;
console.log(`waiting ${Math.round(wait / 1000)}s for the three slots to run...`);
await new Promise((r) => setTimeout(r, wait));

const events: LoggedEvent[] = [];
for (let seq = 0, batch; (batch = await readEvents(topicId, seq, 100)).length; seq = batch.at(-1)!.seq) events.push(...batch);
const done = (hash: string) => events.find((x) => x.e.type === "done" && x.e.jobHash === hash)?.e as Extract<LoggedEvent["e"], { type: "done" }> | undefined;

const dA = done(jobHash(jobA));
expect("A's job ran on the model", !!dA?.ok && dA.tokens > 0, dA ? `${dA.tokens} tokens in ${dA.ms}ms` : "no done event");
const rA = await result(A, jobHash(jobA));
expect("A fetches its result", rA.status === 200, JSON.stringify(rA.body.text ?? rA.body.error).slice(0, 90));
expect("result matches the hash on HCS", !!dA && sha256(rA.body.text ?? "") === dA.resultHash);
expect("B can't read A's result (403)", (await result(B, jobHash(jobA))).status === 403);
const forged = { jobHash: jobHash(jobA), ...signRequest("result", A.id, B.key, jobHash(jobA)) };
expect("forged result request rejected (401)", (await postPaid(`${URL}/results`, forged)).status === 401);
expect("B's job ran", !!done(jobHash(jobB))?.ok);
const dC = done(jobHash(overrun));
expect("C's overrunning job was cut off at slot end", !!dC && !dC.ok && dC.result.startsWith("timeout"), dC?.result);
