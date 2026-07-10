CREATE TYPE "public"."payment_gateway_method" AS ENUM('PIX', 'CARD');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'REFUNDED');--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"provider" text DEFAULT 'MERCADO_PAGO' NOT NULL,
	"provider_payment_id" text NOT NULL,
	"status" "payment_status" DEFAULT 'PENDING' NOT NULL,
	"method" "payment_gateway_method" NOT NULL,
	"amount_cents" integer NOT NULL,
	"qr_code" text,
	"qr_code_base64" text,
	"ticket_url" text,
	"expires_at" timestamp with time zone,
	"refunded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "pix_key" text;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "pix_key" text;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_id_unique" ON "payments" USING btree ("provider","provider_payment_id");
