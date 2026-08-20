// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronRightOutline14: ({ size }: { size?: number }) => <svg data-size={size} />,
}))

import { apply, inject, NS } from '../src/client/quota/index.ts'
import {
  CodexQuotaFooter,
  type CodexQuotaFooterFace,
} from '../src/client/quota/CodexQuotaFooter.tsx'

const SNAPSHOT = {
  currentAccountName: '经纬 钟',
  currentRemainingPercent: 73,
  currentResetsAt: null,
  poolAccountCount: 12,
  poolRemainingPercent: 61,
  refreshedAt: 1,
} as const

interface RegisteredEntry {
  component: unknown
  options: Record<string, unknown>
  inject: () => CodexQuotaFooterFace
}

function bench(withSettingsNavigation = true): {
  ctx: object
  entry: () => RegisteredEntry | undefined
  localeRegister: ReturnType<typeof vi.fn>
  openSection: ReturnType<typeof vi.fn>
  dispose: () => Promise<void>
} {
  let currentEntry: RegisteredEntry | undefined
  const disposers: Array<() => void | Promise<void>> = []
  const localeRegister = vi.fn(() => () => undefined)
  const openSection = vi.fn()
  const slots = {
    register(options: Record<string, unknown>, component: unknown) {
      currentEntry = {
        component,
        options,
        inject: options['inject'] as () => CodexQuotaFooterFace,
      }
      return () => { currentEntry = undefined }
    },
    inject(_name: string, register: () => () => void) {
      const dispose = register()
      disposers.push(dispose)
      return dispose
    },
  }
  const ctx = {
    locale: { register: localeRegister },
    slots,
    get(name: string) {
      return name === 'settingsNavigation' && withSettingsNavigation
        ? { openSection }
        : undefined
    },
    effect(effect: () => () => void | Promise<void>) {
      const dispose = effect()
      disposers.push(dispose)
      return dispose
    },
  }
  return {
    ctx,
    entry: () => currentEntry,
    localeRegister,
    openSection,
    dispose: async () => {
      for (const dispose of [...disposers].reverse()) await dispose()
    },
  }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('unified Codex quota browser contribution', () => {
  it('registers one localized sidebar contribution and opens the shared Codex settings page', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(SNAPSHOT), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const b = bench()

    expect(inject).toEqual(['slots', 'locale'])
    apply(b.ctx as never)

    expect(b.localeRegister).toHaveBeenCalledWith(NS, expect.any(Object))
    const entry = b.entry()
    expect(entry?.component).toBe(CodexQuotaFooter)
    expect(entry?.options).toMatchObject({ id: 'codex-quota', order: -1000, locale: NS })

    const injected = entry?.inject()
    injected?.openSettings?.()
    expect(b.openSection).toHaveBeenCalledWith('openai-codex')
    await expect(injected?.read()).resolves.toEqual(SNAPSHOT)
    expect(fetchMock).toHaveBeenCalledWith(
      '/plugins/dsh-openai-codex/quota',
      expect.objectContaining({ method: 'GET', credentials: 'same-origin' }),
    )

    await b.dispose()
    expect(b.entry()).toBeUndefined()
  })

  it('keeps Settings navigation optional and rejects an unsuccessful quota response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })))
    const b = bench(false)
    apply(b.ctx as never)

    const injected = b.entry()?.inject()
    expect(injected?.openSettings).toBeUndefined()
    await expect(injected?.read()).rejects.toThrow('HTTP 503')
    await b.dispose()
  })
})
