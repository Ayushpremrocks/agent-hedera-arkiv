import type { Job } from "@qy/shared";
import { Worker } from "node:worker_threads";

// Runs in a worker thread so jobs don't block the HTTP server or each other.
const CPU_JOB = `
const { workerData, parentPort } = require("node:worker_threads");
const { createHash } = require("node:crypto");
let h = Buffer.from(workerData.seed);
let n = 0;
const end = Date.now() + workerData.seconds * 1000;
while (Date.now() < end) {
  for (let i = 0; i < 1000; i++) h = createHash("sha256").update(h).digest();
  n += 1000;
}
parentPort.postMessage({ digest: h.toString("hex"), iterations: n });
`;

/**
 * Run a job, killing it after `limitMs` (the end of its slot). The worker is terminated, not asked
 * to stop, so a job can never hold a worker past its slot whatever it does.
 */
export function runJob(job: Job, seed: string, limitMs: number): Promise<{ digest: string; iterations: number }> {
  return new Promise((resolve, reject) => {
    const w = new Worker(CPU_JOB, { eval: true, workerData: { seconds: job.seconds, seed } });
    const kill = setTimeout(() => {
      reject(new Error(`timeout: killed at slot end after ${limitMs}ms`));
      w.terminate();
    }, limitMs);
    w.once("message", (r) => (clearTimeout(kill), resolve(r)));
    w.once("error", (e) => (clearTimeout(kill), reject(e)));
    w.once("exit", (code) => (clearTimeout(kill), code !== 0 && reject(new Error(`worker exited ${code}`))));
  });
}
