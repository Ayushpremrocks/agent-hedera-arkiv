import { useState } from "react";
import { Link, NavLink, Outlet } from "react-router";
import { hbar } from "../lib/format";
import { useMe } from "../lib/hooks";
import { useSession } from "../lib/session";
import { Notice } from "./ui";

const NAV = [
  ["/app", "Overview"],
  ["/app/tasks", "Tasks"],
  ["/app/billing", "Billing"],
  ["/app/settings", "Settings"],
] as const;

export function AppShell() {
  const { account, signOut, signIn } = useSession();
  const me = useMe();
  const [step, setStep] = useState("");
  const [error, setError] = useState("");
  const allowance = me.data?.agent?.allowance;

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
            {NAV.map(([to, label]) => (
              <NavLink key={to} to={to} end={to === "/app"} className="nav-item">
                {label}
              </NavLink>
            ))}
          </nav>
        )}
        <nav aria-label="Public" className="nav-secondary">
          <NavLink to="/network" className="nav-item">
            Network status
          </NavLink>
        </nav>
      </aside>
      <div className="main-col">
        <header className="topbar">
          {account && me.data?.agent && (
            <Link to="/app/billing" className="budget-pill" title="What your agent may still spend">
              Budget <b>{allowance === null || allowance === undefined ? "–" : hbar(allowance)}</b>
            </Link>
          )}
          {account ? (
            <>
              <span className="who-chip">{account}</span>
              <button type="button" className="ghost" onClick={signOut}>
                Sign out
              </button>
            </>
          ) : (
            <button type="button" onClick={connect} disabled={!!step}>
              {step ? "Connecting…" : "Connect HashPack"}
            </button>
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
