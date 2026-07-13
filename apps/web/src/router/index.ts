import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '../stores/auth'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: () => import('../views/HomeView.vue') },
    { path: '/login', name: 'login', component: () => import('../views/LoginView.vue') },
    { path: '/cadastro', name: 'register', component: () => import('../views/RegisterView.vue') },
    { path: '/verificar-email', name: 'verify-email', component: () => import('../views/VerifyEmailView.vue') },
    { path: '/recuperar-senha', name: 'recovery-start', component: () => import('../views/RecoveryStartView.vue') },
    { path: '/recuperar-senha/codigo', name: 'recovery-verify', component: () => import('../views/RecoveryVerifyView.vue') },
    { path: '/recuperar-senha/nova-senha', name: 'recovery-reset', component: () => import('../views/RecoveryResetView.vue') },
    {
      path: '/loja',
      component: () => import('../views/store/StoreLayout.vue'),
      meta: { requiresRole: ['STORE'] },
      children: [
        { path: '', redirect: '/loja/pedidos' },
        {
          path: 'pedidos',
          name: 'store-orders',
          component: () => import('../views/store/StoreOrdersView.vue'),
        },
        {
          path: 'perfil',
          name: 'store-profile',
          component: () => import('../views/store/StoreProfileView.vue'),
        },
        {
          path: 'cardapio',
          name: 'store-menu',
          component: () => import('../views/store/StoreMenuView.vue'),
        },
        {
          path: 'cardapio/produto/:productId?',
          name: 'store-product-form',
          component: () => import('../views/store/ProductFormView.vue'),
        },
        {
          path: 'financeiro',
          name: 'store-finance',
          component: () => import('../views/store/StoreFinanceView.vue'),
        },
        {
          path: 'entregadores',
          name: 'store-drivers',
          component: () => import('../views/store/StoreDriversView.vue'),
        },
        {
          path: 'vagas',
          name: 'store-offers',
          component: () => import('../views/store/StoreOffersView.vue'),
        },
      ],
    },
    {
      path: '/admin',
      component: () => import('../views/admin/AdminLayout.vue'),
      meta: { requiresRole: ['ADMIN'] },
      children: [
        { path: '', name: 'admin', redirect: '/admin/lojas' },
        {
          path: 'lojas',
          name: 'admin-stores',
          component: () => import('../views/admin/AdminStoresView.vue'),
        },
        {
          path: 'entregadores',
          name: 'admin-drivers',
          component: () => import('../views/admin/AdminDriversView.vue'),
        },
        {
          path: 'financeiro',
          name: 'admin-finance',
          component: () => import('../views/admin/AdminFinanceView.vue'),
        },
        {
          path: 'devolucoes',
          name: 'admin-returns',
          component: () => import('../views/admin/AdminReturnsView.vue'),
        },
      ],
    },
    { path: '/busca', name: 'search', component: () => import('../views/SearchView.vue') },
    { path: '/checkout', name: 'checkout', component: () => import('../views/CheckoutView.vue'), meta: { requiresAuth: true } },
    { path: '/pedidos', name: 'my-orders', component: () => import('../views/MyOrdersView.vue'), meta: { requiresAuth: true } },
    { path: '/pedido/:orderId', name: 'order-tracking', component: () => import('../views/OrderTrackingView.vue'), meta: { requiresAuth: true } },
    // deep-link da loja: exemplo.com.br/NomeDaLoja — SEMPRE por último
    {
      path: '/:storeSlug',
      name: 'store-catalog',
      component: () => import('../views/StoreCatalogView.vue'),
    },
    {
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: () => import('../views/NotFoundView.vue'),
    },
  ],
})

router.beforeEach((to) => {
  if (to.meta.requiresAuth) {
    const auth = useAuthStore()
    if (!auth.isAuthenticated) return { name: 'login', query: { redirect: to.fullPath } }
  }
  const required = to.matched.flatMap((r) => (r.meta.requiresRole as string[] | undefined) ?? [])
  if (required.length === 0) return true
  const auth = useAuthStore()
  if (!auth.isAuthenticated) return { name: 'login', query: { redirect: to.fullPath } }
  if (!required.includes(auth.role!)) return { name: 'home' }
  return true
})
