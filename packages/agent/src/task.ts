// Hand your agent a task, or read back what it delivered. Signed with the agent account's key,
// which you hold as the agent's owner.
//
//   pnpm task --agent AGENT_A --label "triage" --task "Summarise in 3 bullets." --input-file notes.txt \
//             --within 150 --max-pay 0.3 --min-comp 0.05
//   pnpm task --agent AGENT_A --list
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { postPaid, role, sha256, signRequest } from "@qy/shared";

const { values: o } = parseArgs({
  options: {
    agent: { type: "string" }, // .env role of the agent you own, e.g. AGENT_A
    url: { type: "string" }, // the agent's endpoint (default http://localhost:4101)
    list: { type: "boolean", default: false },
    label: { type: "string" },
    task: { type: "string" }, // the instruction
    input: { type: "string" }, // material to work on, inline
    "input-file": { type: "string" }, // ...or from a file
    within: { type: "string", default: "600" }, // seconds from now the result is needed by
    "max-tokens": { type: "string", default: "300" },
    "max-pay": { type: "string", default: "0.2" }, // HBAR: most you'll pay to run earlier
    "min-comp": { type: "string", default: "0.05" }, // HBAR: least you'll accept to wait
  },
});
if (!o.agent || (!o.list && (!o.task || !o.label))) {
  console.error('usage: pnpm task --agent AGENT_X --label "..." --task "..." [--input-file f] [--within s] [--max-pay hbar] [--min-comp hbar]');
  console.error("       pnpm task --agent AGENT_X --list");
  process.exit(2);
}
const me = role(o.agent);
const url = o.url ?? "http://localhost:4101";
const tinybars = (hbar: string) => String(Math.round(Number(hbar) * 1e8));

if (o.list) {
  const r = await postPaid(`${url}/tasks/list`, signRequest("tasks", me.id, me.key, "list"));
  if (r.status !== 200) throw new Error(`${r.status} ${r.body.error}`);
  for (const t of r.body.tasks) {
    const when = new Date(t.deadline * 1000).toLocaleTimeString();
    const outcome = t.onTime === null ? t.status : t.onTime ? "delivered on time" : "delivered late";
    console.log(`\n## ${t.label} (due ${when}, slot ${t.slot ?? "-"}): ${outcome}`);
    if (t.result) console.log(t.result);
  }
  if (!r.body.tasks.length) console.log("no tasks yet");
} else {
  const spec = {
    task: o.task,
    input: o["input-file"] ? readFileSync(o["input-file"], "utf8") : (o.input ?? ""),
    label: o.label,
    deadline: Math.floor(Date.now() / 1000) + Number(o.within),
    maxTokens: Number(o["max-tokens"]),
    maxPay: tinybars(o["max-pay"]!),
    minComp: tinybars(o["min-comp"]!),
  };
  const r = await postPaid(`${url}/tasks`, { spec, ...signRequest("task", me.id, me.key, sha256(JSON.stringify(spec))) });
  if (r.status !== 200) throw new Error(`${r.status} ${r.body.error}`);
  console.log(`booked slot #${r.body.serial}, starts in ${r.body.start - Math.floor(Date.now() / 1000)}s, paid ${Number(r.body.price) / 1e8} HBAR: ${r.body.note}`);
  console.log(`check on it with: pnpm task --agent ${o.agent} --list${o.url ? ` --url ${o.url}` : ""}`);
}
