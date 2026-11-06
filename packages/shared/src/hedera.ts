import { AccountId, Client, NftId, PrivateKey, TokenId, TokenNftInfoQuery, TransferTransaction } from "@hiero-ledger/sdk";

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

/** Ticket NFT metadata: which queue ticket it is. Minted only when a ticket is traded. */
export type SlotMeta = { t: number };
export const encodeSlot = (m: SlotMeta) => Buffer.from(JSON.stringify(m));
export const decodeSlot = (b64: string): SlotMeta => JSON.parse(Buffer.from(b64, "base64").toString());

/**
 * Owner and metadata of a slot straight from consensus (no Mirror lag). Costs a tiny query fee.
 * Bounded: the SDK's default retries can stall for minutes when a node misbehaves (seen on testnet),
 * and callers run on a schedule, so give up after `timeoutMs` and let them fall back.
 */
export async function slotInfo(client: Client, tokenId: string, serial: number, timeoutMs = 8000) {
  const query = new TokenNftInfoQuery().setNftId(new NftId(TokenId.fromString(tokenId), serial)).setMaxAttempts(3).setGrpcDeadline(3000);
  let timer: NodeJS.Timeout | undefined;
  const [nft] = await Promise.race([
    query.execute(client, timeoutMs),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`consensus lookup of #${serial} timed out`)), timeoutMs + 1000);
    }),
  ]).finally(() => clearTimeout(timer));
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

/**
 * Hand a ticket NFT back to its token's treasury once the ticket has started: the provider then
 * reissues it for the next trade (a metadata rewrite, about $0.001) instead of minting a new one.
 */
export async function returnTicket(client: Client, tokenId: string, serial: number, from: string) {
  const { treasury_account_id: treasury } = await mirror<{ treasury_account_id: string }>(`/tokens/${tokenId}`);
  const tx = await new TransferTransaction().addNftTransfer(tokenId, serial, from, treasury).execute(client);
  await tx.getReceipt(client);
}
