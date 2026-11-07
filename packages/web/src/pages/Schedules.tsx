// Recurring jobs: each run is reserved ahead at today's price, then booked when it comes.
import { CalendarCheck, Pause, Play, Plus, Trash } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useLocation } from "react-router";
import { Skeleton, toast } from "../components/motion";
import { Empty, Notice, PageHeader, StatusBadge, useNow } from "../components/ui";
import { clock, hbar, inHuman } from "../lib/format";
import type { TaskRow } from "../lib/hooks";
import { useSession } from "../lib/session";

type Schedule = {
  id: string;
  label: string;
  task: string;
  every: number;
  runsLeft: number;
  runsDone: number;
  nextRun: number;
  reservedFor: number | null;
  active: boolean;
  lastError: string | null;
  withinSeconds: number;
  maxTokens: number;
};
type Run = Pick<TaskRow, "jobHash" | "label" | "status" | "onTime" | "deadline" | "finishedAt" | "price" | "createdAt">;

/** "hour", "6 hours", "15 min", "day" */
function everyText(s: number) {
  const [n, unit] = s % 86_400 === 0 ? [s / 86_400, "day"] : s % 3600 === 0 ? [s / 3600, "hour"] : [Math.round(s / 60), "min"];
  return n === 1 ? unit : `${n} ${unit}${unit === "min" ? "" : "s"}`;
}

function Runs({ id }: { id: string }) {
  const { api } = useSession();
  const q = useQuery({ queryKey: ["schedule", id], queryFn: () => api<{ runs: Run[] }>(`/schedules/${id}`), refetchInterval: 8000 });
  if (q.isPending) return <Skeleton h={36} />;
  if (!q.data?.runs.length) return <p className="muted small">No runs yet.</p>;
  return (
    <ul className="sched-runs">
      {q.data.runs.map((r) => (
        <li key={r.jobHash}>
          <Link to={`/app/tasks/${r.jobHash}`} className="row-link" viewTransition>
            {r.label}
          </Link>
          <StatusBadge status={r.status} onTime={r.onTime} />
          <span className="muted small nowrap">{hbar(r.price ?? 0)}</span>
        </li>
      ))}
    </ul>
  );
}

function Card({ s, now, opened }: { s: Schedule; now: number; opened: boolean }) {
  const { api } = useSession();
  const qc = useQueryClient();
  const [open, setOpen] = useState(opened);
  const change = useMutation({
    mutationFn: (body: { active: boolean } | { delete: true }) => api(`/schedules/${s.id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedules"] }),
    onError: (e) => toast("error", "Couldn't change the schedule", e.message),
  });
  const reserved = s.active && s.reservedFor === s.nextRun;
  const total = s.runsDone + s.runsLeft;
  return (
    <li className="sched">
      <div className="sched-head">
        <div className="sched-title">
          <b>{s.label}</b>
          <span className="muted small">
            Every {everyText(s.every)} · run {s.runsDone} of {total} · each due {inHuman(s.withinSeconds).replace(/^in /, "within ")}
          </span>
        </div>
        <div className="page-actions">
          {s.runsLeft > 0 && (
            <button type="button" className="btn btn-ghost" disabled={change.isPending} onClick={() => change.mutate({ active: !s.active })}>
              {s.active ? <Pause size={16} aria-hidden /> : <Play size={16} aria-hidden />}
              {s.active ? "Pause" : "Resume"}
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            aria-label={`Delete ${s.label}`}
            disabled={change.isPending}
            onClick={() => confirm(`Delete "${s.label}"? Runs already booked keep running.`) && change.mutate({ delete: true })}
          >
            <Trash size={16} aria-hidden />
          </button>
        </div>
      </div>
      <p className="sched-task">{s.task}</p>
      <p className="sched-next">
        {!s.runsLeft ? (
          <span className="muted">Finished: all {total} runs booked.</span>
        ) : !s.active ? (
          <span className="muted">Paused.</span>
        ) : (
          <>
            Next run at <b>{clock(s.nextRun)}</b> <span className="muted">({inHuman(s.nextRun - now)})</span>
            {reserved && (
              <span className="tag">
                <CalendarCheck size={12} aria-hidden /> place reserved
              </span>
            )}
          </>
        )}
      </p>
      {s.lastError && <p className="warn small">{s.lastError}</p>}
      <details className="disclose" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
        <summary>Recent runs</summary>
        {open && <Runs id={s.id} />}
      </details>
    </li>
  );
}

export function Schedules() {
  const { api } = useSession();
  const { hash } = useLocation();
  const now = useNow();
  const q = useQuery({ queryKey: ["schedules"], queryFn: () => api<{ schedules: Schedule[] }>("/schedules").then((r) => r.schedules), refetchInterval: 10_000 });
  return (
    <>
      <PageHeader
        title="Schedules"
        intro="Jobs that repeat. Each run reserves its place ahead, so it starts on time even when the network is busy."
        action={
          <Link className="btn btn-primary" to="/app/tasks/new" viewTransition>
            <Plus size={16} weight="bold" aria-hidden /> New schedule
          </Link>
        }
      />
      <Notice text={q.error?.message} kind="error" />
      {q.isPending ? (
        <div className="stack" aria-busy>
          {[0, 1].map((i) => (
            <Skeleton key={i} h={96} />
          ))}
        </div>
      ) : q.data?.length ? (
        <ul className="sched-list">
          {q.data.map((s) => (
            <Card key={s.id} s={s} now={now} opened={hash === `#${s.id}`} />
          ))}
        </ul>
      ) : (
        <Empty title="No schedules yet">
          <p>
            In <Link to="/app/tasks/new">New task</Link>, choose <b>Repeat</b> under Run.
          </p>
        </Empty>
      )}
    </>
  );
}
