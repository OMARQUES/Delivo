<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../lib/api'
import { enablePush, pushConfigured } from '../lib/push'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const router = useRouter()
const isAvailable = ref(false)
const saving = ref(false)
const showPushButton = ref(pushConfigured())
const pixKey = ref('')
const pixMsg = ref('')
const savingPix = ref(false)
type Shift = { id: string; storeName: string; storeAddressText: string; startedAt: string }
type Link = { storeId: string; storeName: string; status: string }
const shift = ref<Shift | null>(null)
const links = ref<Link[]>([])
const shiftBusy = ref(false)
const shiftMsg = ref('')

async function loadShift() {
  const [active, allLinks] = await Promise.all([
    api<Shift | null>('/driver/shifts/active'), api<Link[]>('/driver/links'),
  ])
  shift.value = active
  links.value = allLinks.filter((link) => link.status === 'CONFIRMED')
}

onMounted(async () => {
  try {
    const me = await api<{ isAvailable: boolean; pixKey?: string | null }>('/driver/me')
    isAvailable.value = me.isAvailable
    pixKey.value = me.pixKey ?? ''
    await loadShift()
  } catch {
    // token invalido: guard resolve na proxima navegacao.
  }
})

async function toggle() {
  saving.value = true
  try {
    const r = await api<{ isAvailable: boolean }>('/driver/me/availability', {
      method: 'PATCH',
      body: JSON.stringify({ isAvailable: !isAvailable.value }),
    })
    isAvailable.value = r.isAvailable
  } finally {
    saving.value = false
  }
}

async function start(storeId: string) {
  shiftBusy.value = true
  shiftMsg.value = ''
  try {
    const gps = await new Promise<GeolocationPosition>((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 15_000 }),
    )
    await api('/driver/shifts', { method: 'POST', body: JSON.stringify({ storeId, lat: gps.coords.latitude, lng: gps.coords.longitude }) })
    await loadShift()
  } catch (e) { shiftMsg.value = e instanceof Error ? e.message : 'Não foi possível obter sua localização' }
  finally { shiftBusy.value = false }
}

async function end() {
  if (!shift.value) return
  shiftBusy.value = true
  shiftMsg.value = ''
  try { await api(`/driver/shifts/${shift.value.id}/end`, { method: 'POST' }); await loadShift() }
  catch (e) { shiftMsg.value = e instanceof Error ? e.message : 'Erro' }
  finally { shiftBusy.value = false }
}

async function onEnablePush() {
  const r = await enablePush()
  if (r === 'ok') showPushButton.value = false
}

async function savePixKey() {
  savingPix.value = true
  pixMsg.value = ''
  try {
    await api('/driver/me/pix-key', { method: 'PATCH', body: JSON.stringify({ pixKey: pixKey.value || null }) })
    pixMsg.value = 'Salvo!'
  } catch (e) {
    pixMsg.value = e instanceof Error ? e.message : 'Erro'
  } finally {
    savingPix.value = false
  }
}

async function logout() {
  await auth.logout()
  await router.replace('/login')
}
</script>

<template>
  <div class="min-h-screen">
    <header class="flex items-center justify-between border-b p-3">
      <nav class="flex gap-3 text-sm">
        <RouterLink to="/" class="underline">Disponíveis</RouterLink>
        <RouterLink to="/entregas" class="underline">Minhas entregas</RouterLink>
        <RouterLink to="/financeiro" class="underline">Ganhos</RouterLink>
        <RouterLink to="/lojas" class="underline">Minhas lojas</RouterLink>
      </nav>
      <div class="flex items-center gap-2">
        <button v-if="showPushButton" class="text-sm underline" @click="onEnablePush">🔔 Ativar alertas</button>
        <button
          :disabled="saving"
          class="rounded-full px-3 py-1 text-sm font-semibold"
          :class="isAvailable ? 'bg-green-600 text-white' : 'bg-gray-300'"
          @click="toggle"
        >
          {{ isAvailable ? 'Disponível' : 'Indisponível' }}
        </button>
        <button class="text-sm underline" @click="logout">Sair</button>
      </div>
    </header>
    <section class="border-b bg-blue-50 p-3 text-sm">
      <div v-if="shift" class="flex flex-wrap items-center justify-between gap-2">
        <span><strong>Turno ativo:</strong> {{ shift.storeName }} · {{ shift.storeAddressText }}</span>
        <button class="rounded bg-black px-3 py-1 text-white disabled:opacity-50" :disabled="shiftBusy" @click="end">Encerrar turno</button>
      </div>
      <div v-else-if="links.length" class="flex flex-wrap items-center gap-2">
        <span>Iniciar turno:</span>
        <button v-for="link in links" :key="link.storeId" class="rounded border bg-white px-3 py-1 disabled:opacity-50" :disabled="shiftBusy" @click="start(link.storeId)">{{ link.storeName }}</button>
      </div>
      <p v-else>Confirme um convite em “Minhas lojas” para iniciar um turno.</p>
      <p v-if="shiftMsg" class="mt-1 text-red-600">{{ shiftMsg }}</p>
    </section>
    <details class="border-b p-3 text-sm">
      <summary class="cursor-pointer text-gray-600">Minha chave PIX (recebimento do frete)</summary>
      <div class="mt-2 flex gap-2">
        <input v-model="pixKey" placeholder="Chave PIX" class="flex-1 rounded border p-2" />
        <button class="rounded bg-black px-3 text-white" :disabled="savingPix" @click="savePixKey">Salvar</button>
      </div>
      <p v-if="pixMsg" class="mt-1 text-xs" :class="pixMsg === 'Salvo!' ? 'text-green-700' : 'text-red-600'">{{ pixMsg }}</p>
    </details>
    <RouterView />
  </div>
</template>
