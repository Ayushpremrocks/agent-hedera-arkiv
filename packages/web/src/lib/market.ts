// Public market data, read straight from the sources: providers (host API, which reads Arkiv),
// each provider's signed HCS log (Mirror Node, signatures checked here), offers and trades (Arkiv).
import { asc } from "@arkiv-network/sdk/query";
import { SlotOffer, Trade, arkivReader } from "@qy/shared/arkiv";
import { keccak256, recoverAddress, toBytes } from "viem";

const MIRROR = "https://testnet.mirrornode.hedera.com/api/v1";
const reader = arkivReader(import.meta.env.VITE_ARKIV_ACCESS_KEY ?? "");

export type Provider = { id: string; name: string; tokenId: string; topicId: string; bookingUrl: string; slot: number; model: string; price: string; nextFree: number; tps: number; startupMs: number; maxTokens: number };
export type LogEvent = { seq: number; ts: number; by: string; provider: string; verified: boolean; e: any };
export type Offer = { key: string; provider: string; serial: number; start: number; maxTokens: number; latestOk: number; price: bigint; seller: string; byOwner: boolean };
export type TradeRow = { key: string; provider: string; sellerTicket: number; buyerTicket: number; price: bigint; swapTx: string };
// startBy: promised latest start; limit: hard run limit (seconds); notBefore: a reservation's start, or a trade lock.
export type QueueEntry = { ticket: number; status: "queued" | "running"; startBy: number; startedAt: number | null; limit: number; maxTokens: number; notBefore: number; serial: number | null };

const isAccount = (s: unknown): s is string => typeof s === "string" && /^0\.0\.\d+$/.test(s);
async function mirror<T = any>(path: string): Promise<T> {
  const res = await fetch(`${MIRROR}${path}`);
  if (!res.ok) throw new Error(`Mirror Node ${path} answered ${res.status}`);
  return res.json();
}

const evmCache = new Map<string, Promise<string>>();
export function evmOf(id: string) {
  if (!evmCache.has(id)) {
    const p = mirror(`/accounts/${id}`).then((a) => String(a.evm_address).toLowerCase());
    p.catch(() => evmCache.delete(id));
    evmCache.set(id, p);
  }
  return evmCache.get(id)!;
}

/** A message counts as signed by `by` only if the signature recovers to that account's EVM address. */
async function verify(body: string, by: string, sig: string) {
  if (!/^[0-9a-f]{128}$/i.test(sig)) return false;
  const hash = keccak256(toBytes(body));
  const want = await evmOf(by);
  for (const v of ["1b", "1c"]) {
    try {
      if ((await recoverAddress({ hash, signature: `0x${sig}${v}` })).toLowerCase() === want) return true;
    } catch {}
  }
  return false;
}

const parsed = new Map<string, LogEvent[]>();
/** The latest events on each provider's topic, newest first, with signatures checked and batches unpacked. */
export async function fetchLog(providers: Provider[]): Promise<LogEvent[]> {
  const all = await Promise.all(
    providers.map(async (p) => {
      const msgs = (await mirror(`/topics/${p.topicId}/messages?limit=60&order=desc`)).messages as any[];
      return Promise.all(
        msgs.map(async (m) => {
          const id = `${p.topicId}/${m.sequence_number}`;
          if (!parsed.has(id)) {
            try {
              const env = JSON.parse(atob(m.message));
              if (!isAccount(env.by) || typeof env.body !== "string") throw new Error("not an envelope");
              const body = JSON.parse(env.body);
              const verified = await verify(env.body, env.by, String(env.sig));
              const events: any[] = body.type === "batch" && Array.isArray(body.events) ? body.events : [body];
              // Events in one batch share a timestamp; a tiny offset keeps their order when sorted.
              const ts = Number(m.consensus_timestamp);
              parsed.set(id, events.map((e, i) => ({ seq: Number(m.sequence_number), ts: ts + i * 1e-6, by: env.by, provider: p.id, verified, e })));
            } catch {
              parsed.set(id, []); // anyone can post to a topic; unreadable messages are skipped
            }
          }
          return parsed.get(id)!;
        }),
      );
    }),
  );
  return all.flat(2).sort((a, b) => b.ts - a.ts);
}

/** Each provider's queue as it stands: waiting and running tickets with estimated starts. */
export async function fetchQueues(providers: Provider[]): Promise<Record<string, QueueEntry[]>> {
  const out: Record<string, QueueEntry[]> = {};
  await Promise.all(
    providers.map(async (p) => {
      const res = await fetch(`${p.bookingUrl}/queue`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
      out[p.id] = res?.ok ? ((await res.json()).tickets as QueueEntry[]) : [];
    }),
  );
  return out;
}

export async function fetchOffers(): Promise<Offer[]> {
  const { entities } = await reader.select().from(SlotOffer).orderBy(asc("start_by")).limit(100).fetch();
  return Promise.all(
    entities.map(async (r) => {
      const seller = r.seller.value;
      return {
        key: r.$key,
        provider: r.provider.value,
        serial: Number(r.ticket.value),
        start: Number(r.start_by.value),
        maxTokens: Number(r.max_tokens.value),
        latestOk: Number(r.latest_ok_start.value),
        price: r.min_price.value,
        seller,
        byOwner: isAccount(seller) && r.$owner.toLowerCase() === (await evmOf(seller).catch(() => "")),
      };
    }),
  );
}

export async function fetchTrades(): Promise<TradeRow[]> {
  const { entities } = await reader.select().from(Trade).limit(50).fetch();
  return entities.map((r) => ({
    key: r.$key,
    provider: r.provider.value,
    sellerTicket: Number(r.seller_ticket.value),
    buyerTicket: Number(r.buyer_ticket.value),
    price: r.price.value,
    swapTx: r.swap_tx.value,
  }));
}
