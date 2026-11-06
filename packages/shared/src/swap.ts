import { type Client, Hbar, Transaction, TransferTransaction } from "@hiero-ledger/sdk";

/** Seller refuses to trade a slot (either side) that starts within this many seconds. */
export const CUTOFF_SECONDS = 15;
/** How long a buyer-signed swap stays submittable: short, so the seller holds no long free option. */
export const SWAP_VALID_SECONDS = 30;

/** One trade: seller's slot goes to the buyer, buyer's slot and `price` tinybars go to the seller. */
export type SwapTerms = {
  tokenId: string;
  seller: string;
  sellerSerial: number;
  buyer: string;
  buyerSerial: number;
  price: bigint;
};

/** Buyer side: the whole trade as one transaction, so it settles completely or not at all. */
export function buildSwap(buyerClient: Client, t: SwapTerms) {
  return new TransferTransaction()
    .addNftTransfer(t.tokenId, t.sellerSerial, t.seller, t.buyer)
    .addNftTransfer(t.tokenId, t.buyerSerial, t.buyer, t.seller)
    .addHbarTransfer(t.buyer, Hbar.fromTinybars((-t.price).toString()))
    .addHbarTransfer(t.seller, Hbar.fromTinybars(t.price.toString()))
    .setTransactionValidDuration(SWAP_VALID_SECONDS)
    .freezeWith(buyerClient);
}

/**
 * Seller side: accept the bytes only if they are exactly the agreed trade. Anything extra (another
 * debit from the seller, an allowance-based transfer, a fungible token move) is rejected, because
 * the seller's signature would authorise all of it.
 */
export function checkSwap(bytes: Uint8Array, t: SwapTerms): TransferTransaction {
  const tx = Transaction.fromBytes(bytes);
  if (!(tx instanceof TransferTransaction)) throw new Error("not a transfer transaction");
  if (tx.transactionId?.accountId?.toString() !== t.buyer) throw new Error("buyer must pay the fee");
  if (tx.tokenTransfers.size) throw new Error("unexpected fungible token transfer");

  const nfts = [...tx.nftTransfers];
  if (nfts.length !== 1 || nfts[0][0].toString() !== t.tokenId) throw new Error("must move only slot NFTs");
  const moves = nfts[0][1].map((m) => `${m.serial}:${m.sender}>${m.recipient}:${m.isApproved}`).sort();
  const want = [`${t.sellerSerial}:${t.seller}>${t.buyer}:false`, `${t.buyerSerial}:${t.buyer}>${t.seller}:false`].sort();
  if (moves.join() !== want.join()) throw new Error(`NFT moves ${moves} != ${want}`);

  const hbar = tx.hbarTransfersList.map((h) => `${h.accountId}:${h.amount.toTinybars()}:${h.isApproved}`).sort();
  const wantHbar = [`${t.buyer}:${-t.price}:false`, `${t.seller}:${t.price}:false`].sort();
  if (hbar.join() !== wantHbar.join()) throw new Error(`HBAR moves ${hbar} != ${wantHbar}`);
  return tx;
}
