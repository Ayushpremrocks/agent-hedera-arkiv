import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link } from "react-router";
import { Notice, Section, Stats, TaskStatus } from "../components/ui";
import { clock, hashscan, hbar, toTinybars } from "../lib/format";
import { useSession } from "../lib/session";
import { approveBudget } from "../lib/wallet";

type Me = { account: string; mirrorDown?: boolean; agent: null | { id: string; arkivKey: string | null; balance: string | null; allowance: string | null; stats: Record<string, any> } };
type TaskRow = { jobHash: string; label: string; status: string; deadline: number; providerName: string | null; serial: number | null; onTime: boolean | null; failure: string | null; preview: string | null };

export function Work() {
  const { account, api } = useSession();
  const qc = useQueryClient();
  const [notice, setNotice] = useState<{ text: string; kind?: "info" | "error" } | null>(null);
  const me = useQuery({ queryKey: ["me", account], queryFn: () => api<Me>("/me"), enabled: !!account, refetchInterval: 5000 });
  const createAgent = useMutation({
    mutationFn: () => api("/agent", {}),
    onSuccess: () => {
      setNotice({ text: "Your agent is ready. Give it a budget next." });
      qc.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (e) => setNotice({ text: e.message, kind: "error" }),
  });

  if (!account)
    return (
      <Section title="Get started" intro="Connect your HashPack wallet (Hedera testnet). Your HBAR stays in your wallet: you give your agent a budget it can spend, and you can lower or cancel it any time.">
        <ol className="steps">
          <li>Connect HashPack and sign in. Signing is free.</li>
          <li>Create your agent. It gets its own Hedera account.</li>
          <li>Approve a budget in HashPack. That's the most your agent can ever spend.</li>
          <li>Hand it tasks with a deadline. It books GPU time and, if you're in a hurry, pays others to let you go first.</li>
        </ol>
      </Section>
    );
  if (me.isPending) return <p className="muted">Loading your agent…</p>;
  if (me.isError) return <Notice text={me.error.message} kind="error" />;

  const agent = me.data.agent;
  if (!agent)
    return (
      <Section title="Create your agent" intro="Your agent gets its own Hedera account. It books GPU slots for your tasks and trades places in the queue for you. It can only spend the budget you approve.">
        <Notice text={notice?.text} kind={notice?.kind} />
        <button type="button" onClick={() => createAgent.mutate()} disabled={createAgent.isPending}>
          {createAgent.isPending ? "Creating your agent… (about 15 seconds)" : "Create my agent"}
        </button>
      </Section>
    );

  const s = agent.stats;
  const finished = s.met + s.late + s.failed;
  return (
    <>
      <Notice text={notice?.text} kind={notice?.kind} />
      {me.data.mirrorDown && <Notice text="Hedera's Mirror Node isn't answering, so your balances can't be shown right now. Your tasks keep running; this page catches up when it's back." />}
      {agent.allowance === "0" && <Notice text="Approve a budget so your agent can book GPU time." />}
      <Section
        title="Your agent"
        intro={
          <>
            Account{" "}
            <a href={hashscan("account", agent.id)} target="_blank" rel="noopener">
              {agent.id}
            </a>
            . It spends from the budget below and sends what it earns back to your wallet.
          </>
        }
      >
        <Stats
          items={[
            [hbar(agent.allowance), "budget left"],
            [hbar(agent.balance), "working balance"],
            [finished ? `${s.met} of ${finished}` : "–", "tasks on time"],
            [hbar(s.spent), "spent on GPU time"],
            [hbar(s.earned), "earned by letting others go first"],
          ]}
        />
        <BudgetForm account={account} agentId={agent.id} onNotice={setNotice} />
      </Section>
      <div className="pair">
        <NewTask onNotice={setNotice} />
        <Tasks />
      </div>
    </>
  );
}

function BudgetForm({ account, agentId, onNotice }: { account: string; agentId: string; onNotice: (n: { text: string; kind?: "info" | "error" }) => void }) {
  const qc = useQueryClient();
  const [amount, setAmount] = useState("5");
  const approve = useMutation({
    mutationFn: () => approveBudget(account, agentId, Number(amount)),
    onMutate: () => onNotice({ text: `Approve a ${amount} HBAR budget in HashPack…` }),
    onSuccess: () => {
      onNotice({ text: `Budget set to ${amount} HBAR. It shows up here within a few seconds.` });
      setTimeout(() => qc.invalidateQueries({ queryKey: ["me"] }), 5000);
    },
    onError: (e) => onNotice({ text: e.message, kind: "error" }),
  });
  return (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        approve.mutate();
      }}
    >
      <label>
        Budget
        <span className="unit">
          <input type="number" min="0.5" step="0.5" value={amount} onChange={(e) => setAmount(e.target.value)} /> HBAR
        </span>
      </label>
      <button type="submit" disabled={approve.isPending}>
        {approve.isPending ? "Waiting for HashPack…" : "Approve in HashPack"}
      </button>
    </form>
  );
}

