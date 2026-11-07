# dani.ai

**AI jobs that run on time, and a market to trade your place in line.**

dani.ai is a market for GPU time aimed at AI agents. Every job gets a time it must start by. The payment waits in
escrow until that promise is kept, and an agent that's running late can buy an earlier place from one that can wait.
It runs on Hedera testnet, with Arkiv for discovery and public records.

Built for EthGlobal Mumbai 2026 by Sudhanshu Bharti and Ayush Prem.

---

## The problem

GPU capacity is rented by the hour, and a queue makes no promise about when a job will run. AI agents work to
deadlines, so an urgent job stuck behind one that could wait all day is a real failure, and today there's no way to
move up.

## How dani.ai works

### 1. Every job gets a promised start time
A provider measures its slowest speed when it starts up (every worker busy, long inputs, long outputs). From that, each
job gets a run limit: `(startup + tokens ÷ slowest speed) × 1.25`. The provider plays its queue forward assuming every
job uses its whole limit; where a new booking lands is its **start-by time**. Real jobs finish early, so tickets only
ever start sooner. New bookings go to the back of the queue, so no existing promise ever moves.

### 2. Jobs are never cut short
A job that runs past its limit still finishes. It's already capped by its own token count, and only a model server
that has hung is stopped. The provider absorbs an overrun: tickets behind it may start late, and the escrow credits
them. The provider's speed estimate follows the last ten minutes of real jobs, so a burst of outside load makes new
promises more cautious, and they recover once the load passes.

### 3. Pay for what runs, through escrow
Each provider sets its own prices by job size, for example up to 256 tokens 0.5¢, up to 1,024 tokens 1¢, up to 4,096
tokens 2¢. Demand raises all of them together.
- **Booking:** the buyer deposits the price of the band the job's maximum size falls in. The payment goes into
  **escrow**, not to the provider.
- **After the job runs:** the escrow charges the band the job actually used and returns the rest of the deposit.
- **If the promise slips,** part of the charge comes back, judged by Hedera's consensus timestamps, never anyone's clock:

| What happened | Back to the buyer |
|---|---|
| Started on time and delivered | nothing; the provider is paid |
| Started up to 30 s late | 25% of the charge |
| Started up to 60 s late | 50% of the charge |
| Started later than that, failed, or never started | everything |

### 4. A market to trade places
An agent that will miss its deadline finds an earlier place on Arkiv, offered by an agent that can wait. The seller
only accepts a later place that still meets its own deadline. Both places and the payment move in one atomic Hedera
transaction, or nothing moves. Agents can also **reserve** capacity ahead at today's price, attach the job later, and
resell the reservation if plans change.

### 5. NFTs only when they're needed
A booking is just a place in a provider's queue: nothing is minted. Only when a place is traded does it become an
NFT, so the swap can be atomic. Once the ticket has started, the holder hands the NFT back. The next trade rewrites its
metadata and reissues it (about $0.001) instead of minting a new one (about $0.02).

### 6. Recurring jobs
A job can repeat every 15 minutes to every day, for a set number of runs. Before each run, the agent reserves its
place ahead at today's price, so the run starts on time even when the network is busy. Schedules can be paused,
resumed or deleted. Runs missed while the host was down are skipped, not piled up.

### 7. Open to every provider
Anyone with a GPU can join with one command and their own Hedera account; nobody else's keys are involved. Every
provider has a public track record (promises kept, jobs done, refunds) computed from the messages it signed on
Hedera, so it can't be faked.

---

## Built on Hedera and Arkiv

| Network | What dani.ai uses it for |
|---|---|
| **Hedera** | x402 payments into escrow; escrow payouts and refunds; HTS ticket NFTs (minted only to trade, then reused); atomic swaps; one signed, batched HCS log per provider (bookings, starts, results, trades) |
| **Arkiv** | Provider offers (model, speed, prices, next start); places offered for trade, queried by deadline and price; public task records with no private content. Everything expires on its own when it goes stale. |

Instructions, inputs and results stay private to their owner. Only fingerprints (hashes) go on-chain, so anyone can
check a result wasn't altered.

### Arkiv: who writes, and a query to run

Five entity types on Arkiv's `rabdi` testnet: `qy_provider`, `qy_offer`, `qy_trade`, `qy_agent` and `qy_task`. See
[arkiv/schema.md](arkiv/schema.md) for their fields, owners and expiry, and the [arkiv/](arkiv/) folder for the rest.

Wallets that wrote our entities:

| Wallet | Writes |
|---|---|
| `0xaD5e84A085d638E1dA05C3B97F0Ad57e9dfB6538` | `qy_provider` (our provider) |
| `0x0aFb03527c9B512e0AD0aDc5b69438f217b9dd34` | `qy_agent` (the host) |
| `0x498556a2Bdbc5072E3902ba2216d2d5123FE1009`, `0x3257036190716CF6a777CE7427420435d26D6639`, `0x202305E7404e6bFc5A7b6b8462Ccef97b0781D34` | `qy_task` (hosted user agents) |
| `0x1d68DB730e720ce015dF90cA260662bbd3370D64`, `0x9044F2963A3b0384CeF050971962b62B4fFB2cf5`, `0xb96957269bEF2ACc81a37C0CEC2Aa5bd8C178E3D`, `0x3Ca72cb62507CD0Ba2E6574593efD874176Ad8Bd` | `qy_offer`, `qy_trade`, `qy_task` (test agents used in the demos) |

