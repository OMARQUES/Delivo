import { defineStore } from 'pinia'
import { calcItemPrice, type MenuProduct, type Selection } from '@delivery/shared/constants'

export type CartItem = {
  uid: string
  productId: string
  name: string
  quantity: number
  unitPriceCents: number
  note?: string
  selections: Selection[]
  optionLabels: string[]
}

type Persisted = { storeSlug: string | null; storeName: string | null; items: CartItem[] }
const KEY = 'delivery.cart'

function load(): Persisted {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return JSON.parse(raw) as Persisted
  } catch {
    // corrupt storage -> empty cart
  }
  return { storeSlug: null, storeName: null, items: [] }
}

function labelsFor(product: MenuProduct, selections: Selection[]): string[] {
  const out: string[] = []
  for (const s of selections) {
    const g = product.groups.find((x) => x.id === s.groupId)
    if (!g) continue
    for (const oid of s.optionIds) {
      const o = g.options.find((x) => x.id === oid)
      if (o) out.push(`${g.name}: ${o.name}`)
    }
  }
  return out
}

export const useCartStore = defineStore('cart', {
  state: (): Persisted => load(),
  getters: {
    subtotalCents: (s) => s.items.reduce((acc, i) => acc + i.unitPriceCents * i.quantity, 0),
    count: (s) => s.items.reduce((acc, i) => acc + i.quantity, 0),
    isEmpty: (s) => s.items.length === 0,
  },
  actions: {
    persist() {
      localStorage.setItem(KEY, JSON.stringify({ storeSlug: this.storeSlug, storeName: this.storeName, items: this.items }))
    },
    addItem(
      storeSlug: string,
      storeName: string,
      product: MenuProduct,
      selections: Selection[],
      quantity: number,
      note?: string,
    ): 'added' | 'invalid' | 'other-store' {
      if (this.storeSlug && this.storeSlug !== storeSlug) return 'other-store'
      const priced = calcItemPrice(product, selections)
      if (!priced.ok) return 'invalid'
      this.storeSlug = storeSlug
      this.storeName = storeName
      this.items.push({
        uid: crypto.randomUUID(),
        productId: product.id,
        name: product.name,
        quantity,
        unitPriceCents: priced.totalCents,
        note,
        selections,
        optionLabels: labelsFor(product, selections),
      })
      this.persist()
      return 'added'
    },
    updateQty(uid: string, quantity: number) {
      const item = this.items.find((i) => i.uid === uid)
      if (item && quantity >= 1 && quantity <= 50) {
        item.quantity = quantity
        this.persist()
      }
    },
    removeItem(uid: string) {
      this.items = this.items.filter((i) => i.uid !== uid)
      if (this.items.length === 0) this.clearStoreKeepNothing()
      this.persist()
    },
    clearStoreKeepNothing() {
      this.storeSlug = null
      this.storeName = null
    },
    clear() {
      this.items = []
      this.clearStoreKeepNothing()
      this.persist()
    },
  },
})
