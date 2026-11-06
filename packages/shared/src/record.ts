// A provider's public track record, computed only from its signed HCS log, so anyone can recompute it
// from the Mirror Node and nobody has to trust the host's numbers.
import type { LoggedEvent } from "./hcs.js";

export type TrackRecord = {
  since: number | null; // consensus time of the first event counted
  booked: number; // tickets sold (bookings and reservations)
  started: number; // tickets dispatched to a worker
  kept: number; // started by their promised startBy
  missed: number; // started after it
  done: number; // jobs that ran to completion
  failed: number; // jobs that ran but didn't complete
  refunds: number;
  refunded: string; // tinybars paid back
  earned: string; // tinybars from bookings, before refunds
};

/**
 * `slack` covers the gap between a ticket starting and its dispatch message reaching consensus (the
 * provider's 3s grace, a batch interval and consensus time), so "kept" errs toward the provider only
 * by that much. Only messages the provider itself signed count.
 */
export function trackRecord(events: LoggedEvent[], provider: string, slack = 13): TrackRecord {
  const promise = new Map<number, number>();
  const r: TrackRecord = { since: null, booked: 0, started: 0, kept: 0, missed: 0, done: 0, failed: 0, refunds: 0, refunded: "0", earned: "0" };
  let earned = 0n;
  let refunded = 0n;
  for (const ev of [...events].sort((a, b) => a.seq - b.seq || a.i - b.i)) {
    if (ev.by !== provider) continue;
    const e = ev.e;
    r.since ??= ev.ts;
    if (e.type === "booked") {
      r.booked++;
      earned += BigInt(e.price || 0);
      if (typeof e.startBy === "number") promise.set(e.ticket, e.startBy);
    } else if (e.type === "dispatch") {
      const by = promise.get(e.ticket);
      if (by === undefined) continue; // booked before this window, or before promises existed
      r.started++;
      if (ev.ts <= by + slack) r.kept++;
      else r.missed++;
    } else if (e.type === "done") {
      if (e.ok) r.done++;
      else r.failed++;
    } else if (e.type === "refund") {
      r.refunds++;
      refunded += BigInt(e.amount || 0);
    }
  }
  r.earned = earned.toString();
  r.refunded = refunded.toString();
  return r;
}
