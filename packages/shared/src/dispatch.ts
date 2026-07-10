export const DELIVERY_FAIL_REASONS = ['NO_ANSWER', 'WRONG_ADDRESS', 'REFUSED_PAYMENT', 'OTHER'] as const
export type DeliveryFailReason = (typeof DELIVERY_FAIL_REASONS)[number]

export const DELIVERY_FAIL_REASON_LABELS: Record<DeliveryFailReason, string> = {
  NO_ANSWER: 'Cliente não atendeu',
  WRONG_ADDRESS: 'Endereço errado',
  REFUSED_PAYMENT: 'Recusou pagamento',
  OTHER: 'Outro motivo',
}

export const BATCH_STATUSES = ['OPEN', 'PENDING', 'ACCEPTED', 'COLLECTED', 'CANCELLED'] as const
export type BatchStatus = (typeof BATCH_STATUSES)[number]

export const BATCH_STATUS_LABELS: Record<BatchStatus, string> = {
  OPEN: 'Montando',
  PENDING: 'Aguardando entregador',
  ACCEPTED: 'Entregador a caminho da coleta',
  COLLECTED: 'Coletado',
  CANCELLED: 'Cancelado',
}

export const STORE_DRIVER_STATUSES = ['INVITED', 'CONFIRMED', 'REMOVED'] as const
export type StoreDriverStatus = (typeof STORE_DRIVER_STATUSES)[number]

export const SHIFT_STATUSES = ['ACTIVE', 'CLOSED'] as const
export type ShiftStatus = (typeof SHIFT_STATUSES)[number]

export const SHIFT_CLOSED_BY = ['DRIVER', 'STORE', 'SYSTEM'] as const
export type ShiftClosedBy = (typeof SHIFT_CLOSED_BY)[number]

export const DRIVER_REQUEST_TARGETS = ['GENERAL', 'OWN'] as const
export type DriverRequestTarget = (typeof DRIVER_REQUEST_TARGETS)[number]

/** Raio máximo, em km, para iniciar um turno. */
export const SHIFT_START_RADIUS_KM = 0.5
