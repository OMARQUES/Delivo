<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { formatBRL, parseBRLToCents } from '@delivery/shared/constants'
import { api } from '../../lib/api'

type Link = {
  id: string; driverUserId: string; driverName: string; driverPhone: string | null
  status: 'INVITED' | 'CONFIRMED'; dailyRateCents: number; perDeliveryCents: number
}
type Shift = { id: string; driverUserId: string; driverName: string; startedAt: string; earlyClose: boolean }
const links = ref<Link[]>([])
const shifts = ref<Shift[]>([])
const phone = ref('')
const daily = ref('')
const extra = ref('')
const dow = ref(1)
const startTime = ref('09:00')
const endTime = ref('18:00')
const saving = ref(false)
const error = ref('')

async function load() {
  try {
    ;[links.value, shifts.value] = await Promise.all([
      api<Link[]>('/store/me/drivers'), api<Shift[]>('/store/me/shifts'),
    ])
  } catch (e) { error.value = e instanceof Error ? e.message : 'Erro' }
}
async function invite() {
  const dailyRateCents = parseBRLToCents(daily.value)
  const perDeliveryCents = parseBRLToCents(extra.value)
  if (dailyRateCents == null || perDeliveryCents == null) { error.value = 'Informe valores válidos'; return }
  saving.value = true; error.value = ''
  try {
    await api('/store/me/drivers', { method: 'POST', body: JSON.stringify({
      phone: phone.value, dailyRateCents, perDeliveryCents,
      schedule: [{ dow: dow.value, start: startTime.value, end: endTime.value }],
    }) })
    phone.value = ''; daily.value = ''; extra.value = ''; await load()
  } catch (e) { error.value = e instanceof Error ? e.message : 'Erro' }
  finally { saving.value = false }
}
async function edit(link: Link) {
  const newDaily = prompt('Nova diária (R$)', (link.dailyRateCents / 100).toFixed(2).replace('.', ','))
  if (newDaily == null) return
  const newExtra = prompt('Novo extra por entrega (R$)', (link.perDeliveryCents / 100).toFixed(2).replace('.', ','))
  if (newExtra == null) return
  const dailyRateCents = parseBRLToCents(newDaily); const perDeliveryCents = parseBRLToCents(newExtra)
  if (dailyRateCents == null || perDeliveryCents == null) { error.value = 'Valores inválidos'; return }
  await api(`/store/me/drivers/${link.id}`, { method: 'PATCH', body: JSON.stringify({ dailyRateCents, perDeliveryCents }) })
  await load()
}
async function remove(id: string) { if (confirm('Remover este vínculo?')) { await api(`/store/me/drivers/${id}`, { method: 'DELETE' }); await load() } }
async function release(id: string) { if (confirm('Liberar o entregador e pagar a diária cheia?')) { await api(`/store/me/shifts/${id}/release`, { method: 'POST' }); await load() } }
onMounted(load)
</script>

<template>
  <main class="mx-auto max-w-3xl p-4">
    <h1 class="text-xl font-bold">Entregadores próprios</h1>
    <p class="text-sm text-gray-500">Convide uma conta de entregador já ativa. Valores novos valem apenas para turnos futuros.</p>
    <p v-if="error" class="mt-2 text-sm text-red-600">{{ error }}</p>
    <form class="mt-4 grid gap-2 rounded border p-3 sm:grid-cols-3" @submit.prevent="invite">
      <input v-model="phone" required placeholder="Telefone" class="rounded border p-2" />
      <input v-model="daily" required inputmode="decimal" placeholder="Diária (R$)" class="rounded border p-2" />
      <input v-model="extra" required inputmode="decimal" placeholder="Extra/entrega (R$)" class="rounded border p-2" />
      <select v-model="dow" class="rounded border p-2"><option v-for="(d, i) in ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb']" :key="d" :value="i">{{ d }}</option></select>
      <input v-model="startTime" type="time" class="rounded border p-2" />
      <input v-model="endTime" type="time" class="rounded border p-2" />
      <button :disabled="saving" class="rounded bg-black p-2 font-semibold text-white sm:col-span-3">Convidar</button>
    </form>
    <h2 class="mt-6 font-semibold">Vínculos</h2>
    <ul class="mt-2 space-y-2">
      <li v-for="link in links" :key="link.id" class="flex flex-wrap items-center justify-between gap-2 rounded border p-3 text-sm">
        <span><strong>{{ link.driverName }}</strong> · {{ link.driverPhone }}<br>{{ link.status === 'CONFIRMED' ? 'Confirmado' : 'Convite pendente' }} · {{ formatBRL(link.dailyRateCents) }}/dia + {{ formatBRL(link.perDeliveryCents) }}/entrega</span>
        <span class="flex gap-2"><button class="rounded border px-2 py-1" @click="edit(link)">Editar</button><button class="rounded border border-red-400 px-2 py-1 text-red-600" @click="remove(link.id)">Remover</button></span>
      </li>
    </ul>
    <h2 class="mt-6 font-semibold">Turnos ativos</h2>
    <p v-if="!shifts.length" class="mt-2 text-sm text-gray-500">Nenhum turno ativo.</p>
    <ul class="mt-2 space-y-2"><li v-for="shift in shifts" :key="shift.id" class="flex items-center justify-between rounded border p-3 text-sm"><span><strong>{{ shift.driverName }}</strong> · desde {{ new Date(shift.startedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) }}</span><button class="rounded border px-2 py-1" @click="release(shift.id)">Liberar</button></li></ul>
  </main>
</template>
