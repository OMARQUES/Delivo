ALTER TABLE "driver_shifts" ADD COLUMN "adjustment_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "store_drivers" ADD COLUMN "pending_daily_rate_cents" integer;--> statement-breakpoint
ALTER TABLE "store_drivers" ADD COLUMN "pending_per_delivery_cents" integer;--> statement-breakpoint
ALTER TABLE "store_drivers" ADD COLUMN "pending_schedule" jsonb;--> statement-breakpoint
ALTER TABLE "store_drivers" ADD COLUMN "pending_proposed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "store_drivers" ADD CONSTRAINT "store_drivers_pending_terms_complete" CHECK ((
      "store_drivers"."pending_proposed_at" is null
      and "store_drivers"."pending_daily_rate_cents" is null
      and "store_drivers"."pending_per_delivery_cents" is null
      and "store_drivers"."pending_schedule" is null
    ) or (
      "store_drivers"."pending_proposed_at" is not null
      and "store_drivers"."pending_daily_rate_cents" is not null
      and "store_drivers"."pending_per_delivery_cents" is not null
      and "store_drivers"."pending_schedule" is not null
    ));