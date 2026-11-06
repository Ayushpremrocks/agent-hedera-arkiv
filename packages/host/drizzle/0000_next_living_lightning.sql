CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"key_index" integer DEFAULT 0 NOT NULL,
	"state" jsonb,
	"arkiv_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_owner_unique" UNIQUE("owner")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"job_hash" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"agent_id" text NOT NULL,
	"label" text NOT NULL,
	"task" text,
	"input" text,
	"deadline" bigint NOT NULL,
	"max_pay" text,
	"min_comp" text,
	"provider_id" text,
	"provider_name" text,
	"serial" integer,
	"start" bigint,
	"price" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"on_time" boolean,
	"result" text,
	"result_hash" text,
	"tokens" integer,
	"model" text,
	"failure" text,
	"finished_at" bigint,
	"arkiv_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"account" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_users_account_fk" FOREIGN KEY ("owner") REFERENCES "public"."users"("account") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_owner_users_account_fk" FOREIGN KEY ("owner") REFERENCES "public"."users"("account") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_owner_created" ON "tasks" USING btree ("owner","created_at");