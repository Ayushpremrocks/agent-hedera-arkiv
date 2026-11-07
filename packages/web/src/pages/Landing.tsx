import { ArrowRight } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useEffect, useRef } from "react";
import { Link, Navigate, useNavigate } from "react-router";
import { FlapWord, LiveDot } from "../components/devl";
import { SignIn } from "../components/SignIn";
import { useNow } from "../components/ui";
import { hbar } from "../lib/format";
import { H, W, startLanes } from "../lib/lanes";
import type { LogEvent, Provider } from "../lib/market";
import { useSession } from "../lib/session";

const useProviders = () =>
  useQuery({ queryKey: ["providers"], queryFn: () => fetch("/api/market").then((r) => r.json()).then((d) => d.providers as Provider[]), refetchInterval: 15_000 });

const wrap = "mx-auto w-full max-w-6xl px-4 sm:px-6";
const card = "rounded-2xl border border-line bg-card";
const h2 = "text-3xl font-semibold tracking-tight text-fg md:text-4xl text-balance";
const body = "max-w-[56ch] text-[15px] leading-relaxed text-muted";

function Reveal({ children, className = "" }: { children: ReactNode; className?: string }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduce ? false : { opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.25 }}
      transition={{ duration: 0.6, ease: [0.23, 1, 0.32, 1] }}
    >
      {children}
    </motion.div>
  );
}

/** The scheduler's promise lines, replayed live, in a product-style card. */
function Lanes() {
  const ref = useRef<SVGSVGElement>(null);
  const reduce = useReducedMotion();
  useEffect(() => startLanes(ref.current!, { still: !!reduce }), [reduce]);
  const key = (swatch: string, label: string) => (
    <span className="inline-flex items-center gap-2">
      <span aria-hidden className={swatch} />
      {label}
    </span>
  );
  return (
    <figure className={`${card} m-0 overflow-hidden`}>
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <span className="text-sm font-medium text-fg">Scheduler replay</span>
        <span className="font-mono text-xs text-faint">4 GPU workers</span>
      </div>
      <div className="bg-[radial-gradient(80%_60%_at_70%_0%,rgb(255_176_0/0.06),transparent)] px-2 pt-3 sm:px-4">
        <svg ref={ref} viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby="lanes-cap" preserveAspectRatio="xMidYMid slice" className="block h-auto w-full overflow-visible max-sm:h-[250px]" />
      </div>
      <figcaption id="lanes-cap" className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line px-4 py-3 text-xs text-muted">
        {key("h-2.5 w-5 rounded-[3px] border border-dashed border-fg/40", "Worst case, if every job ahead runs its whole limit")}
        {key("h-3.5 w-0 border-l-2 border-dashed border-accent", "Starts by: the promise")}
        {key("h-2.5 w-5 rounded-[3px] bg-fg", "The real run")}
      </figcaption>
    </figure>
  );
}

/** Live providers as a split-flap departures board (ported from devl.dev "Departures"). */
function ProviderBoard() {
  const providers = useProviders();
  const t = useNow();
  const list = providers.data ?? [];
  const cols = "grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-4 sm:grid-cols-[auto_minmax(0,1fr)_auto_auto]";
  return (
    <div className={`${card} overflow-hidden`} aria-live="polite">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div className="flex items-center gap-2.5">
          <LiveDot on={list.length > 0} />
          <span className="text-sm font-medium text-fg">Online now</span>
        </div>
        <span className="text-xs text-muted tabular-nums">
          {list.length} {list.length === 1 ? "provider" : "providers"}
        </span>
      </div>
      {list.length ? (
        <div className="p-2">
          <div aria-hidden className={`${cols} px-2 pb-1.5 text-[11px] font-medium text-faint`}>
            <span>Provider</span>
            <span className="max-sm:hidden">Model</span>
            <span>Starts by</span>
            <span className="text-right">Price</span>
          </div>
          <ol className="m-0 flex list-none flex-col gap-0.5 p-0">
            {list.map((p) => {
              const wait = Math.round(p.nextFree - t);
              return (
                <li key={p.id} className={`${cols} rounded-xl px-2 py-2 text-fg transition-colors hover:bg-raised/60`}>
                  <FlapWord text={p.name} size={9} start={0} />
                  <FlapWord text={p.model} size={14} start={4} className="text-muted max-sm:hidden" />
                  <FlapWord text={wait > 1 ? `${wait}s` : "now"} size={5} start={8} className={wait > 1 ? "text-fg" : "text-kept"} />
                  <span className="text-right font-mono text-xs text-muted tabular-nums">{hbar(p.price)}</span>
                </li>
              );
            })}
          </ol>
        </div>
      ) : (
        <div className="px-6 py-12 text-center">
          <p className="m-0 text-sm font-medium text-fg">{providers.isLoading ? "Asking Arkiv who is online…" : "No provider is online right now"}</p>
          {!providers.isLoading && <p className="mx-auto mt-1 mb-0 text-xs text-muted">Offers on Arkiv expire on their own when a provider stops.</p>}
        </div>
      )}
    </div>
  );
}

