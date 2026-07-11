<script setup lang="ts">
import { inject, onMounted, ref } from 'vue'
import { formatBRL } from '@delivery/shared/constants'
import type { OfferRecurrence } from '@delivery/shared'
import { api } from '../lib/api'

type Offer = { id: string; storeName: string; storeAddressText: string; dailyRateCents: number; perDeliveryCents: number
  slots: number; acceptedCount: number; recurrence: OfferRecurrence; startTime: string; endTime: string; note: string | null }
const DOW = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
const reloadDriverBar = inject<() => Promise<void> | void>('reloadDriverBar', () => {})
const offers = ref<Offer[]>([]); const error = ref(''); const message = ref(''); const busy = ref<string | null>(null)
function recurrenceLabel(recurrence: OfferRecurrence) {
  return recurrence.kind === 'WEEKLY' ? recurrence.days.map((day) => DOW[day]).join(', ')
    : recurrence.dates.map((date) => date.split('-').reverse().slice(0, 2).join('/')).join(', ')
}
async function load() {
  try { offers.value = await api<Offer[]>('/driver/offers') }
  catch (e) { error.value = e instanceof Error ? e.message : 'Erro ao carregar vagas' }
}
async function accept(offer: Offer) {
  const summary = `${offer.storeName}\n${recurrenceLabel(offer.recurrence)} · ${offer.startTime}–${offer.endTime}\n${formatBRL(offer.dailyRateCents)}/dia + ${formatBRL(offer.perDeliveryCents)}/entrega`
  if (!confirm(`Aceitar esta vaga e criar o vínculo?\n\n${summary}`)) return
  busy.value = offer.id; error.value = ''; message.value = ''
  try { await api(`/driver/offers/${offer.id}/accept`, { method: 'POST' }); message.value = 'Vínculo criado — veja em Minhas lojas.'; await Promise.all([load(), reloadDriverBar()]) }
  catch (e) { error.value = e instanceof Error ? e.message : 'Não foi possível aceitar' }
  finally { busy.value = null }
}
async function dismiss(offer: Offer) {
  busy.value = offer.id; error.value = ''
  try { await api(`/driver/offers/${offer.id}/dismiss`, { method: 'POST' }); await load() }
  catch (e) { error.value = e instanceof Error ? e.message : 'Não foi possível dispensar' }
  finally { busy.value = null }
}
onMounted(load)
</script>

<template>
  <main class="mx-auto max-w-lg p-4">
    <h1 class="text-xl font-bold">Vagas</h1><p class="text-sm text-gray-500">Aceitar cria o vínculo confirmado com a loja.</p>
    <p v-if="error" class="mt-2 rounded bg-red-50 p-2 text-sm text-red-700">{{ error }}</p><p v-if="message" class="mt-2 rounded bg-green-50 p-2 text-sm text-green-700">{{ message }}</p>
    <p v-if="!offers.length" class="mt-4 text-gray-500">Nenhuma vaga disponível agora.</p>
    <ul class="mt-3 space-y-3"><li v-for="offer in offers" :key="offer.id" class="rounded border p-3">
      <h2 class="font-semibold">{{ offer.storeName }}</h2><p class="text-xs text-gray-500">{{ offer.storeAddressText }}</p>
      <p class="mt-2 text-sm">{{ formatBRL(offer.dailyRateCents) }}/dia · {{ formatBRL(offer.perDeliveryCents) }}/entrega</p>
      <p class="text-sm">🗓️ {{ recurrenceLabel(offer.recurrence) }} · {{ offer.startTime }}–{{ offer.endTime }}</p>
      <p class="text-xs text-gray-500">{{ offer.slots - offer.acceptedCount }} vaga(s) restante(s)</p><p v-if="offer.note" class="mt-2 text-sm">{{ offer.note }}</p>
      <div class="mt-3 flex gap-2"><button class="flex-1 rounded border p-2" :disabled="busy === offer.id" @click="dismiss(offer)">Dispensar</button><button class="flex-1 rounded bg-black p-2 text-white" :disabled="busy === offer.id" @click="accept(offer)">Aceitar</button></div>
    </li></ul>
  </main>
</template>
