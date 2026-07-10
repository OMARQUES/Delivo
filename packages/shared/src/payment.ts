export const PAYMENT_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'REFUNDED'] as const
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number]

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  PENDING: 'Aguardando pagamento',
  APPROVED: 'Pago',
  REJECTED: 'Recusado',
  CANCELLED: 'Cancelado',
  EXPIRED: 'Expirado',
  REFUNDED: 'Estornado',
}

export const PIX_EXPIRATION_MINUTES = 15

export const PAYMENT_METHODS = ['CASH', 'CARD_MACHINE', 'PIX_ONLINE', 'CARD_ONLINE'] as const
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: 'Dinheiro',
  CARD_MACHINE: 'Maquininha',
  PIX_ONLINE: 'PIX pago online',
  CARD_ONLINE: 'Cartão pago online',
}

export const isPaidOnline = (method: PaymentMethod) => method === 'PIX_ONLINE' || method === 'CARD_ONLINE'
