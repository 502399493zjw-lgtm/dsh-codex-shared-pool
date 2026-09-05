import { describe, expect, it } from 'vitest'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { supplementCodexModels } from '../src/codex-model-catalog.ts'
import { createTeamClientProvider } from '../src/adapter.ts'
import { supportsCodexFastMode } from '../src/shared/model-capabilities.ts'

describe('supplemental Codex catalog', () => {
  it('routes the supplemental model through the same Team gateway with its verified capabilities', () => {
    const base = 'https://pool.example.test/plugins/dsh-codex-shared-pool/team'
    const source = openaiCodexProvider()
    const provider = createTeamClientProvider(supplementCodexModels(source), base)
    expect(provider.getModels().find(model => model.id === 'gpt-6-astra')).toMatchObject({
      baseUrl: base, input: ['text', 'image'], contextWindow: 272_000,
      thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
    })
    expect(supportsCodexFastMode('gpt-6-astra')).toBe(true)
    expect(source.getModels().every(model => model.baseUrl !== base)).toBe(true)
  })

  it('preserves a future upstream Astra entry and never duplicates it', () => {
    const source = openaiCodexProvider()
    const astra = { ...source.getModels()[0]!, id: 'gpt-6-astra', name: 'Upstream Astra' }
    const provider = supplementCodexModels({ ...source, getModels: () => [astra] })
    expect(provider.getModels()).toEqual([astra])
    expect(provider.getModels()[0]).toBe(astra)
  })
})
