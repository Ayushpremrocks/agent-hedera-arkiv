// Money stays in the user's wallet. The user grants their agent an HBAR allowance (the budget, which
// they can lower or revoke any time); just before the agent pays for a booking or a swap it pulls what
// it needs from that allowance, and anything above a small working float goes back to the user.
import { type Client, Hbar, TransferTransaction } from "@hiero-ledger/sdk";
import { HttpError, MIRROR } from "@qy/shared";

export const FLOAT = 50_000_000n; // 0.5 HBAR the agent keeps for network fees
const SWEEP_ABOVE = 200_000_000n; // send back anything over 2 HBAR

/** The Mirror Node is down or failing: callers should say "unavailable", never guess a number. */
export class MirrorDown extends HttpError {
  constructor(what: string, status: number) {
    super(503, `Hedera's Mirror Node isn't answering (${status}) so ${what} can't be checked right now. Try again shortly.`);
  }
}

/** GET from the Mirror Node, retrying once after a short pause (its outages are often brief). */
async function mirror(path: string, what: string): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${MIRROR}${path}`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
    if (res?.ok) return res.json();
    if (attempt >= 1) throw new MirrorDown(what, res?.status ?? 0);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/** HBAR balance from the Mirror Node (the SDK's balance query is retired); a few seconds behind, which the float absorbs. */
export async function balanceOf(_client: Client, id: string): Promise<bigint> {
  return BigInt((await mirror(`/accounts/${id}?transactions=false`, "the agent's balance")).balance.balance);
}

/** What's left of the HBAR allowance `owner` granted `spender` (Mirror Node, a few seconds behind). */
export async function allowanceLeft(owner: string, spender: string): Promise<bigint> {
  const a = (await mirror(`/accounts/${owner}/allowances/crypto?spender.id=${spender}`, "your budget")).allowances?.[0];
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
