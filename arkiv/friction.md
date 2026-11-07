# Arkiv friction log

What got in our way building dani.ai on `@arkiv-network/sdk` 1.0.1 against the `rabdi` testnet, roughly in order of
how much it cost us. Each item says what we expected, what happened, and how to reproduce it.

## 1. Numbers in filters must be wrapped in `u64(...)`, and only fail at runtime
- **Expected:** the schema already says `start_by` is `u64()`, so `gte("start_by", BigInt(now))` (or a plain number)
  would be coerced, or rejected by TypeScript.
- **What happened:** it compiles, then throws when the query runs:
  `InvalidPredicateError: "start_by" is a u64 column, but the predicate asserts a u256, so it could never match. Write u64(...) around the value.`
  The message is good, but we hit it in production code paths, not at build time. Every filter and every write in our
  code wraps values in `u64(...)`.
- **Reproduce:** `reader.select().from(SlotOffer).where(gte("start_by", BigInt(Date.now() / 1000 | 0))).fetch()`
  against any schema with a `u64()` field.
- **Suggestion:** infer the literal type from the schema column in `eq/gte/lte`, or make the predicate's value type
  depend on the column, so the mistake is a type error.

## 2. Results are capped at 100, with no pagination helper
- **Expected:** `.limit(200)`, or a way to get everything that matches.
- **What happened:** `Error: limit 200 exceeds the node maximum of 100. Page through the results with an offset instead.`
  This is also only at runtime; we wrote our own offset loop.
- **Reproduce:** `reader.select().from(TaskRecord).limit(200).fetch()`.
- **Suggestion:** a `fetchAll()` or async iterator that pages for you. A cursor would also avoid the gaps and
  duplicates an offset gives you when entities expire between pages, which in a market happens all the time.

## 3. Renewing an entity takes two transactions
- **What we do:** each provider updates its `qy_provider` entity every 30 seconds (new price, next start time) and
  extends its expiry, which is `patchEntity` followed by `extendEntity`. That's two transactions per renewal,
  about 5,760 a day per provider.
- **Suggestion:** let `patchEntity` take an `expiration`, or add one "update and extend" call.

## 4. Writes from one wallet have to be queued by hand
- **Expected:** several `createEntity` and `patchEntity` calls from the same wallet client could be issued at once.
- **What happened:** overlapping writes from one account race on its nonce, so we serialize every write per
  wallet ourselves ([mirror.ts](../packages/host/src/mirror.ts#L13-L22)). Every agent publishes its task records
  while it books, so this matters for us.
- **Suggestion:** have the wallet client queue or manage nonces per account, or document that callers must.

## 5. Deleting an entity that already expired throws
- **Expected:** deleting something that's already gone is a no-op, or raises a recognizable "expired" error.
- **What happened:** an agent unlisting a place (its offer may have just expired) gets an error, so we swallow every
  error from `deleteEntity` ([agent.ts#L576](../packages/agent/src/agent.ts#L576)). That also hides real failures.
- **Suggestion:** make delete idempotent, or give the "not found / expired" case its own error type.

## 6. No browser-safe access key
- **Situation:** the web app reads offers and trades from Arkiv directly in the browser. An access key raises the
  rate limit, but anything in the browser bundle is public.
- **What we did:** the browser uses the public, rate-limited endpoint. The Network page refreshes offers every 6
  seconds, so busy moments can hit the limit.
- **Suggestion:** read-only keys, ideally restricted to an origin, that are safe to ship to a browser.

## 7. Every user's wallet needs gas before it can write
- **Situation:** each signed-in user gets an agent with its own wallet, so that its offers and task records are
  owned by it.
- **What happened:** a new wallet can't write until it holds tGLM. So sign-up includes sending each new agent
  0.02 tGLM and waiting for that transaction ([index.ts#L199](../packages/host/src/index.ts#L199)), which adds a round trip to
  the first sign-in.
- **Suggestion:** sponsored writes (a funder pays for another wallet's entities), or a way to grant write gas to a
  wallet.

## 8. Ownership is an EVM address; our identities aren't
- **Situation:** providers and agents are Hedera accounts, so `$owner` (an EVM address) can't be compared directly
  with the `provider` field. Every reader maps the Hedera account to its EVM address through Hedera's mirror node,
  then compares ([hub.ts#L54](../packages/agent/src/hub.ts#L54)). Anyone can write a `qy_provider` claiming any
  provider id; only this check stops an impostor.
- **Suggestion:** document the "rows are claims, check `$owner`" pattern prominently, because it's easy to skip. A
  query-side way to say "only rows whose `X` field equals the owner's verified identity" would be even better.

## What worked well
- **Expiry fits a market.** `ExpirationTime.atDate(...)` for "gone before the place starts" and short TTLs for live
  offers removed all our clean-up code.
- **Typed schemas.** `defineSchema` with `indexed()` columns, plus `render(query)`, made it easy to show users the
  exact query an agent runs.
- **`ownedBy(address)`** made "my own old profiles" a one-line query when a provider restarts.

## What we'd like next
- **Subscriptions.** We poll: the agents every 30 s, the browser every 6 to 10 s. A push subscription for "new
  entities matching this query" would let an urgent agent see a new offer the moment it's listed.
