// The public half of the record: every agent and task gets an Arkiv entity anyone can query and check
// (an agent's record is written by the host's key, a task's by the agent that ran it). Writes from
// one key go out one at a time, so they never race on the account's nonce; failures only log, since
// the private record in Postgres is what the app runs on.
import { ExpirationTime } from "@arkiv-network/sdk";
import { u64 } from "@arkiv-network/sdk/schema";
import { AgentRecord, TaskRecord, arkivWriter, evmKey } from "@qy/shared";

type Writer = ReturnType<typeof arkivWriter>;
const AGENT_TTL_DAYS = 30;
const TASK_TTL_DAYS = 7;

const queues = new Map<string, Promise<unknown>>();
function queued<T>(writer: Writer, fn: () => Promise<T>): Promise<T | undefined> {
  const k = writer.account.address;
  const run = (queues.get(k) ?? Promise.resolve()).then(fn).catch((e) => {
    console.error(`arkiv mirror (${k}):`, (e as Error).message);
    return undefined;
  });
  queues.set(k, run);
  return run;
}

const writers = new Map<string, Writer>();
export const writerFor = (key: string) => {
  if (!writers.has(key)) writers.set(key, arkivWriter(evmKey(key)));
  return writers.get(key)!;
};

export function publishAgent(host: Writer, owner: string, agent: string) {
  return queued(host, async () => {
    const { entityKey } = await host.createEntity(AgentRecord, { owner, agent, created_at: u64(Math.floor(Date.now() / 1000)) }, { expiration: ExpirationTime.fromDays(AGENT_TTL_DAYS) });
    return entityKey;
  });
}

/** Keep an agent's public record alive while the host runs it. */
export function renewAgent(host: Writer, key: `0x${string}`) {
  return queued(host, () => host.extendEntity({ entityKey: key, expiration: ExpirationTime.fromDays(AGENT_TTL_DAYS) }));
}

export type TaskPublic = { owner: string; agent: string; jobHash: string; status: string; deadline: number; provider: string; serial: number; resultHash?: string; onTime?: boolean | null; finishedAt?: number };
const fields = (t: TaskPublic) => ({
  owner: t.owner,
  agent: t.agent,
  job_hash: t.jobHash,
  status: t.status,
  deadline: u64(t.deadline),
  provider: t.provider,
  serial: u64(t.serial),
  result_hash: t.resultHash ?? "",
  on_time: t.onTime === true ? "yes" : t.onTime === false ? "no" : "",
  finished_at: u64(t.finishedAt ?? 0),
});

export function publishTask(agent: Writer, t: TaskPublic) {
  return queued(agent, async () => (await agent.createEntity(TaskRecord, fields(t), { expiration: ExpirationTime.fromDays(TASK_TTL_DAYS) })).entityKey);
}

/** Update a task's public record. `key` is read when the write runs, after the create that made it. */
export function updateTask(agent: Writer, key: () => Promise<string | null | undefined>, t: TaskPublic) {
  return queued(agent, async () => {
    const k = await key();
    if (k) await agent.patchEntity(TaskRecord, k as `0x${string}`, { set: fields(t) });
  });
}
