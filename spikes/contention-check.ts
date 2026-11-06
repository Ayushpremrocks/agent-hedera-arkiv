// What happens to promises when something else uses the provider's GPU? Books real jobs through the
// provider while a separate process loads the same model server directly (traffic the scheduler
// can't see), then reads the outcome from the provider's signed log: did tickets start by their
// promise, and did their jobs finish or get killed at their limit?
//   FLOOD=0 node --import tsx spikes/contention-check.ts   (baseline: same jobs, no outside load)
import { type Job, LATE_AFTER, type LoggedEvent, hbarPayer, jobHash, postPaid, readEvents, role, signRequest } from "@qy/shared";

const URL = process.env.PROVIDER_URL ?? "http://localhost:4000";
const LLM = process.env.LLM_BASE_URL ?? "http://localhost:11434/v1";
const MODEL = process.env.LLM_MODEL ?? "qwen2.5:0.5b-instruct";
const FLOOD = Number(process.env.FLOOD ?? 3); // concurrent outside generations
const JOBS = 8;
const now = () => Math.floor(Date.now() / 1000);
const run = now();

// 1. Outside load the scheduler doesn't know about: long generations straight to the model server.
let flooding = FLOOD > 0;
async function flood() {
  while (flooding) {
    await fetch(`${LLM}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 1500, messages: [{ role: "user", content: `Write a very long story, part ${Math.random()}.` }] }),
    }).catch(() => {});
  }
}
const floods = Array.from({ length: FLOOD }, flood);
if (FLOOD) await new Promise((r) => setTimeout(r, 4000)); // let the outside load get going

// 2. Book ordinary jobs through the provider, as agents would.
const who = [role("AGENT_A"), role("AGENT_B"), role("AGENT_C")];
const booked: { ticket: number; startBy: number; limit: number }[] = [];
let topicId = "";
for (let i = 0; i < JOBS; i++) {
  const w = who[i % who.length];
  const job: Job = { kind: "llm", task: "Write a detailed paragraph.", input: `About GPU queues, take ${i} (run ${run}).`, maxTokens: 300, deadline: now() + 900, label: `contention ${i}` };
  const r = await postPaid(`${URL}/book`, { job, ...signRequest("book", w.id, w.key, jobHash(job)) }, hbarPayer(w.id, w.key, 1_000_000_000n));
  if (r.status !== 200) {
    console.log(`booking ${i} refused: ${r.status} ${r.body.error}`);
    continue;
  }
  booked.push({ ticket: r.body.ticket, startBy: r.body.startBy, limit: r.body.limit });
  topicId = r.body.topicId;
}
console.log(`booked ${booked.length} jobs (limit ${booked[0]?.limit}s each) with ${FLOOD} outside generations running`);

// 3. Wait for every ticket's start and result to reach the signed log.
const first = Math.min(...booked.map((b) => b.ticket));
let events: LoggedEvent[] = [];
const ev = (type: string, ticket: number) => events.find((x) => x.e.type === type && (x.e as any).ticket === ticket);
for (let i = 0; i < 40 && !booked.every((b) => ev("done", b.ticket)); i++) {
  await new Promise((r) => setTimeout(r, 6000));
  const latest = Number(((await (await fetch(`https://testnet.mirrornode.hedera.com/api/v1/topics/${topicId}/messages?order=desc&limit=1`)).json()) as any).messages[0].sequence_number);
  events = [];
  for (let seq = latest - 60, batch; (batch = await readEvents(topicId, seq, 100)).length; seq = batch.at(-1)!.seq) events.push(...batch);
}
flooding = false;

// 4. What the escrow would see.
let late = 0, killed = 0, ok = 0;
for (const b of booked) {
  const d = ev("dispatch", b.ticket);
  const done = ev("done", b.ticket);
  const lateness = d ? d.ts - b.startBy : NaN;
  const dn = done?.e.type === "done" ? done.e : null;
  if (!(lateness <= LATE_AFTER)) late++;
  if (dn?.ok) ok++;
  else killed++;
  console.log(
    `ticket #${b.ticket}: started ${d ? `${lateness.toFixed(0)}s vs promise` : "never"}, ${dn ? (dn.ok ? `finished in ${(dn.ms / 1000).toFixed(1)}s` : `KILLED: ${dn.result}`) : "no result"}`,
  );
}
console.log(`\nSUMMARY outside load ${FLOOD}: ${booked.length - late}/${booked.length} started on time, ${ok}/${booked.length} finished, ${killed} killed or failed (first ticket #${first})`);
await Promise.race([Promise.all(floods), new Promise((r) => setTimeout(r, 2000))]);
process.exit(0);
