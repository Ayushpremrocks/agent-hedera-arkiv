import { Link } from "react-router";
import { BudgetForm } from "../components/BudgetForm";
import { Card, Empty, Metric, Notice, PageHeader } from "../components/ui";
import { clock, hbar } from "../lib/format";
import { useMe, useTasks } from "../lib/hooks";

export function Billing() {
  const me = useMe();
  const tasks = useTasks();
  if (me.isPending) return <p className="muted">Loading…</p>;
  if (me.isError) return <Notice text={me.error.message} kind="error" />;
  const agent = me.data.agent;
  if (!agent) return <Notice text="Create your agent on the Overview page first." />;
  const s = agent.stats;
  const priced = (tasks.data ?? []).filter((t) => t.price);

  return (
    <>
      <PageHeader title="Billing" intro="Your HBAR stays in your wallet. Your agent spends only from the budget you approve, and sends what it earns back to you." />
      <div className="metrics">
        <Metric label="Budget left" value={hbar(agent.allowance)} hint="Approved in HashPack, not yet spent" />
        <Metric label="Spent" value={hbar(s.spent)} hint="GPU time and priority" />
        <Metric label="Earned" value={hbar(s.earned)} hint="By letting others go first" />
        <Metric label="Refunded" value={hbar(s.refunded ?? "0")} hint="When a provider couldn't deliver" />
        <Metric label="Agent's working balance" value={hbar(agent.balance)} hint="For network fees; extra returns to you" />
      </div>
      <div className="two-col">
        <Card title="Change your budget">
          <p className="muted">Approving a new amount replaces the old one. Set it to 0 to stop your agent spending entirely.</p>
          <BudgetForm agentId={agent.id} label="Update in HashPack" />
        </Card>
        <Card title="How charges work">
          <ul className="plain">
            <li>
              <b>GPU time</b>: paid to the provider when a task is booked. The price rises when providers are busy.
            </li>
            <li>
              <b>Priority</b>: paid to another agent when yours moves ahead to meet a deadline, only up to the limit you set.
            </li>
            <li>
              <b>Earnings</b>: paid to you when your agent lets someone go first and still finishes in time.
            </li>
            <li>
              <b>Refunds</b>: automatic if a provider fails to run a task it was paid for.
            </li>
          </ul>
        </Card>
      </div>
      <Card title="Charges by task">
        {priced.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Task</th>
                <th>Due</th>
                <th className="num">GPU time</th>
                <th className="num">Priority</th>
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {priced.map((t) => (
                <tr key={t.jobHash}>
                  <td>
                    <Link to={`/app/tasks/${t.jobHash}`}>{t.label}</Link>
                  </td>
                  <td>{clock(t.deadline)}</td>
                  <td className="num">{hbar(t.price)}</td>
                  <td className="num">{t.rushPaid ? hbar(t.rushPaid) : "–"}</td>
                  <td className="num">{hbar(BigInt(t.price ?? 0) + BigInt(t.rushPaid ?? 0))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty title="No charges yet" />
        )}
      </Card>
    </>
  );
}
