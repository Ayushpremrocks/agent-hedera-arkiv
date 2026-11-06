import { useMemo, useState } from "react";
import { Link } from "react-router";
import { Card, Empty, Notice, PageHeader, StatusBadge } from "../components/ui";
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
  const rows = useMemo(
    () =>
      (tasks.data ?? []).filter(
        (t) =>
          (filter === "all" || (filter === "active" ? t.status === "queued" || t.status === "running" : t.status === filter)) &&
          t.label.toLowerCase().includes(q.trim().toLowerCase()),
      ),
    [tasks.data, filter, q],
  );

  return (
    <>
      <PageHeader
        title="Tasks"
        action={
          <Link className="button" to="/app/tasks/new">
            New task
          </Link>
        }
      />
      <Card>
        <div className="toolbar">
          <div className="segmented" role="tablist" aria-label="Filter tasks">
            {FILTERS.map(([v, l]) => (
              <button key={v} type="button" role="tab" aria-selected={filter === v} className={filter === v ? "on" : ""} onClick={() => setFilter(v)}>
                {l}
              </button>
            ))}
          </div>
          <input type="search" placeholder="Search tasks" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search tasks" />
        </div>
        <Notice text={tasks.error?.message} kind="error" />
        {rows.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Task</th>
                <th>Status</th>
                <th>Due</th>
                <th>Result</th>
                <th className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.jobHash}>
                  <td>
                    <Link to={`/app/tasks/${t.jobHash}`}>{t.label}</Link>
                    {t.rushPaid && <span className="tag">Rushed</span>}
                  </td>
                  <td>
                    <StatusBadge status={t.status} onTime={t.onTime} />
                  </td>
                  <td>{clock(t.deadline)}</td>
                  <td className="clip">{t.preview ?? (t.failure ? <span className="warn">{t.failure}</span> : <span className="muted">–</span>)}</td>
                  <td className="num">{hbar(BigInt(t.price ?? 0) + BigInt(t.rushPaid ?? 0))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty title={tasks.data?.length ? "Nothing matches" : "No tasks yet"}>
            {!tasks.data?.length && (
              <p>
                <Link to="/app/tasks/new">Book your first task</Link>.
              </p>
            )}
          </Empty>
        )}
      </Card>
    </>
  );
}
