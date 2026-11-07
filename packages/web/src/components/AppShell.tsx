import { ArrowSquareOut, GearSix, Globe, ListChecks, Plus, Repeat, SignOut, SquaresFour, Wallet } from "@phosphor-icons/react";
import { useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router";
import { hbar } from "../lib/format";
import { useMe, useTasks } from "../lib/hooks";
import { useSession } from "../lib/session";
import { Notice } from "./ui";

const NAV = [
  ["/app", "Overview", SquaresFour],
  ["/app/tasks", "Tasks", ListChecks],
  ["/app/schedules", "Schedules", Repeat],
  ["/app/billing", "Billing", Wallet],
  ["/app/settings", "Settings", GearSix],
] as const;

/** Which nav item a path belongs to (task and batch pages belong to Tasks). */
const section = (path: string) => (path.startsWith("/app/tasks") || path.startsWith("/app/batches") ? "/app/tasks" : path);
const short = (id: string) => (id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id);

/** The agent's state in one line: what it's doing, and the budget it may still spend. */
function AgentCard() {
  const { account, signOut } = useSession();
  const me = useMe();
  const tasks = useTasks();
  const running = (tasks.data ?? []).filter((t) => t.status === "running").length;
  const waiting = (tasks.data ?? []).filter((t) => t.status === "queued").length;
  const agent = me.data?.agent;
  const state = !agent ? "No agent yet" : running ? `Running ${running} task${running > 1 ? "s" : ""}` : waiting ? `${waiting} waiting to start` : "Idle, ready for work";
  return (
    <div className="rail-agent">
      <div className="rail-agent-state">
        <i className={`pulse ${running || waiting ? "on" : ""}`} aria-hidden />
        <span>{state}</span>
      </div>
      {agent && (
        <Link to="/app/billing" className="rail-budget">
          <span>Budget left</span>
          <b>{hbar(agent.allowance)}</b>
        </Link>
      )}
      <div className="rail-account">
        <span title={account ?? ""}>{account ? short(account) : ""}</span>
        <button type="button" className="icon-btn" onClick={signOut} aria-label="Sign out" title="Sign out">
          <SignOut size={16} aria-hidden />
        </button>
      </div>
    </div>
  );
}

export function AppShell() {
  const { account, signIn } = useSession();
  const me = useMe();
  const { pathname } = useLocation();
  const [step, setStep] = useState("");
  const [error, setError] = useState("");
  const active = section(pathname);

  const connect = async () => {
    setError("");
    try {
      await signIn(setStep);
    } catch (e) {
      setError((e as Error).message ?? String(e));
    } finally {
      setStep("");
    }
  };

  return (
    <div className="app">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <aside className="rail">
        <Link to={account ? "/app" : "/"} className="rail-logo" viewTransition>
          Dani.ai
        </Link>
        {account && (
          <Link to="/app/tasks/new" className="btn btn-primary rail-new" viewTransition>
            <Plus size={16} weight="bold" aria-hidden /> New task
          </Link>
        )}
        <nav aria-label="App" className="rail-nav">
          {account &&
            NAV.map(([to, label, Icon]) => (
              <NavLink key={to} to={to} end={to === "/app"} viewTransition className="rail-link" aria-current={active === to ? "page" : undefined}>
                <Icon size={18} weight={active === to ? "fill" : "regular"} aria-hidden />
                <span>{label}</span>
              </NavLink>
            ))}
          <NavLink to="/network" viewTransition className="rail-link" aria-current={pathname === "/network" ? "page" : undefined}>
            <Globe size={18} weight={pathname === "/network" ? "fill" : "regular"} aria-hidden />
            <span>Network status</span>
          </NavLink>
        </nav>
        {account ? (
          <AgentCard />
        ) : (
          <div className="rail-agent">
            <p className="rail-pitch">Sign in to hand your agent tasks with deadlines.</p>
            <button type="button" className="btn btn-primary" onClick={connect} disabled={!!step}>
              {step ? "Connecting…" : "Sign in with HashPack"}
            </button>
          </div>
        )}
      </aside>
      <main id="main" className="app-main">
        <Notice text={step} />
        <Notice text={error} kind="error" />
        {me.data?.mirrorDown && <Notice text="Hedera's Mirror Node isn't answering, so balances can't be shown right now. Your tasks keep running." />}
        <Outlet />
        <footer className="app-foot">
          <span>Payments, tickets and the signed log on Hedera. Offers and public records on Arkiv.</span>
          <a href="https://hashscan.io/testnet" target="_blank" rel="noopener">
            Testnet explorer <ArrowSquareOut size={12} aria-hidden />
          </a>
        </footer>
      </main>
    </div>
  );
}
