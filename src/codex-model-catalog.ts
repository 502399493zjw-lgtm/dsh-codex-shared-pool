/** Plugin-owned additions to the pinned pi-ai catalog; never patch dependencies. */
import type { Model, Provider } from '@earendil-works/pi-ai'

/**
 * Astra identity, modalities and context window match the Codex catalog observed
 * on 2026-09-05. rc.8 supports reasoning through max, so ultra is not advertised.
 * The output limit is a conservative adapter budget, not a provider maximum.
 * Zero cost is pi-ai's unknown-price placeholder; Team accounting keeps its own
 * versioned rate card and must not infer a price from this descriptor.
 */
const ASTRA: Model<'openai-codex-responses'> = {
  id: 'gpt-6-astra',
  name: 'GPT-6-Astra',
  api: 'openai-codex-responses',
  provider: 'openai-codex',
  baseUrl: 'https://chatgpt.com/backend-api',
  reasoning: true,
  input: ['text', 'image'],
  contextWindow: 272_000,
  maxTokens: 32_768,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  thinkingLevelMap: { minimal: 'low', xhigh: 'xhigh', max: 'max' },
}

/** Preserve future upstream entries instead of adding duplicate model ids. */
export function supplementCodexModels(provider: Provider): Provider {
  return {
    ...provider,
    getModels: () => {
      const models = provider.getModels()
      return models.some(model => model.id === ASTRA.id) ? models : [...models, ASTRA]
    },
  }
}
