// The host's own records: who signed in and which agent works for them. Market state stays on
// Hedera and Arkiv; this is only the service's address book. Agent keys are encrypted at rest.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export const DATA_DIR = fileURLToPath(new URL("../../../data/host", import.meta.url));
mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(`${DATA_DIR}/host.db`);
db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,          -- the agent's Hedera account
    owner TEXT NOT NULL UNIQUE,   -- the user's wallet account; one agent per user
    key_enc TEXT NOT NULL,        -- the agent's private key, AES-256-GCM under HOST_SECRET
    created_at INTEGER NOT NULL
  );
`);

export type AgentRow = { id: string; owner: string; key: string; created_at: number };

let secret: Buffer;
export function useSecret(s: string) {
  secret = createHash("sha256").update(s).digest();
}

function encrypt(plain: string) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", secret, iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString("base64")).join(".");
}
function decrypt(enc: string) {
  const [iv, tag, body] = enc.split(".").map((p) => Buffer.from(p, "base64"));
  const d = createDecipheriv("aes-256-gcm", secret, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString("utf8");
}

export function saveAgent(id: string, owner: string, key: string) {
  db.prepare("INSERT INTO agents (id, owner, key_enc, created_at) VALUES (?, ?, ?, ?)").run(id, owner, encrypt(key), Math.floor(Date.now() / 1000));
}

const toRow = (r: any): AgentRow => ({ id: r.id, owner: r.owner, key: decrypt(r.key_enc), created_at: r.created_at });
export const allAgents = () => db.prepare("SELECT * FROM agents").all().map(toRow);
export const agentOf = (owner: string) => {
  const r = db.prepare("SELECT * FROM agents WHERE owner = ?").get(owner);
  return r ? toRow(r) : null;
};
