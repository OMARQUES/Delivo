import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '../stores/auth'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: () => import('../views/LoginView.vue') },
    { path: '/cadastro', name: 'register', component: () => import('../views/RegisterView.vue') },
    {
      path: '/',
      component: () => import('../components/DriverLayout.vue'),
      meta: { requiresDriver: true },
      children: [
        { path: '', name: 'available', component: () => import('../views/AvailableView.vue') },
        { path: 'entregas', name: 'deliveries', component: () => import('../views/DeliveriesView.vue') },
        { path: 'financeiro', name: 'finance', component: () => import('../views/FinanceView.vue') },
        { path: 'lojas', name: 'stores', component: () => import('../views/StoresView.vue') },
        { path: 'vagas', name: 'offers', component: () => import('../views/OffersView.vue') },
        { path: 'perfil', name: 'profile', component: () => import('../views/ProfileView.vue') },
  ],
    },
  ],
})

router.beforeEach((to) => {
  if (!to.meta.requiresDriver && !to.matched.some((r) => r.meta.requiresDriver)) return true
  const auth = useAuthStore()
  if (!auth.isAuthenticated) return { name: 'login' }
  if (auth.role !== 'DRIVER') return { name: 'login' }
  return true
})
