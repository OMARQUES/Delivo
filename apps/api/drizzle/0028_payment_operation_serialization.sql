CREATE TYPE "public"."payment_operation_result_code" AS ENUM('CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'ESCALATED_TO_REFUND');--> statement-breakpoint
ALTER TABLE "payment_operations" ADD COLUMN "expected_refunded_amount_cents" integer;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD COLUMN "depends_on_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD COLUMN "result_code" "payment_operation_result_code";--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_depends_on_operation_id_payment_operations_id_fk" FOREIGN KEY ("depends_on_operation_id") REFERENCES "public"."payment_operations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_operations_dependency_idx" ON "payment_operations" USING btree ("depends_on_operation_id","status");--> statement-breakpoint
UPDATE "payment_operations" AS operation
SET "expected_refunded_amount_cents" = CASE
  WHEN operation."type" = 'REFUND_FULL' THEN payment."expected_amount_cents"
  WHEN operation."type" = 'REFUND_PARTIAL' THEN LEAST(payment."expected_amount_cents", payment."refunded_amount_cents" + operation."amount_cents")
  ELSE NULL
END
FROM "payments" AS payment
WHERE operation."payment_id" = payment."id"
  AND operation."expected_refunded_amount_cents" IS NULL;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_expected_refund_valid" CHECK (("payment_operations"."type" = 'CANCEL' and "payment_operations"."expected_refunded_amount_cents" is null) or ("payment_operations"."type" in ('REFUND_FULL', 'REFUND_PARTIAL') and "payment_operations"."expected_refunded_amount_cents" > 0));