const STEPS = [
  ["Your agent sees the promise is too late", "It adds your job's own limit to the guaranteed start. If that lands after your deadline, it goes shopping."],
  ["It finds someone who can wait", "Agents with slack list their places on Arkiv. Yours only takes one whose holder still finishes on time."],
  ["Places swap in one transaction", "Both tickets and the price move together on Hedera, or nothing moves."],
] as const;

type Tag = "BOOK" | "TRADE" | "DONE" | "REFUND";
const TAG_TONE: Record<Tag, string> = { BOOK: "text-fg", TRADE: "text-accent", DONE: "text-kept", REFUND: "text-refund" };

/** Customer words for real, verified signed events. */
function plain(ev: LogEvent): [Tag, string] | null {
  const e = ev.e;
  if (!ev.verified) return null;
  if (e.type === "booked") return ["BOOK", e.jobHash ? `Job booked, ${hbar(e.price)}` : `Capacity reserved ahead, ${hbar(e.price)}`];
  if (e.type === "trade") return ["TRADE", `Two agents swapped places for ${hbar(e.price)}`];
  if (e.type === "delivered") return ["DONE", e.met ? "Delivered on time" : "Delivered"];
  if (e.type === "done" && e.ok) return ["DONE", `Finished in ${(e.ms / 1000).toFixed(1)}s`];
  if (e.type === "refund") return ["REFUND", `Refunded ${hbar(e.amount)}`];
  return null;
}

/** The signed event feed, styled after devl.dev "Log Stream". */
function SignedLog() {
  const reduce = useReducedMotion();
  const providers = useProviders();
  const list = providers.data ?? [];
  const log = useQuery({ queryKey: ["landing-log", list.map((p) => p.id).join()], queryFn: async () => (await import("../lib/market")).fetchLog(list), enabled: list.length > 0, refetchInterval: 6000 });
  const names = Object.fromEntries(list.map((p) => [p.id, p.name]));
  const rows = (log.data ?? []).flatMap((ev) => {
    const p = plain(ev);
    return p ? [{ key: `${ev.provider}:${ev.seq}:${ev.ts}`, tag: p[0], text: p[1], ts: ev.ts, provider: names[ev.provider] ?? ev.provider }] : [];
  });
  return (
    <div className={`${card} overflow-hidden`}>
      <ol role="log" className="m-0 min-h-[300px] list-none p-0 py-1.5 font-mono text-[12px] leading-5">
        <AnimatePresence initial={false}>
          {rows.slice(0, 8).map((r) => (
            <motion.li
              key={r.key}
              layout={!reduce}
              initial={reduce ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: { duration: 0.15 } }}
              transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
              className="grid grid-cols-[64px_52px_minmax(0,1fr)] items-baseline gap-x-3 px-4 py-1 sm:grid-cols-[64px_52px_minmax(0,1fr)_auto]"
            >
              <time className="text-faint tabular-nums" dateTime={new Date(r.ts * 1000).toISOString()}>
                {new Date(r.ts * 1000).toLocaleTimeString("en-GB")}
              </time>
              <span className={`font-semibold ${TAG_TONE[r.tag]}`}>{r.tag}</span>
              <span className="truncate text-fg">{r.text}</span>
              <span className="truncate text-faint max-sm:hidden">{r.provider}</span>
            </motion.li>
          ))}
        </AnimatePresence>
        {!rows.length && (
          <li className="grid min-h-[280px] place-items-center px-6 text-center font-sans">
            <div>
              <p className="m-0 text-sm font-medium text-fg">Waiting for the next signed event…</p>
              <p className="mt-1 mb-0 text-xs text-muted">Rows appear as providers and agents sign them on Hedera.</p>
            </div>
          </li>
        )}
      </ol>
      <div className="flex h-10 items-center gap-2.5 border-t border-line px-4 text-xs text-muted">
        <LiveDot on={rows.length > 0} />
        <span className="flex-1 truncate">{rows.length ? "Live, verified in your browser" : "Listening"}</span>
        <Link to="/network" viewTransition className="group inline-flex items-center gap-1.5 font-medium text-fg no-underline">
          Network status
          <ArrowRight aria-hidden size={13} className="transition-transform duration-200 group-hover:translate-x-0.5" />
        </Link>
      </div>
    </div>
  );
}

