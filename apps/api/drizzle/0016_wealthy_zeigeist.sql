ALTER TYPE "public"."driver_request_target" ADD VALUE 'SPECIFIC';--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "requested_driver_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "driver_request_refused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "delivery_batches" ADD COLUMN "target" "driver_request_target" DEFAULT 'GENERAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_batches" ADD COLUMN "requested_driver_id" uuid;--> statement-breakpoint
ALTER TABLE "delivery_batches" ADD COLUMN "refused_at" timestamp with time zone;