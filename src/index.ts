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
import { TeamConfigSchema, type TeamConfig } from './team/config.ts'
import {
  resolveTeamClientApiKey,
  resolveTeamClientBaseUrl,
  TeamClientConfigSchema,
  type TeamClientConfig,
} from './team/client.ts'
import { registerTeamRoutes } from './team/routes.ts'
import { registerTeamGatewayRoute } from './team/gateway.ts'
import { registerTeamManagementRoutes } from './team/management-routes.ts'
import {
  createTeamServiceFromConfig,
  resolveTeamBootstrapToken,
  TeamService,
} from './team/index.ts'

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

export {
  TEAM_BOOTSTRAP_PATH,
  TEAM_CONTRIBUTIONS_PATH,
  TEAM_CONTRIBUTION_OAUTH_CANCEL_PATH,
  TEAM_CONTRIBUTION_OAUTH_REAUTHORIZE_PATH,
  TEAM_CONTRIBUTION_OAUTH_START_PATH,
  TEAM_CONTRIBUTION_REVOKE_PATH,
  TEAM_CONTRIBUTION_UPDATE_PATH,
  TEAM_INVITES_PATH,
  TEAM_INVITES_PREVIEW_PATH,
  TEAM_INVITES_REVEAL_PATH,
  TEAM_INVITES_REVOKE_PATH,
  TEAM_JOIN_PATH,
  TEAM_KEYS_PATH,
  TEAM_KEYS_REVOKE_PATH,
  TEAM_CURRENT_KEY_REVOKE_PATH,
  TEAM_MEMBERS_LEAVE_PATH,
  TEAM_OWNERSHIP_TRANSFER_ACCEPT_PATH,
  TEAM_OWNERSHIP_TRANSFER_PATH,
  TEAM_OWNERSHIP_TRANSFER_REJECT_PATH,
  TEAM_OWNERSHIP_TRANSFER_REVOKE_PATH,
  TEAM_OVERVIEW_PATH,
  TEAM_DISPLAY_NAME_MIGRATION_ACK_PATH,
  TEAM_PATH_PREFIX,
  TEAM_CODEX_RESPONSES_PATH,
  TEAM_RESPONSES_PATH,
  TEAM_STATUS_PATH,
  TEAM_USAGE_PATH,
  TeamService,
  LocalTeamCredentialBroker,
  RemoteTeamCredentialBroker,
  createTeamCredentialBrokerHttpHandler,
  resolveTeamCredentialBrokerBaseUrl,
  TEAM_CREDENTIAL_BROKER_AUTHORIZATION_PATH,
  TEAM_CREDENTIAL_BROKER_OAUTH_CANCEL_PATH,
  TEAM_CREDENTIAL_BROKER_OAUTH_RESTART_PATH,
  TEAM_CREDENTIAL_BROKER_OAUTH_START_PATH,
  TEAM_CREDENTIAL_BROKER_PATH_PREFIX,
  TEAM_CREDENTIAL_BROKER_RESPONSES_PATH,
  TEAM_CREDENTIAL_BROKER_REVOKE_PATH,
  TEAM_CREDENTIAL_BROKER_USAGE_PATH,
  loadTeamCredentialBrokerEnvironment,
  startTeamCredentialBrokerDaemon,
  TEAM_CREDENTIAL_BROKER_HEALTH_PATH,
  verifyTeamCredentialBrokerDatabase,
  Aes256GcmTeamKeyEncryptionProvider,
  decodeTeamCredentialMasterKey,
  POSTGRES_CREDENTIAL_MUTATION_LOCK_SQL,
  PostgresTeamEnvelopeCredentialBackend,
  TeamKeyEncryptionKeyring,
  MemoryTeamStore,
  TeamDissolutionRecoveryRateLimitError,
  TeamDisplayNameMigrationUnavailableError,
  TeamInviteRevealRateLimitError,
  PostgresTeamRequestRouter,
  MemoryTeamTrafficGuard,
  PostgresTeamTrafficGuard,
  TeamTrafficGuardError,
  PostgresTeamStore,
  POSTGRES_TEAM_MIGRATIONS,
  POSTGRES_TEAM_RUNTIME_ROLES_SQL,
  verifyTeamDatabaseRoleBoundary,
  TeamRequestRouter,
  TeamRouteCapacityError,
  projectTeamQuota,
  TeamCapacityProvider,
  createTeamGatewayHandler,
  registerTeamGatewayRoute,
  createTeamCodexBearer,
  DEFAULT_TEAM_CLIENT_API_KEY_REF,
  resolveTeamClientApiKey,
  resolveTeamClientBaseUrl,
  teamClientResponsesUrl,
  unwrapTeamCodexBearer,
  registerTeamManagementRoutes,
} from './team/index.ts'
export {
  TEAM_MANAGEMENT_CAPABILITY_HEADER,
  TEAM_MANAGEMENT_CONTRIBUTIONS_PATH,
  TEAM_MANAGEMENT_CONTRIBUTION_REVOKE_PATH,
  TEAM_MANAGEMENT_CONTRIBUTION_UPDATE_PATH,
  TEAM_MANAGEMENT_DISCONNECT_PATH,
  TEAM_MANAGEMENT_INVITES_PATH,
  TEAM_MANAGEMENT_INVITES_PREVIEW_PATH,
  TEAM_MANAGEMENT_INVITES_REVEAL_PATH,
  TEAM_MANAGEMENT_INVITES_REVOKE_PATH,
  TEAM_MANAGEMENT_JOIN_PATH,
  TEAM_MANAGEMENT_JOIN_DISCARD_PATH,
  TEAM_MANAGEMENT_JOIN_RECOVER_PATH,
  TEAM_MANAGEMENT_LEAVE_PATH,
  TEAM_MANAGEMENT_MEMBERS_REMOVE_PATH,
  TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_ACCEPT_PATH,
  TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_PATH,
  TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_REJECT_PATH,
  TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_REVOKE_PATH,
  TEAM_MANAGEMENT_OAUTH_CANCEL_PATH,
  TEAM_MANAGEMENT_OAUTH_REAUTHORIZE_PATH,
  TEAM_MANAGEMENT_OAUTH_START_PATH,
  TEAM_MANAGEMENT_OVERVIEW_PATH,
  TEAM_MANAGEMENT_DISPLAY_NAME_MIGRATION_ACK_PATH,
  TEAM_MANAGEMENT_PATH_PREFIX,
  TEAM_MANAGEMENT_SESSION_PATH,
  TEAM_MANAGEMENT_STATUS_PATH,
  TEAM_MANAGEMENT_TEAM_STATUS_PATH,
  TEAM_MANAGEMENT_USAGE_PATH,
} from './shared/team-management.ts'
export type {
  TeamManagementConnectionResult,
  TeamManagementDisplayNameMigrationAcknowledgement,
  TeamManagementContributionPatch,
  TeamManagementContributionResult,
  TeamManagementContributionSummary,
  TeamManagementInviteResult,
  TeamManagementInvitePreview,
  TeamManagementInviteRevealResult,
  TeamManagementInviteRevocationResult,
  TeamManagementMemberSummary,
  TeamManagementDepartureResult,
  TeamManagementOwnershipTransferAcceptanceResult,
  TeamManagementOwnershipTransferResult,
  TeamManagementOwnershipTransferSummary,
  TeamManagementOAuthResult,
  TeamManagementOverview,
  TeamManagementStatus,
  TeamManagementSession,
  TeamManagementTeamStatusResult,
  TeamManagementUsageResult,
} from './shared/team-management.ts'
export {
  createTeamServiceFromConfig,
  DEFAULT_TEAM_BOOTSTRAP_TOKEN_REF,
  DEFAULT_TEAM_CREDENTIAL_BROKER_API_KEY_REF,
  DEFAULT_TEAM_CREDENTIAL_MASTER_KEY_REF,
  DEFAULT_TEAM_DATABASE_URL_REF,
  DEFAULT_TEAM_INVITE_TOKEN_MASTER_KEY_REF,
  resolveTeamBootstrapToken,
} from './team/index.ts'
export type {
  LocalTeamCredentialBrokerOptions,
  RemoteTeamCredentialBrokerOptions,
  PostgresTeamMigration,
  PostgresTeamRequestRouterOptions,
  PostgresTeamTrafficGuardOptions,
  PostgresTeamStoreOptions,
  TeamCredentialAuthorizationState,
  TeamCredentialBroker,
  TeamCredentialRef,
  TeamCredentialStoreBackend,
  TeamCredentialBrokerHttpHandlerOptions,
  RunningTeamCredentialBrokerDaemon,
  TeamCredentialBrokerDaemonOptions,
  TeamCredentialBrokerDatabase,
  TeamCredentialBrokerEnvironment,
  TeamResponsesForwardRequest,
  TeamCapacityProviderOptions,
  TeamGatewayOptions,
  TeamRuntimeDependencies,
  PostgresTeamEnvelopeCredentialBackendOptions,
  TeamCredentialKeyRewrapOptions,
  TeamCredentialKeyRewrapResult,
  TeamKeyEncryptionProvider,
  TeamWrappedKey,
  TeamTrafficGuard,
  TeamTrafficGuardOptions,
  TeamTrafficGuardReason,
  TeamTrafficLease,
  TeamTrafficResult,
  TeamClientConfig,
} from './team/index.ts'
export type {
  TeamApiKeySummary,
  TeamAuthContext,
  TeamBootstrapResult,
  TeamInviteResult,
  TeamInviteRevealAuditEventSummary,
  TeamInviteEnvelopeSweepingOptions,
  TeamInviteRevealResult,
  TeamInvitePreview,
  TeamInviteSummary,
  TeamJoinResult,
  TeamMemberDepartureResult,
  TeamMemberSummary,
  TeamOwnershipTransferAcceptanceResult,
  TeamOwnershipTransferResult,
  TeamOwnershipTransferStatus,
  TeamOwnershipTransferSummary,
  TeamContributionAccountPatch,
  TeamContributionAccountSummary,
  TeamContributionCapacityBucketId,
  TeamContributionCapacityBucketSummary,
  TeamContributionCapacityReason,
  TeamContributionCapacitySummary,
  TeamContributionStatus,
  TeamDisplayNameMigrationAcknowledgement,
  TeamDisplayNameMigrationNotice,
  TeamOAuthDeviceChallenge,
  TeamOAuthStartResult,
  TeamOverview,
  TeamRole,
  TeamStatus,
  TeamSummary,
  TeamUsageEventStatus,
  TeamUsageEventSummary,
  TeamRequestAdmission,
  TeamRequestAdmissionInput,
  TeamRequestCapacitySignal,
  TeamServiceOptions,
} from './team/index.ts'
export type {
  TeamQuotaSnapshot,
  TeamRequestAdmissionRouter,
  TeamRouteAccountInspection,
  TeamRouteCandidate,
  TeamRouteLease,
  TeamRouteRequest,
  TeamRouteSelection,
  TeamRouteSettleResult,
  TeamRouteSource,
  TeamRequestRouterOptions,
} from './team/index.ts'

