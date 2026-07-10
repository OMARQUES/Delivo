CREATE TYPE "public"."finance_document_status" AS ENUM('OPEN', 'PAID');--> statement-breakpoint
CREATE TYPE "public"."ledger_entry_type" AS ENUM('STORE_SALE_CREDIT', 'STORE_COMMISSION_DEBIT', 'STORE_DRIVER_FEE_DEBIT', 'DRIVER_DELIVERY_CREDIT');--> statement-breakpoint
CREATE TYPE "public"."ledger_party" AS ENUM('STORE', 'DRIVER');--> statement-breakpoint
CREATE TABLE "driver_payout_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payout_id" uuid NOT NULL,
	"ledger_entry_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "driver_payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"driver_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"status" "finance_document_status" DEFAULT 'OPEN' NOT NULL,
	"total_cents" integer NOT NULL,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"party" "ledger_party" NOT NULL,
	"type" "ledger_entry_type" NOT NULL,
	"amount_cents" integer NOT NULL,
	"description" text NOT NULL,
	"unique_key" text NOT NULL,
	"order_id" uuid NOT NULL,
	"store_id" uuid,
	"driver_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "store_invoice_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"ledger_entry_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "store_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"status" "finance_document_status" DEFAULT 'OPEN' NOT NULL,
	"total_cents" integer NOT NULL,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "store_payout_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payout_id" uuid NOT NULL,
	"ledger_entry_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "store_payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"status" "finance_document_status" DEFAULT 'OPEN' NOT NULL,
	"total_cents" integer NOT NULL,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "commission_bps" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "driver_payout_items" ADD CONSTRAINT "driver_payout_items_payout_id_driver_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."driver_payouts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_payout_items" ADD CONSTRAINT "driver_payout_items_ledger_entry_id_ledger_entries_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."ledger_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_payouts" ADD CONSTRAINT "driver_payouts_driver_id_users_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_driver_id_users_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_invoice_items" ADD CONSTRAINT "store_invoice_items_invoice_id_store_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."store_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_invoice_items" ADD CONSTRAINT "store_invoice_items_ledger_entry_id_ledger_entries_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."ledger_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_invoices" ADD CONSTRAINT "store_invoices_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_payout_items" ADD CONSTRAINT "store_payout_items_payout_id_store_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."store_payouts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_payout_items" ADD CONSTRAINT "store_payout_items_ledger_entry_id_ledger_entries_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."ledger_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_payouts" ADD CONSTRAINT "store_payouts_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "driver_payout_items_ledger_unique" ON "driver_payout_items" USING btree ("ledger_entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "driver_payouts_period_unique" ON "driver_payouts" USING btree ("driver_id","period_start","period_end");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_unique_key" ON "ledger_entries" USING btree ("unique_key");--> statement-breakpoint
CREATE UNIQUE INDEX "store_invoice_items_ledger_unique" ON "store_invoice_items" USING btree ("ledger_entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "store_invoices_period_unique" ON "store_invoices" USING btree ("store_id","period_start","period_end");--> statement-breakpoint
CREATE UNIQUE INDEX "store_payout_items_ledger_unique" ON "store_payout_items" USING btree ("ledger_entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "store_payouts_period_unique" ON "store_payouts" USING btree ("store_id","period_start","period_end");