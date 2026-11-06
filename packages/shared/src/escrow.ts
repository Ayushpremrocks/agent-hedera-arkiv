// Escrow rules: what happens to a booking's payment, decided only from the provider's signed log and
// Hedera's consensus timestamps (never anyone's local clock). The keeper applies these; anyone can
// re-run them on the public log and check every payout and refund.

/** Late by more than this (start message's consensus time vs. promise) counts as a missed promise.
 * Covers the provider's 3 s grace, a 4 s log batch and consensus time. */
export const LATE_AFTER = 13;
/** With no start message at all, wait this long past the promise before refunding: the log may lag. */
export const ABSENT_AFTER = 60;
/** A started job with no result this long after it started is treated as failed. */
export const NO_RESULT_AFTER = 120;

export type EscrowTicket = {
  startBy: number;
  dispatch?: { ts: number; jobHash: string | null };
  done?: { ok: boolean };
};
export type Verdict = { action: "hold" } | { action: "release"; reason: string } | { action: "refund"; reason: string };

/** `now` is the keeper's time; it only ever decides that something did NOT happen in time. */
export function decide(t: EscrowTicket, now: number): Verdict {
  if (t.dispatch) {
    if (t.dispatch.ts > t.startBy + LATE_AFTER) return { action: "refund", reason: "started after its promised time" };
    if (t.dispatch.jobHash === null) return { action: "release", reason: "started on time with no job attached" };
    if (t.done) return t.done.ok ? { action: "release", reason: "started on time and delivered" } : { action: "refund", reason: "the provider failed the job" };
    if (now > t.dispatch.ts + NO_RESULT_AFTER) return { action: "refund", reason: "no result after it started" };
    return { action: "hold" };
  }
  if (now > t.startBy + ABSENT_AFTER) return { action: "refund", reason: "never started" };
  return { action: "hold" };
}
