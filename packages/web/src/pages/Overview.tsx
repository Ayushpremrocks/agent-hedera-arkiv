import { ArrowRight, Check, Plus } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { BudgetForm } from "../components/BudgetForm";
import { Skeleton, toast } from "../components/motion";
import { Ledger, Notice, PageHeader, PromiseTrack, StatusBadge } from "../components/ui";
import { clock, hbar } from "../lib/format";
import { type TaskRow, useMe, useTasks } from "../lib/hooks";
import { useSession } from "../lib/session";

const booked = (t: TaskRow) => Math.floor(new Date(t.createdAt).getTime() / 1000);
const cost = (t: TaskRow) => hbar(BigInt(t.price ?? 0) + BigInt(t.rushPaid ?? 0));

/** First run: three steps, each unlocking the next. */
function Setup({ hasAgent, agentId }: { hasAgent: boolean; agentId?: string }) {
  const { api } = useSession();
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: () => api("/agent", {}),
    onSuccess: () => {
      toast("success", "Your agent is ready", "Give it a budget next.");
      qc.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (e) => toast("error", "Couldn't create your agent", e.message),
  });
  const steps = [
    {
      title: "Create your agent",
      body: "It gets its own Hedera account and books GPU time for you, around the clock.",
      state: hasAgent ? "done" : "now",
      action: !hasAgent && (
        <button type="button" className="btn btn-primary" onClick={() => create.mutate()} disabled={create.isPending}>
          {create.isPending ? "Creating, about 15 seconds…" : "Create agent"}
        </button>
      ),
    },
    {
      title: "Set a budget",
      body: "The most your agent may spend. It stays in your wallet until used; change it any time.",
      state: hasAgent ? "now" : "todo",
      action: hasAgent && agentId && <BudgetForm agentId={agentId} />,
    },
    { title: "Book your first task", body: "Describe the job and when you need it. It gets a start time it must meet.", state: "todo", action: null },
  ];
  return (
    <>
      <PageHeader title="Set up your agent" intro="Three steps to your first task. Nothing is spent until you book one." />
      <ol className="setup">
        {steps.map((s, i) => (
          <li key={s.title} className={`setup-step ${s.state}`} aria-current={s.state === "now" ? "step" : undefined}>
            <span className="setup-mark" aria-hidden>
              {s.state === "done" ? <Check size={14} weight="bold" /> : i + 1}
            </span>
            <div>
              <h2>{s.title}</h2>
              <p>{s.body}</p>
              {s.action}
            </div>
          </li>
        ))}
      </ol>
      <Notice text={create.error?.message} kind="error" />
    </>
  );
}

export function Overview() {
  const me = useMe();
  const tasks = useTasks();

  if (me.isPending)
    return (
      <div className="stack-lg" aria-busy>
        <Skeleton h={34} w="30%" />
        <Skeleton h={64} />
        <Skeleton h={180} />
      </div>
    );
  if (me.isError) return <Notice text={me.error.message} kind="error" />;
  const agent = me.data.agent;
  if (!agent || agent.allowance === "0") return <Setup hasAgent={!!agent} agentId={agent?.id} />;

  const s = agent.stats;
  const finished = s.met + s.late + s.failed;
  const list = tasks.data ?? [];
  const open = list.filter((t) => t.status === "queued" || t.status === "running");
  const delivered = list.filter((t) => t.status === "done" || t.status === "failed").slice(0, 5);

  return (
    <>
      <PageHeader
        title="Overview"
        intro={finished ? `${s.met} of ${finished} tasks delivered on time.` : "Your agent is set up. Book a task to see it here."}
        action={
          <Link className="btn btn-primary" to="/app/tasks/new" viewTransition>
            <Plus size={16} weight="bold" aria-hidden /> New task
          </Link>
        }
      />
      <Ledger
        items={[
          { label: "Budget left", value: hbar(agent.allowance), hint: "What your agent may still spend" },
          { label: "Spent", value: hbar(s.spent), hint: "GPU time and priority" },
          { label: "Earned", value: hbar(s.earned), hint: "Paid to you for letting others go first" },
          { label: "Refunded", value: hbar(s.refunded ?? "0"), hint: "Promises a provider missed" },
          { label: "On time", value: finished ? `${Math.round((s.met / finished) * 100)}%` : "–" },
        ]}
      />

      <section className="block" aria-labelledby="now-h">
        <div className="block-head">
          <h2 id="now-h">In progress</h2>
          <span className="block-note">Bar: time so far. Dashed: starts by. Solid: due.</span>
        </div>
        {tasks.isPending ? (
          <Skeleton h={120} />
        ) : open.length ? (
          <ul className="live-list">
            {open.map((t) => (
              <li key={t.jobHash}>
                <Link to={`/app/tasks/${t.jobHash}`} className="live-row" viewTransition>
                  <div className="live-row-head">
                    <b>{t.label}</b>
                    <StatusBadge status={t.status} onTime={t.onTime} />
                  </div>
                  <PromiseTrack booked={booked(t)} startBy={t.start} deadline={t.deadline} finishedAt={t.finishedAt} status={t.status} onTime={t.onTime} size="lg" />
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <div className="empty-line">
            <p>Nothing in progress. A new task gets a start time it must meet, or the provider refunds it.</p>
            <Link to="/app/tasks/new" className="text-link" viewTransition>
              Book a task <ArrowRight size={14} aria-hidden />
            </Link>
          </div>
        )}
      </section>

      <section className="block" aria-labelledby="done-h">
        <div className="block-head">
          <h2 id="done-h">Recently delivered</h2>
          {list.length > 0 && (
            <Link to="/app/tasks" className="text-link" viewTransition>
              All tasks <ArrowRight size={14} aria-hidden />
            </Link>
          )}
        </div>
        {delivered.length ? (
          <ul className="result-list">
            {delivered.map((t) => (
              <li key={t.jobHash}>
                <Link to={`/app/tasks/${t.jobHash}`} viewTransition>
                  <div className="result-list-head">
                    <b>{t.label}</b>
                    <StatusBadge status={t.status} onTime={t.onTime} />
                  </div>
                  <p>{t.preview ?? t.failure ?? "No preview"}</p>
                  <span className="result-list-meta">
                    {t.finishedAt ? `Finished ${clock(t.finishedAt)}` : `Due ${clock(t.deadline)}`} · {cost(t)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Results land here with a check that the provider's signed fingerprint matches.</p>
        )}
      </section>
    </>
  );
}
