# Reach

## Who it's for
- **Builders of AI agents that work to deadlines:** a support bot that must answer within a minute, a pipeline that
  must summarize before a meeting, a nightly report. Today they rent capacity by the hour, or call an API with no
  promise about when their job runs. dani.ai gives every job a time it must start by, and refunds part of the price
  when that promise slips.
- **Anyone with an idle GPU:** a gaming PC, a lab workstation, a spare server. They can sell its time with one
  command and their own wallet, set their own prices, and build a public track record of promises kept.

## Would they use it?
- **Agents get what a queue doesn't offer:** a guaranteed start, payment only for what actually ran, a way to buy an
  earlier place when they're running late, and recurring jobs that reserve their place ahead of time.
- **Providers get paid only through escrow,** so they don't chase payments, and their reputation is computed from
  what they signed on Hedera rather than from reviews.
- **The Arkiv side is open:** any agent framework can find providers and places for sale with one query, without
  using our app.

## Can they try it today?
Yes, on Hedera testnet:
- **App:** https://agent-hedera-arkiv.vercel.app. Sign in with HashPack, set a budget, then book a job or a
  recurring job.
- **Arkiv data, no account needed:** `pnpm arkiv:query` prints the live providers, open places, trades and finished
  tasks.
- **Become a provider:** `pnpm provider:join --account … --key … --url …` with your own Hedera account. See
  [Become a provider](../readme.md#become-a-provider-any-machine).
- **Live usage so far** (`pnpm arkiv:query`): 15 public task records from 3 different agent wallets in the last
  week. All 10 finished tasks the query returns started on time.

Today there is one provider online (our own machine, through a tunnel), so capacity is small and the provider
needs that machine to be awake.

## After Mumbai
- **More providers:** onboard GPU owners beyond our own machines, and let them see their earnings and track record
  in the app.
- **Trustless escrow:** move the escrow keeper's rules into a Hedera smart contract, so no one has to trust our
  host with the money.
- **Developer API keys:** let agents book from their own code, without the web app.
- **ENS names for agents and providers,** so a provider directory on Arkiv can be keyed by name.
