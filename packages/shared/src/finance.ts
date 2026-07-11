export const LEDGER_ENTRY_TYPES = [
  'STORE_SALE_CREDIT',
  'STORE_COMMISSION_DEBIT',
  'STORE_DRIVER_FEE_DEBIT',
  'DRIVER_DELIVERY_CREDIT',
  'STORE_PER_DELIVERY_DEBIT',
  'STORE_DAILY_RATE_DEBIT',
  'DRIVER_PER_DELIVERY_CREDIT',
  'DRIVER_DAILY_RATE_CREDIT',
  'DRIVER_HALF_FEE_CREDIT',
  'STORE_HALF_FEE_DEBIT',
] as const
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number]

export const LEDGER_ENTRY_LABELS: Record<LedgerEntryType, string> = {
  STORE_SALE_CREDIT: 'Venda da loja',
  STORE_COMMISSION_DEBIT: 'Comissão da plataforma',
  STORE_DRIVER_FEE_DEBIT: 'Frete do entregador',
  DRIVER_DELIVERY_CREDIT: 'Frete do entregador',
  STORE_PER_DELIVERY_DEBIT: 'Extra por entrega (entregador fixo)',
  STORE_DAILY_RATE_DEBIT: 'Diária do entregador',
  DRIVER_PER_DELIVERY_CREDIT: 'Extra por entrega',
  DRIVER_DAILY_RATE_CREDIT: 'Diária do turno',
  DRIVER_HALF_FEE_CREDIT: 'Meia-taxa (deslocamento)',
  STORE_HALF_FEE_DEBIT: 'Meia-taxa do entregador (deslocamento)',
}

export const FINANCE_DOCUMENT_STATUSES = ['OPEN', 'PAID'] as const
export type FinanceDocumentStatus = (typeof FINANCE_DOCUMENT_STATUSES)[number]

export const FINANCE_DOCUMENT_STATUS_LABELS: Record<FinanceDocumentStatus, string> = {
  OPEN: 'Em aberto',
  PAID: 'Pago',
}