const navLink = "rounded-full px-3 py-1.5 text-sm text-muted no-underline transition-colors hover:text-fg";

export function Landing() {
  const { account } = useSession();
  const navigate = useNavigate();
  const reduce = useReducedMotion();
  if (account) return <Navigate to="/app" replace />;
  // The header and footer buttons take you to the sign-in form in the hero.
  const start = () => {
    const field = document.querySelector<HTMLInputElement>(".signin input");
    field?.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
    field?.focus({ preventScroll: true });
  };
  const primary =
    "inline-flex h-11 cursor-pointer items-center justify-center rounded-full border-0 bg-accent px-5 text-[15px] font-semibold text-[#141414] transition-[background-color,scale] duration-150 hover:bg-[#ffc340] active:scale-[0.97] disabled:cursor-progress disabled:opacity-70";

  return (
    <div className="min-h-dvh bg-bg font-sans text-fg antialiased selection:bg-accent selection:text-[#141414]">
      <a href="#main" className="absolute -top-12 left-4 z-30 rounded-full bg-accent px-4 py-2 font-semibold text-[#141414] no-underline focus:top-3">
        Skip to content
      </a>
      <header className="sticky top-0 z-20 border-b border-line bg-bg/75 backdrop-blur-md">
        <div className={`${wrap} flex h-16 items-center justify-between`}>
          <Link to="/" aria-label="Dani.ai home" className="flex items-center gap-2 text-[15px] font-semibold tracking-tight text-fg no-underline">
            <span aria-hidden className="size-2.5 rounded-[3px] bg-accent" />
            Dani.ai
          </Link>
          <nav aria-label="Main" className="flex items-center gap-1">
            <Link to="/network" viewTransition className={`${navLink} max-sm:hidden`}>
              Network
            </Link>
            <Link to="/provide" viewTransition className={navLink}>
              Sell GPU time
            </Link>
            <button type="button" onClick={start} className="ml-1 h-8 cursor-pointer rounded-full border border-line bg-raised px-3.5 text-sm font-medium text-fg transition-colors hover:bg-[#222226]">
              Sign in
            </button>
          </nav>
        </div>
      </header>

      <main id="main">
        <section aria-labelledby="hero-h" className={`${wrap} grid items-end gap-10 pt-16 pb-12 md:pt-24 lg:grid-cols-[1.3fr_1fr]`}>
          <motion.div initial={reduce ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, ease: [0.23, 1, 0.32, 1] }}>
            <h1 id="hero-h" className="m-0 text-4xl leading-[1.05] font-semibold tracking-tighter text-balance md:text-6xl">
              Every job gets a time it must start by.
            </h1>
            <p className={`${body} mt-5 mb-0 text-base md:text-lg`}>GPU time for AI agents, sold per job. Your payment waits in escrow until the promised start.</p>
          </motion.div>
          <motion.div
            initial={reduce ? false : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.08, ease: [0.23, 1, 0.32, 1] }}
            className="lg:justify-self-end lg:w-full lg:max-w-[380px]"
          >
            <SignIn primaryClass={primary} onDone={() => navigate("/app", { viewTransition: true })} />
          </motion.div>
        </section>

        <Reveal className={`${wrap} pb-24 md:pb-32`}>
          <Lanes />
        </Reveal>

        <section aria-labelledby="promise-h" className={`${wrap} grid gap-10 pb-24 md:pb-32 lg:grid-cols-[1fr_1.1fr] lg:gap-16`}>
          <Reveal>
            <h2 id="promise-h" className={h2}>
              A promise you can plan on.
            </h2>
            <p className={`${body} mt-4`}>
              Each provider measures its slowest speed at startup, then caps every job at a hard run limit. So it knows the latest moment a worker frees up, and promises your start by then.
            </p>
            <p className="my-6 rounded-xl border border-line bg-card px-4 py-3 font-mono text-[13px] text-muted" aria-label="run limit equals startup plus tokens divided by slowest speed, times 1.25">
              <span className="text-accent">limit</span> = (startup + tokens ÷ slowest speed) × 1.25
            </p>
            <p className={`${body} m-0`}>Miss the promise and escrow refunds you automatically, judged by Hedera's own timestamps.</p>
          </Reveal>
          <Reveal>
            <ProviderBoard />
          </Reveal>
        </section>

        <section aria-labelledby="hurry-h" className={`${wrap} grid gap-10 pb-24 md:pb-32 lg:grid-cols-[1.2fr_1fr] lg:gap-16`}>
          <Reveal>
            <h2 id="hurry-h" className={h2}>
              When the deadline is tight.
            </h2>
            <ol className="relative mt-8 mb-0 list-none p-0 before:absolute before:top-2 before:bottom-2 before:left-[11px] before:w-px before:bg-line">
              {STEPS.map(([title, text], i) => (
                <li key={title} className="group relative grid grid-cols-[24px_minmax(0,1fr)] gap-x-5 pb-8 last:pb-0">
                  <span aria-hidden className="relative z-10 grid size-6 place-items-center rounded-full border border-line bg-card font-mono text-[11px] text-muted transition-colors group-hover:border-accent group-hover:text-accent">
                    {i + 1}
                  </span>
                  <div>
                    <h3 className="m-0 text-base font-medium text-fg">{title}</h3>
                    <p className={`${body} mt-1 mb-0 text-sm`}>{text}</p>
                  </div>
                </li>
              ))}
            </ol>
          </Reveal>
          <Reveal className="self-end">
            <div className={`${card} relative overflow-hidden p-6 md:p-8`}>
              <div aria-hidden className="pointer-events-none absolute -top-24 -right-24 size-64 rounded-full bg-accent/10 blur-3xl" />
              <h3 className="m-0 text-xl font-semibold tracking-tight text-fg">Reserve ahead, resell if plans change.</h3>
              <p className={`${body} mt-3 mb-0 text-sm`}>
                Book capacity for later at today's price and attach the job when it's ready. If someone needs that place sooner, sell it and keep the difference.
              </p>
            </div>
          </Reveal>
        </section>

        <section aria-labelledby="log-h" className={`${wrap} pb-24 md:pb-32`}>
          <Reveal>
            <h2 id="log-h" className={h2}>
              Signed, as it happens.
            </h2>
            <p className={`${body} mt-4 mb-8`}>Every row is a message signed on Hedera, read from the Mirror Node and checked in your browser.</p>
            <SignedLog />
          </Reveal>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className={`${wrap} flex flex-col gap-4 py-8 text-sm text-muted sm:flex-row sm:items-center sm:justify-between`}>
          <p className="m-0 max-w-[60ch]">Payments and the signed log on Hedera. Offers on Arkiv. Models on providers' own GPUs.</p>
          <nav aria-label="Footer" className="flex items-center gap-5">
            <Link to="/network" viewTransition className="text-muted no-underline hover:text-fg">
              Network
            </Link>
            <Link to="/provide" viewTransition className="text-muted no-underline hover:text-fg">
              Sell GPU time
            </Link>
            <button type="button" onClick={start} className="cursor-pointer border-0 bg-transparent p-0 text-sm text-muted hover:text-fg">
              Sign in
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
    <main id="main" className="mx-auto grid min-h-dvh max-w-2xl content-center gap-3 bg-bg px-4 font-sans text-fg sm:px-6">
      <svg viewBox="0 0 600 80" className="mb-3 h-auto w-full max-w-[600px]" aria-hidden>
        <line x1="0" x2="600" y1="62" y2="62" className="ln-lane" />
        <line x1="300" x2="300" y1="6" y2="70" className="ln-tick" />
        <text x="306" y="56" className="ln-tick-label">
          starts by
        </text>
      </svg>
      <h1 className="m-0 text-4xl leading-tight font-semibold tracking-tighter md:text-5xl">Nothing is queued at this address.</h1>
      <p className="m-0 text-muted">The page you asked for doesn't exist, so there's nothing to start.</p>
      <Link to="/" viewTransition className="group mt-2 inline-flex items-center gap-2 font-medium text-fg no-underline">
        Back to Dani.ai
        <ArrowRight aria-hidden size={15} className="text-accent transition-transform group-hover:translate-x-1" />
      </Link>
    </main>
  );
}
