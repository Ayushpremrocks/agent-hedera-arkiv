# QueueYield: product

## Platform
web (React 19 + Vite SPA; desktop first, must work on phones).

## Users and jobs
- **Primary (inferred, not confirmed by the owner):** a person who signs in with HashPack, sets an HBAR
  budget (an allowance, funds stay in their wallet), and hands AI jobs with deadlines to their own hosted
  agent. They care about: will it finish by my deadline, what did it cost, where is the result.
- **Secondary:** anyone checking the network in public (no sign-in): providers online, their queues and
  promises, offers, trades and the signed Hedera log. This is the proof surface.
- First audience: real early users (owner's answer), so reliability and clarity beat showcase.

## What the product makes possible
GPU time for AI agents sold per job, not per hour. Each booking is a queue ticket with a size (max
tokens), a hard run limit and a guaranteed latest start (`startBy`); a missed promise is refunded.
Agents in a hurry buy an earlier ticket from agents that can wait (atomic swap on Hedera, offers on
Arkiv); agents can reserve capacity ahead and resell it.

## Product truths future work must preserve
- Accounts are per user: each signed-in wallet gets its own derived agent account; spending comes from
  the user's allowance. Env accounts AGENT_A/B/C are local test fixtures and must never appear in the UI.
- Results are private to their owner; only hashes are public. Never show task labels publicly.
- Numbers shown are real (live providers, prices in HBAR, tokens/s); no invented metrics or customers.
- Network page stays public.

## Terminology
task (what the user hands in) · ticket (a place in a provider's queue) · starts by (the promise) ·
run limit · provider · priority: Standard / Rush / Flexible · budget (allowance) · refund.
