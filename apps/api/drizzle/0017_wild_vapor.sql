ALTER TYPE "public"."ledger_entry_type" ADD VALUE 'DRIVER_HALF_FEE_CREDIT';--> statement-breakpoint
ALTER TYPE "public"."ledger_entry_type" ADD VALUE 'STORE_HALF_FEE_DEBIT';--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "driver_arrived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "return_pending_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "return_driver_pay_cents" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "returned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "return_confirmed_by" uuid;