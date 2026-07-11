CREATE TYPE "public"."shift_authorization_status" AS ENUM('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'USED');--> statement-breakpoint
CREATE TYPE "public"."shift_term_proposal_status" AS ENUM('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "shift_start_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_driver_id" uuid NOT NULL,
	"work_date" date NOT NULL,
	"status" "shift_authorization_status" DEFAULT 'PENDING' NOT NULL,
	"authorized_until" timestamp with time zone NOT NULL,
	"scheduled_start_at" timestamp with time zone NOT NULL,
	"scheduled_end_at" timestamp with time zone NOT NULL,
	"daily_rate_cents" integer NOT NULL,
	"per_delivery_cents" integer NOT NULL,
	"note" text NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shift_term_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shift_id" uuid NOT NULL,
	"status" "shift_term_proposal_status" DEFAULT 'PENDING' NOT NULL,
	"daily_rate_cents" integer NOT NULL,
	"per_delivery_cents" integer NOT NULL,
	"apply_retroactive" boolean DEFAULT false NOT NULL,
	"note" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "driver_shifts" ADD COLUMN "store_driver_id" uuid;--> statement-breakpoint
ALTER TABLE "driver_shifts" ADD COLUMN "scheduled_start_at" timestamp with time zone;--> statement-breakpoint
UPDATE "driver_shifts" ds SET "store_driver_id" = sd."id" FROM "store_drivers" sd WHERE sd."store_id" = ds."store_id" AND sd."driver_user_id" = ds."driver_user_id";--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM "driver_shifts" WHERE "store_driver_id" IS NULL) THEN RAISE EXCEPTION 'driver_shifts sem store_driver para backfill'; END IF; END $$;--> statement-breakpoint
ALTER TABLE "driver_shifts" ALTER COLUMN "store_driver_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "shift_start_authorizations" ADD CONSTRAINT "shift_start_authorizations_store_driver_id_store_drivers_id_fk" FOREIGN KEY ("store_driver_id") REFERENCES "public"."store_drivers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_term_proposals" ADD CONSTRAINT "shift_term_proposals_shift_id_driver_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."driver_shifts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shift_auth_one_open_per_occurrence" ON "shift_start_authorizations" USING btree ("store_driver_id","work_date") WHERE "shift_start_authorizations"."status" in ('PENDING', 'ACCEPTED');--> statement-breakpoint
CREATE INDEX "shift_auth_link_status_idx" ON "shift_start_authorizations" USING btree ("store_driver_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "shift_terms_one_pending" ON "shift_term_proposals" USING btree ("shift_id") WHERE "shift_term_proposals"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "shift_terms_shift_status_idx" ON "shift_term_proposals" USING btree ("shift_id","status");--> statement-breakpoint
ALTER TABLE "driver_shifts" ADD CONSTRAINT "driver_shifts_store_driver_id_store_drivers_id_fk" FOREIGN KEY ("store_driver_id") REFERENCES "public"."store_drivers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
DROP INDEX "driver_shifts_driver_store_day_unique";--> statement-breakpoint
DROP INDEX "store_drivers_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "driver_shifts_link_day_unique" ON "driver_shifts" USING btree ("store_driver_id","work_date");--> statement-breakpoint
CREATE INDEX "store_drivers_driver_status_idx" ON "store_drivers" USING btree ("driver_user_id","status");--> statement-breakpoint
CREATE INDEX "store_drivers_store_status_idx" ON "store_drivers" USING btree ("store_id","status");
