# How we use Arkiv

Every Arkiv feature we use maps to something a user sees or relies on. Field-by-field details are in
[schema.md](schema.md).

## What users see that comes from Arkiv

| What the user sees | Where | Arkiv read |
|---|---|---|
| The list of providers and their prices, and the plan before booking ("starts by …, deposit …") | New task page, Network status | `qy_provider`, cheapest first. The host's agents read it every 30 s ([hub.ts](../packages/agent/src/hub.ts#L50-L80)) and serve it at `/api/market` |
| "N earlier places on offer right now" | New task page | `qy_offer` ([NewTask.tsx#L423](../packages/web/src/pages/NewTask.tsx#L423)) |
| Places offered for swaps, with a badge when the row was really written by the seller it names | Network status | `qy_offer`, read straight from the browser ([market.ts#L96-L109](../packages/web/src/lib/market.ts#L96)) |
| "Run the buyer's query": the exact Arkiv filter an urgent agent sends, rendered from the user's own ticket | Network status | `render(offerFilter(...))` ([Market.tsx#L363-L395](../packages/web/src/pages/Market.tsx#L363)) |
| Completed swaps, each next to the seller's signed Hedera message | Network status | `qy_trade` ([market.ts#L116](../packages/web/src/lib/market.ts#L116)) |
| A late job moved earlier without the user doing anything | Task page | The agent's `qy_offer` query, which picks the swap it buys |
| "Public record on Arkiv" key for each task and for your agent | Task page, Settings | `qy_task` and `qy_agent` keys |

## Does each feature fit the app?

**What we filter on.** Every indexed field is one a real query filters or sorts on. Nothing is indexed "just in
case":
- **Buying a place:** the match is one query over `provider`, `start_by`, `latest_ok_start`, `max_tokens` and
  `min_price`. Both sides' deadlines are checked inside Arkiv, so an agent never downloads offers it can't use.
- **Choosing a provider:** sort by `price_now`, with `model` to narrow down.
- **Task records:** `owner`, `agent`, `provider`, `job_hash` and `status` let anyone list a wallet's or a
  provider's tasks, or find the one record for a job hash seen on Hedera.

**Who can edit.** Each entity is owned by whoever made the claim in it, and only they can change it:
- **Providers** own their offers. We check that `$owner` matches the provider's Hedera account, so an impostor's row
  is ignored ([hub.ts#L54](../packages/agent/src/hub.ts#L54)).
- **Sellers** own their places. A buyer refuses to pay unless `$owner` is the seller's wallet
  ([agent.ts#L534](../packages/agent/src/agent.ts#L534)).
- **The agent that ran a task** owns its record, so neither the host nor the provider can rewrite it.

**When things expire.** Every expiry matches how long the data is true:
- **A provider's offer** lives 10 minutes and is renewed every 30 s. When a provider stops, it disappears from every
  user's list on its own.
- **A place for sale** expires before the place starts (`ExpirationTime.atDate`), so a buyer can never be matched
  with a place that has already gone.
- **Trades** live a day (a recent-activity feed), **task records** a week, and **agent records** a month, renewed
  while the agent is active.

## Numbers (live, from `pnpm arkiv:query`)
At the time of writing:
- **1 live provider profile.**
- **15 task records**, written by 3 different agent wallets.
- **6 agent records.**
- **0 open offers and 0 trades.** That's expected when nobody is trading: offers expire before their place starts,
  and trades after a day. `pnpm demo` creates both on purpose.
