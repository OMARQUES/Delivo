import { z } from 'zod'

export const AmendmentProposalSchema = z.object({
  note: z.string().trim().max(280).optional(),
  items: z
    .array(
      z.object({
        orderItemId: z.uuid(),
        /** 0 = remover o item. Só REDUÇÃO é aceita (validado no service contra a quantidade atual). */
        newQuantity: z.number().int().min(0).max(50),
      }),
    )
    .min(1)
    .max(50)
    .refine((items) => new Set(items.map((i) => i.orderItemId)).size === items.length, {
      message: 'Item duplicado na proposta',
    }),
})
export type AmendmentProposalInput = z.infer<typeof AmendmentProposalSchema>
