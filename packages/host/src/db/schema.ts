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
    rushPaid: text("rush_paid"), // paid to another agent to move this task ahead, tinybars
    status: text("status").notNull().default("queued"), // queued | running | done | failed
    onTime: boolean("on_time"),
    result: text("result"), // the model's answer (private)
    resultHash: text("result_hash"),
    tokens: integer("tokens"),
    model: text("model"),
    failure: text("failure"),
    finishedAt: bigint("finished_at", { mode: "number" }),
    arkivKey: text("arkiv_key"), // its public qy_task record
    batchId: text("batch_id"), // set when booked as part of a batch
    batchIndex: integer("batch_index"), // its item number in that batch (0-based)
    scheduleId: text("schedule_id"), // set when booked by a recurring schedule
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("tasks_owner_created").on(t.owner, t.createdAt), index("tasks_batch").on(t.batchId), index("tasks_schedule").on(t.scheduleId)],
);

/** What every job of a batch or schedule shares. Inputs are private, like a task's. */
export type JobSpec = { task: string; input?: string; withinSeconds: number; maxTokens: number; maxPay: string; minComp: string; provider?: string };

/** One set of instructions over many inputs: each item becomes its own job, booked in the background. */
export const batches = pgTable(
  "batches",
  {
    id: text("id").primaryKey(),
    owner: text("owner")
      .notNull()
      .references(() => users.account),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    label: text("label").notNull(),
    spec: jsonb("spec").$type<JobSpec>().notNull(),
    items: jsonb("items").$type<string[]>().notNull(), // one input per job (private)
    deadline: bigint("deadline", { mode: "number" }).notNull(), // every job's deadline, unix seconds
    booked: integer("booked").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    errors: jsonb("errors").$type<{ index: number; error: string }[]>(),
    status: text("status").notNull().default("booking"), // booking | booked | cancelled
    createdAt: createdAt(),
  },
  (t) => [index("batches_owner_created").on(t.owner, t.createdAt)],
);

/** A job that runs again every `every` seconds; each run's capacity is reserved ahead of time. */
export const schedules = pgTable(
  "schedules",
  {
    id: text("id").primaryKey(),
    owner: text("owner")
      .notNull()
      .references(() => users.account),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    label: text("label").notNull(),
    spec: jsonb("spec").$type<JobSpec>().notNull(),
    every: integer("every").notNull(), // seconds between runs
    runsLeft: integer("runs_left").notNull(),
    runsDone: integer("runs_done").notNull().default(0),
    nextRun: bigint("next_run", { mode: "number" }).notNull(), // unix seconds
    reservedFor: bigint("reserved_for", { mode: "number" }), // the run time capacity is already reserved for
    active: boolean("active").notNull().default(true),
    lastError: text("last_error"),
    createdAt: createdAt(),
  },
  (t) => [index("schedules_owner").on(t.owner), index("schedules_due").on(t.active, t.nextRun)],
);
