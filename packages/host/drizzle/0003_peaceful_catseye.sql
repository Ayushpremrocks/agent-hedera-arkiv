ALTER TABLE "batches" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "batches" CASCADE;--> statement-breakpoint
DROP INDEX "tasks_batch";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "batch_id";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "batch_index";