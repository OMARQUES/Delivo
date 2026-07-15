CREATE TYPE "public"."payment_operation_status" AS ENUM('PENDING', 'PROCESSING', 'SUCCEEDED', 'REVIEW_REQUIRED');--> statement-breakpoint
CREATE TYPE "public"."payment_operation_type" AS ENUM('CANCEL', 'REFUND_FULL', 'REFUND_PARTIAL');--> statement-breakpoint
CREATE TYPE "public"."payment_reconciliation_state" AS ENUM('PENDING', 'HEALTHY', 'REVIEW_REQUIRED');--> statement-breakpoint
CREATE TYPE "public"."payment_webhook_status" AS ENUM('PENDING', 'PROCESSING', 'PROCESSED', 'REVIEW_REQUIRED');--> statement-breakpoint
DROP TABLE "payments";--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"provider" text DEFAULT 'MERCADO_PAGO' NOT NULL,
	"provider_order_id" text,
	"provider_transaction_id" text,
	"status" "payment_status" DEFAULT 'PENDING' NOT NULL,
	"method" "payment_gateway_method" NOT NULL,
	"expected_amount_cents" integer NOT NULL,
	"expected_currency" text DEFAULT 'BRL' NOT NULL,
	"expected_country" text DEFAULT 'BR' NOT NULL,
	"create_idempotency_key" text NOT NULL,
	"provider_status" text,
	"provider_status_detail" text,
	"reconciliation_state" "payment_reconciliation_state" DEFAULT 'PENDING' NOT NULL,
	"reconciliation_failure" text,
	"refunded_amount_cents" integer DEFAULT 0 NOT NULL,
	"qr_code" text,
	"qr_code_base64" text,
	"ticket_url" text,
	"expires_at" timestamp with time zone,
	"next_reconcile_at" timestamp with time zone,
	"last_reconciled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_expected_amount_positive" CHECK ("payments"."expected_amount_cents" > 0),
	CONSTRAINT "payments_refunded_amount_valid" CHECK ("payments"."refunded_amount_cents" >= 0 and "payments"."refunded_amount_cents" <= "payments"."expected_amount_cents"),
	CONSTRAINT "payments_pix_artifacts_only" CHECK ("payments"."method" = 'PIX' or ("payments"."qr_code" is null and "payments"."qr_code_base64" is null and "payments"."ticket_url" is null)),
	CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "payment_webhook_inbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text DEFAULT 'MERCADO_PAGO' NOT NULL,
	"topic" text NOT NULL,
	"resource_id" text NOT NULL,
	"request_id" text NOT NULL,
	"signature_timestamp" text,
	"status" "payment_webhook_status" DEFAULT 'PENDING' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"lease_owner" text,
	"leased_until" timestamp with time zone,
	"failure_class" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_webhook_inbox_attempt_count_valid" CHECK ("payment_webhook_inbox"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payment_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"type" "payment_operation_type" NOT NULL,
	"amount_cents" integer,
	"business_key" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "payment_operation_status" DEFAULT 'PENDING' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"lease_owner" text,
	"leased_until" timestamp with time zone,
	"failure_class" text,
	"observed_provider_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_operations_attempt_count_valid" CHECK ("payment_operations"."attempt_count" >= 0),
	CONSTRAINT "payment_operations_amount_valid" CHECK (("payment_operations"."type" = 'REFUND_PARTIAL' and "payment_operations"."amount_cents" > 0) or ("payment_operations"."type" <> 'REFUND_PARTIAL' and "payment_operations"."amount_cents" is null)),
	CONSTRAINT "payment_operations_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payments_create_idempotency_unique" ON "payments" USING btree ("create_idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_order_unique" ON "payments" USING btree ("provider","provider_order_id") WHERE "payments"."provider_order_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_transaction_unique" ON "payments" USING btree ("provider","provider_transaction_id") WHERE "payments"."provider_transaction_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_webhook_inbox_dedupe_unique" ON "payment_webhook_inbox" USING btree ("provider","topic","resource_id","request_id");--> statement-breakpoint
CREATE INDEX "payment_webhook_inbox_status_next_attempt_idx" ON "payment_webhook_inbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_operations_business_key_unique" ON "payment_operations" USING btree ("business_key");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_operations_idempotency_key_unique" ON "payment_operations" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "payment_operations_status_next_attempt_idx" ON "payment_operations" USING btree ("status","next_attempt_at");
