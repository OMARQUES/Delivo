import type { orders } from '../db/schema'

type Order = typeof orders.$inferSelect
type DriverDetailRow = {
  order: Order
  storeName: string
  storeAddressText: string
  storeLat: number
  storeLng: number
  storePhone: string
  customerName: string
  customerPhone: string | null
}

export function toActiveDriverDelivery(row: DriverDetailRow, items: { nameSnapshot: string; quantity: number }[]) {
  const { order } = row
  return {
    id: order.id,
    status: order.status,
    paymentMethod: order.paymentMethod,
    changeForCents: order.changeForCents,
    totalCents: order.totalCents,
    deliveryFeeCents: order.deliveryFeeCents,
    distanceKm: order.distanceKm,
    note: order.note,
    createdAt: order.createdAt,
    batchId: order.batchId,
    driverArrivedAt: order.driverArrivedAt,
    returnPendingAt: order.returnPendingAt,
    returnedAt: order.returnedAt,
    driverReturnedAt: order.driverReturnedAt,
    returnPhotoCount: order.returnPhotoKeys.length,
    storeName: row.storeName,
    storeAddressText: row.storeAddressText,
    storeLat: row.storeLat,
    storeLng: row.storeLng,
    storePhone: row.storePhone,
    customerName: row.customerName,
    customerPhone: row.customerPhone,
    addressText: order.addressText,
    addressReference: order.addressReference,
    addressLat: order.addressLat,
    addressLng: order.addressLng,
    items,
  }
}

export function toDriverHistoryDelivery(row: Pick<DriverDetailRow, 'order' | 'storeName' | 'storeAddressText'>) {
  const { order } = row
  return {
    id: order.id,
    status: order.status,
    deliveryFeeCents: order.deliveryFeeCents,
    distanceKm: order.distanceKm,
    createdAt: order.createdAt,
    storeName: row.storeName,
    storeAddressText: row.storeAddressText,
  }
}

export function toDriverActionResult(row: Pick<Order, 'id' | 'status'>) {
  return { id: row.id, status: row.status }
}
