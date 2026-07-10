CREATE TYPE "public"."amendment_status" AS ENUM('PROPOSED', 'APPROVED', 'REJECTED', 'EXPIRED');--> statement-breakpoint
CREATE TABLE "order_amendment_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"amendment_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"name_snapshot" text NOT NULL,
	"old_quantity" integer NOT NULL,
	"new_quantity" integer NOT NULL,
	"unit_price_cents" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_amendments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"status" "amendment_status" DEFAULT 'PROPOSED' NOT NULL,
	"proposed_by_user_id" uuid NOT NULL,
	"note" text,
	"new_subtotal_cents" integer NOT NULL,
	"new_total_cents" integer NOT NULL,
	"refund_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "order_amendment_items" ADD CONSTRAINT "order_amendment_items_amendment_id_order_amendments_id_fk" FOREIGN KEY ("amendment_id") REFERENCES "public"."order_amendments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_amendment_items" ADD CONSTRAINT "order_amendment_items_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_amendments" ADD CONSTRAINT "order_amendments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_amendments" ADD CONSTRAINT "order_amendments_proposed_by_user_id_users_id_fk" FOREIGN KEY ("proposed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;