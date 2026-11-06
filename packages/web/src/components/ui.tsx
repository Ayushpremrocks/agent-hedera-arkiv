import type { ReactNode } from "react";

export function Notice({ text, kind = "info" }: { text?: string | null; kind?: "info" | "error" }) {
  if (!text) return null;
  return (
    <p className={`notice ${kind}`} role={kind === "error" ? "alert" : "status"}>
      {text}
    </p>
  );
}

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

const STATUS: Record<string, [string, string]> = {
  queued: ["Waiting for its slot", "wait"],
  running: ["Running now", "wait"],
  failed: ["Didn't run", "bad"],
};
export function TaskStatus({ status, onTime }: { status: string; onTime: boolean | null }) {
  const [label, tone] = status === "done" ? (onTime ? ["Delivered on time", "ok"] : ["Delivered late", "late"]) : (STATUS[status] ?? [status, "wait"]);
  return <span className={`chip ${tone}`}>{label}</span>;
}

export function Who({ id, names, color }: { id: string; names: Record<string, string>; color: string }) {
  return (
    <span className="who">
      <i style={{ background: color }} />
      {names[id] ?? id}
    </span>
  );
}
