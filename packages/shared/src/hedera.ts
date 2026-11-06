import { AccountId, Client, NftId, PrivateKey, TokenId, TokenNftInfoQuery } from "@hiero-ledger/sdk";

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

type MirrorAccount = { evm_address: string; key: { _type: string; key: string } | null };

/** An account's ECDSA public key (hex) from the Mirror Node. */
export async function accountKey(id: string): Promise<string> {
  const a = await mirror<MirrorAccount>(`/accounts/${id}`);
  if (a.key?._type !== "ECDSA_SECP256K1") throw new Error(`${id} has no ECDSA key`);
  return a.key.key;
}

/** The EVM address an account signs Arkiv entities with (lowercase 0x hex). */
export async function accountEvm(id: string): Promise<string> {
  return (await mirror<MirrorAccount>(`/accounts/${id}`)).evm_address.toLowerCase();
}

/** Slot NFT metadata: start time and job hash. Must stay under Hedera's 100-byte limit. */
export type SlotMeta = { s: number; h: string };
export const encodeSlot = (m: SlotMeta) => Buffer.from(JSON.stringify(m));
export const decodeSlot = (b64: string): SlotMeta => JSON.parse(Buffer.from(b64, "base64").toString());

/** Owner and metadata of a slot straight from consensus (no Mirror lag). Costs a tiny query fee. */
export async function slotInfo(client: Client, tokenId: string, serial: number) {
  const [nft] = await new TokenNftInfoQuery().setNftId(new NftId(TokenId.fromString(tokenId), serial)).execute(client);
  return { owner: nft.accountId.toString(), meta: JSON.parse(Buffer.from(nft.metadata ?? []).toString()) as SlotMeta };
}

export type MirrorNft = { serial_number: number; account_id: string; metadata: string; deleted: boolean };

/** Every NFT of a token, following Mirror Node pagination. */
export async function tokenNfts(tokenId: string): Promise<MirrorNft[]> {
  const out: MirrorNft[] = [];
  let next: string | null = `/tokens/${tokenId}/nfts?limit=100&order=asc`;
  while (next) {
    const page: { nfts: MirrorNft[]; links: { next: string | null } } = await mirror(next.replace("/api/v1", ""));
    out.push(...page.nfts);
    next = page.links.next;
  }
  return out;
}

/** Serials of `tokenId` currently held by `account`. */
export async function ownedSerials(account: string, tokenId: string): Promise<number[]> {
  const page = await mirror<{ nfts: MirrorNft[] }>(`/accounts/${account}/nfts?token.id=${tokenId}&limit=100`);
  return page.nfts.map((n) => n.serial_number);
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
