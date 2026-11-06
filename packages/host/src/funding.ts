// Money stays in the user's wallet. The user grants their agent an HBAR allowance (the budget, which
// they can lower or revoke any time); just before the agent pays for a booking or a swap it pulls what
// it needs from that allowance, and anything above a small working float goes back to the user.
import { type Client, Hbar, TransferTransaction } from "@hiero-ledger/sdk";
import { HttpError, MIRROR } from "@qy/shared";

export const FLOAT = 50_000_000n; // 0.5 HBAR the agent keeps for network fees
const SWEEP_ABOVE = 200_000_000n; // send back anything over 2 HBAR

/** HBAR balance from the Mirror Node (the SDK's balance query is retired); a few seconds behind, which the float absorbs. */
export async function balanceOf(_client: Client, id: string): Promise<bigint> {
  const res = await fetch(`${MIRROR}/accounts/${id}?transactions=false`);
  if (!res.ok) throw new Error(`balance of ${id}: Mirror ${res.status}`);
  return BigInt(((await res.json()) as any).balance.balance);
}

/** What's left of the HBAR allowance `owner` granted `spender` (Mirror Node, a few seconds behind). */
export async function allowanceLeft(owner: string, spender: string): Promise<bigint> {
  const res = await fetch(`${MIRROR}/accounts/${owner}/allowances/crypto?spender.id=${spender}`);
  if (!res.ok) return 0n;
  const a = ((await res.json()) as any).allowances?.[0];
  return a ? BigInt(a.amount) : 0n;
}

/** Make sure the agent can spend `amount` now, pulling the shortfall from its owner's allowance. */
export async function ensureFunds(client: Client, agent: string, owner: string, amount: bigint) {
  const have = await balanceOf(client, agent);
  const need = amount + FLOAT - have;
  if (need <= 0n) return;
  const left = await allowanceLeft(owner, agent);
  if (left < need) throw new HttpError(402, `budget too low: need ${need} more tinybars, the allowance for this agent has ${left} left. Raise it in your wallet.`);
  await (
    await new TransferTransaction()
      .addApprovedHbarTransfer(owner, Hbar.fromTinybars((-need).toString()))
      .addHbarTransfer(agent, Hbar.fromTinybars(need.toString()))
      .execute(client) // the agent signs as the allowance's spender and pays the fee
  ).getReceipt(client);
}

/** Return what the agent holds above its float (swap earnings, refunds) to its owner. */
export async function sweep(client: Client, agent: string, owner: string) {
  const have = await balanceOf(client, agent);
  if (have <= SWEEP_ABOVE) return 0n;
  const back = have - FLOAT;
  await (
    await new TransferTransaction().addHbarTransfer(agent, Hbar.fromTinybars((-back).toString())).addHbarTransfer(owner, Hbar.fromTinybars(back.toString())).execute(client)
  ).getReceipt(client);
  return back;
}
