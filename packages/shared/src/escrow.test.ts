import assert from "node:assert/strict";
import { test } from "node:test";
import { ABSENT_AFTER, type Bands, HUNG_FACTOR, bandPrice, LATE_AFTER, NO_RESULT_AFTER, type Verdict, decide, lateCredit } from "./escrow.js";

const at = 1000;
const pct = (v: Verdict) => (v.action === "settle" ? v.refundPct : null); // null: still held

test("on time and delivered: the provider keeps it all", () => {
  assert.equal(pct(decide({ startBy: at, dispatch: { ts: at + LATE_AFTER, jobHash: "h" }, done: { ok: true } }, at + 30)), 0);
});

test("late but delivered: a credit scaled to how late, full only past a minute", () => {
  assert.equal(lateCredit(LATE_AFTER), 0);
  assert.equal(lateCredit(LATE_AFTER + 1), 25);
  assert.equal(lateCredit(30), 25);
  assert.equal(lateCredit(45), 50);
  assert.equal(lateCredit(61), 100);
  assert.equal(pct(decide({ startBy: at, dispatch: { ts: at + 20, jobHash: "h" }, done: { ok: true } }, at + 40)), 25);
  assert.equal(pct(decide({ startBy: at, dispatch: { ts: at + 90, jobHash: "h" }, done: { ok: true } }, at + 99)), 100);
});

test("nothing delivered is refunded in full", () => {
  assert.equal(pct(decide({ startBy: at, dispatch: { ts: at, jobHash: "h" }, done: { ok: false } }, at + 5)), 100);
  assert.equal(pct(decide({ startBy: at, dispatch: { ts: at, jobHash: "h" } }, at + NO_RESULT_AFTER + 1)), 100);
  assert.equal(pct(decide({ startBy: at }, at + ABSENT_AFTER + 1)), 100);
});

test("on time with no job attached is the holder's choice: the provider is paid", () => {
  assert.equal(pct(decide({ startBy: at, dispatch: { ts: at, jobHash: null } }, at + 5)), 0);
});

test("waits for evidence before deciding", () => {
  assert.equal(pct(decide({ startBy: at }, at + ABSENT_AFTER)), null);
  assert.equal(pct(decide({ startBy: at, dispatch: { ts: at, jobHash: "h" } }, at + NO_RESULT_AFTER)), null);
});

test("an overrunning job is waited for, up to its own limit times HUNG_FACTOR", () => {
  const t = { startBy: at, limit: 10, dispatch: { ts: at, jobHash: "h" } };
  assert.equal(pct(decide(t, at + 10 * HUNG_FACTOR + LATE_AFTER)), null); // still running long: no penalty yet
  assert.equal(pct(decide(t, at + 10 * HUNG_FACTOR + LATE_AFTER + 1)), 100); // hung
  assert.equal(pct(decide({ ...t, done: { ok: true } }, at + 40)), 0); // finished late, but it started on time: paid
});

test("bands: a job is priced by the smallest band that fits it", () => {
  const bands: Bands = [[256, "100"], [1024, "300"], [2048, "600"]];
  assert.equal(bandPrice(bands, 0), 100n);
  assert.equal(bandPrice(bands, 256), 100n);
  assert.equal(bandPrice(bands, 257), 300n);
  assert.equal(bandPrice(bands, 2048), 600n);
  assert.equal(bandPrice(bands, 9999), 600n); // past the largest band: the largest price
});
