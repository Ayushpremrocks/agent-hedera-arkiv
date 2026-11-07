# Arkiv schema

dani.ai writes five entity types to Arkiv's testnet (`rabdi`) with `@arkiv-network/sdk`. Each is a named schema
(`defineSchema`) in [packages/shared/src/arkiv.ts](../packages/shared/src/arkiv.ts). Prices are tinybars (HBAR),
times are unix seconds, and ids like `0.0.11330602` are Hedera accounts.

Run `pnpm arkiv:query` to read all of them live. It needs no keys.

| Entity | What it is | Owner (`$owner`) | Expires |
|---|---|---|---|
| `qy_provider` | A GPU provider's live offer | The provider's own wallet | 10 minutes, renewed every 30 s while the provider runs |
| `qy_offer` | An agent offering its place in a provider's queue for sale | The selling agent's wallet | Before the place starts: at most 5 minutes ahead, re-listed while still sellable |
| `qy_trade` | A completed swap of two places | The selling agent's wallet | 1 day |
| `qy_agent` | Which agent works for which wallet | The host's wallet | 30 days, renewed whenever the host starts |
| `qy_task` | One task's public trail, with no private content | The agent that ran it | 7 days |

## `qy_provider`: a provider's offer
[Schema](../packages/shared/src/arkiv.ts#L13). Written by the provider ([packages/provider/src/index.ts](../packages/provider/src/index.ts#L585-L599)).

| Field | Indexed | Used for |
|---|---|---|
| `provider` | yes | Who it is (Hedera account); readers check it maps to `$owner` |
| `model` | yes | Filter providers by model |
| `price_now` | yes | Sort cheapest first |
| `next_free` | yes | The start-by time a booking made now would get |
| `name`, `token_id`, `topic_id`, `booking_url`, `escrow`, `bands`, `tps`, `startup_ms`, `max_tokens`, `run_seconds`, `workers` | no | Where to book, its prices by size, its measured speed, its ticket NFT and HCS log |

- **Owner:** the provider's own key, which is also its Hedera account's ECDSA key, so `$owner` can be checked against
  the account. Only the provider can update or delete it.
- **Expiry:** 10 minutes, extended every 30 seconds. A provider that goes offline drops out of the market within 10
  minutes with no clean-up code anywhere.

## `qy_offer`: a place for sale
[Schema](../packages/shared/src/arkiv.ts#L34). Written by agents with time to spare
([packages/agent/src/agent.ts](../packages/agent/src/agent.ts#L602-L616)).

| Field | Indexed | Used for |
|---|---|---|
| `provider` | yes | Places only trade within one provider's queue |
| `start_by` | yes | The provider's promise for this place: earlier than the buyer's, after "now" |
| `latest_ok_start` | yes | The latest place the seller accepts in exchange and still meets its own deadline |
| `max_tokens` | yes | Big enough for the buyer's job |
| `min_price` | yes | Within the buyer's budget; sorted cheapest first |
| `ticket` | yes | Which ticket |
| `seller`, `endpoint`, `job_hash` | no | Who sells it and where to send the payment |

- **Owner:** the seller agent. The buyer only pays if `$owner` is the seller's own wallet
  ([agent.ts#L534](../packages/agent/src/agent.ts#L534)), so nobody can list someone else's place.
- **Expiry:** `ExpirationTime.atDate(...)`, no later than 15 seconds before the place starts and at most 5 minutes
  ahead. The seller re-lists it while it can still be sold, and deletes it once it's sold or no longer spare.

The buyer's whole match runs as one Arkiv query ([`offerFilter`](../packages/shared/src/arkiv.ts#L72)):

```ts
select().from(SlotOffer).where(and(
  eq("provider", provider),
  lte("start_by", u64(min(myStart - 1, myLatest))),  // earlier than mine, and early enough for my deadline
  gte("start_by", u64(notBefore)),                   // not about to start
  gte("max_tokens", u64(myJobSize)),                 // fits my job
  gte("latest_ok_start", u64(myStart)),              // the seller still makes its deadline with my place
  lte("min_price", u64(budget)),                     // I can afford it
)).orderBy(asc("min_price")).limit(20)
```

## `qy_trade`: a completed swap
[Schema](../packages/shared/src/arkiv.ts#L46). Written by the seller after the atomic Hedera swap
([agent.ts#L718](../packages/agent/src/agent.ts#L718)).

| Field | Indexed | Used for |
|---|---|---|
| `provider`, `seller_ticket`, `buyer_ticket`, `price` | yes | Listing swaps by provider and price |
| `swap_tx`, `hcs_seq` | no | The Hedera transaction that moved both NFTs and the HBAR, and the provider's log entry |

- **Owner:** the seller agent.
- **Expiry:** 1 day. It's a recent-activity feed; the permanent proof is the Hedera transaction it points to.

## `qy_agent`: wallet to agent
[Schema](../packages/shared/src/arkiv.ts#L96). Written by the host when a user's agent is created
([packages/host/src/mirror.ts](../packages/host/src/mirror.ts#L30)).

| Field | Indexed |
|---|---|
| `owner` (the user's wallet account), `agent` (the agent's account) | yes |
| `created_at` | no |

- **Owner:** the host's wallet.
- **Expiry:** 30 days, extended each time the host starts with that agent.

## `qy_task`: a task's public trail
[Schema](../packages/shared/src/arkiv.ts#L103). Created by the agent when it books a task, and patched as the task
runs ([mirror.ts#L56-L66](../packages/host/src/mirror.ts#L56)).

| Field | Indexed | Used for |
|---|---|---|
| `owner`, `agent`, `provider` | yes | A wallet's, an agent's or a provider's tasks |
| `job_hash` | yes | The same sha256 the provider logs on Hedera, linking the two |
| `status` | yes | `queued`, `running`, `done` or `failed` |
| `deadline` | yes | Recent tasks |
| `result_hash`, `on_time`, `finished_at`, `serial` | no | Anyone can check a result against its fingerprint |

- **Owner:** the agent that ran the task, so only it can update the record.
- **Expiry:** 7 days.
- **No private content:** the instructions, inputs and results never leave the host's database. Only hashes go on
  Arkiv.
