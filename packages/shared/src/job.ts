import { createHash } from "node:crypto";

/**
 * A unit of real work: one model call. `task` is the instruction, `input` the material to work on.
 * `deadline` (unix seconds) is when the owner needs the result; the provider uses it only to pick
 * which of the owner's jobs runs first. Payloads stay on the provider; only the hash goes on-chain.
 */
export type Job = { kind: "llm"; task: string; input: string; maxTokens: number; deadline: number; label: string };

export const MAX_TASK_CHARS = 2_000;
export const MAX_INPUT_CHARS = 16_000; // keeps a whole request well under the 64KB body limit
export const MAX_TOKENS = 4_096;

/** Validate untrusted input into a Job, or throw. */
export function parseJob(x: any): Job {
  if (!x || x.kind !== "llm") throw new Error("job.kind must be 'llm'");
  if (typeof x.task !== "string" || !x.task || x.task.length > MAX_TASK_CHARS) throw new Error(`job.task must be 1..${MAX_TASK_CHARS} chars`);
  if (typeof x.input !== "string" || x.input.length > MAX_INPUT_CHARS) throw new Error(`job.input must be ≤${MAX_INPUT_CHARS} chars`);
  if (!Number.isInteger(x.maxTokens) || x.maxTokens < 1 || x.maxTokens > MAX_TOKENS) throw new Error(`job.maxTokens must be an integer 1..${MAX_TOKENS}`);
  if (!Number.isInteger(x.deadline) || x.deadline < 0) throw new Error("job.deadline must be unix seconds");
  if (typeof x.label !== "string" || x.label.length > 100) throw new Error("job.label must be a string ≤100 chars");
  return { kind: "llm", task: x.task, input: x.input, maxTokens: x.maxTokens, deadline: x.deadline, label: x.label };
}

/** sha256 over a fixed field order, so agent and provider always agree. Only this goes on-chain. */
export function jobHash(job: Job): string {
  return sha256(JSON.stringify([job.kind, job.task, job.input, job.maxTokens, job.deadline, job.label]));
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
