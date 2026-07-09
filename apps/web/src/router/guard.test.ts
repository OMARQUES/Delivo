import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { router } from './index'
import { useAuthStore } from '../stores/auth'

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
})

describe('route guards', () => {
  it('redirects anonymous from /loja to /login with redirect query', async () => {
    await router.push('/loja')
    await router.isReady()
    expect(router.currentRoute.value.name).toBe('login')
    expect(router.currentRoute.value.query.redirect).toBe('/loja/pedidos')
  })

  it('blocks wrong-role from /admin (customer → home)', async () => {
    const auth = useAuthStore()
    auth.$patch({
      user: { id: 'u', name: 'A', role: 'CUSTOMER', status: 'ACTIVE', phone: null, email: null },
      accessToken: 'a',
      refreshToken: 'r',
    })
    await router.push('/admin')
    expect(router.currentRoute.value.name).toBe('home')
  })

  it('redirects anonymous from customer auth routes to /login', async () => {
    await router.push('/checkout')
    expect(router.currentRoute.value.name).toBe('login')
    expect(router.currentRoute.value.query.redirect).toBe('/checkout')
  })

  it('allows public routes + store deep-link anonymously', async () => {
    await router.push('/PizzariaX')
    expect(router.currentRoute.value.name).toBe('store-catalog')
    await router.push('/')
    expect(router.currentRoute.value.name).toBe('home')
  })
})
