import type { AuthInteraction } from '@earendil-works/pi-ai'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenAICodexProfileStore } from '../src/store.ts'

const model = vi.hoisted(() => ({
  createModels: vi.fn(({ credentials }: { credentials: {
    modify(providerId: string, fn: (current: undefined) => Promise<unknown>): Promise<unknown>
  } }) => ({
    setProvider: vi.fn(),
    login: vi.fn(async () => credentials.modify('openai-codex', async () => ({
      type: 'oauth',
      access: 'captured-access-token',
      refresh: 'captured-refresh-token',
      expires: 4_102_444_800_000,
    }))),
  })),
}))

vi.mock('@earendil-works/pi-ai', () => ({
  createModels: model.createModels,
}))

vi.mock('@earendil-works/pi-ai/providers/openai-codex', () => ({
  openaiCodexProvider: vi.fn(() => ({ id: 'openai-codex' })),
}))

import { loginOpenAICodexProfile } from '../src/auth.ts'

const interaction = {
  notify: vi.fn(),
  prompt: vi.fn(),
} as unknown as AuthInteraction

describe('OpenAI Codex OAuth commit gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not persist a captured credential when Host invalidates the attempt before commit', async () => {
    const cancellation = new Error('authorization attempt cancelled')
    const addProfile = vi.fn()
    const store = { addProfile } as unknown as OpenAICodexProfileStore

    await expect(loginOpenAICodexProfile(interaction, store, {
      beforeCommit: () => { throw cancellation },
    })).rejects.toBe(cancellation)

    expect(addProfile).not.toHaveBeenCalled()
  })
})
