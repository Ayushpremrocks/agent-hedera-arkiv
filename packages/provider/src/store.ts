import type { Job } from "@qy/shared";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Job payloads and results stay private on the provider's disk; only their hashes go on-chain.
export const DATA_DIR = fileURLToPath(new URL("../../../data/provider", import.meta.url));
const QUEUE_FILE = `${DATA_DIR}/jobs.json`;
const RESULTS_DIR = `${DATA_DIR}/results`;

export type Queued = { job: Job; hash: string };

/** Each account's queued jobs. Whatever slot the account holds when it starts runs one of them. */
export const queues = new Map<string, Queued[]>(existsSync(QUEUE_FILE) ? Object.entries(JSON.parse(readFileSync(QUEUE_FILE, "utf8"))) : []);

export function saveQueues() {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(QUEUE_FILE, JSON.stringify(Object.fromEntries(queues), null, 2));
}

export function enqueue(account: string, q: Queued) {
  queues.set(account, [...(queues.get(account) ?? []), q]);
  saveQueues();
}

export function dequeue(account: string, hash: string) {
  const left = (queues.get(account) ?? []).filter((q) => q.hash !== hash);
  if (left.length) queues.set(account, left);
  else queues.delete(account);
  saveQueues();
}

/** Drop every queued job of an account; returns how many. */
export function clearQueue(account: string) {
  const n = queues.get(account)?.length ?? 0;
  queues.delete(account);
  saveQueues();
  return n;
}

/** Earliest deadline first: a slot the owner just bought goes to its most urgent job. */
export function nextJob(account: string): Queued | undefined {
  return [...(queues.get(account) ?? [])].sort((a, b) => a.job.deadline - b.job.deadline)[0];
}

/** What each slot was sold for, so a slot the provider fails to serve can be paid back. */
const PAID_FILE = `${DATA_DIR}/paid.json`;
export const paid: Record<string, { amount: string; paymentTx: string }> = existsSync(PAID_FILE) ? JSON.parse(readFileSync(PAID_FILE, "utf8")) : {};
export function savePaid() {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(PAID_FILE, JSON.stringify(paid, null, 2));
}

export type Result = { owner: string; text: string; tokens: number; model: string; ms: number };

export function saveResult(hash: string, r: Result) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(`${RESULTS_DIR}/${hash}.json`, JSON.stringify(r, null, 2));
}

export function loadResult(hash: string): Result | null {
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;
  const f = `${RESULTS_DIR}/${hash}.json`;
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
}
