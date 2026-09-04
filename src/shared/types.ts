/** User-controlled image-tool integration. */
export interface ImageToolPreferences {
  /** Whether read_image accepts HTTP(S) inputs. */
  modifyReadImage: boolean
  /** Whether non-Codex vision models can call imagegen. */
  shareImagegenWithOtherModels: boolean
}

/** Experimental request behavior used only by the OpenAI Codex adapter. */
export interface ResponseApiPreferences {
  /** Request Codex's priority service tier for models that advertise Fast. */
  useFastMode: boolean
  /** Reuse prior response context through the Codex WebSocket transport. */
  useWebSocketContextReuse: boolean
  /** Use the Codex Responses compaction endpoint. */
  useNativeCompaction: boolean
}

/** One quota window expressed as remaining capacity for direct UI rendering. */
export interface OpenAICodexRateLimitWindow {
  /** Remaining capacity on a zero-to-one-hundred scale. */
  readonly remainingPercent: number
  /** Window duration in seconds. */
  readonly windowSeconds: number
  /** Provider-observed reset instant in epoch milliseconds, when supplied. */
  readonly resetsAt?: number
}

/** One separately metered Codex quota bucket. */
export interface OpenAICodexRateLimit {
  /** Provider-defined bucket identifier. */
  readonly id: string
  /** Optional provider-defined display name. */
  readonly name?: string
  /** Independently resetting windows for this bucket. */
  readonly windows: readonly OpenAICodexRateLimitWindow[]
}

/** Optional exact prepaid-credit balance returned by ChatGPT. */
export interface OpenAICodexCredits {
  /** Whether the account is not constrained by prepaid credits. */
  readonly unlimited: boolean
  /** Display-safe decimal balance when the provider supplies one. */
  readonly balance?: string
}

/** Optional exact workspace member spend limit returned by ChatGPT. */
export interface OpenAICodexIndividualLimit {
  /** Configured workspace member limit. */
  readonly limit: string
  /** Amount already consumed. */
  readonly used: string
  /** Amount still available. */
  readonly remaining: string
  /** Remaining capacity on a zero-to-one-hundred scale. */
  readonly remainingPercent: number
}

/** Secret-free quota projection returned to the browser. */
export interface OpenAICodexUsage {
  readonly planType?: import('./subscription.ts').CodexPlanType
  /** Rate-limit buckets returned by the provider. */
  readonly rateLimits: readonly OpenAICodexRateLimit[]
  /** Optional prepaid-credit projection. */
  readonly credits?: OpenAICodexCredits
  /** Optional workspace member spend-limit projection. */
  readonly individualLimit?: OpenAICodexIndividualLimit
}

/** Browser-safe authentication health for one stored Codex profile. */
export type OpenAICodexConnectionStatus = 'connected' | 'reauth-required'

/** Fixed, secret-free reasons an OAuth attempt can fail in the Host. */
export type OpenAICodexAuthorizationFailure =
  | 'authorization-failed'
  | 'authorization-timed-out'

/** Browser-safe authorization challenge. The OAuth code remains Host-owned. */
export interface OpenAICodexLoginChallenge {
  readonly url: string
}

/** Idempotent result returned by the plugin-owned cancellation route. */
export interface OpenAICodexCancelLoginResult {
  readonly cancelled: boolean
}

/** Typed JSON-safe profile lifecycle projection returned to the browser. */
export type OpenAICodexProfilesStatus<Profile> =
  | { readonly status: 'ready'; readonly profiles: Profile[] }
  | { readonly status: 'signing-in' }
  | { readonly status: 'error'; readonly reason: OpenAICodexAuthorizationFailure }

/** Why the local pool selected one profile for a request. */
export type LocalRoutingReason =
  | 'priority'
  | 'quota_fallback'
  | 'quota_unknown'
  | 'all_exhausted'
  | 'concurrent_binding'

/** Metadata-only lifecycle state for one local Codex request. */
export type LocalRoutingStatus = 'in_progress' | 'succeeded' | 'failed' | 'cancelled'

/** Browser-safe request receipt; profile identity is reduced to an ordinal alias. */
export interface LocalRoutingEventSummary {
  readonly id: string
  readonly profileAlias: string
  readonly previousProfileAlias?: string
  readonly model: string
  readonly reason: LocalRoutingReason
  readonly unit: 'request'
  readonly status: LocalRoutingStatus
  readonly startedAt: number
  readonly finishedAt?: number
}

/** Same-origin response returned by the local routing-event route. */
export interface LocalRoutingEventsResult {
  readonly events: readonly LocalRoutingEventSummary[]
}
