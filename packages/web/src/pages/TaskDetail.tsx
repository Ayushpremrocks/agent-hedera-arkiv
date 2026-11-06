import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { motion, useReducedMotion } from "motion/react";
import { CopyButton, Dots, Skeleton } from "../components/motion";
import { Notice, PageHeader, PromiseTrack, StatusBadge } from "../components/ui";
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
  // How the escrow settled it: the deposit covered the job's maximum size; the provider kept the band it used.
  settlement: { status: string; deposit: string; charged: string | null; returned: string | null; reason: string | null; tx: string | null } | null;
};

export function TaskDetail() {
  const { jobHash = "" } = useParams();
  const { account, api } = useSession();
  const reduce = useReducedMotion();
  const q = useQuery({
    queryKey: ["task", jobHash, account],
    queryFn: () => api<Detail>(`/tasks/${jobHash}`),
    refetchInterval: (query) => (["done", "failed"].includes(query.state.data?.task.status ?? "") ? false : 4000),
  });
  if (q.isPending)
    return (
      <div className="stack-lg" aria-busy>
        <Skeleton h={34} w="40%" />
        <Skeleton h={56} />
        <Skeleton h={220} />
      </div>
    );
  if (q.isError) return <Notice text={q.error.message} kind="error" />;
  const { task: t, provider: p, settlement: st } = q.data;
  const created = Math.floor(new Date(t.createdAt).getTime() / 1000);
  const total = BigInt(t.price ?? 0) + BigInt(t.rushPaid ?? 0);

  // A plain-language history, built from what the record says happened.
  const steps: { when?: number; text: string; state: "done" | "now" | "todo" }[] = [
    { when: created, text: `Booked on ${t.providerName ?? "a provider"} for ${hbar(t.price)}`, state: "done" },
    ...(t.rushPaid ? [{ text: `Moved ahead: paid another agent ${hbar(t.rushPaid)} to finish on time`, state: "done" as const }] : []),
    {
      when: t.start ?? undefined,
      text: t.status === "queued" ? `Guaranteed to start by ${t.start ? clock(t.start) : "its turn in the queue"} (or refunded)` : "Ran on the provider's GPU",
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
      <PageHeader
        title={t.label}
        back={{ to: "/app/tasks", label: "Tasks" }}
        intro={`${t.providerName ?? "Provider pending"}${t.model ? ` · ${t.model}` : ""} · ${hbar(total)}`}
        action={<StatusBadge status={t.status} onTime={t.onTime} />}
      />
      <div className="detail-track">
        <PromiseTrack booked={created} startBy={t.start} deadline={t.deadline} finishedAt={t.finishedAt} status={t.status} onTime={t.onTime} size="lg" />
      </div>
      <div className="detail">
        <div className="detail-main">
          <section className="block" aria-labelledby="result-h">
            <div className="block-head">
              <h2 id="result-h">Result</h2>
              {t.result && <CopyButton value={t.result} label="result" />}
            </div>
            {t.result ? (
              <div className="result">{t.result}</div>
            ) : t.status === "failed" ? (
              <p className="warn">{t.failure}</p>
            ) : (
              <p className="muted waiting-line">
                <Dots label="Waiting for the result" /> The result appears here when the task finishes. This page updates by itself.
              </p>
            )}
          </section>
          <section className="block" aria-labelledby="req-h">
            <div className="block-head">
              <h2 id="req-h">What you asked</h2>
            </div>
            <div className="result quiet">{t.task}</div>
            {t.input && (
              <details className="disclose">
                <summary>Material, {t.input.length.toLocaleString("en")} characters</summary>
                <div className="result quiet">{t.input}</div>
              </details>
            )}
          </section>
        </div>
        <aside className="detail-side">
          <section aria-labelledby="hist-h">
            <h2 id="hist-h">History</h2>
            <ol className="timeline">
              {steps.map((s, i) => (
                <motion.li
                  key={`${i}-${s.state}`}
                  className={s.state}
                  initial={reduce ? false : { opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.25, delay: i * 0.06, ease: [0.2, 0.7, 0, 1] }}
                >
                  <span>{s.text}</span>
                  {s.when ? <time>{clock(s.when)}</time> : null}
                </motion.li>
              ))}
            </ol>
          </section>
          <section aria-labelledby="facts-h">
            <h2 id="facts-h">Details</h2>
            <dl className="facts">
              <div>
                <dt>Due</dt>
                <dd>{clock(t.deadline)}</dd>
              </div>
              {t.finishedAt ? (
                <div>
                  <dt>Finished</dt>
                  <dd>
                    {clock(t.finishedAt)}, {t.onTime ? `${t.deadline - t.finishedAt}s early` : `${t.finishedAt - t.deadline}s late`}
                  </dd>
                </div>
              ) : null}
              <div>
                <dt>{st?.charged ? "Deposit" : "GPU time, deposit"}</dt>
                <dd>{hbar(t.price)}</dd>
              </div>
              {st?.charged !== null && st?.charged !== undefined && (
                <>
                  <div>
                    <dt>Charged, by size used</dt>
                    <dd>{hbar(st.charged)}</dd>
                  </div>
                  <div>
                    <dt>Returned to you</dt>
                    <dd title={st.reason ?? undefined}>{hbar(st.returned ?? "0")}</dd>
                  </div>
                </>
              )}
              {st?.status === "held" && (
                <div>
                  <dt>Escrow</dt>
                  <dd>holding the deposit until it runs</dd>
                </div>
              )}
              <div>
                <dt>Priority paid</dt>
                <dd>{t.rushPaid ? hbar(t.rushPaid) : "none"}</dd>
              </div>
              {t.tokens ? (
                <div>
                  <dt>Tokens</dt>
                  <dd>{t.tokens.toLocaleString("en")}</dd>
                </div>
              ) : null}
            </dl>
          </section>
          <section aria-labelledby="proof-h">
            <h2 id="proof-h">Proof</h2>
            <ul className="proof">
              <li>
                The provider signed the booking, start and result on{" "}
                {p ? (
                  <a href={hashscan("topic", p.topicId)} target="_blank" rel="noopener">
                    Hedera topic {p.topicId}
                  </a>
                ) : (
                  "its Hedera topic"
                )}
                .
              </li>
              <li>
                Job fingerprint <code>{t.jobHash.slice(0, 12)}…</code> <CopyButton value={t.jobHash} label="job fingerprint" />
              </li>
              {t.resultHash && (
                <li>
                  Result checked against the signed fingerprint <code>{t.resultHash.slice(0, 12)}…</code>
                </li>
              )}
              {t.arkivKey && (
                <li>
                  Public record on Arkiv <code>{t.arkivKey.slice(0, 14)}…</code>
                </li>
              )}
              {p && t.serial !== null && (
                <li>
                  {p.name} queue ticket #{t.serial}
                  {t.rushPaid ? (
                    <>
                      , traded as an NFT of{" "}
                      <a href={hashscan("token", p.tokenId)} target="_blank" rel="noopener">
                        {p.tokenId}
                      </a>
                    </>
                  ) : null}
                </li>
              )}
            </ul>
          </section>
        </aside>
      </div>
    </>
  );
}
