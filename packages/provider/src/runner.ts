import type { Job } from "@qy/shared";

// Any OpenAI-compatible chat endpoint. Defaults to a small local model through Ollama; point these
// at a bigger local model or a hosted API to change what the slots run, with no code change.
export const LLM_BASE_URL = process.env.LLM_BASE_URL ?? "http://localhost:11434/v1";
export const LLM_MODEL = process.env.LLM_MODEL ?? "qwen2.5:0.5b-instruct";
const LLM_API_KEY = process.env.LLM_API_KEY;

/**
 * Run one job on the model, cancelled after `limitMs` (the end of its slot). Cancelling closes the
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
    if ((e as Error).name === "TimeoutError") throw new Error(`timeout: killed at slot end after ${limitMs}ms`);
    throw e;
  }
}

/** Load the model before taking bookings: a cold start can take minutes and would eat a slot. */
export async function warmUp() {
  const t = Date.now();
  await runJob({ kind: "llm", task: "Reply with OK.", input: "ping", maxTokens: 2, deadline: 0, label: "warm-up" }, 600_000);
  return Date.now() - t;
}
