/** OpenAI Codex adapter assembled from public dsh-llm-pi-ai extension points. */

import { createModels } from '@earendil-works/pi-ai'
import type { MutableModels, Provider } from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { ReasoningEffortId, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { allocateOpenAICodexSessionProfile } from './account-allocation.ts'
import type { LocalRoutingEventLedger } from './local-routing-events.ts'
import type { OpenAICodexCredentialStore } from './store.ts'
import { OPENAI_CODEX_PROVIDER } from './store.ts'
import { OpenAICodexResponseRuntime } from './responses.ts'
import type { ResponseApiPreferences } from './tool-policy.ts'

/** Provider idle ceiling used by the composite route. */
export const OPENAI_CODEX_STREAM_IDLE_TIMEOUT_MS = 300_000

/**
 * Match the stock rc.8 pi-ai route default while leaving enough request-body
 * headroom for prompts, tools, and JSON around the encoded image payload.
 */
export const OPENAI_CODEX_MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024

const REASONING_DESCRIPTIONS = {
  low: 'Fast responses with lighter reasoning',
  medium: 'Balances speed and reasoning depth for everyday tasks',
  high: 'Greater reasoning depth for complex problems',
  xhigh: 'Extra high reasoning depth for complex problems',
  max: 'Maximum reasoning depth for the hardest problems',
} as const

type CodexReasoningEffort = keyof typeof REASONING_DESCRIPTIONS

interface CodexReasoningCatalogEntry {
  readonly defaultEffort: CodexReasoningEffort
  readonly efforts: readonly CodexReasoningEffort[]
}

/** Mirror the selectable efforts in the bundled Codex 0.147 model catalog. */
const CODEX_REASONING_CATALOG: Readonly<Record<string, CodexReasoningCatalogEntry>> = {
  'gpt-5.4': { defaultEffort: 'medium', efforts: ['low', 'medium', 'high', 'xhigh'] },
  'gpt-5.4-mini': { defaultEffort: 'medium', efforts: ['low', 'medium', 'high', 'xhigh'] },
  'gpt-5.5': { defaultEffort: 'medium', efforts: ['low', 'medium', 'high', 'xhigh'] },
  'gpt-5.6-luna': { defaultEffort: 'medium', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  'gpt-5.6-sol': { defaultEffort: 'low', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  'gpt-5.6-terra': { defaultEffort: 'medium', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
}

/**
 * Give the generic dsh adapter a request-scoped bearer-token entry without
 * changing the provider's user-facing OAuth flow. The resolver accepts only
 * the explicit override supplied by this plugin; it never discovers an API
 * key from the environment or persistent api-key credentials.
 */
function requestProvider(provider: Provider): Provider {
  return {
    ...provider,
    auth: {
      ...provider.auth,
      apiKey: {
        name: 'OpenAI Codex OAuth bearer token',
        resolve({ credential }) {
          const apiKey = credential?.key
          return Promise.resolve(apiKey === undefined || apiKey.length === 0
            ? undefined
            : { auth: { apiKey }, source: 'OAuth' })
        },
      },
    },
  }
}

/** Preserve Harness call purpose until the generic pi-ai adapter reaches the provider. */
class OpenAICodexAdapter extends PiAiAdapter {
  constructor(
    options: ConstructorParameters<typeof PiAiAdapter>[0],
    private readonly responses: OpenAICodexResponseRuntime,
    private readonly credentials: OpenAICodexCredentialStore,
    private readonly allocateLocalSession: boolean,
    private readonly routingEvents?: LocalRoutingEventLedger,
  ) {
    super(options)
  }

  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const resolved = await super.resolveModel(provider, model, signal)
    if (provider !== OPENAI_CODEX_PROVIDER) return resolved
    const catalog = CODEX_REASONING_CATALOG[model]
    if (catalog === undefined) return resolved
    return {
      ...resolved,
      reasoning: {
        efforts: catalog.efforts.map(effort => ({
          id: ReasoningEffortId(effort),
          name: effort === 'xhigh' ? 'Xhigh' : `${effort.charAt(0).toUpperCase()}${effort.slice(1)}`,
          description: REASONING_DESCRIPTIONS[effort],
        })),
        defaultEffort: ReasoningEffortId(catalog.defaultEffort),
      },
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    let routingEventId: string | undefined
    if (this.allocateLocalSession && options.sessionId !== undefined) {
      const allocation = await allocateOpenAICodexSessionProfile(
        this.credentials,
        String(options.sessionId),
        options.model,
        options.signal,
        undefined,
        (sessionId) => {
          this.responses.resetSessionContext(sessionId)
        },
      )
      if (allocation !== undefined && this.routingEvents !== undefined) {
        routingEventId = this.routingEvents.begin({
          allocation,
          profileOrder: (await this.credentials.listProfiles()).map(profile => profile.id),
          model: options.model,
        })
      }
    }
    const release = options.purpose === 'compaction'
      ? this.responses.enterCompaction(options.sessionId === undefined ? undefined : String(options.sessionId))
      : undefined
    let terminalStatus: 'succeeded' | 'failed' | 'cancelled' | undefined
    try {
      for await (const chunk of super.stream(options)) {
        if (chunk.type === 'finish') {
          terminalStatus = chunk.reason.kind === 'aborted'
            ? 'cancelled'
            : chunk.reason.kind === 'error' ? 'failed' : 'succeeded'
        }
        yield chunk
      }
    } catch (error: unknown) {
      terminalStatus = options.signal?.aborted === true ? 'cancelled' : 'failed'
      throw error
    } finally {
      if (routingEventId !== undefined) {
        this.routingEvents?.settle(
          routingEventId,
          terminalStatus ?? (options.signal?.aborted === true ? 'cancelled' : 'succeeded'),
        )
      }
      release?.()
    }
  }
}

/**
 * Create the Codex subscription adapter without requiring a dsh fork. The
 * public pi-ai adapter owns Harness message conversion, image attachment
 * resolution, streaming, and reasoning metadata. This plugin adds optional
 * Codex-native request state/compaction and supplies the provider OAuth token.
 *
 * @param credentials - Refreshable OAuth credential source.
 * @param resolveAttachments - Resolves the active conversation attachment store.
 * @param responsePreferences - Reads the current Codex Responses preferences.
 * @param routingEvents - Optional metadata-only ledger for local routing attempts.
 * @returns Harness adapter for the OpenAI Codex provider.
 */
export function createOpenAICodexAdapter(
  credentials: OpenAICodexCredentialStore,
  resolveAttachments: () => AttachmentStore | undefined,
  responsePreferences: () => ResponseApiPreferences,
  routingEvents?: LocalRoutingEventLedger,
): PiAiAdapter {
  const provider = openaiCodexProvider()
  const responses = new OpenAICodexResponseRuntime(responsePreferences)
  const profiles = new Map<string, ResolvedPiAiProviderProfile>([[OPENAI_CODEX_PROVIDER, {
    provider: OPENAI_CODEX_PROVIDER,
    displayName: 'OpenAI Codex',
    streamIdleTimeoutMs: OPENAI_CODEX_STREAM_IDLE_TIMEOUT_MS,
    maxRequestImageBytes: OPENAI_CODEX_MAX_REQUEST_IMAGE_BYTES,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-openai-codex retryPolicy'),
    configuredMaxTokens: new Map(),
    piProvider: responses.wrap(requestProvider(provider)),
  }]])
  const models: MutableModels = createModels({ credentials })
  models.setProvider(provider)
  return new OpenAICodexAdapter({
    profiles: () => profiles,
    resolveApiKey: async () => (await models.getAuth(OPENAI_CODEX_PROVIDER))?.auth.apiKey,
    resolveAttachments,
  }, responses, credentials, true, routingEvents)
}
