import { useState } from "react";
import { Link, Navigate, useNavigate } from "react-router";
import { Notice } from "../components/ui";
import { useSession } from "../lib/session";

export function Landing() {
  const { account, signIn } = useSession();
  const navigate = useNavigate();
  const [step, setStep] = useState("");
  const [error, setError] = useState("");
  if (account) return <Navigate to="/app" replace />;

  const start = async () => {
    setError("");
    try {
      await signIn(setStep);
      navigate("/app");
    } catch (e) {
      setError((e as Error).message ?? String(e));
    } finally {
      setStep("");
    }
  };

  return (
    <div className="landing">
      <header className="landing-top">
        <span className="logo">QueueYield</span>
        <Link to="/network">Network status</Link>
      </header>
      <section className="hero">
        <h1>AI work, done by the deadline you set.</h1>
        <p>
          Hand a task to your own agent. It books GPU time from independent providers, and when you're in a hurry it pays others to let you go first. When you're not, it earns by
          letting them.
        </p>
        <div className="hero-actions">
          <button type="button" className="big" onClick={start} disabled={!!step}>
            {step ? "Connecting…" : "Get started with HashPack"}
          </button>
          <span className="muted">Hedera testnet. Signing in is free.</span>
        </div>
        <Notice text={step} />
        <Notice text={error} kind="error" />
      </section>
      <section className="how">
        <h2>How it works</h2>
        <ol>
          <li>
            <b>Set a budget.</b> Your HBAR stays in your wallet. You approve the most your agent may spend, and you can lower or cancel it any time.
          </li>
          <li>
            <b>Describe the task and when you need it.</b> Pick Flexible, Standard or Rush. You'll see the cost before you book.
          </li>
          <li>
            <b>Get a verified result.</b> Every result is checked against a fingerprint the provider signs on Hedera, so you know it wasn't changed.
          </li>
        </ol>
      </section>
      <section className="pillars">
        <div>
          <b>Pay for priority, only when it matters</b>
          <p>Rush tasks buy an earlier spot from agents that can wait. Both sides agree on the price; nobody is pushed back without being paid.</p>
        </div>
        <div>
          <b>Your money stays yours</b>
          <p>Agents spend from an allowance you control in HashPack, and send what they earn back to your wallet.</p>
        </div>
        <div>
          <b>Open and checkable</b>
          <p>Bookings, runs and results are signed on Hedera, and the market's records live on Arkiv for anyone to verify.</p>
        </div>
      </section>
    </div>
  );
}
