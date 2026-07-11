ALTER TABLE "orders" ADD COLUMN "driver_returned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "return_photo_keys" jsonb DEFAULT '[]'::jsonb NOT NULL;