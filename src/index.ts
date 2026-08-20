/**
 * Optional OpenAI Codex subscription bundle with ChatGPT OAuth, Codex models,
 * standalone search, browser settings, and vision-aware image input.
 * @module @deepseek-ai/dsh-codex_shared_pool
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-web'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import {
  CodexQuotaConfigSchema,
  CodexQuotaProvider,
  type CodexQuotaConfig,
} from './quota/provider.ts'
import { createOpenAICodexAdapter } from './adapter.ts'
import { registerOpenAICodexAuthRoutes } from './auth-routes.ts'
import { installReadImageEnhancement } from './read-image-enhancement.ts'
import { imagegenTool } from './imagegen.ts'
import { OutboundNetwork } from './network.ts'
import { LocalRoutingEventLedger } from './local-routing-events.ts'
import {
  installOpenAICodexSearchEvent,
  recordOpenAICodexSearchRequest,
} from './search-event.ts'

export { READ_IMAGE_TOOL_NAME } from './read-image-enhancement.ts'
export {
  IMAGEGEN_TOOL_NAME,
  OPENAI_CODEX_IMAGE_EDITS_URL,
  OPENAI_CODEX_IMAGE_GENERATIONS_URL,
  OPENAI_CODEX_IMAGE_MODEL,
  OpenAICodexImageClient,
} from './imagegen.ts'
export {
  DEFAULT_IMAGE_TOOL_PREFERENCES,
  DEFAULT_RESPONSE_API_PREFERENCES,
  ImageToolPolicy,
} from './tool-policy.ts'
export type { ImageToolPreferences, ResponseApiPreferences } from './tool-policy.ts'
export { OutboundNetwork, resolveOutboundProxyEnvironment } from './network.ts'
export type { OutboundNetworkStatus, OutboundProxyEnvironment } from './network.ts'
export { OPENAI_CODEX_USAGE_URL, parseOpenAICodexUsage, readOpenAICodexRateLimits } from './usage.ts'
export type {
  OpenAICodexCredits,
  OpenAICodexIndividualLimit,
  OpenAICodexRateLimit,
  OpenAICodexRateLimitWindow,
  OpenAICodexUsage,
} from './usage.ts'
export {
  installOpenAICodexSearchEvent,
  OPENAI_CODEX_SEARCH_MODEL_REQUEST_EVENT,
  recordOpenAICodexSearchRequest,
} from './search-event.ts'
import {
  DEFAULT_OPENAI_CODEX_SEARCH_CONTEXT_SIZE,
  DEFAULT_OPENAI_CODEX_SEARCH_MAX_OUTPUT_TOKENS,
  DEFAULT_OPENAI_CODEX_SEARCH_MODE,
  DEFAULT_OPENAI_CODEX_SEARCH_MODEL,
  OpenAICodexSearchProvider,
} from './search.ts'
import type { OpenAICodexSearchContextSize, OpenAICodexSearchMode } from './search.ts'
import { OPENAI_CODEX_PROVIDER } from './store.ts'
import { OpenAICodexService } from './service.ts'
import { installOpenAICodexTui } from './tui.ts'

export { OpenAICodexService } from './service.ts'
export type { OpenAICodexServiceOptions } from './service.ts'

export { loginOpenAICodex, loginOpenAICodexProfile, logoutOpenAICodex, openAICodexAuthStatus } from './auth.ts'
export type { OpenAICodexAuthStatus } from './auth.ts'
export {
  OpenAICodexCredentialStore,
  LEGACY_OPENAI_CODEX_AUTH_FILENAME,
  OPENAI_CODEX_AUTH_FILENAME,
  OPENAI_CODEX_PROVIDER,
  openAICodexAuthPath,
} from './store.ts'
export type { CodexProfileSummary, OpenAICodexProfileStore } from './store.ts'
export {
  DEFAULT_OPENAI_CODEX_SEARCH_CONTEXT_SIZE,
  DEFAULT_OPENAI_CODEX_SEARCH_MAX_OUTPUT_TOKENS,
  DEFAULT_OPENAI_CODEX_SEARCH_MODE,
  DEFAULT_OPENAI_CODEX_SEARCH_MODEL,
  mapOpenAICodexSearchResponse,
  OpenAICodexSearchProvider,
  OPENAI_CODEX_BASE_URL,
  OPENAI_CODEX_SEARCH_PROVIDER,
  OPENAI_CODEX_SEARCH_URL,
} from './search.ts'
export type {
  OpenAICodexSearchContextSize,
  OpenAICodexSearchMode,
  OpenAICodexSearchProviderOptions,
  OpenAICodexSearchRequestRecord,
} from './search.ts'

/** Stable Cordis plugin name. */
export const name = 'dsh-codex-shared-pool'

/** LLM and web registries required before the composite provider can register. */
export const inject = ['llm', 'web']

