export const DELIVERY_FAIL_REASONS = ['NO_ANSWER', 'WRONG_ADDRESS', 'REFUSED_PAYMENT', 'OTHER'] as const
export type DeliveryFailReason = (typeof DELIVERY_FAIL_REASONS)[number]

export const DELIVERY_FAIL_REASON_LABELS: Record<DeliveryFailReason, string> = {
  NO_ANSWER: 'Cliente não atendeu',
  WRONG_ADDRESS: 'Endereço errado',
  REFUSED_PAYMENT: 'Recusou pagamento',
  OTHER: 'Outro motivo',
}
