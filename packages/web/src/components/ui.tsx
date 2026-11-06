import type { ReactNode } from "react";
import { statusOf } from "../lib/hooks";

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

export function StatusBadge({ status, onTime }: { status: string; onTime: boolean | null }) {
  const s = statusOf({ status: status as any, onTime });
  return <span className={`badge ${s.tone}`}>{s.label}</span>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
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
