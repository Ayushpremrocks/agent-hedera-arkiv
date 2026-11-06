import { createHash } from "node:crypto";

/** A unit of real work. `cpu` hashes in a loop for `seconds`; the result digest proves it ran. */
export type Job = { kind: "cpu"; seconds: number; label: string };

// Simulated runtime only. It may exceed a slot: the provider kills any job at the end of its slot.
export const MAX_JOB_SECONDS = 120;

/** Validate untrusted input into a Job, or throw. */
export function parseJob(x: any): Job {
  if (!x || x.kind !== "cpu") throw new Error("job.kind must be 'cpu'");
  if (!Number.isInteger(x.seconds) || x.seconds < 1 || x.seconds > MAX_JOB_SECONDS)
    throw new Error(`job.seconds must be an integer 1..${MAX_JOB_SECONDS}`);
  if (typeof x.label !== "string" || x.label.length > 100) throw new Error("job.label must be a string ≤100 chars");
  return { kind: "cpu", seconds: x.seconds, label: x.label };
}

/** sha256 over a fixed field order, so agent and provider always agree. Only this goes on-chain. */
export function jobHash(job: Job): string {
  return createHash("sha256").update(JSON.stringify([job.kind, job.seconds, job.label])).digest("hex");
}
