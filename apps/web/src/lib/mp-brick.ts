/** Payment Brick do MP (cartão). Gated: sem VITE_MP_PUBLIC_KEY -> desabilitado. */
import { loadMercadoPago } from '@mercadopago/sdk-js'

export function cardConfigured(): boolean {
  return Boolean(import.meta.env.VITE_MP_PUBLIC_KEY)
}

export type CardFormData = { token: string; payment_method_id: string; installments: number }

/**
 * Monta o CardPayment Brick no container e resolve com os dados do cartão quando o cliente submeter.
 * Retorna função de destroy.
 */
export async function mountCardBrick(
  containerId: string,
  amountReais: number,
  onSubmit: (data: CardFormData) => Promise<void>,
): Promise<() => void> {
  await loadMercadoPago()
  // @ts-expect-error MercadoPago é global injetado pelo loader
  const mp = new window.MercadoPago(import.meta.env.VITE_MP_PUBLIC_KEY, { locale: 'pt-BR' })
  const bricks = mp.bricks()
  const controller = await bricks.create('cardPayment', containerId, {
    initialization: { amount: amountReais },
    customization: { paymentMethods: { maxInstallments: 1 } },
    callbacks: {
      onReady: () => {},
      onSubmit: (cardFormData: CardFormData) => onSubmit(cardFormData),
      onError: (error: unknown) => console.error('brick error', error),
    },
  })
  return () => controller.unmount()
}
