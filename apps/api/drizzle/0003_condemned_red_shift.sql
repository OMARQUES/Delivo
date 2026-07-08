CREATE TYPE "public"."delivery_fee_mode" AS ENUM('FIXED', 'DISTANCE');--> statement-breakpoint
CREATE TABLE "stores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"category" text NOT NULL,
	"phone" text NOT NULL,
	"city" text NOT NULL,
	"address_text" text NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"logo_key" text,
	"delivery_fee_mode" "delivery_fee_mode" DEFAULT 'FIXED' NOT NULL,
	"delivery_fixed_fee_cents" integer,
	"delivery_min_fee_cents" integer,
	"delivery_per_km_cents" integer,
	"delivery_max_km" real,
	"min_order_cents" integer,
	"delivery_eta_minutes" jsonb,
	"pickup_eta_minutes" jsonb,
	"opening_hours" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_paused" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stores_slug_unique" ON "stores" USING btree (lower("slug"));--> statement-breakpoint
CREATE UNIQUE INDEX "stores_owner_unique" ON "stores" USING btree ("owner_user_id");