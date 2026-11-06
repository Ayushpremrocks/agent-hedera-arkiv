import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSession } from "../lib/session";
import { approveBudget } from "../lib/wallet";
import { Notice } from "./ui";

/** Sets the agent's budget: an HBAR allowance the user approves in HashPack. 0 cancels it. */
export function BudgetForm({ agentId, initial = "5", label = "Approve in HashPack" }: { agentId: string; initial?: string; label?: string }) {
  const { account } = useSession();
  const qc = useQueryClient();
  const [amount, setAmount] = useState(initial);
  const approve = useMutation({
    mutationFn: () => approveBudget(account!, agentId, Number(amount)),
    onSuccess: () => setTimeout(() => qc.invalidateQueries({ queryKey: ["me"] }), 5000),
  });
  return (
    <form
      className="budget-form"
      onSubmit={(e) => {
        e.preventDefault();
        approve.mutate();
      }}
    >
      <label>
        <span className="sr">Budget in HBAR</span>
        <span className="unit">
          <input type="number" min="0" step="0.5" value={amount} onChange={(e) => setAmount(e.target.value)} /> HBAR
        </span>
      </label>
      <button type="submit" disabled={approve.isPending}>
        {approve.isPending ? "Confirm in HashPack…" : label}
      </button>
      {approve.isSuccess && <Notice text={`Budget set to ${amount} HBAR. It shows here within a few seconds.`} />}
      <Notice text={approve.error?.message} kind="error" />
    </form>
  );
}
