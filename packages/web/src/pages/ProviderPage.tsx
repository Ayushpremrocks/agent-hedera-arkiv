// One provider, in public: its offer, its live queue, and a track record anyone can recompute from
// its signed Hedera log. This is also the provider's own dashboard: there's nothing private on it.
import { ArrowSquareOut } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { CopyButton, Skeleton } from "../components/motion";
import { Empty, Ledger, Notice, PageHeader, useNow } from "../components/ui";
import { clock, hashscan, hbar } from "../lib/format";
import { type LogEvent, type Provider, type QueueEntry, type TrackRecord, keptRate } from "../lib/market";

// partial: tickets that started late but delivered, so the buyer got a credit scaled to the delay.
type EscrowStats = { account: string; held: number; released: number; partial: number; refunded: number; heldAmount: string; paidAmount: string; refundedAmount: string };
type Detail = { provider: Provider; online: boolean; record: TrackRecord; recent: (Omit<LogEvent, "provider" | "verified"> & { i: number })[]; escrow: EscrowStats };

function line(e: any): string {
  switch (e.type) {
    case "booked":
      return e.jobHash ? `Ticket #${e.ticket} sold for ${hbar(e.price)}, promised to start by ${clock(e.startBy)}` : `Ticket #${e.ticket} reserved ahead for ${hbar(e.price)}`;
    case "dispatch":
      return e.jobHash ? `Ticket #${e.ticket} started its job` : `Ticket #${e.ticket} came up with no job attached`;
    case "done":
      return e.ok ? `Ticket #${e.ticket} finished in ${(e.ms / 1000).toFixed(1)}s, ${e.tokens} tokens` : `Ticket #${e.ticket} didn't complete`;
    case "tokenized":
      return `Ticket #${e.ticket} became NFT #${e.serial} for a trade`;
    case "trade":
      return `Tickets #${e.sellerTicket} and #${e.buyerTicket} swapped places for ${hbar(e.price)}`;
    case "refund":
      return `Refunded ${hbar(e.amount)}: ${e.reason}`;
    case "expired":
      return "A queued job expired unrun";
    default:
      return "Event";
  }
}

