import { PrivateKey } from "@hiero-ledger/sdk";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseKey } from "./hedera.js";

test("parseKey reads DER, 0x-raw, and bare raw keys that happen to start with 30", () => {
  let k = PrivateKey.generateECDSA();
  while (!k.toStringRaw().startsWith("30")) k = PrivateKey.generateECDSA();
  const raw = k.toStringRaw();
  for (const s of [k.toStringDer(), `0x${raw}`, raw]) assert.equal(parseKey(s).toStringRaw(), raw);
});
