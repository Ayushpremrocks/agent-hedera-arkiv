import { Client, PublicKey, TopicMessageSubmitTransaction } from "@hiero-ledger/sdk";
import { MIRROR, accountKey, parseKey } from "./hedera.js";

export type HcsEvent =
  | { type: "booked"; serial: number; start: number; owner: string; jobHash: string; price: string }
  | { type: "dispatch"; serial: number; start: number; owner: string; jobHash: string | null }
  | { type: "done"; serial: number; owner: string; jobHash: string; ok: boolean; result: string; resultHash: string | null; tokens: number; ms: number }
  | { type: "trade"; sellerSerial: number; buyerSerial: number; seller: string; buyer: string; price: string; swapTx: string }
  | { type: "refund"; buyer: string; amount: string; paymentTx: string; refundTx: string; reason: string }
  // A queued job dropped unrun, long past its deadline (e.g. its slot passed while the provider was down).
  | { type: "expired"; owner: string; jobHash: string; deadline: number }
  // Posted by the job's owner once it has fetched and checked the result.
  | { type: "delivered"; jobHash: string; serial: number; label: string; deadline: number; finishedAt: number; met: boolean };

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

/** One verified log entry. `ts` is consensus time (unix seconds), which the sender can't fake. */
export type LoggedEvent = { seq: number; ts: number; by: string; e: HcsEvent & { at: number } };

const keys = new Map<string, Promise<PublicKey>>();
function keyOf(id: string) {
  if (!keys.has(id)) {
    const p = accountKey(id).then((k) => PublicKey.fromStringECDSA(k));
    p.catch(() => keys.delete(id));
    keys.set(id, p);
  }
  return keys.get(id)!;
}

/**
 * Messages after `afterSeq`, oldest first. The topic has no submit key, so anyone can post:
 * anything unreadable, or not signed by the account it names, is dropped here.
 */
export async function readEvents(topicId: string, afterSeq = 0, limit = 100): Promise<LoggedEvent[]> {
  const res = await fetch(`${MIRROR}/topics/${topicId}/messages?sequencenumber=gte:${afterSeq + 1}&limit=${limit}&order=asc`);
  if (!res.ok) throw new Error(`Mirror topic read: ${res.status}`);
  const out: LoggedEvent[] = [];
  for (const m of ((await res.json()) as any).messages) {
    try {
      const env = JSON.parse(Buffer.from(m.message, "base64").toString());
      if (!/^0\.0\.\d+$/.test(env.by) || typeof env.body !== "string") continue;
      const ok = (await keyOf(env.by)).verify(new TextEncoder().encode(env.body), Buffer.from(String(env.sig), "hex"));
      if (ok) out.push({ seq: Number(m.sequence_number), ts: Math.floor(Number(m.consensus_timestamp)), by: env.by, e: JSON.parse(env.body) });
    } catch {}
  }
  return out;
}
