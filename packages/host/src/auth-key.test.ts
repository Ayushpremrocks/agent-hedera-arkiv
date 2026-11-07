import assert from "node:assert/strict";
import { test } from "node:test";
import { PrivateKey } from "@hiero-ledger/sdk";
import { proto } from "@hiero-ledger/proto";
import { keyChallenge, useAuthSecret, verifyKey } from "./auth.js";

useAuthSecret("test");
const sigMap = (k: PrivateKey, message: string) =>
  Buffer.from(proto.SignatureMap.encode({ sigPair: [{ pubKeyPrefix: k.publicKey.toBytesRaw(), ed25519: k.sign(Buffer.from("\x19Hedera Signed Message:\n" + message.length + message)) }] }).finish()).toString("base64");

test("a key proves itself once, and only with its own signature", () => {
  const k = PrivateKey.generateED25519();
  const publicKey = k.publicKey.toStringDer();
  const { message } = keyChallenge(publicKey);
  assert.throws(() => verifyKey({ publicKey, message, signatureMap: sigMap(PrivateKey.generateED25519(), message) }), /does not match/);
  const again = keyChallenge(publicKey).message;
  assert.equal(verifyKey({ publicKey, message: again, signatureMap: sigMap(k, again) }).toStringDer(), publicKey);
  assert.throws(() => verifyKey({ publicKey, message: again, signatureMap: sigMap(k, again) }), /expired/); // no replay
  assert.throws(() => keyChallenge("not a key"), /public key/);
});
