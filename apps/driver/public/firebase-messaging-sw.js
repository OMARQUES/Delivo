/* global importScripts, firebase, self */
// Service worker do FCM (background). Config duplicada por necessidade - SW não lê import.meta.env.
// Os valores públicos do Firebase NÃO são segredos. Preencha ao configurar o Firebase (ver README).
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js')
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js')

const config = {
  apiKey: 'AIzaSyAf5ERsFAEFcDUeSS6CkTQlUi9L7MqXlYU',
  projectId: 'delivery-573f0',
  messagingSenderId: '396629807095',
  appId: '1:396629807095:web:ede75da21b8c90103ea8f2',
}

if (config.apiKey !== 'FILL_ME') {
  firebase.initializeApp(config)
  const messaging = firebase.messaging()
  messaging.onBackgroundMessage((payload) => {
    self.registration.showNotification(payload.notification?.title ?? 'Nova entrega!', {
      body: payload.notification?.body ?? '',
      data: payload.data,
    })
  })
}
