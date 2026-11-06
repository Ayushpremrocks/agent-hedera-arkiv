import { CheckCircle, Clock, Tray, WarningCircle } from "@phosphor-icons/react";
import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
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

export function PageHeader({ title, intro, action }: { title: string; intro?: ReactNode; action?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {intro && <p>{intro}</p>}
      </div>
      {action}
    </div>
  );
}

export function Card({ title, action, children, className = "" }: { title?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <div className="card-head">
          {title && <h2>{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Metric({ value, label, hint }: { value: ReactNode; label: string; hint?: string }) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <b>{value}</b>
      {hint && <small>{hint}</small>}
    </div>
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
      <Tray size={28} weight="duotone" aria-hidden />
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
