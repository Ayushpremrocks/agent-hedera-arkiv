# Arkiv friction log

Each entry: what I expected, what happened, steps to reproduce.

## 2026-11-06 — docs URLs redirect chain
- **Expected:** `arkiv.dev.golem.network/docs/sdk` (top search result) to show the SDK reference.
- **Actual:** 308 → `docs.arkiv.network/typescript-sdk/querying-data` → 301 → `/querying/select/`. Search results also show two testnets (Kaolin in the v0.6 docs, Mendoza in the v0.4.4 tutorial) while npm has `@arkiv-network/sdk@1.0.1`, so it wasn't obvious which network is current.
- **Repro:** search "arkiv typescript sdk", open the first docs result.