export function ProviderPage() {
  const { id = "" } = useParams();
  const now = useNow();
  const q = useQuery({ queryKey: ["provider", id], queryFn: () => fetch(`/api/providers/${id}`).then(async (r) => (r.ok ? (r.json() as Promise<Detail>) : Promise.reject(new Error((await r.json()).error ?? r.statusText)))), refetchInterval: 15_000 });
  const p = q.data?.provider;
  const queue = useQuery({
    queryKey: ["provider-queue", id],
    queryFn: async () => (await (await fetch(`${p!.bookingUrl}/queue`, { signal: AbortSignal.timeout(5000) })).json()).tickets as QueueEntry[],
    enabled: !!p && !!q.data?.online,
    refetchInterval: 4000,
  });

  if (q.isPending)
    return (
      <div className="stack-lg" aria-busy>
        <Skeleton h={34} w="35%" />
        <Skeleton h={64} />
        <Skeleton h={200} />
      </div>
    );
  if (q.isError) return <Notice text={q.error.message} kind="error" />;
  const { record: r, online, recent, escrow: es } = q.data;
  const escrowed = p!.escrow && p!.escrow === es.account;
  const rate = keptRate(r);

  return (
    <>
      <PageHeader
        title={p!.name}
        back={{ to: "/network", label: "Network status" }}
        intro={
          <>
            {p!.model} · <span className={online ? "ok-text" : "muted"}>{online ? "online" : "offline"}</span> · account {p!.id} <CopyButton value={p!.id} label="provider account" />
          </>
        }
        action={
          <a className="btn btn-ghost" href={hashscan("topic", p!.topicId)} target="_blank" rel="noopener">
            Signed log <ArrowSquareOut size={14} aria-hidden />
          </a>
        }
      />
      <Ledger
        items={[
          { label: "Promises kept", value: rate === null ? "–" : `${Math.round(rate * 100)}% of ${r.started}`, hint: "Tickets that started by their promised time" },
          { label: "Tickets sold", value: String(r.booked) },
          { label: "Jobs completed", value: String(r.done) },
          { label: "Refunds", value: r.refunds ? `${r.refunds}, ${hbar(r.refunded)}` : "none" },
          { label: "Earned", value: hbar(BigInt(r.earned) - BigInt(r.refunded)), hint: "Bookings minus refunds" },
        ]}
      />
      <div className="split">
        <section className="block" aria-labelledby="offer-h">
          <div className="block-head">
            <h2 id="offer-h">Offer</h2>
          </div>
          <dl className="facts">
            <div>
              <dt>Prices now, by job size</dt>
              <dd>{p!.bands?.length ? p!.bands.map(([upTo, t]) => `up to ${upTo.toLocaleString("en")} tokens ${hbar(t)}`).join(" · ") : hbar(p!.price)}</dd>
            </div>
            <div>
              <dt>A booking now starts by</dt>
              <dd>{p!.nextFree - now > 1 ? `${Math.round(p!.nextFree - now)}s from now` : "now"}</dd>
            </div>
            <div>
              <dt>Slowest speed it promises on</dt>
              <dd>{p!.tps ? `${p!.tps} tokens/s` : "–"}</dd>
            </div>
            <div>
              <dt>Largest job</dt>
              <dd>{p!.maxTokens ? `${p!.maxTokens.toLocaleString("en")} tokens` : "–"}</dd>
            </div>
            <div>
              <dt>Payments</dt>
              <dd>{escrowed ? `held in escrow ${es.account}` : "paid to the provider directly (no escrow)"}</dd>
            </div>
            {escrowed && (
              <div>
                <dt>Escrow now</dt>
                <dd>
                  {es.held} held · {es.released} paid in full · {es.partial} credited for a late start · {es.refunded} refunded ({hbar(es.refundedAmount)} back to buyers)
                </dd>
              </div>
            )}
            <div>
              <dt>Record since</dt>
              <dd>{r.since ? new Date(r.since * 1000).toLocaleString() : "–"}</dd>
            </div>
          </dl>
          <p className="muted small">
            The record is computed from messages this provider signed on Hedera, so you can recompute it yourself from{" "}
            <a href={hashscan("topic", p!.topicId)} target="_blank" rel="noopener">
              topic {p!.topicId}
            </a>
            .
          </p>
        </section>
        <section className="block" aria-labelledby="queue-h">
          <div className="block-head">
            <h2 id="queue-h">Queue now</h2>
          </div>
          {!online ? (
            <p className="muted">Offline: its offer on Arkiv has lapsed, so agents aren't sending it work.</p>
          ) : queue.data?.length ? (
            <table className="data">
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th>State</th>
                  <th>Starts by</th>
                  <th className="num">Size</th>
                </tr>
              </thead>
              <tbody>
                {queue.data.map((t) => (
                  <tr key={t.ticket}>
                    <td>#{t.ticket}{t.serial !== null ? <span className="tag">NFT</span> : null}</td>
                    <td>{t.status === "running" ? "running" : "waiting"}</td>
                    <td className="nowrap">{clock(t.startBy)}</td>
                    <td className="num">{t.maxTokens} tokens</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">{queue.isError ? "Its queue isn't reachable from your browser." : "Empty: a booking now starts right away."}</p>
          )}
        </section>
      </div>
      <section className="block" aria-labelledby="ev-h">
        <div className="block-head">
          <h2 id="ev-h">Latest signed events</h2>
        </div>
        {recent.length ? (
          <ol className="log">
            {recent.map((ev) => (
              <li key={`${ev.seq}:${ev.i}`}>
                <time>{clock(ev.ts)}</time>
                <span>{line(ev.e)}</span>
              </li>
            ))}
          </ol>
        ) : (
          <Empty title="No events yet">
            <p>Bookings, starts, results and refunds appear here as the provider signs them.</p>
          </Empty>
        )}
      </section>
      <p className="muted small">
        Run a provider yourself? <Link to="/provide">Sell GPU time</Link>.
      </p>
    </>
  );
}
