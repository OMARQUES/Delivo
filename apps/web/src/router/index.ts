import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '../stores/auth'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: () => import('../views/HomeView.vue') },
    { path: '/login', name: 'login', component: () => import('../views/LoginView.vue') },
    { path: '/cadastro', name: 'register', component: () => import('../views/RegisterView.vue') },
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
      ],
    },
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
  const required = to.matched.flatMap((r) => (r.meta.requiresRole as string[] | undefined) ?? [])
  if (required.length === 0) return true
  const auth = useAuthStore()
  if (!auth.isAuthenticated) return { name: 'login', query: { redirect: to.fullPath } }
  if (!required.includes(auth.role!)) return { name: 'home' }
  return true
})
