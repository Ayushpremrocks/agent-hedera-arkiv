import { useState } from "react";
import { NavLink, Outlet } from "react-router";
import { useSession } from "../lib/session";
import { Notice } from "./ui";

export function Layout() {
  const { account, signIn, signOut } = useSession();
  const [step, setStep] = useState("");
  const [error, setError] = useState("");

  const onConnect = async () => {
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
    <>
      <header className="top">
        <div className="brand">
          <h1>QueueYield</h1>
          <p>Hand your AI tasks to an agent. It books GPU time from providers, and when you're in a hurry it pays others to let you go first.</p>
        </div>
        <div className="account">
          {account ? (
            <>
              <span className="who-chip">{account}</span>
              <button type="button" onClick={signOut}>
                Disconnect
              </button>
            </>
          ) : (
            <button type="button" onClick={onConnect} disabled={!!step}>
              {step ? "Connecting…" : "Connect HashPack"}
            </button>
          )}
        </div>
        <nav className="tabs" aria-label="Sections">
          <NavLink to="/" end className="tab">
            My work
          </NavLink>
          <NavLink to="/market" className="tab">
            Market
          </NavLink>
        </nav>
      </header>
      <main>
        <Notice text={step} />
        <Notice text={error} kind="error" />
        <Outlet />
      </main>
    </>
  );
}
