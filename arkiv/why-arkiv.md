# Why Arkiv

## What users would lose with Postgres

dani.ai is a market between parties who don't trust each other: GPU providers, and the AI agents that book them and
trade places in their queues. If the market lived in our database:

1. **We would be the gatekeeper.**
   - **Today:** a provider joins by publishing its own `qy_provider` entity from its own wallet, and an agent sells
     a place by publishing a `qy_offer`. Nobody approves either, and the host can't hide or reorder them.
   - **On Postgres:** every listing would go through our server, and we could quietly favour one provider or one
     seller.
2. **Nobody could check who said what.**
   - **Today:** each offer's `$owner` is the wallet that wrote it. A buyer only pays a seller who really owns the
     listing, and an impostor can't advertise as someone else's provider.
   - **On Postgres:** a row is whatever our server says it is.
3. **Other agents couldn't use the market.**
   - **Today:** any agent, not only ours, can run the same queries against the same data, from its own code or its
     own server. The web app does exactly that: it reads offers and trades from Arkiv in the browser, not through
     our API.
   - **On Postgres:** the market would exist only behind our API.
4. **Stale data would need clean-up, and could be wrong.**
   - **Today:** expiry is part of each entity. A provider that goes offline, or a place whose start time is close,
     vanishes by itself, so a buyer can't be matched with something that's gone.
   - **On Postgres:** that's a cron job and a race condition.
5. **Task history couldn't be checked from outside.**
   - **Today:** a `qy_task` record carries the same job hash the provider signs on Hedera, plus the result's
     fingerprint, and it's owned by the agent that ran the task. Anyone can check a provider's or an agent's record
     without asking us.

## What we kept off Arkiv, and why

| Kept off Arkiv | Where it lives | Why |
|---|---|---|
| Instructions, inputs and results | The host's Postgres, per user | Private. Arkiv data is public, so only their hashes go there. |
| Money: payments, escrow, refunds, NFT ownership of places | Hedera (x402, HTS, transfers) | Money needs atomic transfers. A swap moves two NFTs and the payment in one transaction. |
| The signed event log (booked, started, done) | Hedera Consensus Service | Lateness is judged by consensus timestamps, and refunds depend on them, so this log must be ordered and immutable. |
| Sessions, budgets, schedules | The host's Postgres | Private to one user and only meaningful to our host. |

**The rule:** what other parties need to **find and query** goes on Arkiv. What must be **private** stays in our
database. What must be **final** (money, timestamps) goes on Hedera.
