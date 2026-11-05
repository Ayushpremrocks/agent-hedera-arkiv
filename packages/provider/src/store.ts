import type { Job } from "@qy/shared";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Job payloads stay private on the provider's disk; only their hashes go on-chain.
export const DATA_DIR = fileURLToPath(new URL("../../../data/provider", import.meta.url));
const FILE = `${DATA_DIR}/jobs.json`;

type Pending = { job: Job; hash: string };

/** One pending job per account: whatever slot the account holds when it starts runs this job. */
export const pending = new Map<string, Pending>(
  existsSync(FILE) ? Object.entries(JSON.parse(readFileSync(FILE, "utf8"))) : [],
);

export function savePending() {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(Object.fromEntries(pending), null, 2));
}
