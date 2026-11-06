import assert from "node:assert/strict";
import { test } from "node:test";
import { bookingPrice } from "./pricing.js";

test("booking price is the floor when idle, rises with use, and caps at 16x", () => {
  const floor = 10_000_000n;
  assert.equal(bookingPrice(0, 20, floor), floor);
  assert.equal(bookingPrice(10, 20, floor), floor * 4n); // half full: 2^2
  assert.equal(bookingPrice(20, 20, floor), floor * 16n);
  assert.equal(bookingPrice(99, 20, floor), floor * 16n); // over-full can't exceed the cap
  let prev = 0n;
  for (let b = 0; b <= 20; b++) {
    const p = bookingPrice(b, 20, floor);
    assert.ok(p >= prev, "price never drops as bookings grow");
    prev = p;
  }
});
