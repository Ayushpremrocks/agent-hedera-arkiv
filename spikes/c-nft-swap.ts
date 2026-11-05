// Spike (c): provider mints two slot NFTs (A gets #1, B gets #2), then A and B swap them in one
// TransferTransaction that A freezes and signs, and B co-signs and submits.
import {
  TokenCreateTransaction,
  TokenMintTransaction,
  TokenSupplyType,
  TokenType,
  Transaction,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import { hashscan, hederaClient, nftOwner, parseKey, role, waitForOwner } from "@qy/shared";

const P = role("PROVIDER");
const T = role("TREASURY");
const A = role("AGENT_A");
const B = role("AGENT_B");
const provider = hederaClient(P.id, P.key);

// Token: treasury holds unissued slots, provider key only mints.
const create = await new TokenCreateTransaction()
  .setTokenName("QueueYield Slot (spike)")
  .setTokenSymbol("QYS")
  .setTokenType(TokenType.NonFungibleUnique)
  .setSupplyType(TokenSupplyType.Infinite)
  .setTreasuryAccountId(T.id)
  .setSupplyKey(parseKey(P.key).publicKey)
  .freezeWith(provider)
  .sign(parseKey(T.key));
const tokenId = (await (await create.execute(provider)).getReceipt(provider)).tokenId!.toString();
console.log("token", tokenId, hashscan("token", tokenId));

const now = Math.floor(Date.now() / 1000);
const meta = (start: number) => Buffer.from(JSON.stringify({ s: start, h: "ab12" }));
const mint = await (
  await new TokenMintTransaction().setTokenId(tokenId).setMetadata([meta(now + 600), meta(now + 60)]).execute(provider)
).getReceipt(provider);
const [sA, sB] = mint.serials.map(Number);
console.log("minted serials", sA, sB);

const issue = await new TransferTransaction()
  .addNftTransfer(tokenId, sA, T.id, A.id)
  .addNftTransfer(tokenId, sB, T.id, B.id)
  .freezeWith(provider)
  .sign(parseKey(T.key));
await (await issue.execute(provider)).getReceipt(provider);
await waitForOwner(tokenId, sB, B.id);
console.log("issued:", sA, "->", await nftOwner(tokenId, sA), ",", sB, "->", await nftOwner(tokenId, sB));

// --- A side: build, freeze, sign, ship bytes ---
const clientA = hederaClient(A.id, A.key);
const swap = new TransferTransaction()
  .addNftTransfer(tokenId, sA, A.id, B.id)
  .addNftTransfer(tokenId, sB, B.id, A.id)
  .setTransactionValidDuration(180)
  .freezeWith(clientA);
await swap.signWithOperator(clientA);
const wire = Buffer.from(swap.toBytes()).toString("base64");
console.log("A signed swap, bytes:", wire.length);

// --- B side: decode, inspect, co-sign, submit ---
const clientB = hederaClient(B.id, B.key);
const got = Transaction.fromBytes(Buffer.from(wire, "base64"));
if (!(got instanceof TransferTransaction)) throw new Error("not a transfer");
const moves = [...got.nftTransfers.get(tokenId)!].map((t) => `${t.serial}:${t.sender}->${t.recipient}`);
console.log("B inspects:", moves);
const receipt = await (await (await got.sign(parseKey(B.key))).execute(clientB)).getReceipt(clientB);
console.log("swap", receipt.status.toString(), hashscan("transaction", got.transactionId!.toString()));

await waitForOwner(tokenId, sB, A.id);
console.log("after:", sA, "->", await nftOwner(tokenId, sA), ",", sB, "->", await nftOwner(tokenId, sB));
for (const c of [provider, clientA, clientB]) c.close();
console.log("spike (c) done");
