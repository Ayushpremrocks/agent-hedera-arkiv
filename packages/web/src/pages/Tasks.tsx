import { MagnifyingGlass, Plus } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { Skeleton } from "../components/motion";
import { Empty, Notice, PageHeader, PromiseTrack, StatusBadge } from "../components/ui";
import { clock, hbar } from "../lib/format";
import { useTasks } from "../lib/hooks";

const FILTERS = [
  ["all", "All"],
  ["active", "In progress"],
  ["done", "Delivered"],
  ["failed", "Failed"],
] as const;

export function Tasks() {
  const tasks = useTasks();
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>("all");
  const [q, setQ] = useState("");
  const all = tasks.data ?? [];
  const count = (v: (typeof FILTERS)[number][0]) =>
    v === "all" ? all.length : all.filter((t) => (v === "active" ? t.status === "queued" || t.status === "running" : t.status === v)).length;
  const rows = useMemo(
    () =>
      all.filter(
        (t) =>
          (filter === "all" || (filter === "active" ? t.status === "queued" || t.status === "running" : t.status === filter)) &&
          t.label.toLowerCase().includes(q.trim().toLowerCase()),
      ),
    [all, filter, q],
  );

  return (
    <>
      <PageHeader
        title="Tasks"
        action={
          <Link className="btn btn-primary" to="/app/tasks/new" viewTransition>
            <Plus size={16} weight="bold" aria-hidden /> New task
          </Link>
        }
      />
      <div className="toolbar">
        <div className="tabs" role="group" aria-label="Filter tasks">
          {FILTERS.map(([v, l]) => (
            <button key={v} type="button" aria-pressed={filter === v} className="tab" onClick={() => setFilter(v)}>
              {l} <span className="tab-count">{count(v)}</span>
            </button>
          ))}
        </div>
        <label className="search">
          <MagnifyingGlass size={16} aria-hidden />
          <input type="search" placeholder="Search by name" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search tasks" />
        </label>
      </div>
      <Notice text={tasks.error?.message} kind="error" />
      {tasks.isPending ? (
        <div className="stack" aria-busy>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} h={44} />
          ))}
        </div>
      ) : rows.length ? (
        <table className="data">
          <thead>
            <tr>
              <th>Task</th>
              <th>Status</th>
              <th className="col-track">Promise</th>
              <th>Due</th>
              <th className="num">Cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.jobHash}>
                <td className="col-name">
                  <Link to={`/app/tasks/${t.jobHash}`} className="row-link" viewTransition>
                    {t.label}
                  </Link>
                  {t.rushPaid && <span className="tag">Rushed</span>}
                  {t.batchId && (
                    <Link to={`/app/batches/${t.batchId}`} className="tag" viewTransition>
                      Batch
                    </Link>
                  )}
                  {t.scheduleId && (
                    <Link to={`/app/schedules#${t.scheduleId}`} className="tag" viewTransition>
                      Repeats
                    </Link>
                  )}
                  <span className="row-sub">{t.preview ?? t.failure ?? t.providerName ?? ""}</span>
                </td>
                <td>
                  <StatusBadge status={t.status} onTime={t.onTime} />
                </td>
                <td className="col-track">
                  <PromiseTrack
                    booked={Math.floor(new Date(t.createdAt).getTime() / 1000)}
                    startBy={t.start}
                    deadline={t.deadline}
                    finishedAt={t.finishedAt}
                    status={t.status}
                    onTime={t.onTime}
                  />
                </td>
                <td className="nowrap">{clock(t.deadline)}</td>
                <td className="num nowrap">{hbar(BigInt(t.price ?? 0) + BigInt(t.rushPaid ?? 0))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty title={all.length ? "No tasks match" : "No tasks yet"}>
          {all.length ? (
            <p>Try another filter or clear the search.</p>
          ) : (
            <p>
              <Link to="/app/tasks/new">Book your first task</Link>. It gets a start time the provider must meet.
            </p>
          )}
        </Empty>
      )}
    </>
  );
}
