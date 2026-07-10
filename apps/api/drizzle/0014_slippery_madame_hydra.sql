CREATE TYPE "public"."driver_request_target" AS ENUM('GENERAL', 'OWN');--> statement-breakpoint
CREATE TYPE "public"."shift_closed_by" AS ENUM('DRIVER', 'STORE', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "public"."shift_status" AS ENUM('ACTIVE', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."store_driver_status" AS ENUM('INVITED', 'CONFIRMED', 'REMOVED');--> statement-breakpoint
ALTER TYPE "public"."ledger_entry_type" ADD VALUE 'STORE_PER_DELIVERY_DEBIT';--> statement-breakpoint
ALTER TYPE "public"."ledger_entry_type" ADD VALUE 'STORE_DAILY_RATE_DEBIT';--> statement-breakpoint
ALTER TYPE "public"."ledger_entry_type" ADD VALUE 'DRIVER_PER_DELIVERY_CREDIT';--> statement-breakpoint
ALTER TYPE "public"."ledger_entry_type" ADD VALUE 'DRIVER_DAILY_RATE_CREDIT';--> statement-breakpoint
CREATE TABLE "driver_shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"driver_user_id" uuid NOT NULL,
	"status" "shift_status" DEFAULT 'ACTIVE' NOT NULL,
	"daily_rate_cents" integer NOT NULL,
	"per_delivery_cents" integer NOT NULL,
	"work_date" date NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"scheduled_end_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"early_close" boolean DEFAULT false NOT NULL,
	"closed_by" "shift_closed_by"
);
--> statement-breakpoint
CREATE TABLE "store_drivers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"driver_user_id" uuid NOT NULL,
	"status" "store_driver_status" DEFAULT 'INVITED' NOT NULL,
	"daily_rate_cents" integer DEFAULT 0 NOT NULL,
	"per_delivery_cents" integer DEFAULT 0 NOT NULL,
	"schedule" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ledger_entries" ALTER COLUMN "order_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shift_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "driver_request_target" "driver_request_target";--> statement-breakpoint
UPDATE "orders" SET "driver_request_target" = 'GENERAL' WHERE "driver_requested_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "driver_shifts" ADD CONSTRAINT "driver_shifts_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_shifts" ADD CONSTRAINT "driver_shifts_driver_user_id_users_id_fk" FOREIGN KEY ("driver_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_drivers" ADD CONSTRAINT "store_drivers_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_drivers" ADD CONSTRAINT "store_drivers_driver_user_id_users_id_fk" FOREIGN KEY ("driver_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "driver_shifts_driver_store_day_unique" ON "driver_shifts" USING btree ("driver_user_id","store_id","work_date");--> statement-breakpoint
CREATE UNIQUE INDEX "driver_shifts_one_active_per_driver" ON "driver_shifts" USING btree ("driver_user_id") WHERE "driver_shifts"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "driver_shifts_store_status_idx" ON "driver_shifts" USING btree ("store_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "store_drivers_unique" ON "store_drivers" USING btree ("store_id","driver_user_id");--> statement-breakpoint
CREATE INDEX "orders_shift_idx" ON "orders" USING btree ("shift_id");
