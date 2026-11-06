import { Client, TopicMessageSubmitTransaction } from "@hiero-ledger/sdk";
import { parseKey } from "./hedera.js";

export type HcsEvent =
  | { type: "booked"; serial: number; start: number; owner: string; jobHash: string }
  | { type: "bound"; account: string; jobHash: string }
  | { type: "dispatch"; serial: number; start: number; owner: string; jobHash: string | null }
  | { type: "done"; serial: number; owner: string; jobHash: string; ok: boolean; result: string; ms: number }
  | { type: "trade"; sellerSerial: number; buyerSerial: number; seller: string; buyer: string; price: string; swapTx: string }
  | { type: "refund"; buyer: string; amount: string; paymentTx: string; refundTx: string; reason: string };

/**
 * Post an event signed by the sender: the envelope carries the exact body string, the sender's
 * account and its signature, so any reader can verify against the sender's Mirror Node key.
 */
export async function postEvent(client: Client, topicId: string, by: string, key: string, event: HcsEvent) {
  const body = JSON.stringify({ ...event, at: Math.floor(Date.now() / 1000) });
  const sig = Buffer.from(parseKey(key).sign(new TextEncoder().encode(body))).toString("hex");
  const receipt = await (
    await new TopicMessageSubmitTransaction()
      .setTopicId(topicId)
      .setMessage(JSON.stringify({ body, by, sig }))
      .execute(client)
  ).getReceipt(client);
  return receipt.topicSequenceNumber!.toString();
}
