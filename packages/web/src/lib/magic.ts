// Email sign-in through Magic: Magic holds the user's Hedera key (no wallet app), and signs what we
// ask with it. Same job as wallet.ts (HashPack): sign the host's sign-in message and approve the
// agent's budget as an HBAR allowance.
import "./polyfill";
import { HederaExtension } from "@magic-ext/hedera";
import { proto } from "@hiero-ledger/proto";
import { AccountAllowanceApproveTransaction, Client, Hbar, PublicKey, TransactionId } from "@hiero-ledger/sdk";
import { Magic } from "magic-sdk";

const magic = new Magic(import.meta.env.VITE_MAGIC_KEY as string, { extensions: [new HederaExtension({ network: "testnet" })] });
const hedera = (magic as any).hedera as HederaExtension;

// The extension's return shapes aren't typed: accept a DER string or { publicKeyDer }, and bytes as array or hex.
const publicKey = async () => {
  const r: any = await hedera.getPublicKey();
  return PublicKey.fromString(typeof r === "string" ? r : r.publicKeyDer);
};
const sign = async (bytes: Uint8Array) => {
  const s: any = await hedera.sign(bytes);
  return typeof s === "string" ? Uint8Array.from(Buffer.from(s.replace(/^0x/, ""), "hex")) : Uint8Array.from(s);
};

/** Email one-time code (Magic's own dialog), then the user's Hedera public key, DER-encoded. */
export async function login(email: string): Promise<string> {
  if (!(await magic.user.isLoggedIn())) await magic.auth.loginWithEmailOTP({ email });
  return (await publicKey()).toStringDer();
}

/** Sign a message the way HashPack does (prefixed), as a base64 SignatureMap the host verifies. */
export async function signMessage(_account: string, message: string): Promise<string> {
  const key = await publicKey();
  const sig = await sign(Buffer.from("\x19Hedera Signed Message:\n" + message.length + message));
  return Buffer.from(proto.SignatureMap.encode({ sigPair: [{ pubKeyPrefix: key.toBytesRaw(), ed25519: sig }] }).finish()).toString("base64");
}

/** Let `agent` spend up to `hbar` from the user's account. Setting it again replaces the old amount. */
export async function approveBudget(account: string, agent: string, hbar: number) {
  const tx = new AccountAllowanceApproveTransaction()
    .approveHbarAllowance(account, agent, new Hbar(hbar))
    .setTransactionId(TransactionId.generate(account))
    .freezeWith(Client.forTestnet());
  await tx.signWith(await publicKey(), sign);
  const res = await tx.execute(Client.forTestnet());
  await res.getReceipt(Client.forTestnet());
  return res.transactionId.toString();
}

export async function disconnect() {
  await magic.user.logout().catch(() => {});
}
