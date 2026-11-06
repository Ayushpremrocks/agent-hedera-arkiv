import { Leaf, Lightning, Timer } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Skeleton, toast } from "../components/motion";
import { Notice, PageHeader, PromiseTrack, useNow } from "../components/ui";
import { clock, hbar, inHuman, toTinybars } from "../lib/format";
import { useMe, useQuote } from "../lib/hooks";
import { useSession } from "../lib/session";

// What each priority means to the agent, in HBAR: the most it pays to jump ahead, and the least it
// accepts to let someone else go first.
const PRIORITY = {
  flexible: { icon: Leaf, title: "Flexible", blurb: "Not urgent. Your agent may let others go first, and earns HBAR when it does.", maxPay: "0", minComp: "0.02" },
  standard: { icon: Timer, title: "Standard", blurb: "Joins the queue now. Pays a little to stay on time if it has to.", maxPay: "0.05", minComp: "0.05" },
  rush: { icon: Lightning, title: "Rush", blurb: "Pays to jump ahead of agents that can wait, so it finishes in time.", maxPay: "0.3", minComp: "0.5" },
} as const;
type Priority = keyof typeof PRIORITY;

const DUE = [
  [150, "2½ min"],
  [300, "5 min"],
  [600, "10 min"],
  [1800, "30 min"],
  [3600, "1 hour"],
] as const;

export function NewTask() {
  const { api } = useSession();
  const me = useMe();
  const quote = useQuote();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const now = useNow();
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
      toast("success", "Task booked", `"${f.label}" has its start time. Follow it here.`);
      qc.invalidateQueries({ queryKey: ["tasks"] });
      navigate(`/app/tasks/${r.jobHash}`, { viewTransition: true });
    },
    onError: (e) => toast("error", "Couldn't book the task", e.message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    book.mutate();
  };

  // The guaranteed start plus the job's run limit, against the deadline: a worst case, so "in time"
  // here is the provider's promise, not a guess.
  const qd = quote.data;
  const deadline = Math.floor(now) + Number(f.within);
  const startBy = qd ? Math.max(qd.startBy, Math.floor(now)) : null;
  const worstEnd = qd && startBy ? startBy + qd.runSeconds : null;
  const inTime = worstEnd !== null ? worstEnd + 10 <= deadline : null;
  const noBudget = me.data?.agent?.allowance === "0";

  return (
    <>
      <PageHeader title="New task" back={{ to: "/app/tasks", label: "Tasks" }} />
      {noBudget && <Notice text="Set a budget on the Billing page before booking." />}
      <form className="compose" onSubmit={submit}>
        <div className="compose-main">
          <fieldset className="group">
            <legend>The job</legend>
            <label className="field">
              <span>Name</span>
              <input required maxLength={100} placeholder="Summarise this week's support tickets" value={f.label} onChange={set("label")} />
            </label>
            <label className="field">
              <span>Instructions</span>
              <textarea required rows={3} maxLength={2000} placeholder="Three bullet points, then flag anything urgent." value={f.task} onChange={set("task")} />
            </label>
            <label className="field">
              <span>
                Material <em>optional</em>
              </span>
              <textarea rows={7} maxLength={16000} placeholder="Paste the text your agent should work on." value={f.input} onChange={set("input")} />
              <small>{f.input.length.toLocaleString("en")} / 16,000 characters</small>
            </label>
          </fieldset>

          <fieldset className="group">
            <legend>Needed within</legend>
            <div className="chips" role="radiogroup" aria-label="Needed within">
              {DUE.map(([v, l]) => (
                <label key={v} className="chip">
                  <input type="radio" name="within" value={v} checked={f.within === String(v)} onChange={set("within")} />
                  <span>{l}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="group">
            <legend>Priority</legend>
            <div className="options">
              {(Object.keys(PRIORITY) as Priority[]).map((p) => {
                const Icon = PRIORITY[p].icon;
                return (
                  <label key={p} className="option">
                    <input type="radio" name="priority" checked={f.priority === p} onChange={() => pick(p)} />
                    <Icon size={20} weight={f.priority === p ? "fill" : "regular"} aria-hidden />
                    <span>
                      <b>{PRIORITY[p].title}</b>
                      <small>{PRIORITY[p].blurb}</small>
                    </span>
                  </label>
                );
              })}
            </div>
            <button type="button" className="text-link" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>
              {advanced ? "Hide exact limits" : "Set exact limits"}
            </button>
            {advanced && (
              <div className="pair-fields">
                <label className="field">
                  <span>Pay at most to jump ahead</span>
                  <span className="unit">
                    <input type="number" min="0" step="0.01" value={f.maxPay} onChange={set("maxPay")} /> HBAR
                  </span>
                </label>
                <label className="field">
                  <span>Accept at least to wait</span>
                  <span className="unit">
                    <input type="number" min="0" step="0.01" value={f.minComp} onChange={set("minComp")} /> HBAR
                  </span>
                </label>
              </div>
            )}
          </fieldset>
        </div>

        <aside className="compose-side" aria-live="polite">
          <h2>Before you book</h2>
          {quote.isError ? (
            <p className="warn">{quote.error.message}</p>
          ) : qd && startBy && worstEnd ? (
            <>
              <PromiseTrack booked={Math.floor(now)} startBy={startBy} deadline={deadline} finishedAt={worstEnd} status="preview" onTime={inTime} size="lg" />
              <p className={inTime ? "verdict ok" : "verdict late"}>
                {inTime
                  ? `Guaranteed in time. It starts within ${startBy - now > 1 ? inHuman(Math.round(startBy - now)) : "seconds"} and finishes by ${clock(worstEnd)} at the latest.`
                  : f.priority === "rush"
                    ? "Too late on its own. Your agent will buy an earlier place from one that can wait."
                    : "The guaranteed start is too late for this deadline. Choose Rush, or give it more time."}
              </p>
              <dl className="receipt">
                <div>
                  <dt>GPU time, at most</dt>
                  <dd>{hbar(qd.price)}</dd>
                </div>
                <div>
                  <dt>Priority, only if needed</dt>
                  <dd>{Number(f.maxPay) > 0 ? `up to ${f.maxPay} HBAR` : "none"}</dd>
                </div>
                <div>
                  <dt>Missed promise</dt>
                  <dd>refunded</dd>
                </div>
              </dl>
              <small className="muted">
                {qd.providers} provider{qd.providers === 1 ? "" : "s"} online. Prices rise when they're busy.
              </small>
            </>
          ) : (
            <div className="stack" aria-busy>
              <Skeleton h={40} />
              <Skeleton h={14} w="80%" />
              <Skeleton h={14} w="60%" />
            </div>
          )}
          <button type="submit" className="btn btn-primary btn-block" disabled={noBudget || book.isPending} aria-busy={book.isPending}>
            {book.isPending ? "Booking…" : "Book task"}
          </button>
          <Link to="/app/billing" className="text-link quiet" viewTransition>
            Spending from your budget of {hbar(me.data?.agent?.allowance)}
          </Link>
        </aside>
      </form>
    </>
  );
}
