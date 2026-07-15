import { type AnyPgColumn, boolean, check, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { PAYMENT_STATUSES } from '@delivery/shared/constants'
import { orders } from './orders'

export const paymentStatus = pgEnum('payment_status', PAYMENT_STATUSES)
export const paymentGatewayMethod = pgEnum('payment_gateway_method', ['PIX', 'CARD'])
export const paymentReconciliationState = pgEnum('payment_reconciliation_state', ['PENDING', 'HEALTHY', 'REVIEW_REQUIRED'])
export const paymentWebhookStatus = pgEnum('payment_webhook_status', ['PENDING', 'PROCESSING', 'PROCESSED', 'REVIEW_REQUIRED'])
export const paymentOperationStatus = pgEnum('payment_operation_status', ['PENDING', 'PROCESSING', 'SUCCEEDED', 'REVIEW_REQUIRED'])
export const paymentOperationType = pgEnum('payment_operation_type', ['CANCEL', 'REFUND_FULL', 'REFUND_PARTIAL'])
export const paymentOperationResultCode = pgEnum('payment_operation_result_code', [
  'CANCELLED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
  'ESCALATED_TO_REFUND',
])

export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull().references(() => orders.id, { onDelete: 'restrict' }),
  provider: text('provider').notNull().default('MERCADO_PAGO'),
  providerOrderId: text('provider_order_id'),
  providerTransactionId: text('provider_transaction_id'),
  status: paymentStatus('status').notNull().default('PENDING'),
  method: paymentGatewayMethod('method').notNull(),
  expectedAmountCents: integer('expected_amount_cents').notNull(),
  expectedCurrency: text('expected_currency').notNull().default('BRL'),
  expectedCountry: text('expected_country').notNull().default('BR'),
  expectedApplicationId: text('expected_application_id').notNull(),
  expectedAccountId: text('expected_account_id').notNull(),
  expectedLiveMode: boolean('expected_live_mode').notNull(),
  createIdempotencyKey: text('create_idempotency_key').notNull(),
  providerStatus: text('provider_status'),
  providerStatusDetail: text('provider_status_detail'),
  reconciliationState: paymentReconciliationState('reconciliation_state').notNull().default('PENDING'),
  reconciliationFailure: text('reconciliation_failure'),
  reconciliationAttemptCount: integer('reconciliation_attempt_count').notNull().default(0),
  refundedAmountCents: integer('refunded_amount_cents').notNull().default(0),
  qrCode: text('qr_code'),
  qrCodeBase64: text('qr_code_base64'),
  ticketUrl: text('ticket_url'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  nextReconcileAt: timestamp('next_reconcile_at', { withTimezone: true }),
  lastReconciledAt: timestamp('last_reconciled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  uniqueIndex('payments_create_idempotency_unique').on(t.createIdempotencyKey),
  uniqueIndex('payments_provider_order_unique').on(t.provider, t.providerOrderId).where(sql`${t.providerOrderId} is not null`),
  uniqueIndex('payments_provider_transaction_unique').on(t.provider, t.providerTransactionId).where(sql`${t.providerTransactionId} is not null`),
  check('payments_expected_amount_positive', sql`${t.expectedAmountCents} > 0`),
  check('payments_refunded_amount_valid', sql`${t.refundedAmountCents} >= 0 and ${t.refundedAmountCents} <= ${t.expectedAmountCents}`),
  check('payments_reconciliation_attempt_count_valid', sql`${t.reconciliationAttemptCount} >= 0`),
  check('payments_pix_artifacts_only', sql`${t.method} = 'PIX' or (${t.qrCode} is null and ${t.qrCodeBase64} is null and ${t.ticketUrl} is null)`),
])

export const paymentWebhookInbox = pgTable('payment_webhook_inbox', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: text('provider').notNull().default('MERCADO_PAGO'),
  topic: text('topic').notNull(),
  resourceId: text('resource_id').notNull(),
  requestId: text('request_id').notNull(),
  signatureTimestamp: text('signature_timestamp'),
  status: paymentWebhookStatus('status').notNull().default('PENDING'),
  attemptCount: integer('attempt_count').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
  leaseOwner: text('lease_owner'),
  leasedUntil: timestamp('leased_until', { withTimezone: true }),
  failureClass: text('failure_class'),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  uniqueIndex('payment_webhook_inbox_dedupe_unique').on(t.provider, t.topic, t.resourceId, t.requestId),
  index('payment_webhook_inbox_status_next_attempt_idx').on(t.status, t.nextAttemptAt),
  check('payment_webhook_inbox_attempt_count_valid', sql`${t.attemptCount} >= 0`),
])

export const paymentOperations = pgTable('payment_operations', {
  id: uuid('id').primaryKey().defaultRandom(),
  paymentId: uuid('payment_id').notNull().references(() => payments.id, { onDelete: 'restrict' }),
  type: paymentOperationType('type').notNull(),
  amountCents: integer('amount_cents'),
  expectedRefundedAmountCents: integer('expected_refunded_amount_cents'),
  dependsOnOperationId: uuid('depends_on_operation_id').references((): AnyPgColumn => paymentOperations.id, { onDelete: 'restrict' }),
  businessKey: text('business_key').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  status: paymentOperationStatus('status').notNull().default('PENDING'),
  resultCode: paymentOperationResultCode('result_code'),
  attemptCount: integer('attempt_count').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
  leaseOwner: text('lease_owner'),
  leasedUntil: timestamp('leased_until', { withTimezone: true }),
  failureClass: text('failure_class'),
  observedProviderStatus: text('observed_provider_status'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  uniqueIndex('payment_operations_business_key_unique').on(t.businessKey),
  uniqueIndex('payment_operations_idempotency_key_unique').on(t.idempotencyKey),
  index('payment_operations_status_next_attempt_idx').on(t.status, t.nextAttemptAt),
  index('payment_operations_dependency_idx').on(t.dependsOnOperationId, t.status),
  check('payment_operations_attempt_count_valid', sql`${t.attemptCount} >= 0`),
  check('payment_operations_amount_valid', sql`(${t.type} = 'REFUND_PARTIAL' and ${t.amountCents} > 0) or (${t.type} <> 'REFUND_PARTIAL' and ${t.amountCents} is null)`),
  check('payment_operations_expected_refund_valid', sql`(${t.type} = 'CANCEL' and ${t.expectedRefundedAmountCents} is null) or (${t.type} in ('REFUND_FULL', 'REFUND_PARTIAL') and ${t.expectedRefundedAmountCents} > 0)`),
])
