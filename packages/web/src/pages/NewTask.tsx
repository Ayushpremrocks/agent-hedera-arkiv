// The job composer: start from a job type, attach the material, pick an output and a size, set the
// deadline on the timeline, and see the plan (provider, size band, deposit, guaranteed start) before booking.
import { ArrowsClockwise, Code, FileText, Funnel, Lightning, ListBullets, MagnifyingGlass, PencilSimple, Repeat, Translate, UploadSimple, X } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type DragEvent, type FormEvent, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "../components/motion";
import { Notice, PageHeader, PromiseTrack, useNow } from "../components/ui";
import { clock, hbar, inHuman, toTinybars } from "../lib/format";
import { useMe } from "../lib/hooks";
import { type Provider, keptRate } from "../lib/market";
import { useSession } from "../lib/session";

const MAX_INPUT_CHARS = 16_000; // what a job may carry (shared/src/job.ts)

type Format = "text" | "markdown" | "json";
type Length = "short" | "medium" | "long";
const TEMPLATES = [
  { id: "summarize", icon: ListBullets, label: "Summarize", task: "Summarize the material in 3 to 5 bullet points. Flag anything urgent or risky.", length: "medium", format: "markdown" },
  { id: "extract", icon: Code, label: "Extract to JSON", task: "Extract every person, organisation, date and amount the material mentions.", length: "medium", format: "json", schema: '{ "people": [], "organisations": [], "dates": [], "amounts": [] }' },
  { id: "classify", icon: Funnel, label: "Classify", task: "Classify each line of the material as positive, negative or neutral. Return one label per line, in order.", length: "short", format: "text" },
  { id: "review", icon: MagnifyingGlass, label: "Review", task: "Review the material like a senior engineer: list the problems by severity, each with a concrete fix.", length: "long", format: "markdown" },
  { id: "translate", icon: Translate, label: "Translate", task: "Translate the material into English. Keep its structure and formatting.", length: "long", format: "text" },
  { id: "custom", icon: PencilSimple, label: "Custom", task: "", length: "medium", format: "text" },
] as const;
type TemplateId = (typeof TEMPLATES)[number]["id"];
const SIZES: Record<Length, { tokens: number; label: string }> = {
  short: { tokens: 256, label: "Short" },
  medium: { tokens: 1024, label: "Medium" },
  long: { tokens: 2048, label: "Long" },
};
const PRIORITY = {
  flexible: { label: "Flexible", maxPay: 0, minComp: 0.02 },
  standard: { label: "Standard", maxPay: 0.05, minComp: 0.05 },
  rush: { label: "Rush", maxPay: 0.3, minComp: 0.5 },
} as const;

type Mode = "once" | "repeat";
const EVERY: [number, string][] = [
  [900, "15 min"],
  [1800, "30 min"],
  [3600, "1 hour"],
  [21_600, "6 hours"],
  [86_400, "1 day"],
];
const everyLabel = (s: number) => EVERY.find(([v]) => v === s)?.[1] ?? `${s}s`;

// Deadline slider: 1 minute to 1 hour on a log scale, so short deadlines get room on the track.
const MIN_S = 60;
const MAX_S = 3600;
const toPos = (s: number) => Math.log(s / MIN_S) / Math.log(MAX_S / MIN_S);
const fromPos = (p: number) => Math.round((MIN_S * (MAX_S / MIN_S) ** p) / 30) * 30;

/** A provider's run limit for a job of `tokens` (the formula in shared/src/job.ts). */
const runFor = (p: Provider, tokens: number) => Math.ceil(((p.startupMs ?? 1000) / 1000 + tokens / Math.max(1, p.tps || 1)) * 1.25);
const bandFor = (p: Provider, tokens: number) => {
  const bands = p.bands?.length ? p.bands : [[Infinity, p.price] as [number, string]];
  return BigInt((bands.find(([upTo]) => tokens <= upTo) ?? bands[bands.length - 1])[1]);
};

/** Text from dropped files; PDFs are read with pdf.js, loaded only when one is dropped. */
async function readFile(f: File): Promise<string> {
  if (f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf")) {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await f.arrayBuffer()) }).promise;
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) pages.push((await (await doc.getPage(i)).getTextContent()).items.map((it) => ("str" in it ? it.str : "")).join(" "));
    return pages.join("\n\n");
  }
  return f.text();
}