/** Stable Cordis plugin name. */
export const name = 'dsh-codex-shared-pool'

/** LLM and web registries required before the composite provider can register. */
export const inject = ['llm', 'web']

/** Composite model and standalone-search configuration. */
export interface Config {
  /** Read-only Codex account-pool quota projection for the browser sidebar. */
  quota?: CodexQuotaConfig
  /** Optional multi-tenant Team control plane. Credentials remain Host-only. */
  team?: TeamConfig
  /** Use one remote Team gateway for openai-codex model requests. */
  teamClient?: TeamClientConfig
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
  team: TeamConfigSchema.default({}),
  teamClient: TeamClientConfigSchema.default({}),
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
  const teamClient = config.teamClient?.enabled === true
    ? {
        baseUrl: resolveTeamClientBaseUrl(config.teamClient.baseUrl),
        resolveApiKey: async () => {
          const hostCredentials = ctx.get('credentials')
          if (hostCredentials === undefined) throw new Error('DSH credential service is required for Team client mode')
          return resolveTeamClientApiKey(config.teamClient ?? {}, hostCredentials)
        },
      }
    : undefined
  ctx.provide('openAICodex', service)
  installOpenAICodexTui(ctx)
  ctx.inject(['settings'], (settingsCtx) => { service.attachSettings(settingsCtx) })
  ctx.llm.registerAdapter(
    [OPENAI_CODEX_PROVIDER],
    createOpenAICodexAdapter(
      credentials,
      () => ctx.get('attachments'),
      () => imageTools.responseApiSnapshot(),
      teamClient,
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
    registerOpenAICodexAuthRoutes(webCtx, credentials, imageTools, network, routingEvents)
  })
  ctx.inject(['webServer', 'credentials'], (teamClientCtx) => {
    registerTeamManagementRoutes(teamClientCtx, config.teamClient ?? {}, teamClientCtx.credentials, {
      localProfiles: credentials,
    })
  })
  if (config.team?.enabled === true) {
    ctx.inject(['webServer', 'credentials'], async (teamCtx) => {
      const team = await createTeamServiceFromConfig(config.team ?? {}, { credentials: teamCtx.credentials })
      try {
        registerTeamRoutes(teamCtx, team, {
          resolveBootstrapToken: async () => resolveTeamBootstrapToken(config.team ?? {}, teamCtx.credentials),
          maxInviteTtlMs: config.team?.maxInviteTtlMs,
        })
        registerTeamGatewayRoute(teamCtx, team)
      } catch (error: unknown) {
        await team.dispose()
        throw error
      }
      return async () => { await team.dispose() }
    })
  }
  ctx.inject(['tools', 'fs', 'attachments'], (toolCtx) => {
    toolCtx.tools.register(imagegenTool(toolCtx, credentials, imageTools))
  })
  ctx.inject(['tools', 'fs', 'attachments', 'agents'], (toolCtx) => {
    installReadImageEnhancement(toolCtx, imageTools)
  })
}
