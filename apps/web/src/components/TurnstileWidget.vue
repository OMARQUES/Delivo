<script setup lang="ts">
import { onMounted, ref } from 'vue'

type TurnstileAction = 'login' | 'register' | 'email_resend' | 'password_recovery'
type TurnstileApi = {
  render: (el: HTMLElement, options: Record<string, unknown>) => string
  reset: (widgetId: string) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
    __deliveryTurnstileLoad?: Promise<void>
  }
}

const props = defineProps<{ action: TurnstileAction }>()
const emit = defineEmits<{ 'update:token': [string | null] }>()

const root = ref<HTMLElement | null>(null)
const widgetId = ref<string | null>(null)
const error = ref('')

function loadTurnstile() {
  if (window.turnstile) return Promise.resolve()
  if (window.__deliveryTurnstileLoad) return window.__deliveryTurnstileLoad
  window.__deliveryTurnstileLoad = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-delivery-turnstile]')
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener('error', () => reject(new Error('Falha ao carregar Turnstile')), { once: true })
      return
    }
    const script = document.createElement('script')
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
    script.async = true
    script.defer = true
    script.dataset.deliveryTurnstile = 'true'
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Falha ao carregar Turnstile'))
    document.head.appendChild(script)
  })
  return window.__deliveryTurnstileLoad
}

async function renderWidget() {
  error.value = ''
  await loadTurnstile()
  if (!root.value || !window.turnstile || widgetId.value) return
  widgetId.value = window.turnstile.render(root.value, {
    sitekey: import.meta.env.VITE_TURNSTILE_SITE_KEY,
    action: props.action,
    callback: (token: string) => emit('update:token', token),
    'expired-callback': () => emit('update:token', null),
    'error-callback': () => emit('update:token', null),
  })
}

function reset() {
  if (widgetId.value && window.turnstile) window.turnstile.reset(widgetId.value)
  emit('update:token', null)
}

defineExpose({ reset })

onMounted(() => {
  renderWidget().catch(() => {
    error.value = 'Não foi possível carregar a verificação antirobô.'
    emit('update:token', null)
  })
})
</script>

<template>
  <div>
    <div ref="root"></div>
    <p v-if="error" class="text-sm text-red-600">{{ error }}</p>
  </div>
</template>
