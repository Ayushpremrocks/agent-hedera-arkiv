// End-to-end check against a running provider with the model up: auth failures, paid booking
// (x402) into a queue with no mint, demand pricing, tokenizing a ticket on demand, real model jobs,
// the run-time kill, private results and the batched signed log.
import { type Job, type LoggedEvent, hbarPayer, hederaClient, jobHash, postPaid, readEvents, role, sha256, signRequest, slotInfo } from "@qy/shared";

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
const tokenize = (who: { id: string; key: string }, tickets: number[], pay = false) =>
  postPaid(`${URL}/tickets/tokenize`, { tickets, ...signRequest("tokenize", who.id, who.key, tickets.join(",")) }, pay ? hbarPayer(who.id, who.key, 1_000_000_000n) : undefined);
const result = (who: { id: string; key: string }, hash: string) => postPaid(`${URL}/results`, { jobHash: hash, ...signRequest("result", who.id, who.key, hash) });
function expect(label: string, ok: boolean, got: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label} ${got}`);
  if (!ok) process.exitCode = 1;
}
const run = now();
const job = (label: string, task: string, input: string, maxTokens = 120): Job => ({ kind: "llm", task, input: `${input} (run ${run})`, maxTokens, deadline: now() + 600, label });

const jobB = job("B summary", "Summarise in one sentence.", "Agent B booked a GPU slot on QueueYield and listed it for sale on Arkiv.");
const jobA = job("A triage", "Answer in two bullet points.", "A slot was sold for 0.02 HBAR. Is the market getting tighter?");
// Reliably long: thousands of tokens, past the provider's 30s run-time limit.
const overrun = job("C overrun", "Write the integers from 1 to 3000 separated by commas, with nothing else.", "Start now.", 4096);
const overrun2 = job("B overrun", "Write the integers from 3000 down to 1 separated by commas, with nothing else.", "Start now.", 4096);
const overrun3 = job("C overrun 2", "Write a very long story, at least 3000 words, about a GPU that never sleeps.", "Begin.", 4096);
const waiting = job("A later", "Reply with one word.", "Say hello.", 10);

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
const c = await book(C, overrun, { pay: true });
expect("C books its overrunning job", c.status === 200, c.status);
const { topicId, tokenId } = a.body;
expect("a booking is a queue ticket with an estimated start, no NFT", Number.isInteger(c.body.ticket) && c.body.eta >= now() - 1 && c.body.serial === undefined, `ticket #${c.body.ticket}, eta +${c.body.eta - now()}s`);
// Two 30s jobs fill both workers, so the next booking really waits in the queue.
expect("B books a second overrunning job", (await book(B, overrun2, { pay: true })).status === 200);
expect("C books a third, in case one stops early", (await book(C, overrun3, { pay: true })).status === 200);
const later = await book(A, waiting);
expect("price rose with both workers busy", BigInt(later.body.price) > FLOOR, later.body.price);
const w = await book(A, waiting, { pay: true });
expect("A's next ticket is booked behind them", w.status === 200, `position ${w.body.position}, eta +${w.body.eta - now()}s`);
const queue = (await (await fetch(`${URL}/queue`)).json()) as { tickets: { ticket: number; status: string }[] };
expect("/queue shows it waiting", queue.tickets.some((t) => t.ticket === w.body.ticket && t.status === "queued"));
expect("results aren't there before the job runs (404)", (await result(A, jobHash(waiting))).status === 404);

// Tokenizing: only the holder, paid, minted to the holder, once.
expect("someone else can't tokenize A's ticket (403)", (await tokenize(B, [w.body.ticket], true)).status === 403);
const tq = await tokenize(A, [w.body.ticket]);
expect("tokenizing is paid (402)", tq.status === 402, tq.status);
const tok = await tokenize(A, [w.body.ticket], true);
const serial = Number(tok.body.serials?.[w.body.ticket]);
expect("A tokenizes its waiting ticket", tok.status === 200 && serial > 0, tok.status === 200 ? `NFT #${serial}` : `${tok.status} ${tok.body.error}`);
if (serial > 0) {
  const nft = await slotInfo(hederaClient(A.id, A.key), tokenId, serial);
  expect("the NFT is A's and names the ticket", nft.owner === A.id && nft.meta.t === w.body.ticket, JSON.stringify(nft));
  const again = await tokenize(A, [w.body.ticket]);
  expect("tokenizing again is free and returns the same NFT", again.status === 200 && again.body.price === "0" && Number(again.body.serials[w.body.ticket]) === serial);
}


// Wait for all three to finish and their batched events to reach the Mirror Node.
const startSeq = Math.max(0, Number((await (await fetch(`https://testnet.mirrornode.hedera.com/api/v1/topics/${topicId}/messages?order=desc&limit=1`)).json()).messages[0]?.sequence_number ?? 0) - 40);
let events: LoggedEvent[] = [];
const done = (hash: string) => events.find((x) => x.e.type === "done" && x.e.jobHash === hash)?.e as Extract<LoggedEvent["e"], { type: "done" }> | undefined;
for (let i = 0; i < 40 && ![jobA, jobB, overrun, waiting].every((j) => done(jobHash(j))); i++) {
  await new Promise((r) => setTimeout(r, 5000));
  events = [];
  for (let seq = startSeq, batch; (batch = await readEvents(topicId, seq, 100)).length; seq = batch.at(-1)!.seq) events.push(...batch);
}
const perMessage = new Map<number, number>();
for (const x of events) perMessage.set(x.seq, (perMessage.get(x.seq) ?? 0) + 1);
expect("events are batched: fewer HCS messages than events", perMessage.size < events.length, `${events.length} events in ${perMessage.size} messages`);

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
expect("C's overrunning job was cut off at the run-time limit", !!dC && !dC.ok && dC.result.startsWith("timeout"), dC?.result);
const dW = done(jobHash(waiting));
expect("the tokenized ticket still ran A's job", !!dW?.ok && dW.owner === A.id, dW ? `${dW.tokens} tokens` : "no done event");
