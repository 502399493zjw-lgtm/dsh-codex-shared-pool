// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconCheckOutline16: (props: Record<string, unknown>) => createElement('svg', props),
  IconChevronDownOutline14: (props: Record<string, unknown>) => createElement('svg', props),
  IconChevronRightOutline14: (props: Record<string, unknown>) => createElement('svg', props),
}))

import { CodexModelSelect } from '../src/client/CodexModelSelect.tsx'
import { zh, type OpenAICodexSettingsKey } from '../src/client/locales.ts'
import { resetResponsePreferencesForTests } from '../src/client/response-preferences.ts'

afterEach(() => {
  cleanup()
  resetResponsePreferencesForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const t = (key: OpenAICodexSettingsKey): string => zh[key]

const snapshot = {
  current: { provider: 'openai-codex', model: 'gpt-5.6-sol', reasoningEffort: 'low' },
  routable: true,
  groups: [{
    id: 'openai-codex',
    name: 'OpenAI Codex',
    models: [{
      id: 'gpt-5.6-sol',
      name: 'GPT-5.6 Sol',
      reasoning: {
        defaultEffort: 'low',
        efforts: [
          { id: 'low', name: '轻度', description: '响应更快，推理程度较轻' },
          { id: 'medium', name: '中', description: '兼顾速度与推理深度，适合日常任务' },
          { id: 'high', name: '高', description: '推理深度更高，适合复杂问题' },
          { id: 'xhigh', name: '极高', description: '超高推理深度，适合复杂问题' },
          { id: 'max', name: '最高', description: '最高推理深度，适合最困难的问题' },
        ],
      },
    }],
  }],
  failures: [],
  status: 'ready',
  error: null,
} as const

describe('stock DSH Codex model selector', () => {
  it('renders Fast and reasoning choices through the rc.8 model-seat contract', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      useFastMode: false,
      useWebSocketContextReuse: false,
      useNativeCompaction: false,
    }), { status: 200 })))

    render(<CodexModelSelect
      locked={false}
      available
      directory={{
        getSnapshot: () => snapshot,
        subscribe: () => () => undefined,
      }}
      load={vi.fn()}
      select={vi.fn(async () => true)}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    let speedRow: HTMLButtonElement | null = null
    await waitFor(() => {
      speedRow = screen.getByText('速度').closest('button')
      expect(speedRow?.getAttribute('role')).toBe('menuitem')
      expect(speedRow?.textContent).toContain('标准')
    })
    fireEvent.click(speedRow!)
    expect(screen.getByRole('menu', { name: '速度' })).toBeDefined()
    expect(screen.getByRole('menuitemradio', { name: /标准/ })).toBeDefined()
    expect(screen.getByRole('menuitemradio', { name: /快速/ })).toBeDefined()

    fireEvent.click(screen.getByRole('menuitemradio', { name: /标准/ }))
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    const reasoningRow = screen.getByText('推理等级').closest('button')
    expect(reasoningRow?.getAttribute('role')).toBe('menuitem')
    expect(reasoningRow?.textContent).toContain('轻度')
    fireEvent.click(reasoningRow!)

    for (const label of ['轻度', '中', '高', '极高', '最高']) {
      expect(screen.getByRole('menuitemradio', { name: new RegExp(`^${label}`) })).toBeDefined()
    }
    for (const description of [
      '响应更快，推理程度较轻',
      '兼顾速度与推理深度，适合日常任务',
      '推理深度更高，适合复杂问题',
      '超高推理深度，适合复杂问题',
      '最高推理深度，适合最困难的问题',
    ]) {
      expect(screen.getByText(description)).toBeDefined()
    }
  })
})