const WITHIN = [
  [150, "2½ minutes (urgent: it will try to buy an earlier slot)"],
  [300, "5 minutes"],
  [600, "10 minutes"],
  [1800, "30 minutes"],
  [3600, "1 hour"],
] as const;

function NewTask({ onNotice }: { onNotice: (n: { text: string; kind?: "info" | "error" }) => void }) {
  const { api } = useSession();
  const qc = useQueryClient();
  const empty = { label: "", task: "", input: "", within: "600", maxPay: "0.2", minComp: "0.05" };
  const [form, setForm] = useState(empty);
  const set = (k: keyof typeof empty) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const book = useMutation({
    mutationFn: () =>
      api<{ providerName: string; serial: number; start: number; note: string }>("/tasks", {
        label: form.label,
        task: form.task,
        input: form.input,
        withinSeconds: Number(form.within),
        maxPay: toTinybars(form.maxPay),
        minComp: toTinybars(form.minComp),
      }),
    onSuccess: (r) => {
      onNotice({ text: `Booked on ${r.providerName}, slot #${r.serial}, starting at ${clock(r.start)}. ${r.note[0].toUpperCase()}${r.note.slice(1)}.` });
      setForm(empty);
      qc.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (e) => onNotice({ text: e.message, kind: "error" }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    book.mutate();
  };
  return (
    <Section title="New task" intro="Runs on an open model on a provider's GPU. The result is checked against a hash the provider signs on Hedera.">
      <form className="task-form" onSubmit={submit}>
        <label>
          Name <input required maxLength={100} placeholder="Weekly summary" value={form.label} onChange={set("label")} />
        </label>
        <label>
          What should it do? <textarea required rows={2} maxLength={2000} placeholder="Summarise in three bullet points." value={form.task} onChange={set("task")} />
        </label>
        <label>
          Material to work on <textarea rows={5} maxLength={16000} placeholder="Paste the text here (optional)" value={form.input} onChange={set("input")} />
        </label>
        <label>
          Needed within
          <select value={form.within} onChange={set("within")}>
            {WITHIN.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <div className="two">
          <label>
            Pay up to
            <span className="unit">
              <input type="number" min="0" step="0.01" value={form.maxPay} onChange={set("maxPay")} /> HBAR
            </span>
            <small>to go ahead of others if it would be late</small>
          </label>
          <label>
            Accept at least
            <span className="unit">
              <input type="number" min="0" step="0.01" value={form.minComp} onChange={set("minComp")} /> HBAR
            </span>
            <small>to let someone go ahead when there's time to spare</small>
          </label>
        </div>
        <button type="submit" disabled={book.isPending}>
          {book.isPending ? "Booking…" : "Book task"}
        </button>
      </form>
    </Section>
  );
}

function Tasks() {
  const { account, api } = useSession();
  const tasks = useQuery({ queryKey: ["tasks", account], queryFn: () => api<{ tasks: TaskRow[] }>("/tasks"), refetchInterval: 5000 });
  return (
    <Section title="Your tasks" intro="Newest first. Updates every few seconds.">
      {tasks.isError && <Notice text={tasks.error.message} kind="error" />}
      <ol className="tasks">
        {tasks.data?.tasks.length === 0 && <li className="empty">No tasks yet. Book one with the form.</li>}
        {tasks.data?.tasks.map((t) => (
          <li key={t.jobHash}>
            <div className="task-head">
              <Link to={`/tasks/${t.jobHash}`}>
                <b>{t.label}</b>
              </Link>
              <TaskStatus status={t.status} onTime={t.onTime} />
            </div>
            <p className="muted">
              Due {clock(t.deadline)} on {t.providerName ?? "a provider"}
              {t.serial !== null ? `, slot #${t.serial}` : ""}
            </p>
            {t.preview && <p className="preview">{t.preview}</p>}
            {t.failure && <p className="preview bad">{t.failure}</p>}
          </li>
        ))}
      </ol>
    </Section>
  );
}
