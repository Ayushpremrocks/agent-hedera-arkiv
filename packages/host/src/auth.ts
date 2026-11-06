// Sign in with a Hedera wallet: the host issues a one-time message, the wallet signs it (HashPack
// over WalletConnect prefixes it as "\x19Hedera Signed Message:\n" + length + message and returns a
// SignatureMap), and the host checks it against the account's key on the Mirror Node. The session
// is an HMAC token, so nothing is stored.
import { PublicKey } from "@hiero-ledger/sdk";
import { proto } from "@hiero-ledger/proto";
import { HttpError, MIRROR } from "@qy/shared";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const SESSION_SECONDS = 12 * 3600;
const CHALLENGE_SECONDS = 300;
const challenges = new Map<string, { account: string; expires: number }>();
const now = () => Math.floor(Date.now() / 1000);
const isAccount = (s: unknown): s is string => typeof s === "string" && /^0\.0\.\d+$/.test(s);

let secret = "";
export const useAuthSecret = (s: string) => (secret = s);
const mac = (data: string) => createHmac("sha256", secret).update(data).digest("base64url");

export function challenge(account: unknown) {
  if (!isAccount(account)) throw new HttpError(400, "account must look like 0.0.1234");
  for (const [m, c] of challenges) if (c.expires < now()) challenges.delete(m);
  const message = `Sign in to Dani.ai\naccount: ${account}\nnonce: ${randomBytes(12).toString("hex")}\nexpires: ${now() + CHALLENGE_SECONDS}`;
  challenges.set(message, { account, expires: now() + CHALLENGE_SECONDS });
  return { message };
}

async function publicKeyOf(account: string) {
  const res = await fetch(`${MIRROR}/accounts/${account}`);
  if (!res.ok) throw new HttpError(400, `unknown account ${account}`);
  const k = ((await res.json()) as any).key as { _type: string; key: string } | null;
  if (k?._type === "ED25519") return PublicKey.fromStringED25519(k.key);
  if (k?._type === "ECDSA_SECP256K1") return PublicKey.fromStringECDSA(k.key);
  throw new HttpError(400, "only single-key ED25519 or ECDSA accounts can sign in");
}

/** Check a wallet-signed challenge and return a session token. */
export async function verify(body: any) {
  const c = challenges.get(String(body?.message ?? ""));
  if (!c || c.expires < now() || c.account !== body?.account) throw new HttpError(401, "unknown or expired sign-in message; request a new one");
  challenges.delete(body.message); // one use only
  let sig: Uint8Array | null | undefined;
  try {
    const map = proto.SignatureMap.decode(Buffer.from(String(body.signatureMap), "base64"));
    sig = map.sigPair?.[0]?.ed25519 ?? map.sigPair?.[0]?.ECDSASecp256k1;
  } catch {
    throw new HttpError(400, "signatureMap must be a base64 SignatureMap");
  }
  if (!sig) throw new HttpError(400, "no signature in signatureMap");
  const signed = Buffer.from("\x19Hedera Signed Message:\n" + body.message.length + body.message);
  if (!(await publicKeyOf(c.account)).verify(signed, sig)) throw new HttpError(401, "signature does not match the account's key");
  const payload = `${c.account}.${now() + SESSION_SECONDS}`;
  return { token: `${payload}.${mac(payload)}`, account: c.account };
}

/** The account a request's bearer token belongs to, or a 401. */
export function session(headers: Record<string, unknown>): string {
  const token = String(headers.authorization ?? "").replace(/^Bearer /, "");
  // Account ids contain dots (0.0.123), so the token is "0.0.123.<exp>.<mac>": split from the right.
  const parts = token.split(".");
  const tokenSig = parts.pop() ?? "";
  const tokenExp = Number(parts.pop());
  const tokenAccount = parts.join(".");
  const expected = mac(`${tokenAccount}.${tokenExp}`);
  if (!isAccount(tokenAccount) || !(tokenExp > now()) || tokenSig.length !== expected.length || !timingSafeEqual(Buffer.from(tokenSig), Buffer.from(expected)))
    throw new HttpError(401, "sign in first");
  return tokenAccount;
}
