import { ArrowsLeftRight, CheckCircle, Lightning, ShieldCheck, Wallet } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { Link, Navigate, useNavigate } from "react-router";
import { AgentStatus, Item, ProgressButton, Stagger } from "../components/motion";
import { Notice } from "../components/ui";
import { hbar } from "../lib/format";
import { type LogEvent, type Provider, fetchLog } from "../lib/market";
import { useSession } from "../lib/session";

/** One line per real network event, in customer words. */
function plain(ev: LogEvent): { icon: typeof CheckCircle; text: string } | null {
  const e = ev.e;
  if (!ev.verified) return null;
  if (e.type === "booked") return { icon: Lightning, text: `A task booked GPU time for ${hbar(e.price)}` };
  if (e.type === "trade") return { icon: ArrowsLeftRight, text: `An agent paid ${hbar(e.price)} to go first; the other still finishes on time` };
  if (e.type === "delivered") return { icon: CheckCircle, text: e.met ? "A task was delivered on time" : "A task was delivered" }; // never echo task names
  if (e.type === "done" && e.ok) return { icon: CheckCircle, text: `A provider finished a task in ${(e.ms / 1000).toFixed(1)}s` };
  return null;
}

function LiveNetwork() {
  const reduce = useReducedMotion();
  const providers = useQuery({ queryKey: ["providers"], queryFn: () => fetch("/api/market").then((r) => r.json()).then((d) => d.providers as Provider[]), refetchInterval: 15_000 });
  const list = providers.data ?? [];
  const log = useQuery({ queryKey: ["landing-log", list.map((p) => p.id).join()], queryFn: () => fetchLog(list), enabled: list.length > 0, refetchInterval: 6000 });
  const lines = (log.data ?? []).flatMap((ev) => {
    const p = plain(ev);
    return p ? [{ key: `${ev.provider}:${ev.seq}`, ...p }] : [];
  });

  return (
    <div className="live-panel" aria-label="Live activity on the network">
      <div className="live-head">
        <AgentStatus working={list.length > 0} label={list.length ? `${list.length} provider${list.length > 1 ? "s" : ""} online` : "Connecting to the network"} />
        <Link to="/network" className="link">
          Network status
        </Link>
      </div>
      <ol className="live-feed">
        <AnimatePresence initial={false}>
          {lines.slice(0, 6).map((l) => (
            <motion.li
              key={l.key}
              layout={!reduce}
              initial={reduce ? false : { opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: { duration: 0.15 } }}
              transition={{ type: "spring", duration: 0.4, bounce: 0 }}
            >
              <l.icon weight="duotone" aria-hidden />
              <span>{l.text}</span>
            </motion.li>
          ))}
        </AnimatePresence>
        {!lines.length && <li className="muted">Waiting for the next event on Hedera…</li>}
      </ol>
      <p className="live-foot">Every line is a message signed on Hedera, read live.</p>
    </div>
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
      navigate("/app");
    } catch (e) {
      setError((e as Error).message ?? String(e));
    } finally {
      setStep("");
    }
  };

  return (
    <div className="landing">
      <header className="landing-top">
        <span className="logo">QueueYield</span>
        <Link to="/network" className="link">
          Network status
        </Link>
      </header>
      <section className="hero">
        <Stagger className="hero-copy">
          <Item>
            <h1>AI work, done by the deadline you set.</h1>
          </Item>
          <Item>
            <p>Your agent books GPU time and, when you're in a hurry, pays others to let you go first.</p>
          </Item>
          <Item className="hero-actions">
            <ProgressButton type="button" className="big" onClick={start} state={step ? "loading" : "idle"}>
              Get started
            </ProgressButton>
          </Item>
          <Notice text={step} />
          <Notice text={error} kind="error" />
        </Stagger>
        <LiveNetwork />
      </section>
      <section className="how">
        <h2>How it works</h2>
        <div className="how-grid">
          <article className="how-wide">
            <Wallet size={28} weight="duotone" aria-hidden />
            <b>Set a budget in HashPack</b>
            <p>Your HBAR stays in your wallet. You approve the most your agent may spend, and change it any time.</p>
          </article>
          <article>
            <Lightning size={28} weight="duotone" aria-hidden />
            <b>Pick how urgent it is</b>
            <p>Flexible earns when others go first. Rush pays to jump ahead. You see the cost before booking.</p>
          </article>
          <article>
            <ShieldCheck size={28} weight="duotone" aria-hidden />
            <b>Get a verified result</b>
            <p>Each result is checked against a fingerprint the provider signs on Hedera.</p>
          </article>
          <article className="how-tint">
            <ArrowsLeftRight size={28} weight="duotone" aria-hidden />
            <b>Nobody waits unpaid</b>
            <p>Agents trade places only when both agree on the price, and only if the one waiting still finishes on time.</p>
          </article>
        </div>
      </section>
    </div>
  );
}
