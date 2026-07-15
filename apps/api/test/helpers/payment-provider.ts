import { vi } from 'vitest'
import type { PaymentProvider, ProviderOrderSnapshot } from '../../src/payments/provider'

export function providerSnapshot(overrides: Partial<ProviderOrderSnapshot> = {}): ProviderOrderSnapshot {
  return {
    providerOrderId: 'order-test',
    providerTransactionId: 'transaction-test',
    orderStatus: 'processed',
    orderStatusDetail: 'accredited',
    transactionStatus: 'processed',
    transactionStatusDetail: 'accredited',
    externalReference: 'order-local',
    totalAmountCents: 6400,
    refundedAmountCents: 0,
    countryCode: 'BR',
    currency: 'BRL',
    processingMode: 'automatic',
    method: 'PIX',
    paymentMethodId: 'pix',
    applicationId: 'app-test',
    accountId: 'account-test',
    liveMode: false,
    transactionCount: 1,
    pix: {
      qrCode: 'qr-test',
      qrCodeBase64: 'qr-base64-test',
      ticketUrl: null,
      expiresAt: new Date('2026-07-15T12:15:00.000Z'),
    },
    updatedAt: new Date('2026-07-15T12:00:00.000Z'),
    ...overrides,
  }
}

export function fakePaymentProvider(overrides: Partial<PaymentProvider> = {}): PaymentProvider {
  const snapshot = providerSnapshot()
  return {
    createOrder: vi.fn(async () => snapshot),
    getOrder: vi.fn(async () => snapshot),
    searchOrders: vi.fn(async () => [snapshot]),
    cancelOrder: vi.fn(async () => providerSnapshot({ orderStatus: 'canceled', orderStatusDetail: 'canceled' })),
    refundOrder: vi.fn(async () => providerSnapshot({ orderStatus: 'refunded', orderStatusDetail: 'refunded', refundedAmountCents: 6400 })),
    refundPartial: vi.fn(async (_orderId, _transactionId, amountCents) => providerSnapshot({
      orderStatus: 'processed',
      orderStatusDetail: 'partially_refunded',
      refundedAmountCents: amountCents,
    })),
    getAccountId: vi.fn(async () => 'account-test'),
    ...overrides,
  }
}
