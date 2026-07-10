export const LEDGER_ENTRY_TYPES = [
  'STORE_SALE_CREDIT',
  'STORE_COMMISSION_DEBIT',
  'STORE_DRIVER_FEE_DEBIT',
  'DRIVER_DELIVERY_CREDIT',
] as const
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number]

export const LEDGER_ENTRY_LABELS: Record<LedgerEntryType, string> = {
  STORE_SALE_CREDIT: 'Venda da loja',
  STORE_COMMISSION_DEBIT: 'Comissão da plataforma',
  STORE_DRIVER_FEE_DEBIT: 'Frete do entregador',
  DRIVER_DELIVERY_CREDIT: 'Frete do entregador',
}

export const FINANCE_DOCUMENT_STATUSES = ['OPEN', 'PAID'] as const
export type FinanceDocumentStatus = (typeof FINANCE_DOCUMENT_STATUSES)[number]

export const FINANCE_DOCUMENT_STATUS_LABELS: Record<FinanceDocumentStatus, string> = {
  OPEN: 'Em aberto',
  PAID: 'Pago',
}
