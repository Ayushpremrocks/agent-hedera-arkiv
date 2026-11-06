import assert from "node:assert/strict";
import { test } from "node:test";
import { askPrice, buyPlan, feasible, latestReplacement, withinBudget, worthListing } from "./policy.js";

const S = 30; // slot seconds

test("feasible: earliest deadline runs in the earliest slot", () => {
  assert.ok(feasible([100], [130], S)); // finishes exactly on time
  assert.ok(!feasible([101], [130], S)); // one second late
  assert.ok(feasible([200, 100], [400, 130], S)); // order of inputs doesn't matter
  assert.ok(!feasible([100, 200], [130, 220], S)); // second job misses
  assert.ok(!feasible([100], [500, 600], S)); // more jobs than slots
  assert.ok(feasible([100, 200], [], S)); // no jobs, nothing to miss
});

test("latestReplacement: spare, tight, and hopeless slots", () => {
  // Two slots, one job: either slot is spare.
  assert.equal(latestReplacement([100, 200], [400], 1, S), Infinity);
  // One slot, deadline 600: the slot may move as late as 570 and still finish on time.
  assert.equal(latestReplacement([100], [600], 0, S), 570);
  // Two jobs: giving away the 100 slot leaves 200 for the earliest deadline (300), so the
  // replacement must serve the 400 deadline: start <= 370.
  assert.equal(latestReplacement([100, 200], [300, 400], 0, S), 370);
  // Replacing the 300 slot: an early enough one (<= 120) serves the 150 deadline, 400 serves 1000.
  assert.equal(latestReplacement([300, 400], [150, 1000], 0, S), 120);
  // The remaining 400 slot can't serve either deadline, so no single replacement helps.
  assert.equal(latestReplacement([300, 400], [150, 200], 0, S), null);
});

test("seller: the listed bound really is the limit", () => {
  const starts = [100, 200];
  const deadlines = [300, 400];
  const latest = latestReplacement(starts, deadlines, 0, S)!;
  assert.ok(feasible([latest, 200], deadlines, S), "swap into the bound keeps every deadline");
  assert.ok(!feasible([latest + 1, 200], deadlines, S), "one second later breaks one");
});

test("buyer: gives its latest slot and needs one starting early enough", () => {
  // Urgent job due at 250, own slot starts 240: late. Needs a slot starting <= 220.
  assert.deepEqual(buyPlan([240], [250], S), { giveStart: 240, latestStart: 220 });
  // Already on time: no trade.
  assert.equal(buyPlan([200], [250], S), null);
  // Two jobs, two slots, the urgent one is late; giving the later slot is the cheap fix.
  const plan = buyPlan([200, 400], [210, 1000], S)!;
  assert.equal(plan.giveStart, 400);
  assert.ok(feasible([plan.latestStart, 200], [210, 1000], S));
  // Deadline already unreachable: buying can't help, so don't pay.
  assert.equal(buyPlan([500], [20], S), null);
});

test("asks: less slack costs more, never below the minimum or above 4x", () => {
  const min = 1_000_000n;
  assert.equal(askPrice(30, min, S), 4_000_000n);
  assert.equal(askPrice(60, min, S), 2_000_000n);
  assert.equal(askPrice(120, min, S), min);
  assert.equal(askPrice(10_000, min, S), min);
  assert.equal(askPrice(1, min, S), 4_000_000n);
  assert.ok(worthListing(60, S) && !worthListing(59, S));
  assert.ok(withinBudget(5n, 5n) && !withinBudget(6n, 5n));
});
