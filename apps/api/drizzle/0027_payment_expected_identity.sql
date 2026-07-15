DROP INDEX "payments_provider_order_unique";--> statement-breakpoint
DROP INDEX "payments_provider_transaction_unique";--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "expected_application_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "expected_account_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "expected_live_mode" boolean NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_order_unique" ON "payments" USING btree ("provider","provider_order_id") WHERE "payments"."provider_order_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_transaction_unique" ON "payments" USING btree ("provider","provider_transaction_id") WHERE "payments"."provider_transaction_id" is not null;