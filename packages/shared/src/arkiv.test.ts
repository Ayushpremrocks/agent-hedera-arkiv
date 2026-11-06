import { render } from "@arkiv-network/sdk/query";
import assert from "node:assert/strict";
import { test } from "node:test";
import { offerFilter } from "./arkiv.js";

test("offer filter encodes provider, both deadlines, cutoff and budget", () => {
  const q = render(offerFilter("0.0.42", { myStart: 1000, myLatest: 900, notBefore: 700, budget: 5000n }));
  console.log(q);
  // eta <= min(999, 900) = 900: the buyer's own deadline is the tighter bound here
  for (const part of ["provider", "0.0.42", "eta", "900", "700", "latest_ok_start", "1000", "min_price", "5000"]) {
    assert.ok(q.includes(part), `missing ${part} in ${q}`);
  }
});
