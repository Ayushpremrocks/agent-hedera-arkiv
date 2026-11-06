// Top up project accounts from the operator: `tsx spikes/topup.ts PROVIDER=100 AGENT_A=60 ...` (HBAR).
import { Hbar, TransferTransaction } from "@hiero-ledger/sdk";
import { MIRROR, hederaClient, need, role } from "@qy/shared";

const op = need("HEDERA_OPERATOR_ID");
const client = hederaClient(op, need("HEDERA_OPERATOR_KEY"));
const tx = new TransferTransaction();
let total = 0;
for (const arg of process.argv.slice(2)) {
  const [name, amount] = arg.split("=");
  const hbar = Number(amount);
  if (!(hbar > 0 && hbar <= 500)) throw new Error(`bad amount in ${arg}`);
  tx.addHbarTransfer(role(name).id, new Hbar(hbar));
  total += hbar;
}
tx.addHbarTransfer(op, new Hbar(-total));
const r = await (await tx.execute(client)).getReceipt(client);
console.log(`sent ${total} HBAR: ${r.status}`);
client.close();
await new Promise((ok) => setTimeout(ok, 5000));
for (const arg of process.argv.slice(2)) {
  const id = role(arg.split("=")[0]).id;
  const b = ((await (await fetch(`${MIRROR}/balances?account.id=${id}`)).json()) as any).balances[0].balance;
  console.log(`${arg.split("=")[0]} ${id}: ${(b / 1e8).toFixed(2)} HBAR`);
}
