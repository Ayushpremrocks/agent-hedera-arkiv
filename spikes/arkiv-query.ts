// Read dani.ai's live data from Arkiv: no keys needed (uses Arkiv's public endpoint unless ARKIV_ACCESS_KEY is set).
//   pnpm arkiv:query
import { and, asc, eq, gte } from "@arkiv-network/sdk/query";
import { u64 } from "@arkiv-network/sdk/schema";
import { AgentRecord, ProviderProfile, SlotOffer, TaskRecord, Trade, arkivReader } from "@qy/shared";

const r = arkivReader();
const now = Math.floor(Date.now() / 1000);

// 1. The providers agents can book right now, cheapest first (what the app's provider list shows).
const providers = await r.select().from(ProviderProfile).orderBy(asc("price_now")).limit(20).fetch();
console.log(`\nqy_provider: ${providers.entities.length} live`);
for (const p of providers.entities)
  console.log(`  ${p.name.value} (${p.provider.value}) ${p.model.value}: ${p.price_now.value} tinybars, next start by ${Math.max(0, Number(p.next_free.value) - now)}s from now, owner ${p.$owner}`);

// 2. Places in a queue offered for sale that haven't started yet (what an urgent agent filters on).
const offers = await r.select().from(SlotOffer).where(gte("start_by", u64(now))).orderBy(asc("start_by")).limit(20).fetch();
console.log(`\nqy_offer: ${offers.entities.length} open (each expires before its place starts)`);
for (const o of offers.entities) console.log(`  ticket #${o.ticket.value} at ${o.provider.value}: starts by ${Number(o.start_by.value) - now}s from now, from ${o.min_price.value} tinybars, seller ${o.seller.value}`);

// 3. Completed trades, and finished tasks with their result fingerprints.
const trades = await r.select().from(Trade).limit(20).fetch();
console.log(`\nqy_trade: ${trades.entities.length} in the last day`);
for (const t of trades.entities) console.log(`  ticket #${t.seller_ticket.value} for #${t.buyer_ticket.value} at ${t.price.value} tinybars, Hedera tx ${t.swap_tx.value}`);

const done = await r.select().from(TaskRecord).where(and(eq("status", "done"), gte("deadline", u64(now - 7 * 86_400)))).limit(10).fetch();
console.log(`\nqy_task (done, last 7 days): ${done.entities.length} shown`);
for (const t of done.entities) console.log(`  job ${t.job_hash.value.slice(0, 16)}… on ${t.provider.value}, on time: ${t.on_time.value}, result sha256 ${t.result_hash.value.slice(0, 16)}…, agent ${t.$owner}`);

const agents = await r.select().from(AgentRecord).limit(20).fetch();
console.log(`\nqy_agent: ${agents.entities.length} (wallet -> its agent), all written by ${[...new Set(agents.entities.map((a) => a.$owner))].join(", ")}`);
