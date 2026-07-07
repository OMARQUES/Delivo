import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import { wireAuthToApi } from './stores/auth'
import './style.css'

const app = createApp(App).use(createPinia()).use(router)
wireAuthToApi()
app.mount('#app')
