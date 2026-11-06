import { type Job, MAX_INPUT_CHARS } from "@qy/shared";

// Any OpenAI-compatible chat endpoint. Defaults to a small local model through Ollama; point these
// at a bigger local model or a hosted API to change what the slots run, with no code change.
export const LLM_BASE_URL = process.env.LLM_BASE_URL ?? "http://localhost:11434/v1";
export const LLM_MODEL = process.env.LLM_MODEL ?? "qwen2.5:0.5b-instruct";
const LLM_API_KEY = process.env.LLM_API_KEY;

/**
 * Run one job on the model, streaming its output so the provider knows how far a running job has got
 * (`onToken` is called with the count so far). Stopped only after `limitMs`, for a hung model server;
 * the job's own token cap bounds normal runs. Cancelling closes the request, which stops generation.
 */
export async function runJob(job: Job, limitMs: number, onToken?: (generated: number) => void): Promise<{ text: string; tokens: number }> {
  try {
    const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(limitMs),
      headers: { "content-type": "application/json", ...(LLM_API_KEY ? { authorization: `Bearer ${LLM_API_KEY}` } : {}) },
      body: JSON.stringify({
        model: LLM_MODEL,
        max_tokens: job.maxTokens,
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          { role: "system", content: job.task },
          { role: "user", content: job.input },
        ],
      }),
    });
    if (!res.ok || !res.body) throw new Error(`model server answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    // Server-sent events: one "data: {json}" line per chunk, "data: [DONE]" at the end.
    let text = "";
    let chunks = 0;
    let usage = 0;
    let buf = "";
    const decoder = new TextDecoder();
    for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(part, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:") || line === "data: [DONE]") continue;
        const msg = JSON.parse(line.slice(5));
        const delta = msg.choices?.[0]?.delta?.content;
        if (delta) {
          text += delta;
          onToken?.(++chunks); // one chunk is about one token
        }
        if (msg.usage?.completion_tokens) usage = Number(msg.usage.completion_tokens);
      }
    }
    return { text, tokens: usage || chunks };
  } catch (e) {
    if ((e as Error).name === "TimeoutError") throw new Error(`timeout: hung, stopped after ${limitMs}ms`);
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
  // Long outputs: generation slows as the output grows, so short samples would overstate the speed of big jobs.
  const long = { kind: "llm" as const, task: "Write a long story about a lighthouse keeper. Keep going.", input: "Begin.", maxTokens: 640, deadline: 0, label: "calibrate" };
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
