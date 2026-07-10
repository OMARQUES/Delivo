/**
 * Resolve o email do pagador enviado ao Mercado Pago.
 * Em sandbox as credenciais de TESTE só aceitam um comprador de teste (senão a MP
 * responde "400 Invalid users involved"). MP_TEST_PAYER_EMAIL sobrepõe o email real
 * quando configurado; em produção fica vazio e usamos o email do cliente.
 */
export function resolvePayerEmail(
  env: { MP_TEST_PAYER_EMAIL?: string },
  userEmail: string | null | undefined,
  sub: string,
): string {
  return env.MP_TEST_PAYER_EMAIL || userEmail || `cliente-${sub.slice(0, 8)}@pedidos.delivo.app`
}
