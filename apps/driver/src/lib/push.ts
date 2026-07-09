import { api } from './api'

export function pushConfigured(): boolean {
  return Boolean(import.meta.env.VITE_FIREBASE_API_KEY && import.meta.env.VITE_FIREBASE_VAPID_KEY)
}

export async function enablePush(): Promise<'ok' | 'denied' | 'unsupported' | 'off'> {
  if (!pushConfigured()) return 'off'
  if (!('Notification' in window) || !('serviceWorker' in navigator)) return 'unsupported'
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return 'denied'

  const { initializeApp } = await import('firebase/app')
  const { getMessaging, getToken, onMessage } = await import('firebase/messaging')
  const app = initializeApp({
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    messagingSenderId: import.meta.env.VITE_FIREBASE_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
  })
  const messaging = getMessaging(app)
  const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js')
  const token = await getToken(messaging, {
    vapidKey: import.meta.env.VITE_FIREBASE_VAPID_KEY,
    serviceWorkerRegistration: registration,
  })
  await api('/driver/me/fcm-token', { method: 'POST', body: JSON.stringify({ token }) })
  onMessage(messaging, () => {
    try {
      const ctx = new AudioContext()
      const osc = ctx.createOscillator()
      osc.frequency.value = 660
      osc.connect(ctx.destination)
      osc.start()
      setTimeout(() => {
        osc.stop()
        ctx.close()
      }, 500)
    } catch {
      // sem audio
    }
  })
  return 'ok'
}
