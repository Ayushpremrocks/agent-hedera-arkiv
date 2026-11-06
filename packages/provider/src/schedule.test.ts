import assert from "node:assert/strict";
import { test } from "node:test";
import { type Planned, broken, canStart, maxTokensWithin, promiseFor, runLimit, simulate } from "./schedule.js";

const speed = { tps: 50, startupMs: 1000 };

test("run limit: startup plus tokens at worst-case speed, with margin", () => {
  assert.equal(runLimit(200, speed), Math.ceil((1 + 4) * 1.25)); // 7
  assert.ok(runLimit(maxTokensWithin(30, speed), speed) <= 30);
  assert.ok(runLimit(maxTokensWithin(30, speed) + 50, speed) > 30);
});

test("simulate plays the queue forward over the first free worker", () => {
  // worker 1 busy until 9, worker 2 idle at 2; the worked example from the design notes
  const plan = simulate([2, 9], [
    { id: 1, limit: 5, notBefore: 0 },
    { id: 2, limit: 3, notBefore: 0 },
    { id: 3, limit: 9, notBefore: 0 },
  ]);
  assert.deepEqual([...plan.values()], [2, 7, 9]);
});

test("a new ticket's promise never moves an existing one", () => {
  const free = [0, 0];
  const queue: Planned[] = [];
  for (let id = 1; id <= 6; id++) {
    const startBy = promiseFor(free, queue, 4 + id, 0);
    queue.push({ id, limit: 4 + id, notBefore: 0, startBy });
    assert.equal(broken(free, queue), 0, `after ticket ${id}`);
  }
});

test("a reservation is promised no earlier than its start", () => {
  assert.equal(promiseFor([0], [], 5, 100), 100);
  assert.equal(promiseFor([200], [], 5, 100), 200); // queue busy past it: promised when free
});

test("real jobs finishing early keep every promise (no scheduling anomaly)", () => {
  // Promise everything with full limits, then run with random shorter durations in promise order.
  for (let trial = 0; trial < 200; trial++) {
    const workers = 1 + (trial % 3);
    const queue: Planned[] = [];
    for (let id = 1; id <= 12; id++) {
      const limit = 1 + ((id * 7 + trial) % 9);
      const notBefore = (id * 13 + trial) % 5 === 0 ? (id * 3) % 40 : 0;
      queue.push({ id, limit, notBefore, startBy: promiseFor(Array(workers).fill(0), queue, limit, notBefore) });
    }
    // Event-driven run: at each moment, idle workers take tickets the dispatcher allows.
    const busy: { end: number }[] = [];
    let waiting = [...queue];
    let t = 0;
    while (waiting.length && t < 10_000) {
      for (let k = busy.length - 1; k >= 0; k--) if (busy[k].end <= t) busy.splice(k, 1);
      for (const q of [...waiting].sort((a, b) => a.startBy - b.startBy || a.id - b.id)) {
        if (busy.length >= workers) break;
        if (!canStart(t, busy.map((b) => b.end), workers - busy.length, waiting, q)) continue;
        assert.ok(t <= q.startBy, `trial ${trial}: ticket ${q.id} started at ${t}, promised ${q.startBy}`);
        const actual = Math.max(1, q.limit - ((q.id + trial) % 3)); // finishes at or before its limit
        busy.push({ end: t + actual });
        waiting = waiting.filter((w) => w.id !== q.id);
      }
      t++;
    }
    assert.equal(waiting.length, 0, `trial ${trial}: tickets never ran`);
  }
});

test("a later ticket may fill an idle worker before a reservation, but not past its promise", () => {
  const res: Planned = { id: 1, limit: 5, notBefore: 10, startBy: 10 };
  const short: Planned = { id: 2, limit: 4, notBefore: 0, startBy: 15 };
  const long: Planned = { id: 3, limit: 20, notBefore: 0, startBy: 15 };
  assert.ok(canStart(0, [], 1, [res, short], short)); // done by 4, reservation still starts at 10
  assert.ok(!canStart(0, [], 1, [res, long], long)); // would run until 20: the reservation would be late
  assert.ok(!canStart(0, [], 1, [res], res)); // not due yet
});
