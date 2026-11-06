import { Link } from "react-router";
import { BudgetForm } from "../components/BudgetForm";
import { Skeleton } from "../components/motion";
import { Empty, Ledger, Notice, PageHeader } from "../components/ui";
import { clock, hbar } from "../lib/format";
import { useMe, useTasks } from "../lib/hooks";

const RULES = [
  ["GPU time", "Paid to the provider when a task is booked. The price rises when providers are busy."],
  ["Priority", "Paid to another agent when yours moves ahead to meet a deadline, never above the limit you set."],
  ["Earnings", "Paid to you when your agent lets someone go first and still finishes in time."],
  ["Refunds", "Automatic when a provider misses its promised start or fails a task it was paid for."],
] as const;

export function Billing() {
  const me = useMe();
  const tasks = useTasks();
  if (me.isPending)
    return (
      <div className="stack-lg" aria-busy>
        <Skeleton h={34} w="30%" />
        <Skeleton h={64} />
      </div>
    );
  if (me.isError) return <Notice text={me.error.message} kind="error" />;
  const agent = me.data.agent;
  if (!agent) return <Notice text="Create your agent on the Overview page first." />;
  const s = agent.stats;
  const priced = (tasks.data ?? []).filter((t) => t.price);

  return (
    <>
      <PageHeader title="Billing" intro="Your HBAR stays in your wallet. Your agent spends only from the budget you approve, and sends what it earns back to you." />
      <Ledger
        items={[
          { label: "Budget left", value: hbar(agent.allowance), hint: "Approved in HashPack, not yet spent" },
          { label: "Spent", value: hbar(s.spent) },
          { label: "Earned", value: hbar(s.earned) },
          { label: "Refunded", value: hbar(s.refunded ?? "0") },
          { label: "Agent float", value: hbar(agent.balance), hint: "Kept for network fees; the rest returns to you" },
        ]}
      />
      <div className="split">
        <section className="block" aria-labelledby="budget-h">
          <div className="block-head">
            <h2 id="budget-h">Budget</h2>
          </div>
          <p className="muted">A new amount replaces the old one. Set it to 0 and your agent stops spending.</p>
          <BudgetForm agentId={agent.id} label="Update in HashPack" />
        </section>
        <section className="block" aria-labelledby="rules-h">
          <div className="block-head">
            <h2 id="rules-h">How charges work</h2>
          </div>
          <dl className="rules">
            {RULES.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
      <section className="block" aria-labelledby="charges-h">
        <div className="block-head">
          <h2 id="charges-h">Charges by task</h2>
        </div>
        {priced.length ? (
          <table className="data">
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
                  <td className="col-name">
                    <Link to={`/app/tasks/${t.jobHash}`} className="row-link" viewTransition>
                      {t.label}
                    </Link>
                  </td>
                  <td className="nowrap">{clock(t.deadline)}</td>
                  <td className="num">{hbar(t.price)}</td>
                  <td className="num">{t.rushPaid ? hbar(t.rushPaid) : "–"}</td>
                  <td className="num">{hbar(BigInt(t.price ?? 0) + BigInt(t.rushPaid ?? 0))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty title="No charges yet">
            <p>Each booking shows here with its GPU time and any priority paid.</p>
          </Empty>
        )}
      </section>
    </>
  );
}
