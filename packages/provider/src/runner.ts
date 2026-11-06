import { type Job, MAX_INPUT_CHARS } from "@qy/shared";

// Any OpenAI-compatible chat endpoint. Defaults to a small local model through Ollama; point these
// at a bigger local model or a hosted API to change what the slots run, with no code change.
export const LLM_BASE_URL = process.env.LLM_BASE_URL ?? "http://localhost:11434/v1";
export const LLM_MODEL = process.env.LLM_MODEL ?? "qwen2.5:0.5b-instruct";
const LLM_API_KEY = process.env.LLM_API_KEY;

/**
 * Run one job on the model, cancelled after `limitMs` (its ticket's run-time limit). Cancelling closes the
 * request, which stops generation on the server, so a job can never hold a worker past its slot.
 */
export async function runJob(job: Job, limitMs: number): Promise<{ text: string; tokens: number }> {
  try {
    const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(limitMs),
      headers: { "content-type": "application/json", ...(LLM_API_KEY ? { authorization: `Bearer ${LLM_API_KEY}` } : {}) },
      body: JSON.stringify({
        model: LLM_MODEL,
        max_tokens: job.maxTokens,
        messages: [
          { role: "system", content: job.task },
          { role: "user", content: job.input },
        ],
      }),
    });
    if (!res.ok) throw new Error(`model server answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const r = (await res.json()) as any;
    return { text: String(r.choices?.[0]?.message?.content ?? ""), tokens: Number(r.usage?.completion_tokens ?? 0) };
  } catch (e) {
    if ((e as Error).name === "TimeoutError") throw new Error(`timeout: killed at the run-time limit after ${limitMs}ms`);
    throw e;
  }
}

/**
 * Measure worst-case speed: every worker generating at once (the GPU is shared, so this is the slow
 * case), plus the fixed startup a one-token job takes. Promises are built on these numbers.
 */
export async function calibrate(workers: number): Promise<{ tps: number; startupMs: number }> {
  // Startup includes reading the prompt, so measure it with the longest input a job may send, on every
  // worker at once: that's the slowest a job can get to its first token.
  // Each prompt starts differently: the model server caches prompts it has seen, which would hide the cost.
  const longest = () => ({
    kind: "llm" as const,
    task: `Reply with OK. (${Math.random()})`,
    input: "lorem ipsum dolor sit amet ".repeat(Math.floor(MAX_INPUT_CHARS / 27)),
    maxTokens: 1,
    deadline: 0,
    label: "calibrate",
  });
  const startups = await Promise.all(
    Array.from({ length: workers }, async () => {
      const t = Date.now();
      await runJob(longest(), 120_000);
      return Date.now() - t;
    }),
  );
  const startupMs = Math.max(...startups);
  // Generation speed is measured on a short prompt, so subtract a short prompt's own startup.
  const t1 = Date.now();
  await runJob({ kind: "llm", task: "Reply with OK.", input: "ping", maxTokens: 1, deadline: 0, label: "calibrate" }, 60_000);
  const shortStartupMs = Date.now() - t1;
  const long = { kind: "llm" as const, task: "Write a long story about a lighthouse keeper. Keep going.", input: "Begin.", maxTokens: 160, deadline: 0, label: "calibrate" };
  // Speed varies run to run on a shared GPU: promise on the slowest of a few rounds.
  const runs: number[] = [];
  for (let round = 0; round < 3; round++)
    runs.push(
      ...(await Promise.all(
        Array.from({ length: workers }, async () => {
          const t0 = Date.now();
          const r = await runJob(long, 120_000);
          return r.tokens / Math.max(0.001, (Date.now() - t0 - shortStartupMs) / 1000);
        }),
      )),
    );
  return { tps: Math.min(...runs), startupMs };
}

/** Load the model before taking bookings: a cold start can take minutes and would eat a slot. */
export async function warmUp() {
  const t = Date.now();
  await runJob({ kind: "llm", task: "Reply with OK.", input: "ping", maxTokens: 2, deadline: 0, label: "warm-up" }, 600_000);
  return Date.now() - t;
}
