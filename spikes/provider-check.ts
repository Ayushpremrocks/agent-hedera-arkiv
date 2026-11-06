// End-to-end check against a running provider with the model up: auth failures, paid booking
// (x402) into a queue with no mint, the startBy promise and ticket sizes, a reservation with its job
// attached later, tokenizing with a trade lock, real model jobs, private results and the batched log.
import { type Job, LATE_AFTER, type LoggedEvent, MIRROR, hbarPayer, hederaClient, jobHash, postPaid, readEvents, returnTicket, role, sha256, signRequest, slotInfo, waitForOwner } from "@qy/shared";

const URL = process.env.PROVIDER_URL ?? "http://localhost:4000";
const A = role("AGENT_A");
const B = role("AGENT_B");
const C = role("AGENT_C");
const now = () => Math.floor(Date.now() / 1000);
type Who = { id: string; key: string };
const pay = (who: Who) => hbarPayer(who.id, who.key, 1_000_000_000n);

async function book(who: Who, job: Job, opts: { tamper?: boolean; pay?: boolean } = {}) {
  const signed = signRequest("book", who.id, who.key, jobHash(job));
  if (opts.tamper) signed.sig = signed.sig.replace(/^../, "00");
  return postPaid(`${URL}/book`, { job, ...signed }, opts.pay ? pay(who) : undefined);
}
const reserve = (who: Who, maxTokens: number, notBefore: number, paid = true) =>
  postPaid(`${URL}/reserve`, { maxTokens, notBefore, ...signRequest("reserve", who.id, who.key, `${maxTokens}@${notBefore}`) }, paid ? pay(who) : undefined);
const attach = (who: Who, job: Job) => postPaid(`${URL}/jobs`, { job, ...signRequest("job", who.id, who.key, jobHash(job)) });
const tokenize = (who: Who, tickets: number[], paid = false) =>
  postPaid(`${URL}/tickets/tokenize`, { tickets, ...signRequest("tokenize", who.id, who.key, tickets.join(",")) }, paid ? pay(who) : undefined);
const result = (who: Who, hash: string) => postPaid(`${URL}/results`, { jobHash: hash, ...signRequest("result", who.id, who.key, hash) });
const queue = async () => (await (await fetch(`${URL}/queue`)).json()) as { maxTokens: number; speed: { tps: number }; graceSeconds: number; tickets: any[] };
function expect(label: string, ok: boolean, got: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label} ${got}`);
  if (!ok) process.exitCode = 1;
}
const run = now();
const job = (label: string, task: string, input: string, maxTokens = 120): Job => ({ kind: "llm", task, input: `${input} (run ${run})`, maxTokens, deadline: now() + 600, label });

const HOST = process.env.HOST_URL ?? "http://localhost:4100";
const escrowStats = async () => (await (await fetch(`${HOST}/api/escrow`)).json()) as { account: string; released: number; partial: number; refunded: number; refundedAmount: string };
const e0 = await escrowStats();
const q0 = await queue();
const BIG = q0.maxTokens; // the largest job the provider accepts
console.log(`provider: worst case ${q0.speed.tps} tokens/s, largest job ${BIG} tokens`);
const jobB = job("B summary", "Summarise in one sentence.", "Agent B booked a GPU slot on Dani.ai and listed it for sale on Arkiv.");
const jobA = job("A triage", "Answer in two bullet points.", "A slot was sold for 0.02 HBAR. Is the market getting tighter?");
// Long jobs to keep the workers busy, each as big as the provider allows.
const filler = (who: string, i: number) => job(`${who} filler ${i}`, "Write the integers from 1 to 5000 separated by commas, with nothing else.", `Start at 1. (${i})`, BIG);
const waiting = job("A later", "Reply with one word.", "Say hello.", 10);
const reserved = job("A reserved", "Reply with one word.", "Say goodbye.", 10);
// Declared big (deposits the 1,024-token band) but answers in a few tokens: pay as you go should charge
// only the smallest band and return the rest.
const oversized = job("A oversized", "Reply with the single word OK.", "Go.", BIG); // as big as the provider takes right now

expect("job bigger than the provider's run-time cap rejected (400)", (await book(B, { ...jobB, maxTokens: BIG + 200 })).status === 400);
expect("tampered signature rejected (401)", (await book(B, jobB, { tamper: true })).status === 401);
expect("signing as someone else rejected (401)", (await book({ id: B.id, key: A.key }, jobB)).status === 401);

const quote = await book(B, jobB);
expect("unpaid booking gets 402 with the startBy it would promise", quote.status === 402 && quote.body.startBy >= now() - 1, `startBy +${quote.body.startBy - now()}s`);
const FLOOR = BigInt(quote.body.floor);
expect("idle price is the floor (covers Hedera fees)", BigInt(quote.body.price) === FLOOR, `${quote.body.price} tinybars`);

const b = await book(B, jobB, { pay: true });
expect("B books (paid)", b.status === 200, b.status);
const a = await book(A, jobA, { pay: true });
const big = await book(A, oversized, { pay: true });
const bands = (a.body.bands ?? [[0, "0"]]) as [number, string][];
const bigPrice = big.status === 200 ? BigInt(big.body.price) : 0n;
expect("a big job deposits its size band, not the smallest", big.status === 200 && bands.length > 1 && bigPrice > BigInt(bands[0][1]), `${big.body.price} vs smallest ${bands[0]?.[1]}`);
expect("A books (paid)", a.status === 200, a.status);
expect("booking the same job twice rejected before paying (409)", (await book(A, jobA, { pay: true })).status === 409);
const { topicId, tokenId } = a.body;
expect("a booking is a sized ticket with a promised startBy, no NFT", Number.isInteger(a.body.ticket) && a.body.startBy >= now() - 2 && a.body.maxTokens === 120 && a.body.limit > 0 && a.body.serial === null, `ticket #${a.body.ticket}, startBy +${a.body.startBy - now()}s, limit ${a.body.limit}s`);