Run it (no keys needed):

```bash
pnpm install
pnpm arkiv:query      # live providers, open places, trades, finished tasks and agents
```

The query an agent runs to buy an earlier place, from [packages/shared/src/arkiv.ts](packages/shared/src/arkiv.ts#L72):

```ts
reader.select().from(SlotOffer).where(and(
  eq("provider", "0.0.11330602"),
  lte("start_by", u64(myStart - 1)), gte("start_by", u64(now + 30)),
  gte("max_tokens", u64(256)), gte("latest_ok_start", u64(myStart)), lte("min_price", u64(budget)),
)).orderBy(asc("min_price")).limit(20).fetch();
```

---

## Repository

```
packages/
  shared/    types and helpers used everywhere: Hedera, Arkiv, x402, HCS log, escrow rules, track records
  provider/  sells GPU time: queue, promises, streaming model runner, tokenizing, joining (provider:join)
  agent/     the agent: books, trades, reserves, verifies results; also the CLI and the fleet runner
  host/      runs one agent per signed-in user, the escrow keeper, and the API for the web app (Postgres)
  web/       React app: landing, the signed-in app, Network status, provider pages, Sell GPU time
spikes/      live checks and the demo (provider-check, host-check, contention-check, demo, ...)
presentation/  the pitch deck, video script and logo
```

---

## Run it locally

You need Node.js 22, pnpm, [Ollama](https://ollama.com), a Hedera testnet account with an ECDSA key
([portal.hedera.com](https://portal.hedera.com)) and an Arkiv access key
([hub.arkiv.network/access-keys](https://hub.arkiv.network/access-keys)).

```bash
pnpm install
cp .env.example .env              # fill in HEDERA_OPERATOR_ID, HEDERA_OPERATOR_KEY, ARKIV_ACCESS_KEY, X402_FACILITATOR_URL
pnpm setup:accounts               # creates a local provider, treasury and test agents, funded from your operator account
ollama pull qwen2.5:0.5b-instruct
```

Then, each in its own terminal:

```bash
pnpm host       # agents for signed-in users, the escrow (it writes ESCROW_ID to .env on first run), API on :4100
pnpm provider   # a provider on :4000, paid through that escrow
pnpm web        # the web app on :5173; sign in with HashPack
```

The `AGENT_A/B/C` accounts that `setup:accounts` creates are local test fixtures for the checks and demos. Real users
never need them: each person who signs in gets their own agent account.

### Become a provider (any machine)

```bash
pnpm provider:join --account 0.0.YOUR_ID --key YOUR_ECDSA_KEY --url http://YOUR_HOST:4000 \
  --name "My GPU" --prices 256:0.5,1024:1,4096:2 --escrow 0.0.ESCROW_ID
QY_ENV=.env.provider pnpm provider
```

The join command checks the key controls the account, creates the provider's own treasury, and writes everything to
`.env.provider`. The web app's **Sell GPU time** page shows the escrow account to use. Agents must be able to reach the
URL you give: a LAN address for agents on your network, a public address or tunnel for everyone.

---

## Deploy

The host and the web app go to the cloud. Providers stay where the GPUs are (your own machine) and are reached
through an HTTPS tunnel.

```
browser ──► web (Vercel) ──/api──► host (one container + volume) ──► provider (your machine, via tunnel) ──► Ollama
   └──────────────── reads /queue directly ─────────────────────────────────┘
```

**Run only one host at a time.** Two hosts with the same `HOST_SECRET` both run the escrow keeper and every user's
agent, and could pay the same ticket twice. Stop the local host before starting the cloud one.

### 1. Host (Railway, Fly.io, Render: any Docker host)
- Deploy the `Dockerfile` at the repository root. Run **one** instance, always on (no scale-to-zero).
- Attach a persistent volume at `/app/data/host`. It holds the escrow's account and state.
- Add a Postgres database and set `DATABASE_URL`. Migrations run on start.
- Set the variables: `HEDERA_OPERATOR_ID`, `HEDERA_OPERATOR_KEY`, `HOST_SECRET` (the same one as before, so existing
  agents and the escrow keep their accounts), `ARKIV_ACCESS_KEY`, `X402_FACILITATOR_URL`, `ESCROW_ID`, and
  `HOST_URL` (the host's own public URL). The platform's `PORT` is picked up.
- Moving from a local host: copy `data/host/escrow.json` and `data/host/escrow-state.json` into the volume if you
  can. If you can't, the escrow finds its account on Hedera and settles only bookings made from then on, so nothing
  is paid twice; let every booking settle locally before switching. Users sign in again; their agents keep their
  accounts. Past task history stays in the local database.

### 2. Web app (Vercel)
- New project from the repository, root directory `packages/web` (Vite is detected; output `dist`).
- In `packages/web/vercel.json`, replace `YOUR-HOST-DOMAIN` with the host's domain.
- Set `VITE_WALLETCONNECT_PROJECT_ID`, and `ENABLE_EXPERIMENTAL_COREPACK=1` so Vercel uses this repository's pnpm.
- Add the Vercel domain to the allowed domains of your WalletConnect (Reown) project, or HashPack won't connect.

### 3. Provider (your machine)
The cloud host books through the provider's URL, and visitors' browsers read its queue, so it needs a public
**HTTPS** address:

```bash
cloudflared tunnel --url http://localhost:4000      # prints https://<random>.trycloudflare.com
PROVIDER_URL=https://<random>.trycloudflare.com pnpm provider
# PowerShell: $env:PROVIDER_URL="https://<random>.trycloudflare.com"; pnpm provider
```

A quick tunnel gets a new URL each time it starts; the provider publishes its current URL on Arkiv when it starts,
so set `PROVIDER_URL` each time. For a URL that never changes, use a named Cloudflare tunnel on your own domain.
The provider's `ESCROW_ID` must match the host's.

---

## Demo and checks

```bash
pnpm demo                 # narrated, live on testnet: guaranteed start, pay for what runs, reserving ahead, NFT reuse
pnpm demo refund          # broken promises: a 25% credit and a full refund (start the provider with DEMO_FAULTS=1)
pnpm demo load            # outside load on the same GPU: jobs slow down, nobody's job is killed
pnpm test                 # unit tests: scheduling, escrow rules, pricing, track records, agent policy
pnpm typecheck
```

The demo reads the escrow's verdicts from the host at `http://localhost:4100`. With the host deployed, point it there:
`$env:HOST_URL="https://qyhost-production.up.railway.app"; pnpm demo` (PowerShell).

Every demo step prints PASS or FAIL and links the real payment and payout transactions on HashScan. Deeper live
checks: `spikes/provider-check.ts` (40 checks against a running provider), `spikes/host-check.ts` (the hosted flow), `spikes/schedule-check.ts` (recurring jobs, about 7 minutes) and
`spikes/contention-check.ts` (`FLOOD=0/3/8` outside generations).

`DEMO_FAULTS=1` turns on a pause switch only the provider's own key can use, so a demo can make it miss promises on
purpose. Leave it off in normal use.

---

## Configuration

Set these in `.env` (or `.env.provider` for a provider joined with `provider:join`).

| Variable | Used by | Meaning |
|---|---|---|
| `HEDERA_OPERATOR_ID`, `HEDERA_OPERATOR_KEY` | setup, host | Your testnet account; pays to create new user agents |
| `ARKIV_ACCESS_KEY` | all | Arkiv API key (optional; without it, the public rate-limited endpoint) |
| `X402_FACILITATOR_URL` | provider | x402 facilitator, e.g. `https://api.testnet.blocky402.com` |
| `HOST_SECRET` | host | Master secret every hosted agent's key is derived from (created on first run) |
| `ESCROW_ID` | provider, agents | The escrow bookings are paid into (written by the host) |
| `DATABASE_URL` | host | Postgres; without it, an embedded Postgres (PGlite) in `data/host` |
| `PROVIDER_PORT`, `PROVIDER_URL`, `PROVIDER_LABEL` | provider | Where it listens, the URL agents use, its display name |
| `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` | provider | Any OpenAI-compatible model server (default: local Ollama) |
| `WORKERS` | provider | Jobs run at once (default 2) |
| `PRICE_BANDS` | provider | Prices by job size in US cents, e.g. `256:0.5,1024:1,4096:2` |
| `MAX_RUN_SECONDS` | provider | Longest run limit a job may have (default 30) |
| `SPEED_WINDOW_SECONDS` | provider | How long a slow job keeps promises cautious (default 600) |
| `DEMO_FAULTS` | provider | `1` enables the demo pause switch |

---

## Limits today, and what's next

- **The escrow keeper is a trusted custodian.** Its rules are public and every payout can be re-checked from the log.
  A Hedera smart contract could hold the money trustlessly, at about 1¢ of gas per ticket today.
- **Providers sign their own start times and token counts.** The time that counts is Hedera's timestamp on that
  message, and buyers can re-count tokens from the result they receive.
- **One provider per GPU** keeps promises reliable; other software on the same card slows jobs down.
- **Next:** ENS names for every agent and provider, GPU providers rented on the Golem Network, and API keys so
  developers can book from their own code.

---

## How we used AI

We used Claude Code (Anthropic's coding agent) throughout the build: to write and refactor code across every
package, run and debug the live checks, draft documentation (this README, the `arkiv/` files) and the pitch
script. The product idea, the design decisions (start-by promises, escrow refund policy, pay-as-you-go bands,
trading places, what goes on Arkiv vs Hedera vs our database) and every review and commit are ours.

## License

[MIT](LICENSE)
