// Trading rules, as pure functions so they can be tested without a network.
//
// The provider runs an account's queued job with the earliest deadline whenever one of its slots
// starts. With equal-length slots that means: sort the account's upcoming slot starts and its
// pending deadlines, and the i-th earliest deadline runs in the i-th earliest slot.

/** Do these slots meet all these deadlines? (Earliest deadline runs in the earliest slot.) */
export function feasible(starts: number[], deadlines: number[], slotSeconds: number): boolean {
  if (deadlines.length > starts.length) return false;
  const s = [...starts].sort((a, b) => a - b);
  const d = [...deadlines].sort((a, b) => a - b);
  return d.every((deadline, i) => s[i] + slotSeconds <= deadline);
}

/** Deadlines that the current slots miss (earliest deadline runs in the earliest slot). */
export function atRisk(starts: number[], deadlines: number[], slotSeconds: number): number[] {
  const s = [...starts].sort((a, b) => a - b);
  return [...deadlines].sort((a, b) => a - b).filter((d, i) => i >= s.length || s[i] + slotSeconds > d);
}

/**
 * The latest start a slot could have in place of `starts[i]` with every deadline still met.
 *   Infinity: slot i is spare, any replacement (or none) works.
 *   null:     no replacement helps, not even one starting right now.
 * A seller lists slot i for swaps into anything up to this. A buyer that is behind asks the same
 * question about the slot it would give away: the answer is how early its new slot must be.
 */
export function latestReplacement(starts: number[], deadlines: number[], i: number, slotSeconds: number): number | null {
  const others = starts.filter((_, j) => j !== i);
  if (feasible(others, deadlines, slotSeconds)) return Infinity;
  const ok = (x: number) => feasible([...others, x], deadlines, slotSeconds);
  if (!ok(0)) return null;
  let lo = 0; // ok
  let hi = Math.max(...deadlines); // a slot starting at the last deadline can't finish by it
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (ok(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** The slot a behind-schedule buyer gives away (its latest), and how early its replacement must start. */
export function buyPlan(starts: number[], deadlines: number[], slotSeconds: number) {
  if (feasible(starts, deadlines, slotSeconds) || !starts.length) return null;
  const give = starts.indexOf(Math.max(...starts));
  const latest = latestReplacement(starts, deadlines, give, slotSeconds);
  if (latest === null || latest === Infinity || latest >= starts[give]) return null; // a swap can't fix it
  return { giveStart: starts[give], latestStart: latest };
}

/**
 * Ask price for giving up a slot that could move `slack` seconds later: 4× the minimum when the
 * agent can barely spare it (one slot of slack), down to the minimum at 4+ slots of slack.
 */
export function askPrice(slack: number, minAsk: bigint, slotSeconds: number): bigint {
  const factor = Math.min(4, Math.max(1, (4 * slotSeconds) / Math.max(slack, 1)));
  return BigInt(Math.round(Number(minAsk) * factor));
}

/** Worth listing only with real slack: at least `minSlotsOfSlack` slots of room before a deadline bites. */
export const worthListing = (slack: number, slotSeconds: number, minSlotsOfSlack = 2) => slack >= minSlotsOfSlack * slotSeconds;

/** A buyer pays at most what missing the deadline would cost it. */
export const withinBudget = (price: bigint, lateCost: bigint) => price <= lateCost;
