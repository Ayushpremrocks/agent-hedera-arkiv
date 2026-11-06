import type { Job } from "@qy/shared";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Job payloads and results stay private on the provider's disk; only their hashes go on-chain.
// One folder per provider, so several can run on one machine (PROVIDER keeps its original folder).
export const PROVIDER_NAME = process.env.PROVIDER_NAME ?? "PROVIDER";
export const DATA_DIR = fileURLToPath(new URL(`../../../data/${PROVIDER_NAME.toLowerCase().replace(/_/g, "-")}`, import.meta.url));
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

/** Earliest deadline first among the jobs that fit the ticket's size. */
export function nextJob(account: string, maxTokens: number): Queued | undefined {
  return [...(queues.get(account) ?? [])].filter((q) => q.job.maxTokens <= maxTokens).sort((a, b) => a.job.deadline - b.job.deadline)[0];
}

/**
 * Queue tickets: a ticket is a paid place in this provider's queue. Its owner is recorded here (and
 * in the signed log) until someone trades it; then it's minted as an NFT and the NFT's holder owns it.
 */
export type Ticket = {
  owner: string; // who booked it (ignored once `serial` is set: the NFT holder owns it)
  price: string; // tinybars paid, refunded if the provider fails to serve it
  paymentTx: string;
  status: "queued" | "running" | "done";
  serial?: number; // the ticket's NFT, if it has been tokenized for a trade
  maxTokens: number; // its size: the largest job it runs
  limit: number; // hard run-time limit, seconds (from maxTokens at worst-case speed)
  startBy: number; // promised latest start, unix seconds; missed = refund
  notBefore: number; // a reservation doesn't start before this
  startedAt?: number;
  endBy?: number; // unix seconds (fractional): start + limit, when the job should end at worst-case speed
  refunded?: boolean; // paid back already (late, or the provider failed it)
};
const TICKETS_FILE = `${DATA_DIR}/tickets.json`;
const saved = existsSync(TICKETS_FILE) ? JSON.parse(readFileSync(TICKETS_FILE, "utf8")) : { next: 1, tickets: {} };
export const tickets: Record<string, Ticket> = saved.tickets;
export const counter = { next: saved.next as number };
export function saveTickets() {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(TICKETS_FILE, JSON.stringify({ next: counter.next, tickets }, null, 2));
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