// Fill both workers (and one more) so the next booking really waits.
// Booked in parallel (each payment takes seconds), and each counts until its token cap.
const filled = await Promise.all(([[C, 1], [B, 2], [C, 3], [B, 4]] as const).map(([who, i]) => book(who, filler(who === B ? "B" : "C", i), { pay: true })));
expect("four fillers booked", filled.every((f) => f.status === 200), filled.map((f) => f.status).join(","));
const later = await book(A, waiting);
expect("price rose with the workers busy", BigInt(later.body.price) > FLOOR, later.body.price);
const w = await book(A, waiting, { pay: true });
expect("A's next ticket is promised a start behind the fillers", w.status === 200 && w.body.startBy > now() + 5, `startBy +${w.body.startBy - now()}s`);
expect("/queue shows it waiting with its promise", (await queue()).tickets.some((t) => t.ticket === w.body.ticket && t.status === "queued" && t.startBy === w.body.startBy));
expect("results aren't there before the job runs (404)", (await result(A, jobHash(waiting))).status === 404);

// A reservation: capacity bought ahead, its job attached later.
const at = now() + 45;
expect("a reservation in the past is refused (400)", (await reserve(A, 20, now() - 10, false)).status === 400);
const r = await reserve(A, 20, at);
expect("A reserves a ticket for later", r.status === 200 && r.body.notBefore === at && r.body.startBy >= at, `ticket #${r.body.ticket}, startBy +${r.body.startBy - now()}s`);
expect("A attaches a job to it (free)", (await attach(A, reserved)).status === 200);

// Tokenizing: only the holder, paid, minted to the holder, once, and locks the ticket for the trade.
expect("someone else can't tokenize A's ticket (403)", (await tokenize(B, [w.body.ticket], true)).status === 403);
const tq = await tokenize(A, [w.body.ticket]);
expect("tokenizing is paid (402)", tq.status === 402, tq.status);
const tok = await tokenize(A, [w.body.ticket], true);
const serial = Number(tok.body.serials?.[w.body.ticket]);
expect("A tokenizes its waiting ticket, locked for the trade", tok.status === 200 && serial > 0 && tok.body.lockedUntil > now() + 20, tok.status === 200 ? `NFT #${serial}, locked ${tok.body.lockedUntil - now()}s` : `${tok.status} ${tok.body.error}`);
if (serial > 0) {
  const nft = await slotInfo(hederaClient(A.id, A.key), tokenId, serial);
  expect("the NFT is A's and names the ticket", nft.owner === A.id && nft.meta.t === w.body.ticket, JSON.stringify(nft));
  const again = await tokenize(A, [w.body.ticket]);
  expect("tokenizing again is free and returns the same NFT", again.status === 200 && again.body.price === "0" && Number(again.body.serials[w.body.ticket]) === serial);
}

