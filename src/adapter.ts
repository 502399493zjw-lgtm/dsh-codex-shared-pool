/** OpenAI Codex adapter assembled from public dsh-llm-pi-ai extension points. */

import { TEAM_LIMIT_REASONS_HEADER, teamLimitMessage } from './team/gateway-errors.ts'
import { supplementCodexModels } from './codex-model-catalog.ts'
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
import { resolveTeamClientBaseUrl, teamClientResponsesUrl } from './team/client.ts'

/** Provider idle ceiling used by the composite route. */
export const OPENAI_CODEX_STREAM_IDLE_TIMEOUT_MS = 300_000

/**
 * Match the stock rc.8 pi-ai route default while leaving enough request-body
 * headroom for prompts, tools, and JSON around the encoded image payload.
 */
export const OPENAI_CODEX_MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024

const REASONING_DESCRIPTIONS = {
  low: '响应更快，推理程度较轻',
  medium: '兼顾速度与推理深度，适合日常任务',
  high: '推理深度更高，适合复杂问题',
  xhigh: '超高推理深度，适合复杂问题',
  max: '最高推理深度，适合最困难的问题',
} as const

type CodexReasoningEffort = keyof typeof REASONING_DESCRIPTIONS

/** Match the simplified-Chinese effort labels used by the Codex client. */
const REASONING_DISPLAY_NAMES: Readonly<Record<CodexReasoningEffort, string>> = {
  low: '轻度',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高',
}

interface CodexReasoningCatalogEntry {
  readonly defaultEffort: CodexReasoningEffort
  readonly efforts: readonly CodexReasoningEffort[]
}

/** Mirror the selectable efforts in the bundled Codex 0.147 model catalog. */
const CODEX_REASONING_CATALOG: Readonly<Record<string, CodexReasoningCatalogEntry>> = {
  'gpt-6-astra': { defaultEffort: 'medium', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
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

export interface OpenAICodexTeamClientAdapterOptions {
  /** Validated Team base URL ending in the plugin Team path. */
  readonly baseUrl: string
  /** Per-request Host credential resolver returning a Codex-compatible Team bearer. */
  readonly resolveApiKey: () => Promise<string>
}

/** Rewrite the complete static Codex model catalog to one Team gateway. */
export function createTeamClientProvider(provider: Provider, baseUrl: string): Provider {
  const resolvedBaseUrl = resolveTeamClientBaseUrl(baseUrl)
  return {
    ...provider,
    baseUrl: resolvedBaseUrl,
    getModels: () => provider.getModels().map(model => ({ ...model, baseUrl: resolvedBaseUrl })),
    streamSimple: (model, context, options) => provider.streamSimple(model, context, {
      ...options,
      onResponse: async (response, responseModel) => {
        await options?.onResponse?.(response, responseModel)
        // pi-ai maps every HTTP 429 to ChatGPT quota exhaustion. Team admission
        // also uses 429; retain the HTTP status and give it a Team-specific error.
        if (response.status === 429) {
          throw new Error(teamLimitMessage(response.headers[TEAM_LIMIT_REASONS_HEADER]))
        }
      },
    }),
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
          name: REASONING_DISPLAY_NAMES[effort],
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
  teamClientOrRoutingEvents?: OpenAICodexTeamClientAdapterOptions | LocalRoutingEventLedger,
  routingEventsOverride?: LocalRoutingEventLedger,
): PiAiAdapter {
  const teamClient = teamClientOrRoutingEvents !== undefined && 'resolveApiKey' in teamClientOrRoutingEvents
    ? teamClientOrRoutingEvents
    : undefined
  const routingEvents = teamClient === undefined
    ? teamClientOrRoutingEvents as LocalRoutingEventLedger | undefined
    : routingEventsOverride
  const localProvider = supplementCodexModels(openaiCodexProvider())
  const provider = teamClient === undefined
    ? localProvider
    : createTeamClientProvider(localProvider, teamClient.baseUrl)
  const responses = new OpenAICodexResponseRuntime(
    responsePreferences,
    teamClient === undefined ? undefined : () => {
      // Team routing owns upstream stickiness; there is no local WebSocket
      // continuation to close when the gateway changes an upstream account.
    },
    teamClient === undefined
      ? {}
      : { forceSse: true, responsesUrl: teamClientResponsesUrl(teamClient.baseUrl) },
  )
  const profiles = new Map<string, ResolvedPiAiProviderProfile>([[OPENAI_CODEX_PROVIDER, {
    provider: OPENAI_CODEX_PROVIDER,
    displayName: 'OpenAI Codex',
    streamIdleTimeoutMs: OPENAI_CODEX_STREAM_IDLE_TIMEOUT_MS,
    maxRequestImageBytes: OPENAI_CODEX_MAX_REQUEST_IMAGE_BYTES,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-openai-codex retryPolicy'),
    configuredMaxTokens: new Map(),
    piProvider: responses.wrap(requestProvider(provider)),
  }]])
  let resolveApiKey: () => Promise<string | undefined>
  if (teamClient === undefined) {
    const models: MutableModels = createModels({ credentials })
    models.setProvider(localProvider)
    resolveApiKey = async () => (await models.getAuth(OPENAI_CODEX_PROVIDER))?.auth.apiKey
  } else {
    resolveApiKey = teamClient.resolveApiKey
  }
  return new OpenAICodexAdapter({
    profiles: () => profiles,
    resolveApiKey,
    resolveAttachments,
  }, responses, credentials, teamClient === undefined, routingEvents)
}
