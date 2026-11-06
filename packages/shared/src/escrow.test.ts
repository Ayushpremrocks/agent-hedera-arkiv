import assert from "node:assert/strict";
import { test } from "node:test";
import { ABSENT_AFTER, LATE_AFTER, NO_RESULT_AFTER, decide } from "./escrow.js";

const at = 1000;

test("on time and delivered pays the provider", () => {
  assert.equal(decide({ startBy: at, dispatch: { ts: at + LATE_AFTER, jobHash: "h" }, done: { ok: true } }, at + 30).action, "release");
});

test("a late start refunds the buyer, whatever happened after", () => {
  const v = decide({ startBy: at, dispatch: { ts: at + LATE_AFTER + 1, jobHash: "h" }, done: { ok: true } }, at + 30);
  assert.equal(v.action, "refund");
});

test("on time but failed refunds; on time with no job attached pays (the holder's choice)", () => {
  assert.equal(decide({ startBy: at, dispatch: { ts: at, jobHash: "h" }, done: { ok: false } }, at + 5).action, "refund");
  assert.equal(decide({ startBy: at, dispatch: { ts: at, jobHash: null } }, at + 5).action, "release");
});

test("waits for evidence before refunding on absence", () => {
  assert.equal(decide({ startBy: at }, at + ABSENT_AFTER).action, "hold");
  assert.equal(decide({ startBy: at }, at + ABSENT_AFTER + 1).action, "refund");
  assert.equal(decide({ startBy: at, dispatch: { ts: at, jobHash: "h" } }, at + NO_RESULT_AFTER).action, "hold");
  assert.equal(decide({ startBy: at, dispatch: { ts: at, jobHash: "h" } }, at + NO_RESULT_AFTER + 1).action, "refund");
});
