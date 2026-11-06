// Agent keys are derived, never stored: key = HKDF(master secret, owner account, index). Any host
// instance holding the master secret can run any agent, and there is no key table to leak. In
// production the master secret belongs in a KMS/HSM; rotating it means migrating agents to new keys.
import { PrivateKey } from "@hiero-ledger/sdk";
import { hkdfSync } from "node:crypto";

// secp256k1 group order: a valid private key is in [1, n-1]
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

export function agentKey(master: string, owner: string, index = 0): string {
  for (let attempt = 0; ; attempt++) {
    const bytes = Buffer.from(hkdfSync("sha256", master, `qy-agent-key`, `${owner}/${index}/${attempt}`, 32));
    const k = BigInt(`0x${bytes.toString("hex")}`);
    if (k > 0n && k < N) return PrivateKey.fromBytesECDSA(bytes).toStringDer(); // ~never needs a retry
  }
}

/** A separate subkey for signing sessions, so the master secret itself is never used directly. */
export function sessionKey(master: string): string {
  return Buffer.from(hkdfSync("sha256", master, "qy-session", "v1", 32)).toString("hex");
}