export function NewTask() {
  const { api } = useSession();
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const now = useNow();
  const providers = useQuery({ queryKey: ["providers"], queryFn: () => fetch("/api/market").then((r) => r.json()).then((d) => d.providers as Provider[]), refetchInterval: 15_000 });
  const offers = useQuery({ queryKey: ["offers"], queryFn: async () => (await import("../lib/market")).fetchOffers(), refetchInterval: 20_000 });

  const [template, setTemplate] = useState<TemplateId>("summarize");
  const tpl = TEMPLATES.find((t) => t.id === template)!;
  const [label, setLabel] = useState("");
  const [task, setTask] = useState<string>(tpl.task);
  const [schema, setSchema] = useState<string>("schema" in tpl ? tpl.schema : "");
  const [format, setFormat] = useState<Format>(tpl.format);
  const [length, setLength] = useState<Length>(tpl.length);
  const [files, setFiles] = useState<{ name: string; text: string }[]>([]);
  const [pasted, setPasted] = useState("");
  const [within, setWithin] = useState(600);
  const [maxPay, setMaxPay] = useState<number>(PRIORITY.standard.maxPay);
  const [minComp, setMinComp] = useState<number>(PRIORITY.standard.minComp);
  const [choice, setChoice] = useState<string>("auto");
  const [mode, setMode] = useState<Mode>("once");
  const [every, setEvery] = useState(3600);
  const [runs, setRuns] = useState(24);
  const [reading, setReading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const pickTemplate = (id: TemplateId) => {
    const t = TEMPLATES.find((x) => x.id === id)!;
    setTemplate(id);
    setTask(t.task);
    setFormat(t.format);
    setLength(t.length);
    setSchema("schema" in t ? t.schema : "");
  };
  const addFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    setReading(true);
    try {
      const read = await Promise.all([...list].map(async (f) => ({ name: f.name, text: await readFile(f) })));
      setFiles((cur) => [...cur, ...read]);
    } catch (e) {
      toast("error", "Couldn't read that file", (e as Error).message);
    } finally {
      setReading(false);
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    addFiles(e.dataTransfer.files);
  };

  const input = [...files.map((f) => `--- ${f.name} ---\n${f.text}`), pasted].filter(Boolean).join("\n\n");
  const over = input.length > MAX_INPUT_CHARS;
  const count = mode === "repeat" ? runs : 1;
  const repeatProblem = mode === "repeat" && within > every ? `Each run must be due before the next one starts: set "Needed within" to ${everyLabel(every)} or less.` : "";
  // The instructions the model gets: the user's, plus how to shape the answer.
  const fullTask =
    task.trim() +
    (format === "markdown" ? "\n\nAnswer in Markdown." : format === "json" ? `\n\nRespond with only valid JSON, no prose before or after it.${schema.trim() ? ` Use this shape:\n${schema.trim()}` : ""}` : "");

  // ---- the plan ----
  const list = (providers.data ?? []).filter((p) => p.maxTokens > 0);
  const largest = Math.max(256, ...list.map((p) => p.maxTokens));
  const tokens = Math.min(SIZES[length].tokens, largest);
  const deadline = Math.floor(now) + within;
  const options = list
    .filter((p) => p.maxTokens >= tokens)
    .map((p) => {
      const startBy = Math.max(p.nextFree, Math.floor(now));
      const finish = startBy + runFor(p, tokens);
      return { p, startBy, finish, deposit: bandFor(p, tokens), fits: finish + 10 <= deadline };
    });
  const auto = [...options].sort((a, b) => Number(a.fits) === Number(b.fits) ? Number(a.deposit - b.deposit) || a.finish - b.finish : a.fits ? -1 : 1)[0];
  const plan = choice === "auto" ? auto : options.find((o) => o.p.id === choice);
  useEffect(() => {
    if (choice !== "auto" && !options.some((o) => o.p.id === choice)) setChoice("auto"); // picked one went offline or can't take this size
  }, [choice, options]);
  const budget = me.data?.agent?.allowance;
  const noBudget = budget === "0";
  const total = plan ? plan.deposit * BigInt(count) : 0n;
  const placesOnOffer = (offers.data ?? []).filter((o) => o.start > now && (!plan || o.provider === plan.p.id) && o.byOwner).length;

  const book = useMutation({
    mutationFn: async (): Promise<string> => {
      const job = {
        label: label.trim() || `${tpl.label}, ${clock(now)}`,
        task: fullTask,
        withinSeconds: within,
        maxTokens: tokens,
        maxPay: toTinybars(String(maxPay)),
        minComp: toTinybars(String(minComp)),
        provider: choice === "auto" ? undefined : choice,
      };
      if (mode === "repeat") return `/app/schedules#${(await api<{ id: string }>("/schedules", { ...job, input: input.slice(0, MAX_INPUT_CHARS), every, runs })).id}`;
      return `/app/tasks/${(await api<{ jobHash: string }>("/tasks", { ...job, input: input.slice(0, MAX_INPUT_CHARS) })).jobHash}`;
    },
    onSuccess: (to) => {
      if (mode === "repeat") toast("success", "Schedule set", "The first run starts now; later runs reserve their place ahead.");
      else toast("success", "Job booked", "It has its start time. Follow it here.");
      qc.invalidateQueries({ queryKey: ["tasks"] });
      navigate(to, { viewTransition: true });
    },
    onError: (e) => toast("error", mode === "repeat" ? "Couldn't set the schedule" : "Couldn't book the job", e.message),
  });
  const canBook = !!plan && !!task.trim() && !noBudget && !book.isPending && !over && !repeatProblem;
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (canBook) book.mutate();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") submit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const priority = (Object.keys(PRIORITY) as (keyof typeof PRIORITY)[]).find((k) => PRIORITY[k].maxPay === maxPay && PRIORITY[k].minComp === minComp);
  const posOf = (s: number) => `${(Math.min(1, Math.max(0, toPos(Math.max(MIN_S, s)))) * 100).toFixed(2)}%`;

  return (
    <>
      <PageHeader title="New job" back={{ to: "/app/tasks", label: "Tasks" }} />
      {noBudget && <Notice text="Set a budget on the Billing page before booking." />}
      <form className="composer" onSubmit={submit}>
        <div className="composer-main">
          {/* 1. job type */}
          <section className="cmp-block" aria-labelledby="kind-h">
            <h2 id="kind-h">What kind of job</h2>
            <div className="templates" role="radiogroup" aria-label="Job type">
              {TEMPLATES.map((t) => (
                <label key={t.id} className="tpl">
                  <input type="radio" name="template" checked={template === t.id} onChange={() => pickTemplate(t.id)} />
                  <span>
                    <t.icon size={18} weight={template === t.id ? "fill" : "regular"} aria-hidden />
                    {t.label}
                  </span>
                </label>
              ))}
            </div>
          </section>

          {/* 2. instructions + material */}
          <section className="cmp-block" aria-labelledby="ins-h">
            <h2 id="ins-h">Instructions</h2>
            <textarea className="ins" rows={4} maxLength={2000} required value={task} onChange={(e) => setTask(e.target.value)} placeholder="Tell the model exactly what to do." />
            <input className="name-input" maxLength={100} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={`Name (optional): ${tpl.label}, ${clock(now)}`} aria-label="Job name" />
          </section>

          <section className="cmp-block" aria-labelledby="mat-h">
            <div className="cmp-head">
              <h2 id="mat-h">Material</h2>
              <span className={over ? "warn small" : "muted small"}>
                {input.length.toLocaleString("en")} / {MAX_INPUT_CHARS.toLocaleString("en")} characters · about {Math.ceil(input.length / 4).toLocaleString("en")} tokens
              </span>
            </div>
            <div
              className={`drop ${dragOver ? "on" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
            >
              <UploadSimple size={22} aria-hidden />
              <span>
                Drop files here, or{" "}
                <button type="button" className="text-link" onClick={() => fileInput.current?.click()}>
                  choose files
                </button>
              </span>
              <small>.txt .md .csv .json .log .pdf{reading ? " · reading…" : ""}</small>
              <input ref={fileInput} type="file" multiple hidden accept=".txt,.md,.csv,.json,.log,.pdf,text/*,application/json,application/pdf" onChange={(e) => addFiles(e.target.files)} />
            </div>
            {files.length > 0 && (
              <ul className="file-list">
                {files.map((f, i) => (
                  <li key={`${f.name}-${i}`}>
                    <FileText size={16} aria-hidden />
                    <span>{f.name}</span>
                    <small>{f.text.length.toLocaleString("en")} characters</small>
                    <button type="button" className="icon-btn" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                      <X size={14} aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <textarea rows={4} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="…or paste text here." aria-label="Pasted material" />
            {over && <p className="warn small">Too long: a job can carry {MAX_INPUT_CHARS.toLocaleString("en")} characters. Remove a file or shorten the text.</p>}
          </section>

          {/* run once, or on a schedule */}
          <section className="cmp-block" aria-labelledby="run-h">
            <div className="cmp-head">
              <h2 id="run-h">Run</h2>
              <div className="seg seg-sm" role="radiogroup" aria-label="How to run">
                {(
                  [
                    ["once", "Once", null],
                    ["repeat", "Repeat", Repeat],
                  ] as const
                ).map(([m, l, Icon]) => (
                  <label key={m}>
                    <input type="radio" name="mode" checked={mode === m} onChange={() => setMode(m)} />
                    <span>
                      {Icon && <Icon size={14} aria-hidden />}
                      {l}
                    </span>
                  </label>
                ))}
              </div>
            </div>
            {mode === "once" && <p className="muted small">One job with all the material above.</p>}
            {mode === "repeat" && (
              <>
                <div className="cmp-row">
                  <div>
                    <span className="small muted">Every</span>
                    <div className="seg seg-sm" role="radiogroup" aria-label="Repeat every">
                      {EVERY.map(([v, l]) => (
                        <label key={v}>
                          <input type="radio" name="every" checked={every === v} onChange={() => setEvery(v)} />
                          <span>{l}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <label>
                    <span className="small muted">Number of runs</span>
                    <input className="name-input" type="number" min={1} max={100} value={runs} onChange={(e) => setRuns(Math.max(1, Math.min(100, Math.round(Number(e.target.value) || 1))))} />
                  </label>
                </div>
                <p className={repeatProblem ? "warn small" : "muted small"}>
                  {repeatProblem ||
                    "The first run starts now. Before each later run, your agent reserves its place ahead at today's price, so it starts on time even when the network is busy."}
                </p>
              </>
            )}
          </section>

          {/* 3. output */}
          <section className="cmp-block cmp-row" aria-label="Output">
            <div>
              <h2>Output</h2>
              <div className="seg" role="radiogroup" aria-label="Output format">
                {(["text", "markdown", "json"] as Format[]).map((f) => (
                  <label key={f}>
                    <input type="radio" name="format" checked={format === f} onChange={() => setFormat(f)} />
                    <span>{f === "json" ? "JSON" : f === "markdown" ? "Markdown" : "Plain text"}</span>
                  </label>
                ))}
              </div>
            </div>
            <div>
              <h2>Length</h2>
              <div className="seg" role="radiogroup" aria-label="Output length">
                {(Object.keys(SIZES) as Length[]).map((l) => (
                  <label key={l}>
                    <input type="radio" name="length" checked={length === l} onChange={() => setLength(l)} />
                    <span>
                      {SIZES[l].label} <small>≤ {Math.min(SIZES[l].tokens, largest).toLocaleString("en")}</small>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </section>
          {format === "json" && (
            <section className="cmp-block">
              <h2>JSON shape</h2>
              <textarea className="mono" rows={3} value={schema} onChange={(e) => setSchema(e.target.value)} placeholder='{ "field": "type" }' aria-label="JSON shape" />
            </section>
          )}

          {/* 4. deadline on the timeline */}
          <section className="cmp-block" aria-labelledby="due-h">
            <div className="cmp-head">
              <h2 id="due-h">Needed within</h2>
              <b className="due-value">{inHuman(within)}</b>
            </div>
            <div className="due-track">
              <div className="due-rail" />
              {plan && (
                <>
                  <span className="due-run" style={{ left: posOf(plan.startBy - now), width: `calc(${posOf(plan.finish - now)} - ${posOf(plan.startBy - now)})` }} />
                  <span className="due-promise" style={{ left: posOf(plan.startBy - now) }} />
                </>
              )}
              <input
                type="range"
                min={0}
                max={1}
                step={0.001}
                value={toPos(within)}
                onChange={(e) => setWithin(Math.max(MIN_S, Math.min(MAX_S, fromPos(Number(e.target.value)))))}
                aria-label="Deadline"
                aria-valuetext={inHuman(within)}
                className={plan && !plan.fits ? "late" : ""}
              />
            </div>
            <div className="due-scale" aria-hidden>
              {[60, 300, 900, 3600].map((s) => (
                <span key={s} style={{ left: posOf(s) }}>
                  {inHuman(s)}
                </span>
              ))}
            </div>
          </section>

          {/* 5. priority */}
          <section className="cmp-block" aria-labelledby="pri-h">
            <div className="cmp-head">
              <h2 id="pri-h">How much is on time worth?</h2>
              <div className="seg seg-sm" role="radiogroup" aria-label="Priority preset">
                {(Object.keys(PRIORITY) as (keyof typeof PRIORITY)[]).map((k) => (
                  <label key={k}>
                    <input
                      type="radio"
                      name="priority"
                      checked={priority === k}
                      onChange={() => {
                        setMaxPay(PRIORITY[k].maxPay);
                        setMinComp(PRIORITY[k].minComp);
                      }}
                    />
                    <span>{PRIORITY[k].label}</span>
                  </label>
                ))}
              </div>
            </div>
            <label className="slider">
              <span>
                Pay up to <b>{maxPay.toFixed(2)} HBAR</b> to go first if it would be late
              </span>
              <input type="range" min={0} max={1} step={0.01} value={maxPay} onChange={(e) => setMaxPay(Number(e.target.value))} />
            </label>
            <label className="slider">
              <span>
                Let others go first for at least <b>{minComp.toFixed(2)} HBAR</b>
              </span>
              <input type="range" min={0} max={1} step={0.01} value={minComp} onChange={(e) => setMinComp(Number(e.target.value))} />
            </label>
            <p className="muted small">
              <ArrowsClockwise size={13} aria-hidden /> {placesOnOffer} earlier place{placesOnOffer === 1 ? "" : "s"} on offer right now
              {plan ? ` at ${plan.p.name}` : ""}.
            </p>
          </section>

          {/* 6. provider */}
          <section className="cmp-block" aria-labelledby="prov-h">
            <h2 id="prov-h">Provider</h2>
            <div className="providers" role="radiogroup" aria-label="Provider">
              <label className="prov">
                <input type="radio" name="provider" checked={choice === "auto"} onChange={() => setChoice("auto")} />
                <span className="prov-main">
                  <b>Auto</b>
                  <small>The cheapest that meets the deadline{auto ? `: ${auto.p.name} now` : ""}</small>
                </span>
              </label>
              {options.map((o) => {
                const rate = keptRate(o.p.record);
                return (
                  <label key={o.p.id} className="prov">
                    <input type="radio" name="provider" checked={choice === o.p.id} onChange={() => setChoice(o.p.id)} />
                    <span className="prov-main">
                      <b>{o.p.name}</b>
                      <small>
                        {o.p.model} · {o.p.tps} tok/s · {rate === null ? "no record yet" : `${Math.round(rate * 100)}% promises kept`}
                      </small>
                    </span>
                    <span className="prov-side">
                      <b>{hbar(o.deposit)}</b>
                      <small className={o.fits ? "ok-text" : "warn"}>{o.fits ? "in time" : "too late"}</small>
                    </span>
                  </label>
                );
              })}
              {!options.length && <p className="muted small">{providers.isLoading ? "Asking the network…" : `No provider online takes jobs this long. Try a shorter output.`}</p>}
            </div>
          </section>
        </div>

        {/* the plan */}
        <aside className="compose-side plan" aria-live="polite">
          <h2>The plan</h2>
          {plan ? (
            <>
              <dl className="receipt">
                <div>
                  <dt>Provider</dt>
                  <dd>
                    {plan.p.name} <small className="muted">{plan.p.model}</small>
                  </dd>
                </div>
                <div>
                  <dt>Size</dt>
                  <dd>up to {tokens.toLocaleString("en")} tokens</dd>
                </div>
                <div>
                  <dt>Deposit, at most</dt>
                  <dd>
                    {hbar(plan.deposit)}
                    {count > 1 && <small className="muted">per run</small>}
                  </dd>
                </div>
                {mode === "repeat" && (
                  <div>
                    <dt>Runs</dt>
                    <dd>
                      {runs}, every {everyLabel(every)}
                      {count > 1 && <small className="muted">up to {hbar(total)} in all</small>}
                    </dd>
                  </div>
                )}
              </dl>
              <PromiseTrack booked={Math.floor(now)} startBy={plan.startBy} deadline={deadline} finishedAt={plan.finish} status="preview" onTime={plan.fits} size="lg" />
              <p className={plan.fits ? "verdict ok" : "verdict late"}>
                {plan.fits
                  ? `Guaranteed in time: starts by ${clock(plan.startBy)}, done by ${clock(plan.finish)} at the latest.`
                  : maxPay > 0
                    ? "Too late on its own; your agent will try to buy an earlier place."
                    : "Too late for this deadline. Give it more time, a shorter output, or a budget to go first."}
              </p>
              <p className="muted small">The deposit waits in escrow. You pay the size band the job actually uses, and get the rest back.</p>
            </>
          ) : (
            <p className="muted">{providers.isLoading ? "Checking providers…" : "No provider can take this job right now."}</p>
          )}
          <button type="submit" className="btn btn-primary btn-block" disabled={!canBook} aria-busy={book.isPending}>
            {book.isPending ? "Booking…" : mode === "repeat" ? "Start schedule" : "Book job"}
            <kbd>Ctrl ↵</kbd>
          </button>
          <Link to="/app/billing" className="text-link quiet" viewTransition>
            <Lightning size={13} aria-hidden /> Budget left: {hbar(budget)}
          </Link>
        </aside>
      </form>
    </>
  );
}
