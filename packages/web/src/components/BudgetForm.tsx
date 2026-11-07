import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { signer, useSession } from "../lib/session";
import { ProgressButton, toast } from "./motion";

const MAX = 25; // HBAR, the slider's range; the number field accepts more

/** Sets the agent's budget: an HBAR allowance the user approves (HashPack, or Magic for email sign-ins). 0 cancels it. */
export function BudgetForm({ agentId, initial = 5, label = "Approve budget" }: { agentId: string; initial?: number; label?: string }) {
  const { account } = useSession();
  const qc = useQueryClient();
  const [amount, setAmount] = useState(initial);
  const approve = useMutation({
    mutationFn: async () => (await signer()).approveBudget(account!, agentId, amount),
    onSuccess: () => {
      toast("success", amount === 0 ? "Budget cancelled" : `Budget set to ${amount} HBAR`, "It shows here within a few seconds.");
      setTimeout(() => qc.invalidateQueries({ queryKey: ["me"] }), 5000);
    },
    onError: (e) => toast("error", "Budget not changed", e.message),
  });
  const pct = Math.min(100, (amount / MAX) * 100);
  return (
    <form
      className="budget-form"
      onSubmit={(e) => {
        e.preventDefault();
        approve.mutate();
      }}
    >
      <div className="budget-slider">
        <label htmlFor="budget-range">Budget</label>
        <output htmlFor="budget-range">{amount} HBAR</output>
        <input
          id="budget-range"
          type="range"
          min={0}
          max={MAX}
          step={0.5}
          value={Math.min(amount, MAX)}
          onChange={(e) => setAmount(Number(e.target.value))}
          style={{ ["--pct" as any]: `${pct}%` }}
          aria-valuetext={`${amount} HBAR`}
        />
      </div>
      <ProgressButton type="submit" state={approve.isPending ? "loading" : approve.isSuccess ? "done" : "idle"} doneLabel="Approved">
        {amount === 0 ? "Cancel budget" : label}
      </ProgressButton>
    </form>
  );
}
