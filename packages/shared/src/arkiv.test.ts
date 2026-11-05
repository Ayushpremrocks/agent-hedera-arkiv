import { render } from "@arkiv-network/sdk/query";
import assert from "node:assert/strict";
import { test } from "node:test";
import { offerFilter } from "./arkiv.js";

test("offer filter encodes provider, earlier slot, seller deadline and budget", () => {
  const q = render(offerFilter("0.0.42", 1000, 5000n));
  console.log(q);
  for (const part of ["provider", "0.0.42", "slot_start", "latest_ok_start", "min_price", "1000", "5000"]) {
    assert.ok(q.includes(part), `missing ${part} in ${q}`);
  }
});
