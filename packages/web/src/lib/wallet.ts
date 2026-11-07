// HashPack (or any Hedera wallet) through Reown AppKit with Hedera's native adapter: connect, sign the
// host's sign-in message, and approve the agent's budget as an HBAR allowance. Keys never leave the wallet.
import "./polyfill";
import { HederaAdapter, HederaChainDefinition, HederaProvider, hederaNamespace, transactionToBase64String } from "@hashgraph/hedera-wallet-connect";
import { AccountAllowanceApproveTransaction, Client, Hbar, TransactionId } from "@hiero-ledger/sdk";
import { createAppKit } from "@reown/appkit";

const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string;
// Reown's Verify checks this url against the domains allowlisted for the project, so it must be the page's own origin.
const metadata = { name: "Dani.ai", description: "GPU time for AI agents", url: location.origin, icons: [`${location.origin}/favicon.svg`] };
const testnet = HederaChainDefinition.Native.Testnet;

let kit: Promise<{ appKit: ReturnType<typeof createAppKit>; provider: HederaProvider }> | null = null;
const init = () =>
  (kit ??= (async () => {
    const provider = await HederaProvider.init({ projectId, metadata });
    const appKit = createAppKit({
      adapters: [new HederaAdapter({ projectId, networks: [testnet], namespace: hederaNamespace })],
      universalProvider: provider as any, // Hedera's provider extends WalletConnect's UniversalProvider
      projectId,
      metadata,
      networks: [testnet],
      defaultNetwork: testnet,
      themeMode: "dark",
      themeVariables: { "--w3m-accent": "#ffb000" },
      features: { analytics: false, email: false, socials: false, swaps: false, onramp: false },
    });
    return { appKit, provider };
  })());

/** "hedera:testnet:0.0.123" or "0.0.123" -> "0.0.123" */
const accountOf = (address?: string) => address?.split(":").pop() || null;

/** Open the AppKit modal (QR code or the HashPack extension) and return the account once connected. */
export async function connect(): Promise<string> {
  const { appKit } = await init();
  const already = accountOf(appKit.getAddress());
  if (already) return already;
  return new Promise<string>((resolve, reject) => {
    let opened = false;
    let settled = false; // subscribeAccount has no unsubscribe, so later events are ignored instead
    appKit.subscribeAccount((a) => {
      const id = accountOf(a.address);
      if (a.isConnected && id) done(() => resolve(id));
    });
    const stopState = appKit.subscribeState((s) => {
      if (s.open) opened = true;
      else if (opened) done(() => reject(new Error("the wallet connection was closed")));
    });
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      stopState();
      fn();
    };
    appKit.open().catch((e: Error) => done(() => reject(e)));
  });
}

export async function disconnect() {
  const { appKit } = await init();
  await appKit.disconnect().catch(() => {});
}

/** Sign a plain message; returns the base64 SignatureMap the host verifies. */
export async function signMessage(account: string, message: string): Promise<string> {
  const { provider } = await init();
  return (await provider.hedera_signMessage({ signerAccountId: `hedera:testnet:${account}`, message })).signatureMap;
}

/** Let `agent` spend up to `hbar` from the user's account. Setting it again replaces the old amount. */
export async function approveBudget(account: string, agent: string, hbar: number) {
  const { provider } = await init();
  if (!provider.getAccountAddresses().some((a) => accountOf(a) === account)) throw new Error("Your wallet session ended. Disconnect and connect HashPack again.");
  // The wallet only sets a transaction id, never the nodes, so freeze it fully here: the testnet client
  // supplies the node list (no network call), then HashPack signs and submits it.
  const tx = new AccountAllowanceApproveTransaction()
    .approveHbarAllowance(account, agent, new Hbar(hbar))
    .setTransactionId(TransactionId.generate(account))
    .freezeWith(Client.forTestnet());
  const res: any = await provider.hedera_signAndExecuteTransaction({ signerAccountId: `hedera:testnet:${account}`, transactionList: transactionToBase64String(tx as any) });
  return String(res?.transactionId ?? "");
}