// Wait for everything to run and the batched events to reach the Mirror Node.
const startSeq = Math.max(0, Number((await (await fetch(`https://testnet.mirrornode.hedera.com/api/v1/topics/${topicId}/messages?order=desc&limit=1`)).json()).messages[0]?.sequence_number ?? 0) - 40);
let events: LoggedEvent[] = [];
const ofType = <T extends LoggedEvent["e"]["type"]>(type: T) => events.filter((x) => x.e.type === type) as (LoggedEvent & { e: Extract<LoggedEvent["e"], { type: T }> })[];
const done = (hash: string) => ofType("done").find((x) => x.e.jobHash === hash)?.e;
for (let i = 0; i < 60 && ![jobA, jobB, waiting, reserved].every((j) => done(jobHash(j))); i++) {
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
const dW = done(jobHash(waiting));
expect("the tokenized ticket still ran A's job", !!dW?.ok && dW.owner === A.id, dW ? `${dW.tokens} tokens` : "no done event");

// Every promise kept: each ticket booked in this run was dispatched by its startBy (+ grace).
const promised = new Map(ofType("booked").map((x) => [x.e.ticket, x.e.startBy]));
const dispatched = ofType("dispatch").filter((x) => promised.has(x.e.ticket));
const lateOnes = dispatched.filter((x) => x.ts > promised.get(x.e.ticket)! + LATE_AFTER); // the escrow's own tolerance (grace + batching + consensus)
expect("every ticket started by its promised startBy", dispatched.length >= 6 && !lateOnes.length, `${dispatched.length} dispatched, late: ${lateOnes.map((x) => `#${x.e.ticket} +${x.ts - promised.get(x.e.ticket)!}s`).join(", ") || "none"}`);
const rd = dispatched.find((x) => x.e.ticket === r.body.ticket);
// A holder's jobs run on whichever of its tickets fits, most urgent first: either of A's small jobs.
expect("the reservation ran one of A's jobs, not before it was due", !!rd && [jobHash(reserved), jobHash(waiting)].includes(rd.e.jobHash ?? "") && rd.ts >= at, rd ? `started ${rd.ts - at}s after notBefore` : "not dispatched");
expect("no refunds: the provider kept its word", !ofType("refund").some((x) => promised.has(x.e.ticket ?? -1)), ofType("refund").map((x) => x.e.reason).join("; "));

// ---- escrow: bookings are paid into escrow, and the keeper pays out once tickets start on time ----
const payment = (await (await fetch(`${MIRROR}/transactions/${String(a.body.paymentTx).replace("@", "-").replace(/\.(\d+)$/, "-$1")}`)).json()) as any;
expect("A's booking was paid into the escrow, not to the provider", (payment.transactions?.[0]?.transfers ?? []).some((t: any) => t.account === e0.account && t.amount > 0), e0.account);
let e1 = e0;
for (let i = 0; i < 12 && e1.released - e0.released < 4; i++) {
  await new Promise((r) => setTimeout(r, 10_000));
  e1 = await escrowStats();
}
expect("the escrow paid the provider for tickets that started on time", e1.released - e0.released >= 4, `${e1.released - e0.released} paid out`);
expect("no full refunds: no promise was broken", e1.refunded === e0.refunded, `${e1.refunded - e0.refunded} refunded`);
// The oversized job used the smallest band, so part of its deposit came back: pay as you go.
const back = BigInt(e1.refundedAmount) - BigInt(e0.refundedAmount);
const expected = bigPrice - BigInt(bands[0][1]);
expect("pay as you go: the unused part of the big job's deposit was returned", bigPrice > 0n && e1.partial - e0.partial >= 1 && back >= expected, `${back} tinybars returned (expected at least ${expected})`);

// ---- NFT reuse: a returned ticket NFT is reissued (metadata rewrite) instead of minted ----
if (serial > 0) {
  const treasury = ((await (await fetch(`${MIRROR}/tokens/${tokenId}`)).json()) as any).treasury_account_id as string;
  await returnTicket(hederaClient(A.id, A.key), tokenId, serial, A.id);
  await waitForOwner(tokenId, serial, treasury);
  const later = await reserve(A, 20, now() + 90);
  const re = await tokenize(A, [later.body.ticket], true);
  expect(
    "tokenizing again reissues the returned NFT, for less than a mint",
    re.status === 200 && Number(re.body.serials?.[later.body.ticket]) === serial && BigInt(re.body.price) < BigInt(tok.body.price),
    re.status === 200 ? `NFT #${re.body.serials?.[later.body.ticket]} for ${re.body.price} (a mint was ${tok.body.price})` : `${re.status} ${re.body.error}`,
  );
  const nft = await slotInfo(hederaClient(A.id, A.key), tokenId, serial);
  expect("the reissued NFT now names the new ticket", nft.owner === A.id && nft.meta.t === later.body.ticket, JSON.stringify(nft));
}
