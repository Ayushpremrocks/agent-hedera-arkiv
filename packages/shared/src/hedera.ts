import { AccountId, Client, PrivateKey } from "@hiero-ledger/sdk";

export const MIRROR = "https://testnet.mirrornode.hedera.com/api/v1";
export const hashscan = (kind: "transaction" | "token" | "topic" | "account", id: string) =>
  `https://hashscan.io/testnet/${kind}/${id}`;

/** Accepts DER (what our setup script writes) or raw 0x/hex ECDSA (what the portal shows). */
export function parseKey(key: string): PrivateKey {
  // A raw 64-hex key can itself start with "30", so tell DER apart by length too.
  const der = key.startsWith("30") && key.length > 64;
  return der ? PrivateKey.fromStringDer(key) : PrivateKey.fromStringECDSA(key);
}

export function hederaClient(id: string, key: string): Client {
  return Client.forTestnet().setOperator(AccountId.fromString(id), parseKey(key));
}

/** The same secp256k1 key signs on Arkiv, so each process has exactly one key. */
export function evmKey(key: string): `0x${string}` {
  return `0x${parseKey(key).toStringRaw()}`;
}

async function mirror<T>(path: string): Promise<T> {
  const res = await fetch(`${MIRROR}${path}`);
  if (!res.ok) throw new Error(`Mirror ${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

/** Current owner of an NFT according to the Mirror Node (lags consensus by a few seconds). */
export async function nftOwner(tokenId: string, serial: number): Promise<string> {
  const nft = await mirror<{ account_id: string }>(`/tokens/${tokenId}/nfts/${serial}`);
  return nft.account_id;
}

/** Poll until the Mirror Node reflects `expected` as owner, or throw. */
export async function waitForOwner(tokenId: string, serial: number, expected: string, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if ((await nftOwner(tokenId, serial).catch(() => "")) === expected) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Mirror never showed ${tokenId}#${serial} owned by ${expected}`);
}
