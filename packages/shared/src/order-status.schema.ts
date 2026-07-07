import { z } from 'zod'
import { ORDER_STATUSES } from './order-status'

/** Runtime validation for HTTP-inbound status strings */
export const OrderStatusSchema = z.enum(ORDER_STATUSES)
