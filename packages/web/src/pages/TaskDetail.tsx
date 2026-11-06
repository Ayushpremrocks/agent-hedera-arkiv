import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { Notice, Section, TaskStatus } from "../components/ui";
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
  };
  provider: { topicId: string; tokenId: string; name: string } | null;
};

export function TaskDetail() {
  const { jobHash = "" } = useParams();
  const { account, api } = useSession();
  const q = useQuery({
    queryKey: ["task", jobHash, account],
    queryFn: () => api<Detail>(`/tasks/${jobHash}`),
    enabled: !!account,
    refetchInterval: (query) => (query.state.data?.task.status === "done" || query.state.data?.task.status === "failed" ? false : 5000),
  });
  if (!account) return <Notice text="Connect your wallet to see your tasks." />;
  if (q.isPending) return <p className="muted">Loading…</p>;
  if (q.isError) return <Notice text={q.error.message} kind="error" />;
  const { task: t, provider: p } = q.data;

  return (
    <>
      <p>
        <Link to="/">← Your tasks</Link>
      </p>
      <Section title={t.label} className="detail">
        <p>
          <TaskStatus status={t.status} onTime={t.onTime} />
        </p>
        <dl className="facts">
          <dt>Due</dt>
          <dd>{clock(t.deadline)}</dd>
          <dt>Ran on</dt>
          <dd>
            {t.providerName ?? "–"}
            {t.serial !== null ? `, slot #${t.serial}` : ""}
            {t.start ? ` starting ${clock(t.start)}` : ""}
          </dd>
          {t.finishedAt ? (
            <>
              <dt>Finished</dt>
              <dd>
                {clock(t.finishedAt)} ({t.onTime ? `${t.deadline - t.finishedAt}s early` : `${t.finishedAt - t.deadline}s late`})
              </dd>
            </>
          ) : null}
          <dt>Booking</dt>
          <dd>{hbar(t.price)}</dd>
          <dt>Your limits</dt>
          <dd>
            pay up to {hbar(t.maxPay)} to go earlier, accept at least {hbar(t.minComp)} to wait
          </dd>
          {t.model && (
            <>
              <dt>Model</dt>
              <dd>
                {t.model}, {t.tokens} tokens
              </dd>
            </>
          )}
        </dl>
        {t.failure && <Notice text={t.failure} kind="error" />}
        {t.result && (
          <>
            <h3>Result</h3>
            <div className="result">{t.result}</div>
          </>
        )}
        <h3>Instruction</h3>
        <div className="result quiet">{t.task}</div>
        {t.input && (
          <details>
            <summary>Material ({t.input.length} characters)</summary>
            <div className="result quiet">{t.input}</div>
          </details>
        )}
        <h3>Proof</h3>
        <ul className="proof">
          <li>
            Job hash <code>{t.jobHash.slice(0, 16)}…</code>: the provider logged this job, its dispatch and its result on{" "}
            {p ? (
              <a href={hashscan("topic", p.topicId)} target="_blank" rel="noopener">
                its Hedera topic {p.topicId}
              </a>
            ) : (
              "its Hedera topic"
            )}
            .
          </li>
          {t.resultHash && (
            <li>
              Result hash <code>{t.resultHash.slice(0, 16)}…</code>: your agent checked the text above against it before saving.
            </li>
          )}
          {t.arkivKey && (
            <li>
              Public record on Arkiv: <code>{t.arkivKey.slice(0, 18)}…</code> (a <code>qy_task</code> entity written by your agent).
            </li>
          )}
          {p && t.serial !== null && (
            <li>
              The slot is NFT{" "}
              <a href={`${hashscan("token", p.tokenId)}/${t.serial}`} target="_blank" rel="noopener">
                {p.tokenId} #{t.serial}
              </a>
              .
            </li>
          )}
        </ul>
      </Section>
    </>
  );
}
