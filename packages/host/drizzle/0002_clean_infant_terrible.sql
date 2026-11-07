CREATE TABLE "batches" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"agent_id" text NOT NULL,
	"label" text NOT NULL,
	"spec" jsonb NOT NULL,
	"items" jsonb NOT NULL,
	"deadline" bigint NOT NULL,
	"booked" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"errors" jsonb,
	"status" text DEFAULT 'booking' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"agent_id" text NOT NULL,
	"label" text NOT NULL,
	"spec" jsonb NOT NULL,
	"every" integer NOT NULL,
	"runs_left" integer NOT NULL,
	"runs_done" integer DEFAULT 0 NOT NULL,
	"next_run" bigint NOT NULL,
	"reserved_for" bigint,
	"active" boolean DEFAULT true NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "batch_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "batch_index" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "schedule_id" text;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_owner_users_account_fk" FOREIGN KEY ("owner") REFERENCES "public"."users"("account") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_owner_users_account_fk" FOREIGN KEY ("owner") REFERENCES "public"."users"("account") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "batches_owner_created" ON "batches" USING btree ("owner","created_at");--> statement-breakpoint
CREATE INDEX "schedules_owner" ON "schedules" USING btree ("owner");--> statement-breakpoint
CREATE INDEX "schedules_due" ON "schedules" USING btree ("active","next_run");--> statement-breakpoint
CREATE INDEX "tasks_batch" ON "tasks" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "tasks_schedule" ON "tasks" USING btree ("schedule_id");