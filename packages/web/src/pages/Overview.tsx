import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { Plus } from "@phosphor-icons/react";
import { BudgetForm } from "../components/BudgetForm";
import { AnimatedNumber, Item, Skeleton, Stagger, toast } from "../components/motion";
import { Card, Empty, Metric, Notice, PageHeader, StatusBadge } from "../components/ui";
import { clock, hbar } from "../lib/format";
import { useMe, useTasks } from "../lib/hooks";
import { useSession } from "../lib/session";

export function Overview() {
  const { api } = useSession();
  const qc = useQueryClient();
  const me = useMe();
  const tasks = useTasks();
  const create = useMutation({
    mutationFn: () => api("/agent", {}),
    onSuccess: () => {
      toast("success", "Your agent is ready", "Give it a budget next.");
      qc.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (e) => toast("error", "Couldn't create your agent", e.message),
  });

  if (me.isPending)
    return (
      <div className="metrics" aria-busy>
        {[0, 1, 2, 3, 4].map((i) => (
          <div className="metric" key={i}>
            <Skeleton h={12} w="55%" />
            <Skeleton h={26} w="80%" />
            <Skeleton h={10} w="65%" />
          </div>
        ))}
      </div>
    );
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
              <button type="button" className="press" onClick={() => create.mutate()} disabled={create.isPending}>
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
  const hb = (n: number) => `${n.toFixed(4).replace(/\.?0+$/, "")} HBAR`;
  return (
    <Stagger>
      <Item>
        <PageHeader
          title="Overview"
          action={
            <Link className="button press" to="/app/tasks/new">
              <Plus weight="bold" aria-hidden /> New task
            </Link>
          }
        />
      </Item>
      <Item className="metrics">
        <Metric label="Budget left" value={agent.allowance === null ? "–" : <AnimatedNumber value={Number(agent.allowance) / 1e8} format={hb} />} hint="What your agent may still spend" />
        <Metric
          label="Delivered on time"
          value={finished ? <AnimatedNumber value={Math.round((s.met / finished) * 100)} format={(n) => `${Math.round(n)}%`} /> : "–"}
          hint={finished ? `${s.met} of ${finished} tasks` : "No tasks finished yet"}
        />
        <Metric label="In progress" value={<AnimatedNumber value={active} format={(n) => String(Math.round(n))} />} hint="Scheduled or running" />
        <Metric label="Spent" value={<AnimatedNumber value={Number(s.spent) / 1e8} format={hb} />} hint="GPU time and priority" />
        <Metric label="Earned" value={<AnimatedNumber value={Number(s.earned) / 1e8} format={hb} />} hint="By letting others go first" />
      </Item>
      <Item>
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
      </Item>
    </Stagger>
  );
}
