// Spike (a): write offers, range-query with the deadline filter, delete, and watch expiry.
import { ExpirationTime } from "@arkiv-network/sdk";
import { u64 } from "@arkiv-network/sdk/schema";
import { SlotOffer, arkivReader, arkivWriter, evmKey, findOffers, need } from "@qy/shared";

const writer = arkivWriter(evmKey(need("AGENT_B_KEY")));
const reader = arkivReader();
const provider = `spike-${Date.now()}`; // isolates this run's rows
const now = Math.floor(Date.now() / 1000);

const offer = (serial: number, start: number, latestOk: number, price: number, lifeSec: number) =>
  writer.createEntity(
    SlotOffer,
    {
      provider,
      ticket: u64(serial),
      eta: u64(start),
      latest_ok_start: u64(latestOk),
      min_price: u64(price),
      seller: need("AGENT_B_ID"),
      endpoint: "http://localhost:0",
      job_hash: "0x00",
    },
    { expiration: ExpirationTime.fromSeconds(lifeSec) },
  );

const myStart = now + 300;
// B: earlier slot, flexible deadline -> should match. C: deadline before myStart -> must not.
// D: price over budget -> must not. E: short-lived -> should vanish after expiry.
const b = await offer(1, now + 60, now + 600, 1_000, 3600);
const c = await offer(2, now + 90, now + 200, 500, 3600);
const d = await offer(3, now + 30, now + 900, 99_999, 3600);
const e = await offer(4, now + 45, now + 900, 800, 30);
console.log("created", { b: b.entityKey, c: c.entityKey, d: d.entityKey, e: e.entityKey });

const keys = async () => (await findOffers(reader, provider, { myStart, myLatest: myStart, notBefore: now, budget: 5_000n })).entities.map((r) => r.$key);
const first = await keys();
console.log("match now (expect B,E cheapest-first: E,B):", first);
console.assert(first.length === 2 && first[0] === e.entityKey && first[1] === b.entityKey, "range query wrong");

await writer.deleteEntity({ entityKey: b.entityKey });
console.log("after deleting B (expect E):", await keys());

console.log("waiting 45s for E to expire...");
await new Promise((r) => setTimeout(r, 45_000));
const last = await keys();
console.log("after expiry (expect []):", last);
console.assert(last.length === 0, "expiry did not remove E");

for (const k of [c.entityKey, d.entityKey]) await writer.deleteEntity({ entityKey: k });
console.log("spike (a) done");
