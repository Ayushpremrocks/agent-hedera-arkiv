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

/** Run a job to completion. The result digest + iteration count are the proof of work. */
export function runJob(job: Job, seed: string): Promise<{ digest: string; iterations: number }> {
  return new Promise((resolve, reject) => {
    const w = new Worker(CPU_JOB, { eval: true, workerData: { seconds: job.seconds, seed } });
    w.once("message", resolve);
    w.once("error", reject);
    w.once("exit", (code) => code !== 0 && reject(new Error(`worker exited ${code}`)));
  });
}
