import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoggedEvent } from "./hcs.js";
import { trackRecord } from "./record.js";

const P = "0.0.100";
let seq = 0;
const ev = (ts: number, e: any, by = P): LoggedEvent => ({ seq: ++seq, i: 0, ts, by, e: { ...e, at: ts } });

test("kept vs missed is judged against each ticket's own promise, with slack for the log", () => {
  const r = trackRecord(
    [
      ev(100, { type: "booked", ticket: 1, owner: "a", jobHash: "h1", price: "10", startBy: 100, maxTokens: 50 }),
      ev(100, { type: "booked", ticket: 2, owner: "b", jobHash: "h2", price: "20", startBy: 110, maxTokens: 50 }),
      ev(112, { type: "dispatch", ticket: 1, owner: "a", jobHash: "h1" }), // 12s after: within slack
      ev(140, { type: "dispatch", ticket: 2, owner: "b", jobHash: "h2" }), // 30s after: missed
      ev(141, { type: "done", ticket: 1, owner: "a", jobHash: "h1", ok: true, result: "ok", resultHash: "x", tokens: 5, ms: 900 }),
      ev(142, { type: "refund", buyer: "b", amount: "20", paymentTx: "t", refundTx: "r", reason: "missed", ticket: 2 }),
    ],
    P,
  );
  assert.equal(r.booked, 2);
  assert.equal(r.started, 2);
  assert.equal(r.kept, 1);
  assert.equal(r.missed, 1);
  assert.equal(r.done, 1);
  assert.equal(r.refunds, 1);
  assert.equal(r.earned, "30");
  assert.equal(r.refunded, "20");
  assert.equal(r.since, 100);
});

test("messages signed by anyone else don't count", () => {
  const r = trackRecord([ev(1, { type: "booked", ticket: 9, owner: "x", jobHash: "h", price: "999", startBy: 1, maxTokens: 1 }, "0.0.666")], P);
  assert.equal(r.booked, 0);
  assert.equal(r.earned, "0");
});

test("a dispatch whose booking is outside the window is not counted either way", () => {
  const r = trackRecord([ev(5, { type: "dispatch", ticket: 77, owner: "a", jobHash: null })], P);
  assert.equal(r.started, 0);
});
