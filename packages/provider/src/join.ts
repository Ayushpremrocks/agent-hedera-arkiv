// Become a QueueYield provider with your own Hedera testnet account: no shared keys, no one's .env.
//
//   pnpm provider:join --account 0.0.1234 --key <your ECDSA private key> --url http://<reachable host>:4000
//                      [--name "My GPU"] [--model qwen2.5:0.5b-instruct] [--llm http://localhost:11434/v1]
//                      [--workers 2] [--port 4000] [--out .env.provider]
//
// It checks the key really controls the account, creates a small treasury account (paid by you) that
// holds ticket NFTs before they're handed out, and writes everything to one file. Then:
//
//   QY_ENV=.env.provider pnpm provider          (PowerShell: $env:QY_ENV=".env.provider"; pnpm provider)
//
// Your provider announces itself on Arkiv; agents find it, check its signatures, and send work.
import { AccountCreateTransaction, Hbar, PrivateKey } from "@hiero-ledger/sdk";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const { values: a } = parseArgs({
  options: {
    account: { type: "string" },
    key: { type: "string" },
    url: { type: "string" },
    name: { type: "string", default: "Community GPU" },
    model: { type: "string", default: "qwen2.5:0.5b-instruct" },
    llm: { type: "string", default: "http://localhost:11434/v1" },
    workers: { type: "string", default: "2" },
    port: { type: "string", default: "4000" },
    out: { type: "string", default: ".env.provider" },
    force: { type: "boolean", default: false },
  },
});
const fail = (msg: string): never => {
  console.error(`\n${msg}\n`);
  process.exit(1);
};
if (!a.account || !/^0\.0\.\d+$/.test(a.account)) fail("--account must be your Hedera testnet account id, like 0.0.1234 (portal.hedera.com gives you one).");
if (!a.key) fail("--key must be that account's ECDSA private key (HashPack: Settings, Export private key).");
if (!a.url) fail("--url must be where agents can reach this provider, e.g. http://192.168.1.20:4000 on a LAN or a public tunnel URL.");
const out = resolve(a.out!);
if (existsSync(out) && !a.force) fail(`${out} already exists. Use --force to replace it (its treasury account would be abandoned).`);

// Loaded only now, so the shared package doesn't demand the repo's .env while setting up.
process.env.QY_ENV = out;
const { MIRROR, arkivReader, arkivWriter, evmKey, hederaClient, parseKey } = await import("@qy/shared");

// 1. The key must control the account, and be ECDSA: Arkiv entities are signed with its EVM form.
const acct = (await (await fetch(`${MIRROR}/accounts/${a.account}`)).json()) as any;
if (!acct?.key) fail(`${a.account} wasn't found on testnet.`);
if (acct.key._type !== "ECDSA_SECP256K1") fail(`${a.account} has an ${acct.key._type} key; QueueYield needs an ECDSA account (it signs on Arkiv too).`);
let key: PrivateKey;
try {
  key = parseKey(a.key!);
} catch {
  fail("That private key couldn't be read. Paste the hex or DER string HashPack exports.");
}
if (key!.publicKey.toStringRaw() !== acct.key.key) fail("That key doesn't control this account.");
const hbar = Number(acct.balance?.balance ?? 0) / 1e8;
if (hbar < 15) fail(`${a.account} has ${hbar} HBAR; a provider needs about 15 to start (treasury, token, topic, refunds). Testnet faucet: portal.hedera.com`);
console.log(`account ${a.account}: ECDSA key verified, ${hbar.toFixed(2)} HBAR`);

// 2. A treasury of its own: holds the ticket NFT class; the provider's key can only mint.
const client = hederaClient(a.account!, a.key!);
const tKey = PrivateKey.generateECDSA();
const treasury = (
  await (
    await new AccountCreateTransaction().setECDSAKeyWithAlias(tKey).setInitialBalance(new Hbar(5)).setMaxAutomaticTokenAssociations(-1).execute(client)
  ).getReceipt(client)
).accountId!.toString();
client.close();
console.log(`treasury ${treasury} created (5 HBAR from your account)`);

// 3. Everything in one file, readable only by you.
const label = a.name!.replace(/[\r\n"]/g, "");
writeFileSync(
  out,
  [
    `# QueueYield provider "${label}", made by pnpm provider:join. Keep this file private.`,
    `PROVIDER_NAME=PROVIDER`,
    `PROVIDER_LABEL="${label}"`,
    `PROVIDER_ID=${a.account}`,
    `PROVIDER_KEY=${a.key}`,
    `TREASURY_ID=${treasury}`,
    `TREASURY_KEY=${tKey.toStringDer()}`,
    `PROVIDER_PORT=${a.port}`,
    `PROVIDER_URL=${a.url}`,
    `WORKERS=${a.workers}`,
    `LLM_BASE_URL=${a.llm}`,
    `LLM_MODEL=${a.model}`,
    `X402_FACILITATOR_URL=https://api.testnet.blocky402.com`,
    `# Optional, for a higher Arkiv rate limit: https://hub.arkiv.network/access-keys`,
    `ARKIV_ACCESS_KEY=`,
    "",
  ].join("\n"),
  { mode: 0o600 },
);
console.log(`wrote ${out}`);

// 4. Arkiv gas: announcing on Arkiv costs a little tGLM at the account's EVM address.
const evm = arkivWriter(evmKey(a.key!)).account.address;
const gas = await arkivReader().getBalance({ address: evm }).catch(() => 0n);
console.log(
  gas > 0n
    ? `Arkiv: ${evm} has ${(Number(gas) / 1e18).toFixed(4)} tGLM, enough to announce.`
    : `Arkiv: ${evm} has no tGLM yet. Get some free at https://hub.arkiv.network/faucet before starting.`,
);
console.log(`\nNext:\n  make sure ${a.model} answers at ${a.llm}\n  QY_ENV=${a.out} pnpm provider\n`);
