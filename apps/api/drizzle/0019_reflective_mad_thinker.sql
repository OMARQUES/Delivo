CREATE TYPE "public"."offer_acceptance_status" AS ENUM('ACCEPTED', 'DISMISSED');--> statement-breakpoint
CREATE TYPE "public"."driver_offer_status" AS ENUM('OPEN', 'CLOSED');--> statement-breakpoint
CREATE TABLE "driver_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"status" "driver_offer_status" DEFAULT 'OPEN' NOT NULL,
	"daily_rate_cents" integer NOT NULL,
	"per_delivery_cents" integer NOT NULL,
	"slots" integer NOT NULL,
	"accepted_count" integer DEFAULT 0 NOT NULL,
	"recurrence" jsonb NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "driver_offers_slots_valid" CHECK ("driver_offers"."slots" between 1 and 20 and "driver_offers"."accepted_count" between 0 and "driver_offers"."slots")
);
--> statement-breakpoint
CREATE TABLE "offer_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offer_id" uuid NOT NULL,
	"driver_user_id" uuid NOT NULL,
	"status" "offer_acceptance_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "store_drivers" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "driver_offers" ADD CONSTRAINT "driver_offers_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_acceptances" ADD CONSTRAINT "offer_acceptances_offer_id_driver_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."driver_offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_acceptances" ADD CONSTRAINT "offer_acceptances_driver_user_id_users_id_fk" FOREIGN KEY ("driver_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "driver_offers_status_idx" ON "driver_offers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "driver_offers_store_status_idx" ON "driver_offers" USING btree ("store_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "offer_acceptances_offer_driver_unique" ON "offer_acceptances" USING btree ("offer_id","driver_user_id");