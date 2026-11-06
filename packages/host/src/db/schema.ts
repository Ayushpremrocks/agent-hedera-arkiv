// The host's private record. Market truth lives on Hedera; the public trail of agents and tasks is
// mirrored to Arkiv (see mirror.ts). What only the user should see (instructions, inputs, results)
// lives here. Agent keys are never stored: they're derived from the host's master secret.
import { bigint, boolean, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

export const users = pgTable("users", {
  account: text("account").primaryKey(), // Hedera account that signed in
  createdAt: createdAt(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
});

export const agents = pgTable("agents", {
  id: text("id").primaryKey(), // the agent's Hedera account
  owner: text("owner")
    .notNull()
    .unique()
    .references(() => users.account),
  keyIndex: integer("key_index").notNull().default(0), // which derived key this agent uses
  state: jsonb("state"), // the agent's working state (slots held, jobs in flight, listings)
  arkivKey: text("arkiv_key"), // its public qy_agent record
  createdAt: createdAt(),
});

export const tasks = pgTable(
  "tasks",
  {
    jobHash: text("job_hash").primaryKey(),
    owner: text("owner")
      .notNull()
      .references(() => users.account),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    label: text("label").notNull(),
    task: text("task"), // the instruction (private)
    input: text("input"), // the material (private)
    deadline: bigint("deadline", { mode: "number" }).notNull(), // unix seconds
    maxPay: text("max_pay"), // tinybars
    minComp: text("min_comp"), // tinybars
    providerId: text("provider_id"),
    providerName: text("provider_name"),
    serial: integer("serial"),
    start: bigint("start", { mode: "number" }),
    price: text("price"), // what the booking cost, tinybars
    status: text("status").notNull().default("queued"), // queued | running | done | failed
    onTime: boolean("on_time"),
    result: text("result"), // the model's answer (private)
    resultHash: text("result_hash"),
    tokens: integer("tokens"),
    model: text("model"),
    failure: text("failure"),
    finishedAt: bigint("finished_at", { mode: "number" }),
    arkivKey: text("arkiv_key"), // its public qy_task record
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("tasks_owner_created").on(t.owner, t.createdAt)],
);
