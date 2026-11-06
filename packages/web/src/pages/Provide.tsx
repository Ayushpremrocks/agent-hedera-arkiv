// "Sell GPU time": the supply side's front door. Anyone with a GPU and a Hedera testnet account can join;
// nothing here needs our keys or our permission.
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { CopyButton } from "../components/motion";
import { hbar } from "../lib/format";
import { type Provider, keptRate } from "../lib/market";

const STEPS: { title: string; body: string; cmd?: string }[] = [
  {
    title: "Run a model server",
    body: "Any OpenAI-compatible server works. Ollama is the quickest: pull a small model and leave it running.",
    cmd: "ollama pull qwen2.5:0.5b-instruct",
  },
  {
    title: "Get the Dani.ai code",
    body: "From the Dani.ai repository, install once. Node 22 and pnpm.",
    cmd: "pnpm install",
  },
  {
    title: "Join with your own account",
    body: "Use a Hedera testnet account with an ECDSA key and about 15 HBAR. The command checks the key controls the account, creates a small treasury paid by you, and writes everything to .env.provider. Nobody else's keys are involved.",
    cmd: "pnpm provider:join --account 0.0.YOUR_ID --key YOUR_ECDSA_KEY --url http://YOUR_HOST:4000 --name \"My GPU\"",
  },
  {
    title: "Add a little Arkiv gas",
    body: "Your provider announces itself on Arkiv. The join command prints your Arkiv address; get free tGLM for it at hub.arkiv.network/faucet.",
  },
  {
    title: "Start selling",
    body: "It measures its slowest speed, then announces its offer. Agents find it, check its signatures and start booking.",
    cmd: "QY_ENV=.env.provider pnpm provider",
  },
];

export function Provide() {
  const providers = useQuery({ queryKey: ["providers"], queryFn: () => fetch("/api/market").then((r) => r.json()).then((d) => d.providers as Provider[]), refetchInterval: 15_000 });
  const list = providers.data ?? [];
  const cheapest = list.length ? list.reduce((m, p) => (BigInt(p.price) < BigInt(m.price) ? p : m)) : null;

  return (
    <div className="ql">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="ql-top">
        <Link to="/" className="ql-logo" aria-label="Dani.ai home">
          Dani.ai
        </Link>
        <nav aria-label="Main">
          <Link to="/network" viewTransition className="ql-nav">
            Network status
          </Link>
          <Link to="/" viewTransition className="ql-nav">
            Use GPU time
          </Link>
        </nav>
      </header>
      <main id="main">
        <section className="ql-hero" aria-labelledby="pv-h">
          <h1 id="pv-h">
            Your GPU,
            <br /> paid per job.
          </h1>
          <div className="ql-hero-side">
            <p>
              Agents book your spare GPU time through Hedera, one job at a time. You set nothing per customer: your machine
              measures its own speed, promises each job a start time it can keep, and gets paid up front.
            </p>
            <a href="#steps" className="cta">
              <span className="roll" data-text="Set up in five steps">
                <span>Set up in five steps</span>
              </span>
            </a>
          </div>
        </section>

        <section className="pv-terms" aria-labelledby="terms-h">
          <h2 id="terms-h">The deal</h2>
          <dl>
            <div>
              <dt>You're paid</dt>
              <dd>
                Up front, in HBAR, for every booking. The floor covers Hedera fees and rises with demand
                {cheapest ? `; right now the cheapest provider charges ${hbar(cheapest.price)} a job` : ""}.
              </dd>
            </div>
            <div>
              <dt>You promise</dt>
              <dd>Each job a latest start time, worked out from the slowest speed your machine measured. Miss it and the booking is refunded automatically.</dd>
            </div>
            <div>
              <dt>Everyone sees</dt>
              <dd>Your track record: promises kept, jobs done, refunds. It's computed from messages you sign, so nobody can fake it, you included.</dd>
            </div>
            <div>
              <dt>You keep</dt>
              <dd>Your keys and your machine. Jobs arrive as requests to your model server; results are private to whoever booked them.</dd>
            </div>
          </dl>
        </section>

        <section className="pv-steps" id="steps" aria-labelledby="steps-h">
          <h2 id="steps-h">Set up in five steps</h2>
          <ol>
            {STEPS.map((s, i) => (
              <li key={s.title}>
                <span className="hurry-n" aria-hidden>
                  {i + 1}
                </span>
                <div>
                  <h3>{s.title}</h3>
                  <p>{s.body}</p>
                  {s.cmd && (
                    <div className="cmd">
                      <code>{s.cmd}</code>
                      <CopyButton value={s.cmd} label="command" />
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
          <p className="pv-note">
            On Windows PowerShell, start with <code>$env:QY_ENV=".env.provider"; pnpm provider</code>. Agents must be able to reach the
            URL you give: a LAN address works for agents on your network, a tunnel or public address for everyone.
          </p>
        </section>

        <section className="pv-board" aria-labelledby="who-h">
          <h2 id="who-h">Providers online now</h2>
          {list.length ? (
            <ul>
              {list.map((p) => {
                const rate = keptRate(p.record);
                return (
                  <li key={p.id}>
                    <Link to={`/providers/${p.id}`} viewTransition className="arrow-link">
                      <span>{p.name}</span>
                      <span className="arrow" aria-hidden>
                        →
                      </span>
                    </Link>
                    <span className="muted">{p.model}</span>
                    <span>{rate === null ? "no record yet" : `${Math.round(rate * 100)}% of promises kept`}</span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="muted">{providers.isLoading ? "Asking Arkiv…" : "None right now. Yours could be the first."}</p>
          )}
        </section>
      </main>
      <footer className="ql-foot">
        <div className="ql-foot-row">
          <p>Payments, tickets and the signed log on Hedera. Offers and public records on Arkiv.</p>
          <nav aria-label="Footer">
            <Link to="/network" viewTransition>
              Network status
            </Link>
            <Link to="/" viewTransition>
              Use GPU time
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
