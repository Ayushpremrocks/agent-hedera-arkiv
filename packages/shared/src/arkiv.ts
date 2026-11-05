import { createPublicClient, createWalletClient } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { and, asc, eq, gte, lt, lte } from "@arkiv-network/sdk/query";
import { defineSchema, str, u64 } from "@arkiv-network/sdk/schema";
import { http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Named schemas tag each entity with arkiv.schema, which replaces the plan's type="qy_*" field.
// Prices are tinybars (HBAR is the x402 asset), times are unix seconds.

export const ProviderProfile = defineSchema("qy_provider", {
  provider: str().indexed(), // Hedera account id
  token_id: str(),
  topic_id: str(),
  slot_seconds: u64(),
  booking_url: str(),
});

export const SlotOffer = defineSchema("qy_offer", {
  provider: str().indexed(),
  slot_serial: u64().indexed(),
  slot_start: u64().indexed(),
  latest_ok_start: u64().indexed(), // seller's deadline minus runtime
  min_price: u64().indexed(),
  seller: str(), // seller's Hedera account id
  endpoint: str(), // seller's x402 swap endpoint
  job_hash: str(),
});

export const Trade = defineSchema("qy_trade", {
  provider: str().indexed(),
  seller_serial: u64().indexed(),
  buyer_serial: u64().indexed(),
  price: u64().indexed(),
  payment_tx: str(),
  swap_tx: str(),
  hcs_seq: str(),
});

const chain = () => rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY ?? "" });

export const arkivReader = () => createPublicClient({ chain: chain(), transport: http() });

export function arkivWriter(evmKey: `0x${string}`) {
  return createWalletClient({ chain: chain(), transport: http(), account: privateKeyToAccount(evmKey) });
}

/**
 * Offers a buyer holding a slot at `myStart` can take: the offered slot is earlier, and the seller
 * still meets its deadline if it moves to `myStart`. The deadline check lives in the query itself.
 */
export function offerFilter(provider: string, myStart: number, budget: bigint) {
  return and(
    eq("provider", provider),
    lt("slot_start", u64(myStart)),
    gte("latest_ok_start", u64(myStart)),
    lte("min_price", u64(budget)),
  );
}

export function findOffers(reader: ReturnType<typeof arkivReader>, provider: string, myStart: number, budget: bigint) {
  return reader
    .select()
    .from(SlotOffer)
    .where(offerFilter(provider, myStart, budget))
    .orderBy(asc("min_price"))
    .limit(20)
    .fetch();
}
