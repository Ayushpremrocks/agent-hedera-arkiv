import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Lightning, Leaf, Timer } from "@phosphor-icons/react";
import { ProgressButton, Skeleton, toast } from "../components/motion";
import { Card, Notice, PageHeader } from "../components/ui";
import { hbar, inHuman, toTinybars } from "../lib/format";
import { useMe, useQuote } from "../lib/hooks";
import { useSession } from "../lib/session";

// What each priority means to the agent, in HBAR: the most it pays to jump ahead, and the least it
// accepts to let someone else go first.
const PRIORITY = {
  flexible: { icon: Leaf, title: "Flexible", blurb: "Not urgent. Your agent may let others go first, and earns HBAR when it does.", maxPay: "0", minComp: "0.02" },
  standard: { icon: Timer, title: "Standard", blurb: "Runs in the next free slot. Pays a little to stay on time if needed.", maxPay: "0.05", minComp: "0.05" },
  rush: { icon: Lightning, title: "Rush", blurb: "Your agent pays to jump ahead of others so it finishes in time.", maxPay: "0.3", minComp: "0.5" },
} as const;
type Priority = keyof typeof PRIORITY;

const DUE = [
  [150, "In 2½ minutes"],
  [300, "In 5 minutes"],
  [600, "In 10 minutes"],
  [1800, "In 30 minutes"],
  [3600, "In an hour"],
] as const;

export function NewTask() {
  const { api } = useSession();
  const me = useMe();
  const quote = useQuote();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [f, setF] = useState({ label: "", task: "", input: "", within: "600", priority: "standard" as Priority, maxPay: PRIORITY.standard.maxPay as string, minComp: PRIORITY.standard.minComp as string });
  const [advanced, setAdvanced] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const pick = (p: Priority) => setF({ ...f, priority: p, maxPay: PRIORITY[p].maxPay, minComp: PRIORITY[p].minComp });

  const book = useMutation({
    mutationFn: () =>
      api<{ jobHash: string }>("/tasks", {
        label: f.label,
        task: f.task,
        input: f.input,
        withinSeconds: Number(f.within),
        maxPay: toTinybars(f.maxPay),
        minComp: toTinybars(f.minComp),
      }),
    onSuccess: (r) => {
      toast("success", "Task booked", `"${f.label}" is scheduled. Follow it here.`);
      qc.invalidateQueries({ queryKey: ["tasks"] });
      navigate(`/app/tasks/${r.jobHash}`);
    },
    onError: (e) => toast("error", "Couldn't book the task", e.message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    book.mutate();
  };

  // Estimate: the booking price now, plus whatever Rush may add; whether the soonest slot is in time.
  const qd = quote.data;
  const startsIn = qd ? qd.soonestStart - qd.at : null;
  const inTime = qd ? qd.soonestStart + qd.slotSeconds <= qd.at + Number(f.within) : null;
  const noBudget = me.data?.agent?.allowance === "0";

  return (
    <>
      <PageHeader title="New task" intro={<Link to="/app/tasks">← Tasks</Link>} />
      {noBudget && <Notice text="Set a budget on the Billing page before booking." />}
      <form className="new-task" onSubmit={submit}>
        <Card title="What should be done?">
          <div className="fields">
            <label>
              Name
              <input required maxLength={100} placeholder="e.g. Summarise customer feedback" value={f.label} onChange={set("label")} />
            </label>
            <label>
              Instructions
              <textarea required rows={3} maxLength={2000} placeholder="e.g. Summarise in three bullet points and flag anything urgent." value={f.task} onChange={set("task")} />
            </label>
            <label>
              <span>
                Material <span className="muted">(optional)</span>
              </span>
              <textarea rows={6} maxLength={16000} placeholder="Paste the text to work on." value={f.input} onChange={set("input")} />
            </label>
          </div>
        </Card>

        <Card title="When and how urgently?">
          <div className="fields">
            <label>
              Needed
              <select value={f.within} onChange={set("within")}>
                {DUE.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <fieldset className="priority">
              <legend>Priority</legend>
              {(Object.keys(PRIORITY) as Priority[]).map((p) => {
                const Icon = PRIORITY[p].icon;
                return (
                <label key={p} className={`press-soft ${f.priority === p ? "on" : ""}`}>
                  <input type="radio" name="priority" checked={f.priority === p} onChange={() => pick(p)} />
                  <b>
                    <Icon weight={f.priority === p ? "fill" : "regular"} aria-hidden /> {PRIORITY[p].title}
                  </b>
                  <span>{PRIORITY[p].blurb}</span>
                </label>
                );
              })}
            </fieldset>
            <button type="button" className="link-button" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>
              {advanced ? "Hide" : "Show"} exact limits
            </button>
            {advanced && (
              <div className="two">
                <label>
                  Pay at most to jump ahead
                  <span className="unit">
                    <input type="number" min="0" step="0.01" value={f.maxPay} onChange={set("maxPay")} /> HBAR
                  </span>
                </label>
                <label>
                  Accept at least to wait
                  <span className="unit">
                    <input type="number" min="0" step="0.01" value={f.minComp} onChange={set("minComp")} /> HBAR
                  </span>
                </label>
              </div>
            )}
          </div>
        </Card>

        <aside className="estimate card" aria-live="polite">
          <h2>Estimate</h2>
          {quote.isError ? (
            <p className="warn">{quote.error.message}</p>
          ) : qd ? (
            <>
              <dl>
                <dt>GPU time</dt>
                <dd>{hbar(qd.price)}</dd>
                {Number(f.maxPay) > 0 && (
                  <>
                    <dt>Priority, if needed</dt>
                    <dd>up to {f.maxPay} HBAR</dd>
                  </>
                )}
                <dt>Starts</dt>
                <dd>{startsIn !== null && startsIn > 0 ? inHuman(startsIn) : "now"}</dd>
              </dl>
              {inTime ? (
                <p className="ok-text">The next free slot finishes in time.</p>
              ) : f.priority === "rush" ? (
                <p>The next free slot is too late; your agent will buy an earlier one from someone who can wait.</p>
              ) : (
                <p className="warn">The next free slot would finish late. Choose Rush to let your agent buy an earlier one.</p>
              )}
              <small className="muted">From {qd.providers} provider{qd.providers === 1 ? "" : "s"} online. Prices follow demand.</small>
            </>
          ) : (
            <div className="skeleton-rows" aria-busy>
              <Skeleton h={14} />
              <Skeleton h={14} w="70%" />
              <Skeleton h={14} w="85%" />
            </div>
          )}
          <ProgressButton type="submit" className="big" disabled={noBudget} state={book.isPending ? "loading" : "idle"}>
            {book.isPending ? "Booking" : "Book task"}
          </ProgressButton>
        </aside>
      </form>
    </>
  );
}
