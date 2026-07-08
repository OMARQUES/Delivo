export type LatLng = { lat: number; lng: number }

/** Distância em linha reta (haversine), km */
export function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

export type DeliveryFeeConfig = {
  deliveryFeeMode: 'FIXED' | 'DISTANCE'
  deliveryFixedFeeCents: number | null
  deliveryMinFeeCents: number | null
  deliveryPerKmCents: number | null
  deliveryMaxKm: number | null
}

/**
 * Frete em centavos. DISTANCE: km arredondado pra CIMA em passos de 0,5;
 * taxa = max(minFee, perKm × km). Fora do raio ou não configurado → null.
 */
export function calcDeliveryFee(cfg: DeliveryFeeConfig, distKm: number): number | null {
  if (cfg.deliveryFeeMode === 'FIXED') return cfg.deliveryFixedFeeCents ?? null
  if (cfg.deliveryPerKmCents == null) return null
  if (cfg.deliveryMaxKm != null && distKm > cfg.deliveryMaxKm) return null
  const km = Math.ceil(distKm * 2) / 2
  const fee = Math.round(cfg.deliveryPerKmCents * km)
  return Math.max(cfg.deliveryMinFeeCents ?? 0, fee)
}
