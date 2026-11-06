import { Client, PublicKey, TopicMessageSubmitTransaction } from "@hiero-ledger/sdk";
import { MIRROR, accountKey, parseKey } from "./hedera.js";

/** What happens to a queue ticket, as the provider and agents sign it onto the provider's topic. */
export type HcsEvent =
  | { type: "booked"; ticket: number; owner: string; jobHash: string; price: string }
  | { type: "dispatch"; ticket: number; owner: string; jobHash: string | null }
  | { type: "done"; ticket: number; owner: string; jobHash: string; ok: boolean; result: string; resultHash: string | null; tokens: number; ms: number }
  // A ticket turned into an NFT so it can be traded (minted only on demand).
  | { type: "tokenized"; ticket: number; serial: number; owner: string }
  | { type: "trade"; sellerTicket: number; buyerTicket: number; seller: string; buyer: string; price: string; swapTx: string }
  | { type: "refund"; buyer: string; amount: string; paymentTx: string; refundTx: string; reason: string }
  // A queued job dropped unrun, long past its deadline (e.g. the provider was down for it).
  | { type: "expired"; owner: string; jobHash: string; deadline: number }
  // Posted by the job's owner once it has fetched and checked the result.
  | { type: "delivered"; jobHash: string; ticket: number; label: string; deadline: number; finishedAt: number; met: boolean };

/** Several events in one signed message: one HCS fee instead of one per event. */
type Batch = { type: "batch"; events: HcsEvent[] };

/**
 * Post an event signed by the sender: the envelope carries the exact body string, the sender's
 * account and its signature, so any reader can verify against the sender's Mirror Node key.
 */
export async function postEvent(client: Client, topicId: string, by: string, key: string, event: HcsEvent | Batch) {
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

// One HCS chunk is 1024 bytes and every extra chunk is another fee. The envelope adds the account,
// a 128-hex signature and JSON escaping, so batch bodies stay under this.
const MAX_BATCH_BODY = 720;

/**
 * Collects events and posts them as signed batches: when the next event wouldn't fit in one chunk,
 * or every `everyMs`. Logging never blocks or breaks the caller; failures are only printed.
 */
export class EventBatcher {
  private pending: HcsEvent[] = [];
  private size = 0;
  constructor(
    private client: Client,
    private topicId: string,
    private by: string,
    private key: string,
    everyMs = 4000,
  ) {
    setInterval(() => this.flush(), everyMs).unref();
  }

  add(event: HcsEvent) {
    const bytes = JSON.stringify(event).length + 1;
    if (this.size + bytes > MAX_BATCH_BODY) this.flush();
    this.pending.push(event);
    this.size += bytes;
  }

  flush() {
    if (!this.pending.length) return;
    const events = this.pending;
    this.pending = [];
    this.size = 0;
    postEvent(this.client, this.topicId, this.by, this.key, events.length === 1 ? events[0] : { type: "batch", events }).catch((e) =>
      console.error(`HCS post of ${events.length} event(s) failed:`, e.message),
    );
  }
}

/** One verified log entry. `ts` is consensus time (unix seconds), which the sender can't fake. */
export type LoggedEvent = { seq: number; i: number; ts: number; by: string; e: HcsEvent & { at: number } };

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
 * Messages after `afterSeq`, oldest first, with batches unpacked (`i` is the event's place in its
 * message). The topic has no submit key, so anyone can post: anything unreadable, or not signed by
 * the account it names, is dropped here.
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
      if (!ok) continue;
      const body = JSON.parse(env.body);
      const events: HcsEvent[] = body.type === "batch" && Array.isArray(body.events) ? body.events : [body];
      const seq = Number(m.sequence_number);
      const ts = Math.floor(Number(m.consensus_timestamp));
      events.forEach((e, i) => out.push({ seq, i, ts, by: env.by, e: { ...e, at: body.at } }));
    } catch {}
  }
  return out;
}
