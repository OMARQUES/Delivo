CREATE TYPE "public"."batch_status" AS ENUM('OPEN', 'PENDING', 'ACCEPTED', 'COLLECTED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "delivery_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"driver_id" uuid,
	"status" "batch_status" DEFAULT 'OPEN' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
ALTER TABLE "delivery_batches" ADD CONSTRAINT "delivery_batches_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delivery_batches_store_status_idx" ON "delivery_batches" USING btree ("store_id","status");--> statement-breakpoint
CREATE INDEX "delivery_batches_status_idx" ON "delivery_batches" USING btree ("status");--> statement-breakpoint
CREATE INDEX "orders_batch_idx" ON "orders" USING btree ("batch_id");