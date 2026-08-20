import { describe, expect, it } from 'vitest'
import {
  createOpenAICodexAdapter,
  OPENAI_CODEX_MAX_REQUEST_IMAGE_BYTES,
} from '../src/adapter.ts'
import { OpenAICodexCredentialStore } from '../src/store.ts'

const preferences = () => ({
  useFastMode: false,
  useWebSocketContextReuse: false,
  useNativeCompaction: false,
})

describe('OpenAI Codex model capabilities', () => {
  it('uses the rc.8 provider request image budget', () => {
    expect(OPENAI_CODEX_MAX_REQUEST_IMAGE_BYTES).toBe(20 * 1024 * 1024)
  })

  it('exposes the Codex-native Sol reasoning menu without generic aliases', async () => {
    const adapter = createOpenAICodexAdapter(
      new OpenAICodexCredentialStore(),
      () => undefined,
      preferences,
    )

    const resolved = await adapter.resolveModel('openai-codex', 'gpt-5.6-sol')

    expect(resolved.reasoning?.defaultEffort).toBe('low')
    expect(resolved.reasoning?.efforts.map(effort => effort.id))
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('uses the Codex-native default for Terra', async () => {
    const adapter = createOpenAICodexAdapter(
      new OpenAICodexCredentialStore(),
      () => undefined,
      preferences,
    )

    const resolved = await adapter.resolveModel('openai-codex', 'gpt-5.6-terra')

    expect(resolved.reasoning?.defaultEffort).toBe('medium')
  })
})
