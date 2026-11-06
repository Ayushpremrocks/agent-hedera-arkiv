import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router";
import { Notice } from "../components/ui";
import { hbar } from "../lib/format";
import { H, W, startLanes } from "../lib/lanes";
import type { LogEvent, Provider } from "../lib/market";
import { useSession } from "../lib/session";

const now = () => Math.floor(Date.now() / 1000);
const useProviders = () =>
  useQuery({ queryKey: ["providers"], queryFn: () => fetch("/api/market").then((r) => r.json()).then((d) => d.providers as Provider[]), refetchInterval: 15_000 });

/** A label that slides out as its copy slides in: the site's one button treatment. */
function Roll({ children }: { children: string }) {
  return (
    <span className="roll" data-text={children}>
      <span>{children}</span>
    </span>
  );
}

/** The signature: the scheduler's promise lines, replayed live. */
function Lanes() {
  const ref = useRef<SVGSVGElement>(null);
  const reduce = useReducedMotion();
  useEffect(() => startLanes(ref.current!, { still: !!reduce }), [reduce]);
  return (
    <figure className="lanes">
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby="lanes-cap" preserveAspectRatio="xMidYMid slice" />
      <figcaption id="lanes-cap">
        <span className="key key-ghost" aria-hidden /> worst case, if every job ahead runs its whole limit
        <span className="key key-tick" aria-hidden /> starts by: the promise
        <span className="key key-bar" aria-hidden /> the real run
        <span className="lanes-note">A replay of the rule every provider runs. Jobs only ever start before their line.</span>
      </figcaption>
    </figure>
  );
}

