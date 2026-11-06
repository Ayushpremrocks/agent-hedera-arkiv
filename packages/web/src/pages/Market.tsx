// The public market, read from Arkiv and the Mirror Node: who provides GPU time, what's scheduled,
// what's offered for swaps, what traded, and every provider's signed log.
import { render } from "@arkiv-network/sdk/query";
import { arkivReader, findOffers, offerFilter } from "@qy/shared/arkiv";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { Notice, Section, Stats, Who } from "../components/ui";
import { clock, hashscan, hbar, inHuman, shortClock } from "../lib/format";
import { type LogEvent, type Provider, fetchLog, fetchOffers, fetchSlots, fetchTrades } from "../lib/market";

declare const __AGENT_NAMES__: Record<string, string>;
const PAST = 120;
const AHEAD = 240;
const NOT_BEFORE_SECONDS = 45; // CUTOFF_SECONDS + SWAP_VALID_SECONDS in shared/src/swap.ts
const now = () => Date.now() / 1000;

const PALETTE = ["#C8326B", "#23786A", "#6550C8", "#B5651D", "#3B6FB6", "#7A8B2E", "#A23C9A", "#2F7F96"];
function colorOf(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function useNow(ms = 1000) {
  const [t, setT] = useState(now());
  useEffect(() => {
    const i = setInterval(() => setT(now()), ms);
    return () => clearInterval(i);
  }, [ms]);
  return t;
}

export function Market() {
  const providers = useQuery({ queryKey: ["providers"], queryFn: () => fetch("/api/market").then((r) => r.json()).then((d) => d.providers as Provider[]), refetchInterval: 15_000 });
  const list = providers.data ?? [];
  const log = useQuery({ queryKey: ["log", list.map((p) => p.id).join()], queryFn: () => fetchLog(list), enabled: list.length > 0, refetchInterval: 6000 });
  const slots = useQuery({ queryKey: ["slots", list.map((p) => p.id).join()], queryFn: () => fetchSlots(list, now() - PAST), enabled: list.length > 0, refetchInterval: 6000 });
  const offers = useQuery({ queryKey: ["offers"], queryFn: fetchOffers, refetchInterval: 6000 });
  const trades = useQuery({ queryKey: ["trades"], queryFn: fetchTrades, refetchInterval: 10_000 });

  const names = useMemo(() => {
    const n: Record<string, string> = {};
    for (const [id, letter] of Object.entries(__AGENT_NAMES__)) n[id] = `Agent ${letter}`;
    for (const p of list) n[p.id] = p.name;
    return n;
  }, [list]);
  const events = log.data ?? [];
  const verified = events.filter((x) => x.verified);

  const delivered = verified.filter((x) => x.e.type === "delivered");
  const tradeEvents = verified.filter((x) => x.e.type === "trade" && x.by === x.e.seller);
  const lastBooking = verified.find((x) => x.e.type === "booked" && x.e.price);
  const error = providers.error ?? log.error ?? offers.error;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Network status</h1>
          <p>The open market behind QueueYield, read live from Hedera and Arkiv: providers, scheduled GPU time, priority trades and every signed event.</p>
        </div>
      </div>
      <Notice text={error?.message} kind="error" />
      <Stats
        items={[
          [String(list.length), "providers online"],
          [delivered.length ? `${Math.round((delivered.filter((x) => x.e.met).length / delivered.length) * 100)}%` : "–", `of ${delivered.length} recent jobs on time`],
          [String(tradeEvents.length), `recent swaps, ${hbar(tradeEvents.reduce((a, t) => a + Number(t.e.price), 0))}`],
          [lastBooking ? hbar(lastBooking.e.price) : "–", "latest booking price"],
        ]}
      />
      <Providers list={list} />
      <Section title="Schedule" intro="Each block is one slot on a provider's GPU, colored by who holds it. Arcs join slots that swapped owners.">
        <Schedule providers={list} slots={slots.data ?? []} events={verified} names={names} />
      </Section>
      <div className="pair">
        <Offers offers={offers.data ?? []} providers={list} names={names} />
        <BuyerQuery providers={list} slots={slots.data ?? []} names={names} />
      </div>
      <div className="pair">
        <Trades trades={trades.data ?? []} events={verified} providers={list} names={names} />
        <Log events={events} names={names} />
      </div>
    </>
  );
}

