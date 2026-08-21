// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconCheckOutline16: (props: Record<string, unknown>) => createElement('svg', props),
  IconChevronRightOutline14: (props: Record<string, unknown>) => createElement('svg', props),
}))

import { FastModeModelPreference } from '../src/client/FastModeModelPreference.tsx'
import { zh, type OpenAICodexSettingsKey } from '../src/client/locales.ts'
import { resetResponsePreferencesForTests } from '../src/client/response-preferences.ts'

afterEach(() => {
  cleanup()
  resetResponsePreferencesForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const t = (key: OpenAICodexSettingsKey): string => zh[key]

describe('Codex mode localization', () => {
  it('uses the Codex client Chinese names for the speed selector', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        useFastMode: false,
        useWebSocketContextReuse: false,
        useNativeCompaction: false,
      }),
    } as Response)))

    render(<FastModeModelPreference
      selection={{ provider: 'openai-codex', model: 'gpt-5.6-sol' }}
      interactionId="test-menu"
      close={vi.fn()}
      registerItem={vi.fn()}
      t={t}
    />)

    await waitFor(() => {
      expect(screen.getByRole('menuitem').textContent).toContain('速度')
      expect(screen.getByRole('menuitem').textContent).toContain('标准')
    })
    fireEvent.click(screen.getByRole('menuitem'))

    expect(screen.getByRole('menu', { name: '速度' })).toBeDefined()
    expect(screen.getByRole('menuitemradio', { name: /标准/ })).toBeDefined()
    expect(screen.getByRole('menuitemradio', { name: /快速/ })).toBeDefined()
    expect(screen.queryByText('Standard')).toBeNull()
    expect(screen.queryByText('Fast')).toBeNull()
  })
})
