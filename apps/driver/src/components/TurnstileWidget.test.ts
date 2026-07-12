import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TurnstileWidget from './TurnstileWidget.vue'

type TurnstileOptions = {
  callback: (token: string) => void
  'expired-callback': () => void
  'error-callback': () => void
}

beforeEach(() => {
  document.head.innerHTML = ''
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.stubEnv('VITE_TURNSTILE_SITE_KEY', 'site-key')
})

describe('driver TurnstileWidget', () => {
  it('renders explicitly, emits token/null, and can reset', async () => {
    let options!: TurnstileOptions
    const reset = vi.fn()
    vi.stubGlobal('turnstile', {
      render: vi.fn((_el: HTMLElement, opts: TurnstileOptions) => {
        options = opts
        return 'widget-1'
      }),
      reset,
    })

    const wrapper = mount(TurnstileWidget, { props: { action: 'login' } })
    await vi.waitFor(() => expect(window.turnstile!.render).toHaveBeenCalled())

    options.callback('token-1')
    expect(wrapper.emitted('update:token')?.at(-1)).toEqual(['token-1'])
    options['error-callback']()
    expect(wrapper.emitted('update:token')?.at(-1)).toEqual([null])
    ;(wrapper.vm as unknown as { reset: () => void }).reset()
    expect(reset).toHaveBeenCalledWith('widget-1')
  })
})
