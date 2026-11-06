// HashPack (or any Hedera wallet) over WalletConnect: connect, sign the host's sign-in message, and
// approve the agent's budget as an HBAR allowance. Keys never leave the wallet.
import "./polyfill";
import { DAppConnector, HederaChainId, HederaJsonRpcMethod, HederaSessionEvent, transactionToBase64String } from "@hashgraph/hedera-wallet-connect";
import { AccountAllowanceApproveTransaction, Client, Hbar, LedgerId, TransactionId } from "@hiero-ledger/sdk";

const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string;

const connector = new DAppConnector(
  { name: "Dani.ai", description: "GPU time for AI agents", url: location.origin, icons: [`${location.origin}/favicon.ico`] },
  LedgerId.TESTNET,
  projectId,
  Object.values(HederaJsonRpcMethod),
  [HederaSessionEvent.ChainChanged, HederaSessionEvent.AccountsChanged],
  [HederaChainId.Testnet],
);
let ready: Promise<void> | null = null;
const init = () => (ready ??= connector.init({ logger: "error" }));

/** The connected account, if a wallet session survives from earlier. */
export async function restored(): Promise<string | null> {
  await init();
  return connector.signers[0]?.getAccountId().toString() ?? null;
}

/** Open the WalletConnect modal (QR code or the HashPack extension) and return the account. */
export async function connect(): Promise<string> {
  await init();
  await connector.openModal();
  const signer = connector.signers[0];
  if (!signer) throw new Error("the wallet didn't share an account");
  return signer.getAccountId().toString();
}

export async function disconnect() {
  await init();
  await connector.disconnectAll().catch(() => {});
}

/** Sign a plain message; returns the base64 SignatureMap the host verifies. */
export async function signMessage(account: string, message: string): Promise<string> {
  const res = await connector.signMessage({ signerAccountId: `hedera:testnet:${account}`, message });
  return (res as any).result?.signatureMap ?? (res as any).signatureMap;
}

/** Let `agent` spend up to `hbar` from the user's account. Setting it again replaces the old amount. */
export async function approveBudget(account: string, agent: string, hbar: number) {
  await init();
  if (!connector.signers.some((s) => s.getAccountId().toString() === account)) throw new Error("Your wallet session ended. Disconnect and connect HashPack again.");
  // The wallet signer only sets a transaction id, never the nodes, so freeze it fully here: the
  // testnet client supplies the node list (no network call), then HashPack signs and submits it.
  const tx = new AccountAllowanceApproveTransaction()
    .approveHbarAllowance(account, agent, new Hbar(hbar))
    .setTransactionId(TransactionId.generate(account))
    .freezeWith(Client.forTestnet());
  const res: any = await connector.signAndExecuteTransaction({ signerAccountId: `hedera:testnet:${account}`, transactionList: transactionToBase64String(tx as any) });
  return String(res?.result?.transactionId ?? res?.transactionId ?? "");
}
