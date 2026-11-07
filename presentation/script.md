# dani.ai: 4-minute video script

EthGlobal Mumbai 2026 · Sudhanshu Bharti, Ayush Prem

| Part | Time |
|---|---|
| Slides 1 to 8 | 0:00 to 1:32 |
| Live demo | 1:32 to 3:52 |
| Closing slide | 3:52 to 4:00 |

Each slide's lines are also in its speaker notes.

## Slides

**1. Title** · 0:00 to 0:08
> Hi, we're Sudhanshu and Ayush. This is dani.ai: AI jobs that run on time, and a market to trade your place in line.

**2. Agents have deadlines. GPU queues don't.** · 0:08 to 0:20
> AI agents work to deadlines. But GPU time is rented by the hour, and a queue makes no promise about when your job runs. So an urgent job ends up behind work that could wait all day, with no way to move up.

**3. Every job gets a time it must start by** · 0:20 to 0:35
> Our answer: every booking gets a time it must start by. The provider works it out from its slowest measured speed, so real jobs start sooner, never later. A job that runs long is never cut short; the provider absorbs that. And your payment waits in escrow until the promise is kept.

**4. Pay for what runs** · 0:35 to 0:50
> You pay for what actually runs. Your deposit covers the job's size band and waits in escrow. Once it runs, the provider gets the band it really used and the rest comes back to you. If the start slips, part of the charge comes back too, and all of it if the job fails. Lateness is judged by Hedera's own timestamps.

**5. Running late? Buy an earlier place** · 0:50 to 1:03
> When an agent is running late, it can buy an earlier place from one that can wait. Both places and the payment move in a single Hedera transaction, and the seller only accepts if it still finishes on time. Agents can also reserve capacity ahead, and resell it if plans change.

**6. How it's built** · 1:03 to 1:17
> People sign in with HashPack and set a budget, and each gets their own agent. Providers are anyone's GPU running an open model. Hedera carries the money and the proof: x402 payments into escrow, payouts and refunds, ticket NFTs, and a signed log. Arkiv is where everything is found: offers, places for trade, and public records.

**7. Anyone with a GPU can sell** · 1:17 to 1:27
> And it's open: anyone with a GPU can join with one command and their own wallet. Providers set their own prices by job size, get paid through escrow, and earn a public track record built from what they sign on Hedera.

**8. Live on Hedera testnet** · 1:27 to 1:32
> All of this runs on Hedera testnet today. Let's see it.

## Live demo · 1:32 to 3:52

Two windows: the web app, and a terminal for the refund case.

| # | Time | Show | Say |
|---|---|---|---|
| 1 | 1:32 to 1:45 | Landing page | Every bar has to start before its dashed line. This is the same rule our providers run. |
| 2 | 1:45 to 2:05 | Sign in with HashPack; Billing shows the budget | The money stays in my wallet. My agent can only spend the budget I approve. |
| 3 | 2:05 to 2:30 | New task: fill it in, point at "Before you book" | Before I book, I can see the latest it will start and finish, against my deadline, and the most it can cost. |
| 4 | 2:30 to 3:00 | Task page: the track fills, the result arrives | It started before its promise. The result is checked against a fingerprint the provider signed on Hedera. And look at the cost: deposit, what was charged for the size it used, and what came back to me. |
| 5 | 3:00 to 3:30 | Terminal: `pnpm demo refund` | Here we make a provider stall on purpose. Twenty seconds late, a quarter of the charge comes back. Over a minute late, all of it. Both payouts are real Hedera transactions. |
| 6 | 3:30 to 3:52 | Network status, then a provider's page | Anyone can see every provider's queue, its promises, and a track record built from its signed log. And anyone with a GPU can join in one command. |

## Closing slide · 3:52 to 4:00

> That's dani.ai: AI jobs that run on time, and a market to trade your place in line. Thank you.

## Before recording

1. Start Ollama, then the provider with the demo switch, then the host and the web app:
   ```
   $env:DEMO_FAULTS="1"; pnpm provider      # the switch lets the refund demo stall it on purpose
   pnpm host
   pnpm web
   ```
2. Sign in once beforehand, so the agent and its budget already exist.
3. Run `pnpm demo refund` once before recording. It takes about 3 minutes; for the video, record it and speed up the waiting parts.
4. Optional backup takes: `pnpm demo` (guarantee, pay for what runs, reserving ahead, NFT reuse) and `pnpm demo load` (outside load on the GPU; jobs slow down but nobody's job is killed).
