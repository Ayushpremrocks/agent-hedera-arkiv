// Creates PROVIDER, TREASURY and AGENT_A, AGENT_B, ... testnet accounts funded from the operator,
// appends them to .env, and shares the operator's Arkiv tGLM with the roles that write to Arkiv.
// Safe to re-run; `--agents N` adds agents up to N (default 3).
import { AccountCreateTransaction, Hbar, PrivateKey } from "@hiero-ledger/sdk";
import { appendFileSync } from "node:fs";
import { formatEther } from "viem";
import { ENV_PATH, arkivReader, arkivWriter, evmKey, hederaClient, need } from "@qy/shared";
import { privateKeyToAccount } from "viem/accounts";
import { parseArgs } from "node:util";

const agents = Number(parseArgs({ options: { agents: { type: "string", default: "3" } } }).values.agents);
if (!(agents >= 1 && agents <= 26)) throw new Error("--agents must be 1..26");
const AGENT_NAMES = Array.from({ length: agents }, (_, i) => `AGENT_${String.fromCharCode(65 + i)}`);
const ROLES: Record<string, number> = { PROVIDER: 40, TREASURY: 10, ...Object.fromEntries(AGENT_NAMES.map((n) => [n, 30])) };
const ARKIV_ROLES = ["PROVIDER", ...AGENT_NAMES];

const opId = need("HEDERA_OPERATOR_ID");
const opKey = need("HEDERA_OPERATOR_KEY");
const client = hederaClient(opId, opKey);

for (const [name, hbar] of Object.entries(ROLES)) {
  if (process.env[`${name}_ID`]) {
    console.log(`${name} already set: ${process.env[`${name}_ID`]}`);
    continue;
  }
  const key = PrivateKey.generateECDSA();
  const receipt = await (
    await new AccountCreateTransaction()
      .setECDSAKeyWithAlias(key)
      .setInitialBalance(new Hbar(hbar))
      .setMaxAutomaticTokenAssociations(-1) // receive slot NFTs without a separate associate tx
      .execute(client)
  ).getReceipt(client);
  const id = receipt.accountId!.toString();
  appendFileSync(ENV_PATH, `\n${name}_ID=${id}\n${name}_KEY=${key.toStringDer()}\n`);
  process.env[`${name}_ID`] = id;
  process.env[`${name}_KEY`] = key.toStringDer();
  console.log(`${name} = ${id}  evm ${privateKeyToAccount(evmKey(key.toStringDer())).address}`);
}
client.close();

// Arkiv gas: fund the operator's EVM address at https://hub.arkiv.network/faucet, then re-run.
const reader = arkivReader();
const funder = arkivWriter(evmKey(opKey));
const funderBal = await reader.getBalance({ address: funder.account.address });
console.log(`\nOperator Arkiv address ${funder.account.address}: ${formatEther(funderBal)} tGLM`);
for (const name of ARKIV_ROLES) {
  const to = privateKeyToAccount(evmKey(need(`${name}_KEY`))).address;
  const bal = await reader.getBalance({ address: to });
  if (bal > 0n) {
    console.log(`${name} ${to}: ${formatEther(bal)} tGLM`);
    continue;
  }
  if (funderBal === 0n) {
    console.log(`${name} ${to}: 0 tGLM (fund operator or this address at the faucet)`);
    continue;
  }
  const share = funderBal / BigInt(ARKIV_ROLES.length + 1); // keep a share for the operator
  const hash = await funder.sendTransaction({ to, value: share });
  await reader.waitForTransactionReceipt({ hash });
  console.log(`${name} ${to}: sent ${formatEther(share)} tGLM`);
}
