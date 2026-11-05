import {
  type Client,
  TokenCreateTransaction,
  TokenMintTransaction,
  TokenSupplyType,
  TokenType,
  TopicCreateTransaction,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import { type SlotMeta, encodeSlot, parseKey } from "@qy/shared";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DATA_DIR } from "./store.js";

export type Infra = { tokenId: string; topicId: string };
type Role = { id: string; key: string };

/** Load the slot token + HCS topic ids, creating them on first run. */
export async function ensureInfra(client: Client, provider: Role, treasury: Role): Promise<Infra> {
  const file = `${DATA_DIR}/infra.json`;
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));

  // Provider key may only mint (supply key); unissued slots sit with the separate treasury.
  const tokenTx = await new TokenCreateTransaction()
    .setTokenName("QueueYield Slot")
    .setTokenSymbol("QYSLOT")
    .setTokenType(TokenType.NonFungibleUnique)
    .setSupplyType(TokenSupplyType.Infinite)
    .setTreasuryAccountId(treasury.id)
    .setSupplyKey(parseKey(provider.key).publicKey)
    .freezeWith(client)
    .sign(parseKey(treasury.key));
  const tokenId = (await (await tokenTx.execute(client)).getReceipt(client)).tokenId!.toString();

  // No submit key: sellers post trades here too. Every message is signed by its sender instead.
  const topicId = (
    await (await new TopicCreateTransaction().setTopicMemo("QueueYield log").execute(client)).getReceipt(client)
  ).topicId!.toString();

  const infra = { tokenId, topicId };
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(infra, null, 2));
  return infra;
}

/** Mint one slot NFT and hand it from the treasury to `owner`. Returns the serial. */
export async function issueSlot(client: Client, tokenId: string, treasury: Role, owner: string, meta: SlotMeta) {
  const mint = await (
    await new TokenMintTransaction().setTokenId(tokenId).setMetadata([encodeSlot(meta)]).execute(client)
  ).getReceipt(client);
  const serial = mint.serials[0].toNumber();

  const transfer = await new TransferTransaction()
    .addNftTransfer(tokenId, serial, treasury.id, owner)
    .freezeWith(client)
    .sign(parseKey(treasury.key));
  const tx = await transfer.execute(client);
  await tx.getReceipt(client);
  return { serial, transferTx: tx.transactionId.toString() };
}