/** Composite model and standalone-search configuration. */
export interface Config {
  /** Read-only Codex account-pool quota projection for the browser sidebar. */
  quota?: CodexQuotaConfig
  /** Model used for auxiliary standalone searches. */
  searchModel?: string
  /** Cached, indexed, or live web access. */
  searchMode?: OpenAICodexSearchMode
  /** Amount of search context returned by the provider. */
  searchContextSize?: OpenAICodexSearchContextSize
  /** Maximum generated tokens returned by the standalone search endpoint. */
  searchMaxOutputTokens?: number
  /** Extend Harness read_image with HTTP(S) URL input. */
  modifyReadImage?: boolean
  /** Allow non-Codex vision models to call imagegen. */
  shareImagegenWithOtherModels?: boolean
  /** Reuse matching Codex context through the session's WebSocket connection. */
  useWebSocketContextReuse?: boolean
  /** Use Codex's priority service tier when the selected model supports Fast. */
  useFastMode?: boolean
  /** Use Codex V2 Responses compaction for Harness compaction calls. */
  useNativeCompaction?: boolean
}

export const Config: z<Config> = z.object({
  quota: CodexQuotaConfigSchema.default({}),
  searchModel: z.string().default(DEFAULT_OPENAI_CODEX_SEARCH_MODEL),
  searchMode: z.union(['cached', 'indexed', 'live'] as const).default(DEFAULT_OPENAI_CODEX_SEARCH_MODE),
  searchContextSize: z.union(['low', 'medium', 'high'] as const).default(DEFAULT_OPENAI_CODEX_SEARCH_CONTEXT_SIZE),
  searchMaxOutputTokens: z.number().step(1).min(1).default(DEFAULT_OPENAI_CODEX_SEARCH_MAX_OUTPUT_TOKENS),
  modifyReadImage: z.boolean().default(true),
  shareImagegenWithOtherModels: z.boolean().default(true),
  useFastMode: z.boolean().default(false),
  useWebSocketContextReuse: z.boolean().default(false),
  useNativeCompaction: z.boolean().default(false),
})

/**
 * Register the `openai-codex` LLM route and standalone web-search provider
 * with one provider-native OAuth credential store.
 * @param ctx - plugin context carrying the LLM and web registries plus optional agent and attachment services.
 * @param config - standalone-search model, access mode, context size, and output budget.
 */
export function apply(ctx: Context, config: Config): void {
  const network = new OutboundNetwork()
  ctx.effect(() => network.install(), 'dsh-openai-codex: outbound network')
  installOpenAICodexSearchEvent()
  const service = new OpenAICodexService({
    modifyReadImage: config.modifyReadImage ?? true,
    shareImagegenWithOtherModels: config.shareImagegenWithOtherModels ?? true,
    useFastMode: config.useFastMode ?? false,
    useWebSocketContextReuse: config.useWebSocketContextReuse ?? false,
    useNativeCompaction: config.useNativeCompaction ?? false,
  }, () => {
    const sessionId = ctx.get('agents')?.currentInitiator()?.session.id
    return sessionId === undefined ? undefined : String(sessionId)
  })
  const credentials = service.credentials
  const imageTools = service.policy
  const routingEvents = new LocalRoutingEventLedger()
  ctx.provide('openAICodex', service)
  installOpenAICodexTui(ctx)
  ctx.inject(['settings'], (settingsCtx) => { service.attachSettings(settingsCtx) })
  ctx.llm.registerAdapter(
    [OPENAI_CODEX_PROVIDER],
    createOpenAICodexAdapter(
      credentials,
      () => ctx.get('attachments'),
      () => imageTools.responseApiSnapshot(),
      routingEvents,
    ),
  )
  ctx.web.registerSearchProvider(new OpenAICodexSearchProvider({
    credentials,
    model: config.searchModel ?? DEFAULT_OPENAI_CODEX_SEARCH_MODEL,
    mode: config.searchMode ?? DEFAULT_OPENAI_CODEX_SEARCH_MODE,
    contextSize: config.searchContextSize ?? DEFAULT_OPENAI_CODEX_SEARCH_CONTEXT_SIZE,
    maxOutputTokens: config.searchMaxOutputTokens ?? DEFAULT_OPENAI_CODEX_SEARCH_MAX_OUTPUT_TOKENS,
    resolveRequestId: () => String(ctx.get('agents')?.currentInitiator()?.session.id ?? randomUUID()),
    recordRequest: (request) => { recordOpenAICodexSearchRequest(ctx, request) },
  }))
  ctx.inject(['webServer'], (webCtx) => {
    // The official Codex app-server quota reader is optional at runtime. The
    // route itself falls back to the profile usage endpoint when a host does
    // not provide subprocess support, keeping this package independently
    // installable while preserving the full DSH sidebar projection.
    const quota = ctx.get('subprocess') === undefined
      ? undefined
      : new CodexQuotaProvider(config.quota ?? {}, {
        cwd: process.cwd(),
        spawn: spec => ctx.get('subprocess')!.spawn(spec),
        warn: message => ctx.logger.warn(message),
        readStoredProfileCount: async () => (await credentials.listProfiles()).length,
      })
    registerOpenAICodexAuthRoutes(webCtx, credentials, imageTools, network, routingEvents, quota)
  })
  ctx.inject(['tools', 'fs', 'attachments'], (toolCtx) => {
    toolCtx.tools.register(imagegenTool(toolCtx, credentials, imageTools))
  })
  ctx.inject(['tools', 'fs', 'attachments', 'agents'], (toolCtx) => {
    installReadImageEnhancement(toolCtx, imageTools)
  })
}
