import { createPublicClient, createWalletClient } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { and, asc, eq, gte, lte } from "@arkiv-network/sdk/query";
import { defineSchema, str, u64 } from "@arkiv-network/sdk/schema";
import { http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Named schemas tag each entity with arkiv.schema, which replaces the plan's type="qy_*" field.
// Prices are tinybars (HBAR is the x402 asset), times are unix seconds.

// A provider's live offer, like a Golem Offer: what it runs and when it's free. The provider renews it
// every few seconds with a short expiry, so a provider that goes offline drops out of the market.
export const ProviderProfile = defineSchema("qy_provider", {
  provider: str().indexed(), // Hedera account id
  name: str(),
  token_id: str(),
  topic_id: str(),
  run_seconds: u64(), // typical job run time, for estimating when a queued ticket starts
  booking_url: str(),
  model: str().indexed(),
  workers: u64(),
  price_now: u64().indexed(), // current booking price, tinybars
  next_free: u64().indexed(), // estimated start of a ticket booked now, unix seconds
});

// An agent offering its place in a provider's queue. `eta` is the provider's estimate of when that
// ticket starts; the buyer gives back its own (later) ticket plus the price.
export const SlotOffer = defineSchema("qy_offer", {
  provider: str().indexed(),
  ticket: u64().indexed(),
  eta: u64().indexed(),
  latest_ok_start: u64().indexed(), // latest start the seller can take in exchange and still meet its deadlines
  min_price: u64().indexed(),
  seller: str(), // seller's Hedera account id
  endpoint: str(), // seller's x402 swap endpoint
  job_hash: str(),
});

export const Trade = defineSchema("qy_trade", {
  provider: str().indexed(),
  seller_ticket: u64().indexed(),
  buyer_ticket: u64().indexed(),
  price: u64().indexed(),
  swap_tx: str(), // one atomic transaction: both slots and the HBAR price
  hcs_seq: str(),
});

// An empty key uses Arkiv's public (rate-limited) endpoint; the browser passes its own or none.
const chain = (accessKey = process.env.ARKIV_ACCESS_KEY ?? "") => rabdi({ accessKey });

export const arkivReader = (accessKey?: string) => createPublicClient({ chain: chain(accessKey), transport: http() });

export function arkivWriter(evmKey: `0x${string}`) {
  return createWalletClient({ chain: chain(), transport: http(), account: privateKeyToAccount(evmKey) });
}

/** What a buyer holding a slot at `myStart` is looking for. All times are unix seconds. */
export type Want = { myStart: number; myLatest: number; notBefore: number; budget: bigint };

/**
 * Offers the buyer can take: the slot is earlier than the buyer's own and meets the buyer's deadline
 * (`myLatest` = deadline minus one slot), it isn't about to start, the seller still meets its own
 * deadline after moving to `myStart`, and the price fits the budget. All of it runs on Arkiv.
 */
export function offerFilter(provider: string, w: Want) {
  return and(
    eq("provider", provider),
    lte("eta", u64(Math.min(w.myStart - 1, w.myLatest))),
    gte("eta", u64(w.notBefore)),
    gte("latest_ok_start", u64(w.myStart)),
    lte("min_price", u64(w.budget)),
  );
}

export function findOffers(reader: ReturnType<typeof arkivReader>, provider: string, w: Want) {
  return reader.select().from(SlotOffer).where(offerFilter(provider, w)).orderBy(asc("min_price")).limit(20).fetch();
}

/** Live provider profiles, cheapest first; optionally only those running `model`. Rows are claims: check `$owner`. */
export function findProviders(reader: ReturnType<typeof arkivReader>, model?: string) {
  const q = reader.select().from(ProviderProfile);
  return (model ? q.where(eq("model", model)) : q).orderBy(asc("price_now")).limit(100).fetch();
}

// ---- the app's public records: written by the host and its agents, readable and verifiable by anyone ----

/** Which agent works for which wallet. Written by the host, so `$owner` is the host's key. */
export const AgentRecord = defineSchema("qy_agent", {
  owner: str().indexed(), // the user's wallet account
  agent: str().indexed(), // the agent's Hedera account
  created_at: u64(),
});

/** One task's public trail. Written by the agent that ran it; inputs and results stay private. */
export const TaskRecord = defineSchema("qy_task", {
  owner: str().indexed(),
  agent: str().indexed(),
  job_hash: str().indexed(), // sha256 of the job, the same hash the provider logs on HCS
  status: str().indexed(), // queued | running | done | failed
  deadline: u64().indexed(),
  provider: str().indexed(),
  serial: u64(), // queue ticket
  result_hash: str(), // sha256 of the result, matching the provider's signed `done` event
  on_time: str(), // "yes" | "no" | ""
  finished_at: u64(),
});
