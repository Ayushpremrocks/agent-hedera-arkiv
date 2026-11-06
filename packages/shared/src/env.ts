import { config } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The repo's .env by default. QY_ENV points at another file instead, so a community provider runs
// from its own .env.provider (made by `pnpm provider:join`) and never needs anyone else's keys.
export const ENV_PATH = process.env.QY_ENV ? resolve(process.env.QY_ENV) : fileURLToPath(new URL("../../../.env", import.meta.url));
config({ path: ENV_PATH, quiet: true });

export function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in ${ENV_PATH} (see .env.example, or run pnpm provider:join)`);
  return v;
}

/** Account id + key for a role, e.g. role("AGENT_A") reads AGENT_A_ID / AGENT_A_KEY. */
export function role(name: string) {
  return { id: need(`${name}_ID`), key: need(`${name}_KEY`) };
}