/** Real numbers from the providers online now, or an honest empty state. */
function PromiseSection() {
  const providers = useProviders();
  const list = providers.data ?? [];
  const t = now();
  return (
    <section className="promise" aria-labelledby="promise-h">
      <div className="promise-copy">
        <h2 id="promise-h">A promise you can plan on.</h2>
        <p>
          Every provider measures its slowest speed when it starts: all workers busy, the longest input allowed. From that, each
          job gets a hard run limit, and the provider stops the job there. So it knows the latest moment a worker frees up, and
          promises your job will start by then.
        </p>
        <p className="formula" aria-label="run limit equals startup plus tokens divided by worst-case speed, times 1.25">
          <span>limit</span> = (startup + tokens ÷ slowest speed) × 1.25
        </p>
        <p>Miss the promise by more than three seconds and the provider pays your booking back. Automatically, on Hedera.</p>
      </div>
      <div className="promise-live" aria-live="polite">
        <h3>Online now</h3>
        {list.length ? (
          <ul>
            {list.map((p) => (
              <li key={p.id}>
                <div className="pl-head">
                  <b>{p.name}</b>
                  <span>{p.model}</span>
                </div>
                <dl>
                  <div>
                    <dt>Starts by</dt>
                    <dd>{p.nextFree - t > 1 ? `${p.nextFree - t}s` : "now"}</dd>
                  </div>
                  <div>
                    <dt>Slowest speed</dt>
                    <dd>{p.tps ? `${p.tps} tok/s` : "measuring"}</dd>
                  </div>
                  <div>
                    <dt>Largest job</dt>
                    <dd>{p.maxTokens ? `${p.maxTokens.toLocaleString("en")} tokens` : "unknown"}</dd>
                  </div>
                  <div>
                    <dt>Price</dt>
                    <dd>{hbar(p.price)}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">{providers.isLoading ? "Asking Arkiv who is online…" : "No provider is online right now. Their offers on Arkiv expire on their own when they stop."}</p>
        )}
      </div>
    </section>
  );
}

const STEPS = [
  ["Your agent sees the promise is too late", "It adds your job's own limit to the guaranteed start. If that lands after your deadline, it goes shopping."],
  ["It finds someone who can wait", "Agents with slack list their places on Arkiv. Yours only takes one whose holder still finishes on time with your later place."],
  ["Places swap in one transaction", "Both tickets and the price move together on Hedera, or nothing moves. Both promises stay with their tickets."],
] as const;

/** Customer words for real signed events. */
function plain(ev: LogEvent): string | null {
  const e = ev.e;
  if (!ev.verified) return null;
  if (e.type === "booked") return e.jobHash ? `Job booked, ${hbar(e.price)}` : `Capacity reserved ahead, ${hbar(e.price)}`;
  if (e.type === "trade") return `Two agents swapped places for ${hbar(e.price)}`;
  if (e.type === "delivered") return e.met ? "Delivered on time" : "Delivered";
  if (e.type === "done" && e.ok) return `Finished in ${(e.ms / 1000).toFixed(1)}s`;
  if (e.type === "refund") return `Refunded ${hbar(e.amount)}`;
  return null;
}

function Board() {
  const reduce = useReducedMotion();
  const providers = useProviders();
  const list = providers.data ?? [];
  const log = useQuery({ queryKey: ["landing-log", list.map((p) => p.id).join()], queryFn: async () => (await import("../lib/market")).fetchLog(list), enabled: list.length > 0, refetchInterval: 6000 });
  const names = Object.fromEntries(list.map((p) => [p.id, p.name]));
  const rows = (log.data ?? []).flatMap((ev) => {
    const text = plain(ev);
    return text ? [{ key: `${ev.provider}:${ev.seq}:${ev.ts}`, text, ts: ev.ts, provider: names[ev.provider] ?? ev.provider }] : [];
  });
  return (
    <section className="board" aria-labelledby="board-h">
      <div className="board-head">
        <h2 id="board-h">Signed, as it happens.</h2>
        <p>Every row is a message a provider or agent signed on Hedera, read from the Mirror Node and checked in your browser.</p>
      </div>
      <ol className="board-rows">
        <AnimatePresence initial={false}>
          {rows.slice(0, 7).map((r) => (
            <motion.li
              key={r.key}
              layout={!reduce}
              initial={reduce ? false : { opacity: 0, x: -24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, transition: { duration: 0.15 } }}
              transition={{ duration: 0.42, ease: [0.2, 0.7, 0, 1] }}
            >
              <time dateTime={new Date(r.ts * 1000).toISOString()}>{new Date(r.ts * 1000).toLocaleTimeString("en-GB")}</time>
              <span>{r.text}</span>
              <span className="board-prov">{r.provider}</span>
            </motion.li>
          ))}
        </AnimatePresence>
        {!rows.length && <li className="board-empty">Waiting for the next signed event…</li>}
      </ol>
      <Link to="/network" viewTransition className="arrow-link">
        <span>Open the network status</span>
        <span className="arrow" aria-hidden>
          →
        </span>
      </Link>
    </section>
  );
}

export function Landing() {
  const { account, signIn } = useSession();
  const navigate = useNavigate();
  const [step, setStep] = useState("");
  const [error, setError] = useState("");
  if (account) return <Navigate to="/app" replace />;

  const start = async () => {
    setError("");
    try {
      await signIn(setStep);
      navigate("/app", { viewTransition: true });
    } catch (e) {
      setError((e as Error).message ?? String(e));
    } finally {
      setStep("");
    }
  };
  const cta = (
    <button type="button" className="cta" onClick={start} disabled={!!step} aria-busy={!!step}>
      <Roll>{step ? "Connecting…" : "Get started with HashPack"}</Roll>
    </button>
  );

  return (
    <div className="ql">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="ql-top">
        <Link to="/" className="ql-logo" aria-label="QueueYield home">
          QueueYield
        </Link>
        <nav aria-label="Main">
          <Link to="/network" viewTransition className="ql-nav">
            Network status
          </Link>
          <button type="button" className="ql-nav ql-nav-btn" onClick={start}>
            Sign in
          </button>
        </nav>
      </header>
      <main id="main">
        <section className="ql-hero" aria-labelledby="hero-h">
          <h1 id="hero-h">
            Every job gets a time
            <br /> it must start by.
          </h1>
          <div className="ql-hero-side">
            <p>
              GPU time for AI agents, sold per job instead of per hour. The provider promises the latest moment your job starts,
              or pays you back. In a hurry? Your agent buys an earlier place from one that can wait.
            </p>
            {cta}
            <Notice text={step} />
            <Notice text={error} kind="error" />
          </div>
        </section>
        <Lanes />
        <PromiseSection />
        <section className="hurry" aria-labelledby="hurry-h">
          <h2 id="hurry-h">When the deadline is tight.</h2>
          <ol>
            {STEPS.map(([title, body], i) => (
              <li key={title}>
                <span className="hurry-n" aria-hidden>
                  {i + 1}
                </span>
                <h3>{title}</h3>
                <p>{body}</p>
              </li>
            ))}
          </ol>
        </section>
        <section className="ahead" aria-labelledby="ahead-h">
          <h2 id="ahead-h">Reserve ahead, resell if plans change.</h2>
          <p>
            Agents with routine work book capacity for later at today's price and attach the job when it's ready. If someone needs
            that place sooner, they sell it and keep the difference.
          </p>
        </section>
        <Board />
      </main>
      <footer className="ql-foot">
        <p className="ql-foot-mark" aria-hidden>
          QueueYield
        </p>
        <div className="ql-foot-row">
          <p>Payments, tickets and the signed log on Hedera. Offers and public records on Arkiv. Models run on providers' own GPUs.</p>
          <nav aria-label="Footer">
            <Link to="/network" viewTransition>
              Network status
            </Link>
            <button type="button" className="link-button" onClick={start}>
              Get started
            </button>
          </nav>
        </div>
      </footer>
    </div>
  );
}

/** Nothing is queued at this address: the 404 keeps the concept. */
export function NotFound() {
  return (
    <div className="ql ql-404">
      <main id="main">
        <svg viewBox="0 0 600 80" className="nf-lane" aria-hidden>
          <line x1="0" x2="600" y1="62" y2="62" className="ln-lane" />
          <line x1="300" x2="300" y1="6" y2="70" className="ln-tick" />
          <text x="306" y="56" className="ln-tick-label">
            starts by
          </text>
        </svg>
        <h1>Nothing is queued at this address.</h1>
        <p>The page you asked for doesn't exist, so there's nothing to start.</p>
        <Link to="/" viewTransition className="arrow-link">
          <span>Back to QueueYield</span>
          <span className="arrow" aria-hidden>
            →
          </span>
        </Link>
      </main>
    </div>
  );
}
