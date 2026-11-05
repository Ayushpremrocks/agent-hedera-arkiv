import { PublicKey } from "@hiero-ledger/sdk";
import { accountKey, parseKey } from "./hedera.js";

/** How old a signed request may be before it's rejected (replay window). */
export const MAX_SKEW_SECONDS = 60;

export type Signed = { account: string; ts: number; sig: string };

const message = (action: string, account: string, subject: string, ts: number) =>
  new TextEncoder().encode(`qy|${action}|${account}|${subject}|${ts}`);

/** Sign `action` on `subject` (e.g. a job hash) as `account`. */
export function signRequest(action: string, account: string, key: string, subject: string): Signed {
  const ts = Math.floor(Date.now() / 1000);
  const sig = Buffer.from(parseKey(key).sign(message(action, account, subject, ts))).toString("hex");
  return { account, ts, sig };
}

/** Throws unless `req` is a fresh signature by `req.account`'s on-chain key over action+subject. */
export async function verifyRequest(action: string, subject: string, req: Partial<Signed>): Promise<string> {
  const { account, ts, sig } = req;
  if (typeof account !== "string" || !/^0\.0\.\d+$/.test(account)) throw new Error("bad account");
  if (typeof ts !== "number" || Math.abs(Date.now() / 1000 - ts) > MAX_SKEW_SECONDS) throw new Error("stale request");
  if (typeof sig !== "string" || !/^[0-9a-f]+$/.test(sig)) throw new Error("bad signature format");
  const pub = PublicKey.fromStringECDSA(await accountKey(account));
  if (!pub.verify(message(action, account, subject, ts), Buffer.from(sig, "hex"))) throw new Error("bad signature");
  return account;
}
