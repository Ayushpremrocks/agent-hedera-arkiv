// Escrow rules: what happens to a booking's payment, decided only from the provider's signed log and
// Hedera's consensus timestamps (never anyone's local clock). The keeper applies these; anyone can
// re-run them on the public log and check every payout and refund.

/** Late by more than this (start message's consensus time vs. promise) counts as a missed promise.
 * Covers the provider's 3 s grace, a 4 s log batch and consensus time. */
export const LATE_AFTER = 13;
/** With no start message at all, wait this long past the promise before refunding: the log may lag. */
export const ABSENT_AFTER = 60;
/** A started job with no result this long after it started is treated as failed (when its limit is unknown). */
export const NO_RESULT_AFTER = 120;
/**
 * Jobs aren't stopped at their run limit: the work is worth finishing, and the provider absorbs an
 * overrun (later tickets start late, so the escrow credits them). Only a job running this many times
 * its limit is treated as hung and stopped.
 */
export const HUNG_FACTOR = 5;

export type EscrowTicket = {
  startBy: number;
  limit?: number; // the ticket's run limit, seconds
  dispatch?: { ts: number; jobHash: string | null };
  done?: { ok: boolean };
};
/** `refundPct` of the price goes back to the ticket's holder; the provider keeps the rest. */
export type Verdict = { action: "hold" } | { action: "settle"; refundPct: number; reason: string };

/**
 * Credit for a late start, like a service-level credit: scaled to how late it started (in seconds past
 * the promise, by consensus time), in full only once the promise is clearly broken. The first
 * LATE_AFTER seconds are the measuring tolerance, not lateness.
 */
export const LATE_CREDITS: [upToSeconds: number, refundPct: number][] = [
  [LATE_AFTER, 0],
  [30, 25],
  [60, 50],
];
export function lateCredit(secondsLate: number): number {
  for (const [upTo, pct] of LATE_CREDITS) if (secondsLate <= upTo) return pct;
  return 100;
}

/**
 * Nothing delivered (failed, no result, never started) is refunded in full; a delivered job keeps the
 * provider paid minus its lateness credit. `now` is the keeper's time; it only ever decides that
 * something did NOT happen in time.
 */
export function decide(t: EscrowTicket, now: number): Verdict {
  const settle = (refundPct: number, reason: string): Verdict => ({ action: "settle", refundPct, reason });
  if (t.dispatch) {
    const late = Math.max(0, Math.round(t.dispatch.ts - t.startBy));
    const credit = lateCredit(late);
    const when = credit ? `started ${late}s late` : "started on time";
    if (t.done && !t.done.ok) return settle(100, "the provider failed the job");
    if (t.done || t.dispatch.jobHash === null) return settle(credit, t.done ? `${when}, delivered` : `${when}, no job attached`);
    const giveUp = t.limit ? t.limit * HUNG_FACTOR + LATE_AFTER : NO_RESULT_AFTER;
    if (now > t.dispatch.ts + giveUp) return settle(100, "no result after it started");
    return { action: "hold" };
  }
  if (now > t.startBy + ABSENT_AFTER) return settle(100, "never started");
  return { action: "hold" };
}

/**
 * A provider's own prices by job size: [up to this many tokens, tinybars], ascending. A booking
 * deposits the band its maximum size falls in; the escrow charges the band the job actually used and
 * returns the rest, so buyers pay for what ran, at prices each provider sets.
 */
export type Bands = [maxTokens: number, tinybars: string][];

/** The price of the smallest band that fits `tokens` (the largest band if none does). */
export function bandPrice(bands: Bands, tokens: number): bigint {
  const band = bands.find(([upTo]) => tokens <= upTo) ?? bands[bands.length - 1];
  return BigInt(band[1]);
}
