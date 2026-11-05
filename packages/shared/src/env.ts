import { config } from "dotenv";
import { fileURLToPath } from "node:url";

export const ENV_PATH = fileURLToPath(new URL("../../../.env", import.meta.url));
config({ path: ENV_PATH, quiet: true });

export function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in .env (see .env.example)`);
  return v;
}

/** Account id + key for a role, e.g. role("AGENT_A") reads AGENT_A_ID / AGENT_A_KEY. */
export function role(name: string) {
  return { id: need(`${name}_ID`), key: need(`${name}_KEY`) };
}
