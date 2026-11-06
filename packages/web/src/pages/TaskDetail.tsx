import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { Card, Notice, PageHeader, StatusBadge } from "../components/ui";
import { clock, hashscan, hbar } from "../lib/format";
import { useSession } from "../lib/session";

type Detail = {
  task: {
    jobHash: string;
    label: string;
    task: string | null;
    input: string | null;
    status: string;
    deadline: number;
    providerName: string | null;
    serial: number | null;
    start: number | null;
    price: string | null;
    rushPaid: string | null;
    maxPay: string | null;
    minComp: string | null;
    onTime: boolean | null;
    result: string | null;
    resultHash: string | null;
    tokens: number | null;
    model: string | null;
    failure: string | null;
    finishedAt: number | null;
    arkivKey: string | null;
    createdAt: string;
  };
  provider: { topicId: string; tokenId: string; name: string } | null;
};

export function TaskDetail() {
  const { jobHash = "" } = useParams();
  const { account, api } = useSession();
  const q = useQuery({
    queryKey: ["task", jobHash, account],
    queryFn: () => api<Detail>(`/tasks/${jobHash}`),
    refetchInterval: (query) => (["done", "failed"].includes(query.state.data?.task.status ?? "") ? false : 4000),
  });
  if (q.isPending) return <p className="muted">Loading…</p>;
  if (q.isError) return <Notice text={q.error.message} kind="error" />;
  const { task: t, provider: p } = q.data;
  const created = Math.floor(new Date(t.createdAt).getTime() / 1000);
  const total = BigInt(t.price ?? 0) + BigInt(t.rushPaid ?? 0);

  // A plain-language history, built from what the record says happened.
  const steps: { when?: number; text: string; state: "done" | "now" | "todo" }[] = [
    { when: created, text: `Booked on ${t.providerName ?? "a provider"} for ${hbar(t.price)}`, state: "done" },
    ...(t.rushPaid ? [{ text: `Moved ahead in the queue: paid another agent ${hbar(t.rushPaid)} to finish on time`, state: "done" as const }] : []),
    {
      when: t.start ?? undefined,
      text: t.status === "queued" ? `Scheduled to start at ${t.start ? clock(t.start) : "the next free slot"}` : "Ran on the provider's GPU",
      state: t.status === "queued" ? "now" : "done",
    },
    t.status === "failed"
      ? { text: `Didn't complete: ${t.failure ?? "unknown reason"}`, state: "now" }
      : {
          when: t.finishedAt ?? undefined,
          text: t.status === "done" ? `Delivered ${t.onTime ? "on time" : "late"} and verified` : "Waiting for the result",
          state: t.status === "done" ? "done" : t.status === "running" ? "now" : "todo",
        },
  ];

  return (
    <>
      <PageHeader title={t.label} intro={<Link to="/app/tasks">← Tasks</Link>} action={<StatusBadge status={t.status} onTime={t.onTime} />} />
      <div className="detail-grid">
        <div className="stack">
          <Card title="Result">
            {t.result ? (
              <div className="result">{t.result}</div>
            ) : t.status === "failed" ? (
              <p className="warn">{t.failure}</p>
            ) : (
              <p className="muted">The result appears here when the task finishes. This page updates by itself.</p>
            )}
          </Card>
          <Card title="Request">
            <div className="result quiet">{t.task}</div>
            {t.input && (
              <details>
                <summary>Material ({t.input.length.toLocaleString()} characters)</summary>
                <div className="result quiet">{t.input}</div>
              </details>
            )}
          </Card>
        </div>
        <div className="stack">
          <Card title="Progress">
            <ol className="timeline">
              {steps.map((s, i) => (
                <li key={i} className={s.state}>
                  <span>{s.text}</span>
                  {s.when ? <time>{clock(s.when)}</time> : null}
                </li>
              ))}
            </ol>
          </Card>
          <Card title="Summary">
            <dl className="facts">
              <dt>Due</dt>
              <dd>{clock(t.deadline)}</dd>
              {t.finishedAt ? (
                <>
                  <dt>Finished</dt>
                  <dd>
                    {clock(t.finishedAt)} ({t.onTime ? `${t.deadline - t.finishedAt}s early` : `${t.finishedAt - t.deadline}s late`})
                  </dd>
                </>
              ) : null}
              <dt>Total cost</dt>
              <dd>{hbar(total)}</dd>
              {t.model && (
                <>
                  <dt>Model</dt>
                  <dd>{t.model}</dd>
                </>
              )}
            </dl>
          </Card>
          <details className="card verification">
            <summary>Verification</summary>
            <ul className="proof">
              <li>
                The provider signed this job, its start and its result on{" "}
                {p ? (
                  <a href={hashscan("topic", p.topicId)} target="_blank" rel="noopener">
                    Hedera topic {p.topicId}
                  </a>
                ) : (
                  "its Hedera topic"
                )}
                . Job fingerprint <code>{t.jobHash.slice(0, 12)}…</code>
              </li>
              {t.resultHash && (
                <li>
                  Your agent checked the result against the fingerprint the provider signed: <code>{t.resultHash.slice(0, 12)}…</code>
                </li>
              )}
              {t.arkivKey && (
                <li>
                  Public record on Arkiv: <code>{t.arkivKey.slice(0, 14)}…</code>
                </li>
              )}
              {p && t.serial !== null && (
                <li>
                  GPU time was held as NFT{" "}
                  <a href={`${hashscan("token", p.tokenId)}/${t.serial}`} target="_blank" rel="noopener">
                    {p.tokenId} #{t.serial}
                  </a>
                </li>
              )}
            </ul>
          </details>
        </div>
      </div>
    </>
  );
}
