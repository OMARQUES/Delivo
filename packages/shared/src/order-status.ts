export const ORDER_STATUSES = [
  'AWAITING_PAYMENT',
  'PENDING',
  'ACCEPTED',
  'PREPARING',
  'READY',
  'AWAITING_DRIVER',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'DELIVERY_FAILED',
  'CANCELLED',
] as const

export type OrderStatus = (typeof ORDER_STATUSES)[number]

const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  // pagamento online: nasce aqui; PIX expirado/cartão desistido -> CANCELLED
  AWAITING_PAYMENT: ['PENDING', 'CANCELLED'],
  PENDING: ['ACCEPTED', 'CANCELLED'],
  ACCEPTED: ['PREPARING', 'CANCELLED'],
  PREPARING: ['READY', 'CANCELLED'],
  // READY -> OUT_FOR_DELIVERY: entregador próprio ou dispatch antecipado já atribuído
  // READY -> DELIVERED: retirada no balcão (fulfillment PICKUP)
  READY: ['AWAITING_DRIVER', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED'],
  AWAITING_DRIVER: ['OUT_FOR_DELIVERY', 'CANCELLED'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'DELIVERY_FAILED'],
  DELIVERED: [],
  DELIVERY_FAILED: [],
  CANCELLED: [],
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false
}

export function isTerminal(status: OrderStatus): boolean {
  return TRANSITIONS[status].length === 0
}

/** Labels PT-BR para exibição nos frontends */
export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  AWAITING_PAYMENT: 'Aguardando pagamento',
  PENDING: 'Aguardando confirmação',
  ACCEPTED: 'Confirmado',
  PREPARING: 'Em preparo',
  READY: 'Pronto',
  AWAITING_DRIVER: 'Aguardando entregador',
  OUT_FOR_DELIVERY: 'Saiu para entrega',
  DELIVERED: 'Entregue',
  DELIVERY_FAILED: 'Entrega não realizada',
  CANCELLED: 'Cancelado',
}
