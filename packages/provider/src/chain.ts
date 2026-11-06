import {
  type Client,
  Long,
  TokenCreateTransaction,
  TokenMintTransaction,
  TokenSupplyType,
  TokenType,
  TokenUpdateNftsTransaction,
  TopicCreateTransaction,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import { type SlotMeta, encodeSlot, parseKey } from "@qy/shared";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DATA_DIR } from "./store.js";

// reusable: the token has a metadata key, so a returned ticket NFT is rewritten and reissued instead of
// minting a new one (about $0.001 instead of $0.02).
export type Infra = { tokenId: string; topicId: string; reusable?: boolean };
type Role = { id: string; key: string };

/** Load the slot token + HCS topic ids, creating them on first run. */
export async function ensureInfra(client: Client, provider: Role, treasury: Role): Promise<Infra> {
  const file = `${DATA_DIR}/infra.json`;
  const old: Infra | null = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  if (old?.reusable) return old;

  // Provider key may only mint (supply key); unissued slots sit with the separate treasury.
  const tokenTx = await new TokenCreateTransaction()
    .setTokenName("Dani.ai Slot")
    .setTokenSymbol("QYSLOT")
    .setTokenType(TokenType.NonFungibleUnique)
    .setSupplyType(TokenSupplyType.Infinite)
    .setTreasuryAccountId(treasury.id)
    .setSupplyKey(parseKey(provider.key).publicKey)
    .setMetadataKey(parseKey(provider.key).publicKey)
    .freezeWith(client)
    .sign(parseKey(treasury.key));
  const tokenId = (await (await tokenTx.execute(client)).getReceipt(client)).tokenId!.toString();

  // No submit key: sellers post trades here too. Every message is signed by its sender instead.
  // A provider upgrading from a non-reusable token keeps its topic, and so its track record.
  const topicId =
    old?.topicId ?? (await (await new TopicCreateTransaction().setTopicMemo("Dani.ai log").execute(client)).getReceipt(client)).topicId!.toString();

  const infra = { tokenId, topicId, reusable: true };
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(infra, null, 2));
  return infra;
}

/**
 * Hand a ticket NFT from the treasury to `owner`: a returned one (`reuse`) gets its metadata rewritten,
 * otherwise a new one is minted. The client must be the provider's (it holds the supply and metadata key).
 */
export async function issueSlot(client: Client, tokenId: string, treasury: Role, owner: string, meta: SlotMeta, reuse?: number) {
  let serial = reuse;
  if (serial !== undefined) {
    await (await new TokenUpdateNftsTransaction().setTokenId(tokenId).setSerialNumbers([Long.fromNumber(serial)]).setMetadata(encodeSlot(meta)).execute(client)).getReceipt(client);
  } else {
    const mint = await (await new TokenMintTransaction().setTokenId(tokenId).setMetadata([encodeSlot(meta)]).execute(client)).getReceipt(client);
    serial = mint.serials[0].toNumber();
  }

  const transfer = await new TransferTransaction()
    .addNftTransfer(tokenId, serial, treasury.id, owner)
    .freezeWith(client)
    .sign(parseKey(treasury.key));
  const tx = await transfer.execute(client);
  await tx.getReceipt(client);
  return { serial, transferTx: tx.transactionId.toString() };
}
