// The guarantee behind every ticket: a `startBy` time the provider promises when it sells the ticket
// and must meet or refund. Pure functions, so the promise logic is tested without a model or a chain.
//
// Each ticket has a size (the most tokens its job may generate) and so a hard run-time limit: the
// provider kills a job at its limit. Playing the queue forward with every job using its full limit
// gives the latest each ticket can start; real jobs only finish earlier.

export { type Speed, maxTokensWithin, runLimit } from "@qy/shared";

export type Planned = { id: number; limit: number; notBefore: number; startBy: number };

/**
 * Latest start of each queued ticket if every job uses its full limit. `free` is when each worker is
 * free at the latest (a running job's kill time, or now if idle); tickets go in `queue` order to the
 * first free worker, never before their `notBefore`.
 */
export function simulate(free: number[], queue: Omit<Planned, "startBy">[]): Map<number, number> {
  const f = [...free];
  const out = new Map<number, number>();
  for (const t of queue) {
    let i = 0;
    for (let j = 1; j < f.length; j++) if (f[j] < f[i]) i = j;
    const start = Math.max(f[i], t.notBefore);
    out.set(t.id, start);
    f[i] = start + t.limit;
  }
  return out;
}

/** Queue order: earliest promise first. */
export const byPromise = (a: Planned, b: Planned) => a.startBy - b.startBy || a.id - b.id;

/** How many tickets would start after their promise under this plan. */
export function broken(free: number[], queue: Planned[]): number {
  const plan = simulate(free, queue);
  return queue.filter((t) => plan.get(t.id)! > t.startBy).length;
}

/**
 * The promise for a new ticket: it goes behind everything already sold, so no existing promise moves.
 * It can still run sooner: see `canStart`.
 */
export function promiseFor(free: number[], queue: Planned[], limit: number, notBefore: number): number {
  return simulate(free, [...[...queue].sort(byPromise), { id: -1, limit, notBefore }]).get(-1)!;
}

/**
 * May ticket `t` start right now on an idle worker? Yes unless doing so would make more promises
 * break than the plan already breaks. Lets later tickets fill a worker while an early reservation
 * isn't due yet, without ever pushing that reservation past its promise.
 * `busy` = kill times of running jobs; `idle` = number of idle workers (at least 1).
 */
export function canStart(now: number, busy: number[], idle: number, queue: Planned[], t: Planned): boolean {
  if (t.notBefore > now) return false;
  const rest = queue.filter((q) => q.id !== t.id).sort(byPromise);
  const before = broken([...busy, ...Array(idle).fill(now)], [...queue].sort(byPromise));
  const after = broken([...busy, now + t.limit, ...Array(idle - 1).fill(now)], rest);
  return after <= before;
}
