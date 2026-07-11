CREATE TYPE "public"."shift_daily_decision" AS ENUM('PENDING', 'APPROVED', 'REJECTED');--> statement-breakpoint
ALTER TYPE "public"."shift_status" ADD VALUE 'PENDING_DAILY' BEFORE 'CLOSED';--> statement-breakpoint
ALTER TYPE "public"."shift_status" ADD VALUE 'REOPEN_ALLOWED' BEFORE 'CLOSED';--> statement-breakpoint
ALTER TABLE "driver_shifts" ADD COLUMN "daily_decision" "shift_daily_decision";--> statement-breakpoint
ALTER TABLE "driver_shifts" ADD COLUMN "daily_decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "driver_shifts" ADD COLUMN "daily_decided_by" uuid;--> statement-breakpoint
ALTER TABLE "driver_shifts" ADD COLUMN "daily_decision_reason" text;--> statement-breakpoint
ALTER TABLE "driver_shifts" ADD COLUMN "auto_approve_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "driver_shifts" ADD COLUMN "reopen_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "driver_shifts" ADD COLUMN "reopen_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "driver_shifts" SET "daily_decision" = 'APPROVED', "daily_decided_at" = "ended_at" WHERE "status" = 'CLOSED';--> statement-breakpoint
ALTER TABLE "driver_shifts" ADD CONSTRAINT "driver_shifts_daily_decided_by_users_id_fk" FOREIGN KEY ("daily_decided_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
