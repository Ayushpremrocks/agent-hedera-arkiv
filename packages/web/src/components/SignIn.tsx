import { type FormEvent, useState } from "react";
import { useSession } from "../lib/session";
import { Notice } from "./ui";

/** Sign in with email (Magic keeps the key, no wallet app) or with HashPack. */
export function SignIn({ onDone, primaryClass = "btn btn-primary" }: { onDone?: () => void; primaryClass?: string }) {
  const { signIn } = useSession();
  const [email, setEmail] = useState("");
  const [step, setStep] = useState("");
  const [error, setError] = useState("");
  const go = async (withEmail: boolean) => {
    setError("");
    try {
      await signIn(setStep, withEmail ? email.trim() : undefined);
      onDone?.();
    } catch (e) {
      setError((e as Error).message ?? String(e));
    } finally {
      setStep("");
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    go(true);
  };
  return (
    <form className="signin" onSubmit={submit}>
      <input type="email" required autoComplete="email" placeholder="you@example.com" aria-label="Email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={!!step} />
      <button type="submit" className={primaryClass} disabled={!!step} aria-busy={!!step}>
        {step ? "Signing in…" : "Continue with email"}
      </button>
      <button type="button" className="text-link signin-alt" onClick={() => go(false)} disabled={!!step}>
        or use HashPack
      </button>
      <Notice text={step} />
      <Notice text={error} kind="error" />
    </form>
  );
}
