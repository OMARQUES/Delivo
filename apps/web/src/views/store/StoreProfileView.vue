<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { STORE_CATEGORIES } from '@delivery/shared/constants'
import { api } from '../../lib/api'
import MapPicker from '../../components/MapPicker.vue'

type Hours = { dow: number; open: string; close: string }
type Store = {
  id: string; name: string; slug: string; category: string; phone: string
  addressText: string; lat: number; lng: number; logoKey: string | null
  deliveryFeeMode: 'FIXED' | 'DISTANCE'
  deliveryFixedFeeCents: number | null; deliveryMinFeeCents: number | null
  deliveryPerKmCents: number | null; deliveryMaxKm: number | null
  minOrderCents: number | null
  deliveryEtaMinutes: [number, number] | null; pickupEtaMinutes: [number, number] | null
  isPaused: boolean; openingHours: Hours[]
}

const DOWS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8787'

const store = ref<Store | null>(null)
const msg = ref('')
const saving = ref(false)
const form = reactive<Partial<Store>>({})

onMounted(async () => {
  store.value = await api<Store>('/store/me')
  Object.assign(form, store.value)
  if (!form.openingHours) form.openingHours = []
})

function addHour() {
  form.openingHours!.push({ dow: 1, open: '18:00', close: '23:00' })
}
function removeHour(i: number) {
  form.openingHours!.splice(i, 1)
}

async function save() {
  msg.value = ''
  saving.value = true
  try {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- descarta campos read-only do PATCH
    const { id, slug, logoKey, ...payload } = form as Store
    store.value = await api<Store>('/store/me', { method: 'PATCH', body: JSON.stringify(payload) })
    msg.value = 'Salvo!'
  } catch (e) {
    msg.value = e instanceof Error ? e.message : 'Erro ao salvar'
  } finally {
    saving.value = false
  }
}

async function uploadLogo(ev: Event) {
  const file = (ev.target as HTMLInputElement).files?.[0]
  if (!file) return
  const { logoKey } = await api<{ logoKey: string }>('/store/me/logo', {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: file,
  })
  if (store.value) store.value.logoKey = logoKey
}
</script>

<template>
  <main v-if="store" class="mx-auto max-w-2xl space-y-6 p-4">
    <section>
      <h1 class="text-xl font-bold">Perfil — /{{ store.slug }}</h1>
      <label class="mt-2 flex items-center gap-2 text-sm">
        <input v-model="form.isPaused" type="checkbox" /> Pausar pedidos agora
      </label>
    </section>

    <section class="space-y-2">
      <img v-if="store.logoKey" :src="`${API_URL}/media/${store.logoKey}`" class="h-20 w-20 rounded object-cover" alt="logo" />
      <input type="file" accept="image/png,image/jpeg,image/webp" @change="uploadLogo" />
    </section>

    <section class="space-y-2">
      <input v-model="form.name" class="w-full rounded border p-2" placeholder="Nome" />
      <select v-model="form.category" class="w-full rounded border p-2">
        <option v-for="(label, key) in STORE_CATEGORIES" :key="key" :value="key">{{ label }}</option>
      </select>
      <input v-model="form.phone" class="w-full rounded border p-2" placeholder="WhatsApp" />
      <input v-model="form.addressText" class="w-full rounded border p-2" placeholder="Endereço" />
      <MapPicker
        v-if="form.lat != null"
        :lat="form.lat!"
        :lng="form.lng!"
        @update="({ lat, lng }) => Object.assign(form, { lat, lng })"
      />
    </section>

    <section class="space-y-2">
      <h2 class="font-semibold">Entrega</h2>
      <select v-model="form.deliveryFeeMode" class="w-full rounded border p-2">
        <option value="FIXED">Taxa fixa</option>
        <option value="DISTANCE">Mínimo + por km</option>
      </select>
      <input v-if="form.deliveryFeeMode === 'FIXED'" v-model.number="form.deliveryFixedFeeCents" type="number" class="w-full rounded border p-2" placeholder="Taxa fixa (centavos)" />
      <template v-else>
        <input v-model.number="form.deliveryMinFeeCents" type="number" class="w-full rounded border p-2" placeholder="Taxa mínima (centavos)" />
        <input v-model.number="form.deliveryPerKmCents" type="number" class="w-full rounded border p-2" placeholder="Por km (centavos)" />
        <input v-model.number="form.deliveryMaxKm" type="number" step="0.5" class="w-full rounded border p-2" placeholder="Raio máx (km, opcional)" />
      </template>
      <input v-model.number="form.minOrderCents" type="number" class="w-full rounded border p-2" placeholder="Pedido mínimo (centavos, opcional)" />
    </section>

    <section class="space-y-2">
      <h2 class="font-semibold">Horários</h2>
      <div v-for="(h, i) in form.openingHours" :key="i" class="flex items-center gap-2">
        <select v-model.number="h.dow" class="rounded border p-1">
          <option v-for="(d, di) in DOWS" :key="di" :value="di">{{ d }}</option>
        </select>
        <input v-model="h.open" type="time" class="rounded border p-1" />
        <span>–</span>
        <input v-model="h.close" type="time" class="rounded border p-1" />
        <button type="button" class="text-sm text-red-600" @click="removeHour(i)">remover</button>
      </div>
      <button type="button" class="rounded border px-2 py-1 text-sm" @click="addHour">+ horário</button>
    </section>

    <p v-if="msg" class="text-sm" :class="msg === 'Salvo!' ? 'text-green-700' : 'text-red-600'">{{ msg }}</p>
    <button :disabled="saving" class="w-full rounded bg-black p-2 text-white disabled:opacity-50" @click="save">
      {{ saving ? 'Salvando…' : 'Salvar' }}
    </button>
  </main>
</template>
