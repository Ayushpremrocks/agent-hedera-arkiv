import { ArrowLeft, CheckCircle, Clock, Tray, WarningCircle } from "@phosphor-icons/react";
import { motion, useReducedMotion } from "motion/react";
import { type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router";
import { clock } from "../lib/format";
import { statusOf } from "../lib/hooks";
import { Dots } from "./motion";

export function Notice({ text, kind = "info" }: { text?: string | null; kind?: "info" | "error" }) {
  if (!text) return null;
  return (
    <p className={`notice ${kind}`} role={kind === "error" ? "alert" : "status"}>
      {text}
    </p>
  );
}

export function PageHeader({ title, intro, action, back }: { title: ReactNode; intro?: ReactNode; action?: ReactNode; back?: { to: string; label: string } }) {
  return (
    <header className="page-head">
      {back && (
        <Link to={back.to} className="page-back" viewTransition>
          <ArrowLeft size={14} aria-hidden /> {back.label}
        </Link>
      )}
      <div className="page-head-row">
        <div>
          <h1>{title}</h1>
          {intro && <p>{intro}</p>}
        </div>
        {action && <div className="page-actions">{action}</div>}
      </div>
    </header>
  );
}

/** Ticks once a second while `live`, so tracks and countdowns move with real time. */
export function useNow(live = true) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!live) return;
    const i = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(i);
  }, [live]);
  return now;
}

/**
 * A task as its promise: time runs left to right from booking; the dashed amber mark is the latest
 * start the provider guaranteed, the solid mark is the deadline. The bar is elapsed time, and its
 * end is "now" while the task is open, or when it finished. A task is on track when it starts
 * before the dashed mark and the bar stops before the deadline.
 */
export function PromiseTrack({
  booked,
  startBy,
  deadline,
  finishedAt,
  status,
  onTime,
  size = "sm",
}: {
  booked: number;
  startBy: number | null;
  deadline: number;
  finishedAt: number | null;
  status: string;
  onTime: boolean | null;
  size?: "sm" | "lg";
}) {
  const open = status === "queued" || status === "running";
  const now = useNow(open);
  const end = finishedAt ?? (open ? now : deadline);
  const t1 = Math.max(deadline, end) + Math.max(4, (deadline - booked) * 0.06);
  const span = Math.max(1, t1 - booked);
  const pct = (t: number) => `${Math.min(100, Math.max(0, ((t - booked) / span) * 100)).toFixed(2)}%`;
  const tone = status === "failed" ? "bad" : status === "done" ? (onTime ? "ok" : "late") : end > deadline ? "late" : status === "preview" ? "ok" : "run";
  const label =
    status === "preview"
      ? `Worst case: starts by ${startBy ? clock(startBy) : "now"}, finishes by ${clock(end)}, due ${clock(deadline)}`
      : status === "done"
      ? `Finished ${onTime ? `${Math.max(0, Math.round(deadline - (finishedAt ?? deadline)))}s before` : `${Math.round((finishedAt ?? deadline) - deadline)}s after`} the deadline`
      : status === "failed"
        ? "Did not complete"
        : startBy && now < startBy
          ? `Starts within ${Math.max(0, Math.round(startBy - now))}s, due in ${Math.max(0, Math.round(deadline - now))}s`
          : `Due in ${Math.max(0, Math.round(deadline - now))}s`;
  return (
    <div className={`track track-${size} tone-${tone} ${status === "preview" ? "track-preview" : ""}`} role="img" aria-label={label}>
      <div className="track-rail">
        <span className="track-fill" style={{ scale: `${Math.min(1, Math.max(0, (end - booked) / span)).toFixed(4)} 1` }} />
        {startBy !== null && <span className="track-promise" style={{ left: pct(startBy) }} />}
        <span className="track-due" style={{ left: pct(deadline) }} />
      </div>
      {size === "lg" && (
        <div className="track-labels" aria-hidden>
          <span style={{ left: 0 }}>{status === "preview" ? "Now" : `Booked ${clock(booked)}`}</span>
          {startBy !== null && <span style={{ left: pct(startBy) }} className="tl-promise">Starts by {clock(startBy)}</span>}
          <span style={{ left: pct(deadline) }} className="tl-due">Due {clock(deadline)}</span>
        </div>
      )}
    </div>
  );
}

/** Money and counts as one statement line, not a grid of cards. */
export function Ledger({ items }: { items: { label: string; value: ReactNode; hint?: string }[] }) {
  return (
    <dl className="ledger">
      {items.map((i) => (
        <div key={i.label} title={i.hint}>
          <dt>{i.label}</dt>
          <dd>{i.value}</dd>
        </div>
      ))}
    </dl>
  );
}



/** Status with a cue that doesn't depend on colour alone: dots while running, an icon otherwise. */
export function StatusBadge({ status, onTime }: { status: string; onTime: boolean | null }) {
  const s = statusOf({ status: status as any, onTime });
  const reduce = useReducedMotion();
  const icon =
    s.tone === "run" ? <Dots label="Running" /> : s.tone === "ok" ? (
      <motion.span style={{ display: "inline-flex" }} initial={reduce ? false : { scale: 0.25, opacity: 0, filter: "blur(4px)" }} animate={{ scale: 1, opacity: 1, filter: "blur(0px)" }} transition={{ type: "spring", duration: 0.3, bounce: 0 }}>
        <CheckCircle weight="fill" />
      </motion.span>
    ) : s.tone === "bad" || s.tone === "late" ? <WarningCircle weight="fill" /> : <Clock weight="bold" />;
  return (
    <span className={`badge ${s.tone}`}>
      {icon}
      {s.label}
    </span>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <Tray size={26} aria-hidden />
      <b>{title}</b>
      {children}
    </div>
  );
}

// Kept for the Network page.
export function Section({ title, intro, children, className }: { title: string; intro?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={className}>
      <div className="section-head">
        <h2>{title}</h2>
        {intro && <p>{intro}</p>}
      </div>
      {children}
    </section>
  );
}
export function Stats({ items }: { items: [ReactNode, string][] }) {
  return (
    <div className="stats">
      {items.map(([value, label]) => (
        <div key={label}>
          <b>{value}</b>
          <span>{label}</span>
        </div>
      ))}
    </div>
  );
}
export function Who({ id, names, color }: { id: string; names: Record<string, string>; color: string }) {
  return (
    <span className="who">
      <i style={{ background: color }} />
      {names[id] ?? id}
    </span>
  );
}
