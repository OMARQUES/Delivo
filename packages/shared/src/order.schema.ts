import { z } from 'zod'
import { OrderStatusSchema } from './order-status.schema'

const Cents = z.number().int().min(0).max(1_000_000)

const SelectionSchema = z.object({
  groupId: z.uuid(),
  optionIds: z.array(z.uuid()).max(20),
})

export const CheckoutItemSchema = z.object({
  productId: z.uuid(),
  quantity: z.number().int().min(1).max(50),
  note: z.string().trim().max(140).optional(),
  selections: z.array(SelectionSchema).max(10).default([]),
})
export type CheckoutItemInput = z.infer<typeof CheckoutItemSchema>

export const CheckoutSchema = z
  .object({
    storeSlug: z.string().min(1).max(60),
    fulfillment: z.enum(['DELIVERY', 'PICKUP']),
    addressId: z.uuid().optional(),
    paymentMethod: z.enum(['CASH', 'CARD_MACHINE', 'PIX_ONLINE', 'CARD_ONLINE']),
    changeForCents: Cents.nullable().optional(),
    /** CARD_ONLINE: token do Payment Brick */
    cardToken: z.string().min(8).max(120).optional(),
    /** CARD_ONLINE: bandeira retornada pelo Brick (ex: 'master', 'visa') */
    cardPaymentMethodId: z.string().min(2).max(40).optional(),
    /** CARD_ONLINE: parcelas (MVP: só 1) */
    installments: z.number().int().min(1).max(1).optional(),
    /** CPF/CNPJ na nota (opcional) — só dígitos, 11 ou 14 */
    taxId: z.string().transform((s) => s.replace(/\D/g, '')).pipe(z.string().regex(/^(\d{11}|\d{14})$/)).optional(),
    note: z.string().trim().max(280).optional(),
    items: z.array(CheckoutItemSchema).min(1).max(50),
    idempotencyKey: z.uuid(),
  })
  .refine((v) => v.fulfillment !== 'DELIVERY' || Boolean(v.addressId), {
    message: 'Entrega exige endereço',
  })
  .refine((v) => v.paymentMethod !== 'CARD_ONLINE' || (Boolean(v.cardToken) && Boolean(v.cardPaymentMethodId)), {
    message: 'Cartão online exige token do cartão',
  })
export type CheckoutInput = z.infer<typeof CheckoutSchema>

export const AddressSchema = z.object({
  label: z.string().trim().max(30).optional(),
  addressText: z.string().trim().min(5).max(200),
  reference: z.string().trim().max(140).optional(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
})
export type AddressInput = z.infer<typeof AddressSchema>

export const StatusUpdateSchema = z.object({
  to: OrderStatusSchema,
  reason: z.string().trim().max(280).optional(),
})
export type StatusUpdateInput = z.infer<typeof StatusUpdateSchema>

export const CancelRequestSchema = z.object({
  note: z.string().trim().max(280).optional(),
})
export type CancelRequestInput = z.infer<typeof CancelRequestSchema>