function Providers({ list }: { list: Provider[] }) {
  const t = useNow(5000);
  return (
    <Section title="Providers" intro="Live offers on Arkiv. Each provider renews its offer every 30 seconds; one that goes offline drops out on its own.">
      <table>
        <thead>
          <tr>
            <th>Provider</th>
            <th>Model</th>
            <th className="num">Price now</th>
            <th>Next free slot</th>
            <th>Log</th>
          </tr>
        </thead>
        <tbody>
          {list.map((p) => (
            <tr key={p.id}>
              <td>
                <b>{p.name}</b> <span className="muted">{p.id}</span>
              </td>
              <td>{p.model}</td>
              <td className="num">{hbar(p.price)}</td>
              <td>
                {shortClock(p.nextFree)} <span className="muted">{inHuman(p.nextFree - t)}</span>
              </td>
              <td>
                <a href={hashscan("topic", p.topicId)} target="_blank" rel="noopener">
                  {p.topicId}
                </a>
              </td>
            </tr>
          ))}
          {!list.length && (
            <tr>
              <td colSpan={5} className="muted">
                No provider is online. Start one with <code>pnpm provider</code>.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Section>
  );
}

type Slot = { provider: string; serial: number; start: number; owner: string };
function statusOf(events: LogEvent[], p: Provider, s: Slot) {
  const done = events.find((x) => x.by === p.id && x.e.type === "done" && x.e.serial === s.serial);
  const dispatch = events.find((x) => x.by === p.id && x.e.type === "dispatch" && x.e.serial === s.serial);
  if (done) return done.e.ok ? { kind: "ran", text: `ran ${(done.e.ms / 1000).toFixed(1)}s`, owner: done.e.owner } : { kind: "killed", text: String(done.e.result).startsWith("timeout") ? "killed at end" : "failed", owner: done.e.owner };
  if (dispatch) return dispatch.e.jobHash ? { kind: "running", text: "running", owner: dispatch.e.owner } : { kind: "idle", text: "no job", owner: dispatch.e.owner };
  if (s.start > now()) return { kind: "waiting", text: "waiting", owner: s.owner };
  return { kind: "idle", text: "not run", owner: s.owner };
}

function Schedule({ providers, slots, events, names }: { providers: Provider[]; slots: Slot[]; events: LogEvent[]; names: Record<string, string> }) {
  const t = useNow();
  const t0 = t - PAST;
  const t1 = t + AHEAD;
  const W = 1000, G = 110, LANE = 50, BLOCK = 38, TOP = 52, GAP = 18;
  const x = (u: number) => G + ((u - t0) / (t1 - t0)) * (W - G - 8);

  // One band of lanes per provider; within a band, slots at the same start stack into lanes.
  let y = TOP;
  const bands = providers.map((p) => {
    const visible = slots.filter((s) => s.provider === p.id && s.start + p.slot > t0 && s.start < t1).sort((a, b) => a.start - b.start || a.serial - b.serial);
    const byStart = new Map<number, Slot[]>();
    for (const s of visible) byStart.set(s.start, [...(byStart.get(s.start) ?? []), s]);
    const lanes = Math.max(1, ...[...byStart.values()].map((l) => l.length));
    const band = { p, byStart, lanes, y };
    y += lanes * LANE + GAP;
    return band;
  });
  const H = y + 10;
  const pos = new Map<string, { cx: number; y: number }>();

  return (
    <div className="chart-wrap">
      <svg id="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Slot schedule across providers">
        {Array.from({ length: Math.ceil((t1 - t0) / 60) + 1 }, (_, i) => Math.ceil(t0 / 60) * 60 + i * 60)
          .filter((u) => u < t1)
          .map((u) => (
            <g key={u}>
              <line className="tick" x1={x(u)} x2={x(u)} y1={TOP - 6} y2={H - 26} />
              <text className="tick-label" x={x(u)} y={H - 10} textAnchor="middle">
                {shortClock(u)}
              </text>
            </g>
          ))}
        {bands.map(({ p, byStart, lanes, y: by }) => (
          <g key={p.id}>
            <text className="band-label" x={G - 10} y={by + 16} textAnchor="end">
              {p.name}
            </text>
            <text className="lane-label" x={G - 10} y={by + 31} textAnchor="end">
              {p.model.split(":")[0]}
            </text>
            {Array.from({ length: lanes }, (_, i) => (
              <rect key={i} className="lane" x={G} y={by + i * LANE} width={W - G - 8} height={BLOCK} />
            ))}
            {[...byStart.entries()].flatMap(([start, list]) =>
              list.map((s, i) => {
                const st = statusOf(events, p, s);
                const bx = Math.max(G, x(start) + 1);
                const bw = Math.min(x(start + p.slot) - 1, W - 8) - bx;
                if (bw <= 2) return null;
                const sy = by + i * LANE;
                pos.set(`${p.id}:${s.serial}`, { cx: bx + bw / 2, y: sy });
                return (
                  <g key={s.serial} className={`block ${st.kind}`} style={{ ["--c" as any]: colorOf(st.owner) }}>
                    <title>{`${p.name} slot #${s.serial}, ${clock(s.start)}, held by ${names[st.owner] ?? st.owner}: ${st.text}`}</title>
                    <rect x={bx} y={sy} width={bw} height={BLOCK} rx={3} />
                    {st.kind === "killed" && <rect className="hatch" x={bx} y={sy} width={bw} height={BLOCK} rx={3} />}
                    {bw > 40 && (
                      <>
                        <text className="b1" x={bx + 6} y={sy + 16}>
                          #{s.serial}
                        </text>
                        <text className="b2" x={bx + 6} y={sy + 30}>
                          {st.text}
                        </text>
                      </>
                    )}
                  </g>
                );
              }),
            )}
          </g>
        ))}
        {events
          .filter((ev) => ev.e.type === "trade" && ev.by === ev.e.seller)
          .map((ev) => {
            const a = pos.get(`${ev.provider}:${ev.e.sellerSerial}`);
            const b = pos.get(`${ev.provider}:${ev.e.buyerSerial}`);
            if (!a || !b) return null;
            const apex = Math.min(a.y, b.y) - 34;
            const mx = (a.cx + b.cx) / 2;
            return (
              <g key={`${ev.provider}:${ev.seq}`}>
                <path className="arc" d={`M ${a.cx} ${a.y} Q ${mx} ${apex} ${b.cx} ${b.y}`} />
                <text className="arc-label" x={mx} y={apex + 12} textAnchor="middle">
                  swapped for {hbar(ev.e.price)}
                </text>
              </g>
            );
          })}
        {!providers.length && (
          <text className="empty-chart" x={(G + W) / 2} y={TOP + 30} textAnchor="middle">
            No provider is online.
          </text>
        )}
        <line className="now" x1={x(t)} x2={x(t)} y1={TOP - 14} y2={H - 26} />
        <text className="now-label" x={x(t)} y={TOP - 18} textAnchor="middle">
          now
        </text>
      </svg>
    </div>
  );
}

function Offers({ offers, providers, names }: { offers: Awaited<ReturnType<typeof fetchOffers>>; providers: Provider[]; names: Record<string, string> }) {
  const t = useNow();
  const live = offers.filter((o) => o.start > t);
  const pname = (id: string) => providers.find((p) => p.id === id)?.name ?? id;
  return (
    <Section title="Slots offered for swaps" intro="Live qy_offer entities on Arkiv. Each disappears on its own 15 seconds before its slot starts.">
      {live.length ? (
        <table>
          <thead>
            <tr>
              <th>Slot</th>
              <th>Starts</th>
              <th>Seller</th>
              <th className="num">Asks</th>
              <th>Check</th>
            </tr>
          </thead>
          <tbody>
            {live.map((o) => (
              <tr key={o.key}>
                <td>
                  {pname(o.provider)} #{o.serial}
                </td>
                <td>
                  {clock(o.start)} <span className="muted">{inHuman(o.start - t)}</span>
                </td>
                <td>
                  <Who id={o.seller} names={names} color={colorOf(o.seller)} />
                </td>
                <td className="num">{hbar(o.price)}</td>
                <td>{o.byOwner ? "written by the seller" : <span className="warn">not written by {o.seller}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="empty">Nothing offered right now. Agents with time to spare offer their slots here.</p>
      )}
    </Section>
  );
}

function BuyerQuery({ providers, slots, names }: { providers: Provider[]; slots: Slot[]; names: Record<string, string> }) {
  const t = useNow(5000);
  const upcoming = slots.filter((s) => s.start > t).sort((a, b) => b.start - a.start);
  const [pick, setPick] = useState("");
  const [within, setWithin] = useState("150");
  const [budget, setBudget] = useState("0.2");
  const [result, setResult] = useState<string | null>(null);
  const chosen = upcoming.find((s) => `${s.provider}:${s.serial}` === pick) ?? upcoming[0];
  const provider = providers.find((p) => p.id === chosen?.provider);
  const want = chosen && provider ? { myStart: chosen.start, myLatest: Math.floor(t) + Number(within) - provider.slot, notBefore: Math.floor(t) + NOT_BEFORE_SECONDS, budget: BigInt(Math.round(Number(budget) * 1e8)) } : null;

  const run = async (e: FormEvent) => {
    e.preventDefault();
    if (!want || !provider) return;
    setResult("Asking Arkiv…");
    try {
      const { entities } = await findOffers(arkivReader(import.meta.env.VITE_ARKIV_ACCESS_KEY ?? ""), provider.id, want);
      setResult(
        entities.length
          ? `${entities.length} offer${entities.length > 1 ? "s" : ""} match, cheapest first: ${entities.map((r) => `#${r.slot_serial.value} from ${names[r.seller.value] ?? r.seller.value} at ${hbar(r.min_price.value)}`).join(", ")}.`
          : want.myLatest >= want.myStart
            ? "That slot already meets the deadline; nothing earlier is needed."
            : "No offer matches: nobody can take the later slot, or every price is over budget.",
      );
    } catch (err) {
      setResult(`Arkiv didn't answer: ${(err as Error).message}`);
    }
  };

  return (
    <Section title="Run the buyer's query" intro="The exact filter an urgent agent sends to Arkiv. Both parties' deadlines are checked inside the query." className="query">
      <form onSubmit={run}>
        <label>
          Slot you hold
          <select value={pick} onChange={(e) => setPick(e.target.value)}>
            {upcoming.length ? (
              upcoming.map((s) => (
                <option key={`${s.provider}:${s.serial}`} value={`${s.provider}:${s.serial}`}>
                  {providers.find((p) => p.id === s.provider)?.name} #{s.serial} at {clock(s.start)}, held by {names[s.owner] ?? s.owner}
                </option>
              ))
            ) : (
              <option>No upcoming slots</option>
            )}
          </select>
        </label>
        <label>
          Must finish within
          <span className="unit">
            <input type="number" min="30" step="10" value={within} onChange={(e) => setWithin(e.target.value)} /> seconds
          </span>
        </label>
        <label>
          Budget
          <span className="unit">
            <input type="number" min="0" step="0.01" value={budget} onChange={(e) => setBudget(e.target.value)} /> HBAR
          </span>
        </label>
        <button type="submit" disabled={!want}>
          Run query on Arkiv
        </button>
      </form>
      <pre className="query-text">{want && provider ? render(offerFilter(provider.id, want)) : "Book a slot first: the query starts from a slot you hold."}</pre>
      {result && <p role="status">{result}</p>}
    </Section>
  );
}

function Trades({ trades, events, providers, names }: { trades: Awaited<ReturnType<typeof fetchTrades>>; events: LogEvent[]; providers: Provider[]; names: Record<string, string> }) {
  // Only trades confirmed by a signed HCS message from the seller are shown: an Arkiv record alone is a claim.
  const rows = trades
    .map((t) => ({ t, ev: events.find((x) => x.e.type === "trade" && x.e.swapTx === t.swapTx && x.by === x.e.seller) }))
    .filter((r) => r.ev)
    .sort((a, b) => b.ev!.ts - a.ev!.ts);
  return (
    <Section title="Swaps" intro="qy_trade records on Arkiv, each matched to the seller's signed message on Hedera. Slots and payment moved in one transaction.">
      {rows.length ? (
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Slots</th>
              <th>Seller to buyer</th>
              <th className="num">Price</th>
              <th>Proof</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ t, ev }) => (
              <tr key={t.key}>
                <td>{clock(ev!.ts)}</td>
                <td>
                  {providers.find((p) => p.id === t.provider)?.name} #{t.sellerSerial} for #{t.buyerSerial}
                </td>
                <td>
                  <Who id={ev!.e.seller} names={names} color={colorOf(ev!.e.seller)} /> to <Who id={ev!.e.buyer} names={names} color={colorOf(ev!.e.buyer)} />
                </td>
                <td className="num">{hbar(t.price)}</td>
                <td>
                  <a href={hashscan("transaction", t.swapTx)} target="_blank" rel="noopener">
                    Swap transaction
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="empty">No swaps in the recent log yet.</p>
      )}
    </Section>
  );
}

function describe(ev: LogEvent, names: Record<string, string>) {
  const e = ev.e;
  const n = (id: unknown) => (typeof id === "string" ? (names[id] ?? id) : "?");
  switch (e.type) {
    case "booked":
      return `${n(e.owner)} booked slot #${e.serial} for ${clock(e.start)}${e.price ? `, paid ${hbar(e.price)}` : ""}`;
    case "dispatch":
      return e.jobHash ? `Slot #${e.serial} started ${n(e.owner)}'s job` : `Slot #${e.serial} started with no job`;
    case "done":
      return e.ok ? `Slot #${e.serial} finished ${n(e.owner)}'s job in ${(e.ms / 1000).toFixed(1)}s${e.tokens ? `, ${e.tokens} tokens` : ""}` : `Slot #${e.serial}: ${n(e.owner)}'s job ${String(e.result).startsWith("timeout") ? "was cut off at slot end" : "failed"}`;
    case "trade":
      return `${n(e.seller)} gave slot #${e.sellerSerial} to ${n(e.buyer)} for ${hbar(e.price)} and took #${e.buyerSerial}`;
    case "refund":
      return `Provider refunded ${hbar(e.amount)} to ${n(e.buyer)}`;
    case "delivered":
      return `${n(ev.by)} received "${e.label}" ${e.met ? "on time" : `${Math.max(0, e.finishedAt - e.deadline)}s late`}`;
    case "expired":
      return `${n(e.owner)}'s job expired unrun`;
    default:
      return "Unknown message";
  }
}

function Log({ events, names }: { events: LogEvent[]; names: Record<string, string> }) {
  return (
    <Section title="Signed log" intro="Latest messages on every provider's Hedera topic, newest first. Signatures are checked in your browser.">
      <ol className="log">
        {events.slice(0, 30).map((ev) => (
          <li key={`${ev.provider}:${ev.seq}`} className={ev.verified ? "" : "unverified"}>
            <time>{clock(ev.ts)}</time>
            <span>{describe(ev, names)}</span>
            <span className="sig">{ev.verified ? `${names[ev.provider] ?? ev.provider} log, signed by ${names[ev.by] ?? ev.by}` : `unverified, claims ${ev.by}`}</span>
          </li>
        ))}
      </ol>
    </Section>
  );
}
