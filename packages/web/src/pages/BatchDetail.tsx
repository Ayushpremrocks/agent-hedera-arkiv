// One batch: the same instructions over many inputs, each booked as its own job with its own promise.
import { DownloadSimple } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { Skeleton, toast } from "../components/motion";
import { Notice, PageHeader, PromiseTrack, Stats, StatusBadge } from "../components/ui";
import { clock, hbar } from "../lib/format";
import type { TaskRow } from "../lib/hooks";
import { useSession } from "../lib/session";

type Run = Pick<TaskRow, "jobHash" | "label" | "status" | "onTime" | "deadline" | "start" | "finishedAt" | "failure" | "price" | "createdAt"> & { batchIndex: number | null; result: string | null };
type Batch = {
  id: string;
  label: string;
  spec: { task: string; withinSeconds: number; maxTokens: number };
  total: number;
  inputs: string[];
  deadline: number;
  booked: number;
  failed: number;
  errors: { index: number; error: string }[] | null; // null until an item fails
  status: "booking" | "booked" | "cancelled";
  createdAt: string;
};
type Data = { batch: Batch; tasks: Run[] };

const finished = (t: Run) => t.status === "done" || t.status === "failed";

function download(name: string, type: string, text: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const csvCell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;

export function BatchDetail() {
  const { id = "" } = useParams();
  const { api } = useSession();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["batch", id],
    queryFn: () => api<Data>(`/batches/${id}`),
    // stop polling once everything is booked and every job has finished
    refetchInterval: (query) => {
      const d = query.state.data;
      return d && d.batch.status !== "booking" && d.tasks.every(finished) ? false : 4000;
    },
  });
  const cancel = useMutation({
    mutationFn: () => api<{ cancelled: boolean }>(`/batches/${id}/cancel`, {}),
    onSuccess: (r) => {
      toast(r.cancelled ? "success" : "error", r.cancelled ? "Batch stopped" : "Nothing left to stop", r.cancelled ? "Jobs already booked still run." : undefined);
      qc.invalidateQueries({ queryKey: ["batch", id] });
    },
    onError: (e) => toast("error", "Couldn't stop the batch", e.message),
  });

  if (q.isPending)
    return (
      <>
        <PageHeader title="Batch" back={{ to: "/app/tasks", label: "Tasks" }} />
        <div className="stack" aria-busy>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} h={44} />
          ))}
        </div>
      </>
    );
  if (!q.data) return <Notice text={q.error?.message ?? "Batch not found"} kind="error" />;

  const { batch: b, tasks } = q.data;
  const byIndex = new Map(tasks.map((t) => [t.batchIndex, t]));
  const done = tasks.filter((t) => t.status === "done");
  const onTime = done.filter((t) => t.onTime).length;
  const cost = tasks.reduce((s, t) => s + BigInt(t.price ?? 0), 0n);
  const rows = Array.from({ length: b.total }, (_, i) => ({ i, input: b.inputs[i], task: byIndex.get(i), error: b.errors?.find((e) => e.index === i)?.error }));
  const exportRows = rows.map((r) => ({ index: r.i + 1, input: r.input, status: r.task?.status ?? (r.error ? "not booked" : "waiting"), onTime: r.task?.onTime ?? null, result: r.task?.result ?? null, error: r.task?.failure ?? r.error ?? null }));
  const name = b.label.replace(/[^\w-]+/g, "-").toLowerCase() || "batch";

  return (
    <>
      <PageHeader
        title={b.label}
        intro={`${b.total} jobs, one instruction · due by ${clock(b.deadline)}`}
        back={{ to: "/app/tasks", label: "Tasks" }}
        action={
          <div className="page-actions">
            <button type="button" className="btn btn-ghost" onClick={() => download(`${name}.json`, "application/json", JSON.stringify(exportRows, null, 2))}>
              <DownloadSimple size={16} aria-hidden /> JSON
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => download(`${name}.csv`, "text/csv", [Object.keys(exportRows[0] ?? { index: 0 }).join(","), ...exportRows.map((r) => Object.values(r).map(csvCell).join(","))].join("\n"))}
            >
              <DownloadSimple size={16} aria-hidden /> CSV
            </button>
            {b.status === "booking" && (
              <button type="button" className="btn btn-ghost" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
                Stop booking
              </button>
            )}
          </div>
        }
      />
      <Stats
        items={[
          [`${b.booked} / ${b.total}`, b.status === "booking" ? "Booked so far" : b.status === "cancelled" ? "Booked, then stopped" : "Booked"],
          [`${done.length} / ${b.booked}`, "Delivered"],
          [done.length ? `${onTime} / ${done.length}` : "–", "Started on time"],
          [hbar(cost), "Charged so far"],
        ]}
      />
      <div className="batch-bar" role="progressbar" aria-label="Jobs finished" aria-valuemin={0} aria-valuemax={b.total} aria-valuenow={tasks.filter(finished).length}>
        <span className="batch-bar-done" style={{ width: `${(tasks.filter(finished).length / b.total) * 100}%` }} />
        <span className="batch-bar-booked" style={{ width: `${(b.booked / b.total) * 100}%` }} />
      </div>
      <details className="disclose">
        <summary>Instructions</summary>
        <pre className="result">{b.spec.task}</pre>
      </details>
      <table className="data">
        <thead>
          <tr>
            <th className="num">#</th>
            <th>Input</th>
            <th>Status</th>
            <th className="col-track">Promise</th>
            <th className="num">Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ i, input, task: t, error }) => (
            <tr key={i}>
              <td className="num">{i + 1}</td>
              <td className="col-name">
                {t ? (
                  <Link to={`/app/tasks/${t.jobHash}`} className="row-link" viewTransition>
                    {input}
                  </Link>
                ) : (
                  <span>{input}</span>
                )}
                <span className="row-sub">{t?.result?.slice(0, 160) ?? t?.failure ?? error ?? ""}</span>
              </td>
              <td>{t ? <StatusBadge status={t.status} onTime={t.onTime} /> : error ? <span className="badge bad">Not booked</span> : <span className="badge wait">{b.status === "cancelled" ? "Stopped" : "Booking…"}</span>}</td>
              <td className="col-track">
                {t && <PromiseTrack booked={Math.floor(new Date(t.createdAt).getTime() / 1000)} startBy={t.start} deadline={t.deadline} finishedAt={t.finishedAt} status={t.status} onTime={t.onTime} />}
              </td>
              <td className="num nowrap">{t ? hbar(t.price ?? 0) : "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
