// What each kind of agent actually works on: real reports about QueueYield's own live market,
// built from the signed HCS log and the offers on Arkiv. Only the model call runs on the provider.
import type { LoggedEvent } from "@qy/shared";

export type Market = {
  me: string;
  names: Record<string, string>;
  events: LoggedEvent[]; // recent verified log, oldest first
  offers: { serial: number; start: number; latestOk: number; price: bigint; seller: string }[];
};
export type Task = { task: string; input: string; label: string; maxTokens: number };

export type Role = {
  /** Seconds between routine jobs; `trigger` can add more on notable events. */
  every: number;
  deadlineIn: number;
  /** Most it will pay for an earlier slot: roughly what missing its deadline costs it. */
  lateCost: bigint;
  /** Least it asks for a slot it can spare. */
  minAsk: bigint;
  make: (m: Market, trigger?: LoggedEvent) => Task;
  /** Events that should start a job right away (urgent roles only). */
  trigger?: (e: LoggedEvent, me: string) => boolean;
};

const hbar = (t: bigint | string | number) => `${+(Number(t) / 1e8).toFixed(4)} HBAR`;
const clock = (t: number) => new Date(t * 1000).toISOString().slice(11, 19);

/** One plain line per log event, for the model's input. */
export function line(ev: LoggedEvent, names: Record<string, string>) {
  const n = (id: unknown) => (typeof id === "string" ? (names[id] ?? id) : "?");
  const e = ev.e;
  const t = clock(ev.ts);
  switch (e.type) {
    case "booked": return `${t} ${n(e.owner)} booked ticket #${e.ticket} for ${hbar(e.price ?? 0)}`;
    case "dispatch": return `${t} ticket #${e.ticket} started ${e.jobHash ? `${n(e.owner)}'s job` : "with no job"}`;
    case "done": return `${t} ticket #${e.ticket} ${e.ok ? `finished ${n(e.owner)}'s job (${e.tokens} tokens, ${(e.ms / 1000).toFixed(1)}s)` : `failed for ${n(e.owner)}: ${e.result}`}`;
    case "trade": return `${t} ${n(e.seller)} gave ticket #${e.sellerTicket} to ${n(e.buyer)} for ${hbar(e.price)}, taking #${e.buyerTicket}`;
    case "expired": return `${t} ${n(e.owner)}'s job expired unrun`;
    case "refund": return `${t} provider refunded ${hbar(e.amount)} to ${n(e.buyer)} (${e.reason})`;
    case "delivered": return `${t} ${n(ev.by)} got "${e.label}" ${e.met ? "on time" : `late by ${e.finishedAt - e.deadline}s`}`;
    default: return "";
  }
}

const history = (m: Market, count: number) => m.events.slice(-count).map((ev) => line(ev, m.names)).join("\n") || "(no activity yet)";
const offerLines = (m: Market) =>
  m.offers.map((o) => `slot #${o.serial} starting ${clock(o.start)}, ${m.names[o.seller] ?? o.seller} asks ${hbar(o.price)}, accepts slots up to ${clock(o.latestOk)}`).join("\n") ||
  "(no slots for sale)";

const CONTEXT = "QueueYield is a market where AI agents book 30-second GPU slots from a provider, and trade them so urgent jobs run first.";

export const ROLES: Record<string, Role> = {
  /** Works only on tasks its user hands it (POST /tasks, or `pnpm task`); prices come with each task. */
  assistant: {
    every: 0,
    deadlineIn: 600,
    lateCost: 20_000_000n,
    minAsk: 10_000_000n,
    make: () => {
      throw new Error("assistant agents only run tasks from their user");
    },
  },
  /** On-call analyst: explains notable market events fast. Tight deadlines, so it buys. */
  urgent: {
    every: 240,
    // As long as the provider's booking lead: its own fresh slot can never make it, only a bought one can.
    deadlineIn: 120,
    lateCost: 50_000_000n, // 0.5 HBAR: a late alert is worth little
    minAsk: 30_000_000n,
    trigger: (ev, me) =>
      ev.by !== me &&
      ((ev.e.type === "trade" && ev.e.buyer !== me && ev.e.seller !== me) || (ev.e.type === "done" && !ev.e.ok) || ev.e.type === "refund"),
    make: (m, ev) => ({
      label: ev ? `alert: ${ev.e.type} #${ev.seq}` : "routine health check",
      maxTokens: 200,
      task: `${CONTEXT} You are its on-call analyst. In at most 3 short bullet points tell an operator what happened, why it matters, and what to watch next. Use only the facts given.`,
      input: `${ev ? `Event to explain:\n${line(ev, m.names)}\n\n` : "No single trigger: check the market's health.\n\n"}Recent activity:\n${history(m, 15)}`,
    }),
  },
  /** Digest writer: summarises the market every few minutes. Loose deadline, so it sells. */
  digest: {
    every: 180,
    deadlineIn: 600,
    lateCost: 5_000_000n,
    minAsk: 5_000_000n, // 0.05 HBAR: cheap to move, the deadline is far off
    make: (m) => ({
      label: "market digest",
      maxTokens: 350,
      task: `${CONTEXT} Write a short market digest: activity, who traded with whom and at what prices, failed or late jobs, and one sentence on the trend. Use only the facts given.`,
      input: `Activity, oldest first:\n${history(m, 60)}\n\nSlots for sale now:\n${offerLines(m)}`,
    }),
  },
  /** Price reporter: tracks booking and trade prices. Medium deadline: sometimes sells, sometimes buys. */
  report: {
    every: 120,
    deadlineIn: 270,
    lateCost: 20_000_000n,
    minAsk: 10_000_000n,
    make: (m) => {
      const priced = m.events.filter((ev) => ev.e.type === "booked" || ev.e.type === "trade");
      return {
        label: "price report",
        maxTokens: 250,
        task: `${CONTEXT} Write a price report: how booking prices and slot trade prices moved, the current asks, and whether capacity is getting tighter or looser. Quote numbers. Use only the facts given.`,
        input: `Bookings and trades, oldest first:\n${priced.slice(-40).map((ev) => line(ev, m.names)).join("\n") || "(none yet)"}\n\nCurrent asks:\n${offerLines(m)}`,
      };
    },
  },
};
