<script setup lang="ts">
import { inject, onMounted, ref } from 'vue'
import { formatBRL } from '@delivery/shared/constants'
import { api } from '../lib/api'

// recarrega a barra de turno do layout (o botão "Iniciar turno" depende dos vínculos confirmados)
const reloadDriverBar = inject<() => Promise<void> | void>('reloadDriverBar', () => {})

type ScheduleItem = ({ dow: number } | { date: string }) & { start: string; end: string }
type Link = {
  id: string
  status: 'INVITED' | 'CONFIRMED'
  storeName: string
  storeAddressText: string
  dailyRateCents: number
  perDeliveryCents: number
  schedule: ScheduleItem[]
  pendingDailyRateCents: number | null
  pendingPerDeliveryCents: number | null
  pendingSchedule: ScheduleItem[] | null
  pendingProposedAt: string | null
}
const DOW = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
function daysLabel(schedule: ScheduleItem[]) {
  if (!schedule?.length) return 'Sem dias definidos'
  return `${schedule.map((s) => 'date' in s ? s.date.split('-').reverse().slice(0, 2).join('/') : DOW[s.dow]).join(', ')} · ${schedule[0]!.start}–${schedule[0]!.end}`
}
const links = ref<Link[]>([])
const error = ref('')
async function load() {
  try { links.value = await api<Link[]>('/driver/links') }
  catch (e) { error.value = e instanceof Error ? e.message : 'Erro' }
}
async function confirm(id: string) {
  try { await api(`/driver/links/${id}/confirm`, { method: 'POST' }); await load(); await reloadDriverBar() }
  catch (e) { error.value = e instanceof Error ? e.message : 'Erro' }
}
async function decideTerms(id: string, decision: 'confirm' | 'reject') {
  error.value = ''
  try {
    await api(`/driver/links/${id}/terms/${decision}`, { method: 'POST' })
    await load()
    await reloadDriverBar()
  } catch (e) { error.value = e instanceof Error ? e.message : 'Erro' }
}
onMounted(load)
</script>

<template>
  <main class="mx-auto max-w-lg p-4">
    <h1 class="text-xl font-bold">Minhas lojas</h1>
    <p v-if="error" class="mt-2 text-sm text-red-600">{{ error }}</p>
    <p v-if="!links.length" class="mt-4 text-gray-500">Nenhum vínculo ou convite.</p>
    <ul class="mt-3 space-y-2">
      <li v-for="link in links" :key="link.id" class="rounded border p-3">
        <div class="flex justify-between gap-3">
          <div><p class="font-semibold">{{ link.storeName }}</p><p class="text-xs text-gray-500">{{ link.storeAddressText }}</p></div>
          <span class="text-xs" :class="link.status === 'CONFIRMED' ? 'text-green-700' : 'text-yellow-700'">
            {{ link.status === 'CONFIRMED' ? 'Confirmado' : 'Convite pendente' }}
          </span>
        </div>
        <p class="mt-2 text-sm">Diária {{ formatBRL(link.dailyRateCents) }} · extra {{ formatBRL(link.perDeliveryCents) }}/entrega</p>
        <p class="text-xs text-gray-500">🗓️ {{ daysLabel(link.schedule) }}</p>
        <button v-if="link.status === 'INVITED'" class="mt-2 w-full rounded bg-black p-2 text-white" @click="confirm(link.id)">Confirmar convite</button>
        <div v-if="link.pendingProposedAt && link.pendingSchedule" class="mt-3 rounded border border-yellow-300 bg-yellow-50 p-3 text-sm">
          <p class="font-semibold">🔔 A loja propôs novos termos</p>
          <p class="mt-1 text-xs text-gray-600">Atual: {{ formatBRL(link.dailyRateCents) }}/dia + {{ formatBRL(link.perDeliveryCents) }}/entrega · {{ daysLabel(link.schedule) }}</p>
          <p class="text-xs">Novo: {{ formatBRL(link.pendingDailyRateCents!) }}/dia + {{ formatBRL(link.pendingPerDeliveryCents!) }}/entrega · {{ daysLabel(link.pendingSchedule) }}</p>
          <div class="mt-2 flex gap-2"><button class="flex-1 rounded border bg-white p-2" @click="decideTerms(link.id, 'reject')">Recusar</button><button class="flex-1 rounded bg-black p-2 text-white" @click="decideTerms(link.id, 'confirm')">Aceitar</button></div>
        </div>
      </li>
    </ul>
  </main>
</template>
