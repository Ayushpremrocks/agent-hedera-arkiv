// The market as every agent in this process sees it: live providers from Arkiv, and each provider's
// signed HCS log, read once and handed to every agent. Many agents share one hub, so a process with
// hundreds of agents still makes one Arkiv query and one Mirror read per topic per tick.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type LoggedEvent, MIRROR, accountEvm, arkivReader, findProviders, readEvents } from "@qy/shared";

export type Provider = { id: string; name: string; tokenId: string; topicId: string; bookingUrl: string; slot: number; model: string; price: string; nextFree: number };
type Listener = (provider: string, ev: LoggedEvent) => void;
const isAccount = (s: unknown): s is string => typeof s === "string" && /^0\.0\.\d+$/.test(s);

export class Hub {
  readonly reader = arkivReader();
  /** Providers with a live, genuine offer on Arkiv right now. */
  live = new Map<string, Provider>();
  /** Recent verified log events across all providers, oldest first. */
  history: LoggedEvent[] = [];
  private seen: Record<string, Provider> = {}; // every provider ever used, so in-flight work survives an offer lapsing
  private lastSeq: Record<string, number> = {}; // topic -> last sequence handed to listeners
  private listeners = new Set<Listener>();
  private evm = new Map<string, Promise<string>>();

  /** `stateFile` keeps read positions, so a restart replays what was missed instead of skipping it. */
  constructor(private stateFile: string, private model?: string) {
    if (existsSync(stateFile)) Object.assign(this, JSON.parse(readFileSync(stateFile, "utf8")));
  }

  evmOf(id: string) {
    if (!this.evm.has(id)) this.evm.set(id, accountEvm(id).catch(() => (this.evm.delete(id), "")));
    return this.evm.get(id)!;
  }

  known(id: string): Provider | undefined {
    return this.live.get(id) ?? this.seen[id];
  }

  /** Make sure a provider's log keeps being read even if its offer has lapsed. */
  track(p: Provider) {
    this.seen[p.id] ??= p;
  }

  on(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async refreshProviders() {
    const next = new Map<string, Provider>();
    for (const r of (await findProviders(this.reader, this.model)).entities) {
      const id = r.provider.value;
      if (!isAccount(id) || r.$owner.toLowerCase() !== (await this.evmOf(id))) continue; // someone posing as a provider
      next.set(id, {
        id,
        name: r.name.value,
        tokenId: r.token_id.value,
        topicId: r.topic_id.value,
        bookingUrl: r.booking_url.value,
        slot: Number(r.run_seconds.value), // typical run time: how long one queued ticket takes
        model: r.model.value,
        price: r.price_now.value.toString(),
        nextFree: Number(r.next_free.value),
      });
    }
    this.live = next;
    for (const p of next.values()) this.seen[p.id] = p;
  }

  /** Read every tracked provider's topic once and hand new events to all listeners. */
  async poll() {
    for (const p of Object.values(this.seen)) {
      if (this.lastSeq[p.topicId] === undefined) {
        // First look at this provider: recent history is context, only what comes next is acted on.
        const latest = Number(((await (await fetch(`${MIRROR}/topics/${p.topicId}/messages?order=desc&limit=1`)).json()) as any).messages[0]?.sequence_number ?? 0);
        this.history.push(...(await readEvents(p.topicId, Math.max(0, latest - 50))));
        this.lastSeq[p.topicId] = latest;
        continue;
      }
      for (const ev of await readEvents(p.topicId, this.lastSeq[p.topicId])) {
        this.history.push(ev);
        this.lastSeq[p.topicId] = ev.seq;
        for (const fn of this.listeners) fn(p.id, ev);
      }
    }
    this.history = this.history.sort((a, b) => a.ts - b.ts).slice(-300);
    this.save();
  }

  private save() {
    mkdirSync(dirname(this.stateFile), { recursive: true });
    writeFileSync(this.stateFile, JSON.stringify({ seen: this.seen, lastSeq: this.lastSeq }));
  }

  /** Keep the view fresh: providers every 30s, logs every 5s. Returns a stop function. */
  start(onError: (e: Error) => void = () => {}) {
    let stopped = false;
    const loop = async (fn: () => Promise<void>, ms: number) => {
      while (!stopped) {
        await fn().catch(onError);
        await new Promise((r) => setTimeout(r, ms));
      }
    };
    loop(() => this.refreshProviders(), 30_000);
    loop(() => this.poll(), 5_000);
    return () => (stopped = true);
  }
}
