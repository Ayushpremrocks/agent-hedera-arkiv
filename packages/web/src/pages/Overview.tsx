import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { BudgetForm } from "../components/BudgetForm";
import { Card, Empty, Metric, Notice, PageHeader, StatusBadge } from "../components/ui";
import { clock, hbar } from "../lib/format";
import { useMe, useTasks } from "../lib/hooks";
import { useSession } from "../lib/session";

export function Overview() {
  const { api } = useSession();
  const qc = useQueryClient();
  const me = useMe();
  const tasks = useTasks();
  const create = useMutation({ mutationFn: () => api("/agent", {}), onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }) });

  if (me.isPending) return <p className="muted">Loading…</p>;
  if (me.isError) return <Notice text={me.error.message} kind="error" />;
  const agent = me.data.agent;

  // First run: one clear path to a first task.
  if (!agent || agent.allowance === "0")
    return (
      <>
        <PageHeader title="Welcome" intro="Three steps to your first task." />
        <ol className="checklist">
          <li className={agent ? "done" : "current"}>
            <div>
              <b>Create your agent</b>
              <p>It gets its own Hedera account and works for you around the clock.</p>
            </div>
            {!agent && (
              <button type="button" onClick={() => create.mutate()} disabled={create.isPending}>
                {create.isPending ? "Creating… (about 15 seconds)" : "Create agent"}
              </button>
            )}
          </li>
          <li className={agent ? "current" : ""}>
            <div>
              <b>Set a budget</b>
              <p>The most your agent may spend. It stays in your wallet until used, and you can change it any time.</p>
            </div>
            {agent && <BudgetForm agentId={agent.id} />}
          </li>
          <li>
            <div>
              <b>Book your first task</b>
              <p>Describe what you need and when.</p>
            </div>
          </li>
        </ol>
        <Notice text={create.error?.message} kind="error" />
      </>
    );

  const s = agent.stats;
  const finished = s.met + s.late + s.failed;
  const list = tasks.data ?? [];
  const active = list.filter((t) => t.status === "queued" || t.status === "running").length;
  return (
    <>
      <PageHeader
        title="Overview"
        action={
          <Link className="button" to="/app/tasks/new">
            New task
          </Link>
        }
      />
      <div className="metrics">
        <Metric label="Budget left" value={hbar(agent.allowance)} hint="What your agent may still spend" />
        <Metric label="Delivered on time" value={finished ? `${Math.round((s.met / finished) * 100)}%` : "–"} hint={finished ? `${s.met} of ${finished} tasks` : "No tasks finished yet"} />
        <Metric label="In progress" value={String(active)} hint="Scheduled or running" />
        <Metric label="Spent" value={hbar(s.spent)} hint="GPU time and priority" />
        <Metric label="Earned" value={hbar(s.earned)} hint="By letting others go first" />
      </div>
      <Card
        title="Recent tasks"
        action={
          <Link to="/app/tasks" className="link">
            View all
          </Link>
        }
      >
        {list.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Task</th>
                <th>Status</th>
                <th>Due</th>
                <th className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {list.slice(0, 6).map((t) => (
                <tr key={t.jobHash}>
                  <td>
                    <Link to={`/app/tasks/${t.jobHash}`}>{t.label}</Link>
                  </td>
                  <td>
                    <StatusBadge status={t.status} onTime={t.onTime} />
                  </td>
                  <td>{clock(t.deadline)}</td>
                  <td className="num">{hbar(BigInt(t.price ?? 0) + BigInt(t.rushPaid ?? 0))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty title="No tasks yet">
            <p>
              <Link to="/app/tasks/new">Book your first task</Link> to see it here.
            </p>
          </Empty>
        )}
      </Card>
    </>
  );
}
