import { GearSix, Globe, ListChecks, SquaresFour, Wallet } from "@phosphor-icons/react";
import { useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router";
import { useMe, useTasks } from "../lib/hooks";
import { useSession } from "../lib/session";
import { AgentStatus, AnimatedNumber, ProgressButton, SlidingHighlight } from "./motion";
import { Notice } from "./ui";

const NAV = [
  ["/app", "Overview", SquaresFour],
  ["/app/tasks", "Tasks", ListChecks],
  ["/app/billing", "Billing", Wallet],
  ["/app/settings", "Settings", GearSix],
] as const;

/** Which nav item a path belongs to (task pages belong to Tasks). */
const section = (path: string) => (path.startsWith("/app/tasks") ? "/app/tasks" : path.startsWith("/app/") ? path : path === "/app" ? "/app" : path);

export function AppShell() {
  const { account, signOut, signIn } = useSession();
  const me = useMe();
  const tasks = useTasks();
  const { pathname } = useLocation();
  const [step, setStep] = useState("");
  const [error, setError] = useState("");
  const allowance = me.data?.agent?.allowance;
  const running = (tasks.data ?? []).filter((t) => t.status === "running").length;
  const scheduled = (tasks.data ?? []).filter((t) => t.status === "queued").length;
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
    <div className="shell">
      <aside className="sidebar">
        <Link to={account ? "/app" : "/"} className="logo">
          QueueYield
        </Link>
        {account && (
          <nav aria-label="App">
            {NAV.map(([to, label, Icon]) => (
              <NavLink key={to} to={to} end={to === "/app"} className="nav-item" aria-current={active === to ? "page" : undefined}>
                {active === to && <SlidingHighlight id="nav" />}
                <Icon size={18} weight={active === to ? "fill" : "regular"} aria-hidden />
                <span>{label}</span>
              </NavLink>
            ))}
          </nav>
        )}
        <nav aria-label="Public" className="nav-secondary">
          <NavLink to="/network" className="nav-item">
            {pathname === "/network" && <SlidingHighlight id="nav" />}
            <Globe size={18} weight={pathname === "/network" ? "fill" : "regular"} aria-hidden />
            <span>Network status</span>
          </NavLink>
        </nav>
      </aside>
      <div className="main-col">
        <header className="topbar">
          {account && me.data?.agent && (
            <>
              <AgentStatus
                working={running + scheduled > 0}
                label={running ? `Agent is running ${running} task${running > 1 ? "s" : ""}` : scheduled ? `${scheduled} task${scheduled > 1 ? "s" : ""} scheduled` : "Agent idle"}
              />
              <Link to="/app/billing" className="budget-pill" title="What your agent may still spend">
                Budget{" "}
                <b>{allowance === null || allowance === undefined ? "–" : <AnimatedNumber value={Number(allowance) / 1e8} format={(n) => `${n.toFixed(2)} HBAR`} />}</b>
              </Link>
            </>
          )}
          {account ? (
            <>
              <span className="who-chip">{account}</span>
              <button type="button" className="ghost press" onClick={signOut}>
                Sign out
              </button>
            </>
          ) : (
            <ProgressButton type="button" onClick={connect} state={step ? "loading" : "idle"}>
              Connect HashPack
            </ProgressButton>
          )}
        </header>
        <main className="content">
          <Notice text={step} />
          <Notice text={error} kind="error" />
          {me.data?.mirrorDown && <Notice text="Hedera's Mirror Node isn't answering, so balances can't be shown right now. Your tasks keep running." />}
          <Outlet />
        </main>
      </div>
    </div>
  );
}
