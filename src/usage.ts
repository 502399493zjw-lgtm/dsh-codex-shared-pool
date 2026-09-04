/** Live ChatGPT Codex rate-limit usage for the browser account page. */

import { createModels, ModelsError } from '@earendil-works/pi-ai'
import type { CredentialStore } from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { OPENAI_CODEX_PROVIDER } from './store.ts'
import { normalizeCodexPlan } from './shared/subscription.ts'
import { OpenAICodexAuthenticationError } from './openai-codex-authentication-error.ts'
import { withDeadline } from './with-deadline.ts'
import type {
  OpenAICodexCredits,
  OpenAICodexIndividualLimit,
  OpenAICodexRateLimit,
  OpenAICodexRateLimitWindow,
  OpenAICodexUsage,
} from './shared/types.ts'

export type {
  OpenAICodexCredits,
  OpenAICodexIndividualLimit,
  OpenAICodexRateLimit,
  OpenAICodexRateLimitWindow,
  OpenAICodexUsage,
} from './shared/types.ts'

/** Fixed endpoint used by the official Codex client for ChatGPT rate limits. */
export const OPENAI_CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'

const USAGE_REQUEST_TIMEOUT_MS = 15_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (typeof value !== 'string' || !/^-?\d+$/u.test(value.trim())) return undefined
  const parsed = Number(value.trim())
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function parseResetAt(value: Record<string, unknown>, observedAt: number): number | undefined {
  const absolute = value['reset_at'] ?? value['resets_at']
  const unixSeconds = parseInteger(absolute)
  if (unixSeconds !== undefined && unixSeconds > 0 && Number.isSafeInteger(unixSeconds * 1000)) {
    return unixSeconds * 1000
  }
  if (typeof absolute === 'string' && absolute.trim().length > 0) {
    const parsed = Date.parse(absolute.trim())
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed
  }
  const resetAfterSeconds = parseInteger(value['reset_after_seconds'])
  if (resetAfterSeconds === undefined || resetAfterSeconds < 0) return undefined
  const resetAt = observedAt + resetAfterSeconds * 1000
  return Number.isSafeInteger(resetAt) && resetAt >= observedAt ? resetAt : undefined
}

function parseWindow(value: unknown, observedAt: number): OpenAICodexRateLimitWindow | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new Error('OpenAI Codex returned a malformed rate-limit window')
  const usedPercent = value['used_percent']
  const windowSeconds = value['limit_window_seconds']
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) {
    throw new Error('OpenAI Codex returned an invalid used percentage')
  }
  if (typeof windowSeconds !== 'number' || !Number.isInteger(windowSeconds) || windowSeconds <= 0) {
    throw new Error('OpenAI Codex returned an invalid rate-limit window duration')
  }
  const resetsAt = parseResetAt(value, observedAt)
  return {
    remainingPercent: 100 - usedPercent,
    windowSeconds,
    ...resetsAt === undefined ? {} : { resetsAt },
  }
}

function parseLimit(
  id: string,
  name: string | undefined,
  value: unknown,
  observedAt: number,
): OpenAICodexRateLimit | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new Error('OpenAI Codex returned malformed rate-limit details')
  const windows = [
    parseWindow(value['primary_window'], observedAt),
    parseWindow(value['secondary_window'], observedAt),
  ]
    .filter(window => window !== undefined)
  return windows.length === 0 ? undefined : { id, ...name === undefined ? {} : { name }, windows }
}

function exactAmount(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0 || value.length > 64 || !/^-?\d+(?:\.\d+)?$/u.test(value)) {
    throw new Error(`OpenAI Codex returned an invalid ${key} amount`)
  }
  return value
}

function parseCredits(value: unknown): OpenAICodexCredits | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value) || typeof value['has_credits'] !== 'boolean' || typeof value['unlimited'] !== 'boolean') {
    throw new Error('OpenAI Codex returned malformed credit details')
  }
  if (!value['has_credits']) return undefined
  const balance = value['balance']
  if (balance !== undefined && balance !== null
    && (typeof balance !== 'string' || balance.length === 0 || balance.length > 64 || !/^-?\d+(?:\.\d+)?$/u.test(balance))) {
    throw new Error('OpenAI Codex returned an invalid credit balance')
  }
  return {
    unlimited: value['unlimited'],
    ...typeof balance === 'string' ? { balance } : {},
  }
}

function parseIndividualLimit(value: unknown): OpenAICodexIndividualLimit | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new Error('OpenAI Codex returned malformed spend-control details')
  const individual = value['individual_limit']
  if (individual === undefined || individual === null) return undefined
  if (!isRecord(individual)) throw new Error('OpenAI Codex returned a malformed individual limit')
  const remainingPercent = individual['remaining_percent']
  if (typeof remainingPercent !== 'number' || !Number.isFinite(remainingPercent)
    || remainingPercent < 0 || remainingPercent > 100) {
    throw new Error('OpenAI Codex returned an invalid individual-limit percentage')
  }
  return {
    limit: exactAmount(individual, 'limit'),
    used: exactAmount(individual, 'used'),
    remaining: exactAmount(individual, 'remaining'),
    remainingPercent,
  }
}

/**
 * Convert the provider response into the small secret-free object sent to the browser.
 * @param value - opaque JSON returned by the ChatGPT usage endpoint.
 * @returns core and additionally metered quota buckets with remaining percentages.
 */
export function parseOpenAICodexUsage(value: unknown, observedAt = Date.now()): OpenAICodexUsage {
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) throw new Error('usage observation time is invalid')
  if (!isRecord(value)) throw new Error('OpenAI Codex returned a malformed usage response')
  const limits: OpenAICodexRateLimit[] = []
  const primary = parseLimit('codex', 'Codex', value['rate_limit'], observedAt)
  if (primary !== undefined) limits.push(primary)

  const additional = value['additional_rate_limits']
  if (additional !== undefined && additional !== null && !Array.isArray(additional)) {
    throw new Error('OpenAI Codex returned malformed additional rate limits')
  }
  for (const item of additional ?? []) {
    if (!isRecord(item)) throw new Error('OpenAI Codex returned a malformed additional rate limit')
    const id = item['metered_feature']
    const name = item['limit_name']
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('OpenAI Codex returned an additional rate limit without an id')
    }
    if (name !== undefined && name !== null && typeof name !== 'string') {
      throw new Error('OpenAI Codex returned an invalid additional rate-limit name')
    }
    const limit = parseLimit(
      id,
      typeof name === 'string' && name.length > 0 ? name : undefined,
      item['rate_limit'],
      observedAt,
    )
    if (limit !== undefined) limits.push(limit)
  }
  const credits = parseCredits(value['credits'])
  const individualLimit = parseIndividualLimit(value['spend_control'])
  const planType = normalizeCodexPlan(value['plan_type'])
  return {
    ...planType === undefined ? {} : { planType },
    rateLimits: limits,
    ...credits === undefined ? {} : { credits },
    ...individualLimit === undefined ? {} : { individualLimit },
  }
}

/**
 * Read current quota without issuing a model request. OAuth is refreshed through
 * the same provider-native credential lifecycle used by normal Codex turns.
 * @param store - plugin-owned OAuth credential store.
 * @param signal - optional caller cancellation signal combined with the request timeout.
 * @returns current rate-limit buckets safe to expose to the local browser page.
 */
export async function readOpenAICodexRateLimits(
  store: CredentialStore,
  signal?: AbortSignal,
): Promise<OpenAICodexUsage> {
  return withDeadline(deadline => readRateLimits(store, deadline), USAGE_REQUEST_TIMEOUT_MS, signal)
}

async function readRateLimits(store: CredentialStore, signal: AbortSignal): Promise<OpenAICodexUsage> {
  const models = createModels({ credentials: {
    list: () => store.list(),
    read: async provider => {
      signal.throwIfAborted()
      const credential = await store.read(provider)
      signal.throwIfAborted()
      return credential
    },
    modify: (provider, update) => store.modify(provider, current => {
      // Queued transactions must not start a fresh OAuth refresh after expiry.
      // Once started, let update finish and persist rotated credentials safely.
      signal.throwIfAborted()
      return update(current)
    }),
    delete: provider => store.delete(provider),
  } })
  // The pinned provider does not forward abort to its OAuth refresh fetch.
  // Bound the caller, but let its locked credential transaction settle safely:
  // abandoning a rotated token before persistence could invalidate the account.
  models.setProvider(openaiCodexProvider())
  let auth
  try {
    auth = await models.getAuth(OPENAI_CODEX_PROVIDER)
  } catch (error: unknown) {
    signal.throwIfAborted()
    if (error instanceof ModelsError && error.code === 'oauth') {
      throw new OpenAICodexAuthenticationError('OpenAI Codex sign-in needs to be renewed')
    }
    throw error
  }
  signal.throwIfAborted()
  const credential = await store.read(OPENAI_CODEX_PROVIDER)
  signal.throwIfAborted()
  const access = auth?.auth.apiKey
  const accountId = credential?.type === 'oauth' ? credential.accountId : undefined
  if (access === undefined || access.length === 0 || typeof accountId !== 'string' || accountId.length === 0) {
    throw new OpenAICodexAuthenticationError('OpenAI Codex is signed out')
  }
  const response = await fetch(OPENAI_CODEX_USAGE_URL, {
    method: 'GET',
    redirect: 'error',
    headers: {
      authorization: `Bearer ${access}`,
      'chatgpt-account-id': accountId,
      accept: 'application/json',
      'cache-control': 'no-store',
      'user-agent': 'dsh-openai-codex',
    },
    signal,
  })
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new OpenAICodexAuthenticationError('OpenAI Codex sign-in needs to be renewed')
    }
    throw new Error(`OpenAI Codex usage request failed with HTTP ${response.status}`)
  }
  let value: unknown
  try {
    value = await response.json()
  } catch (error: unknown) {
    throw new Error('OpenAI Codex returned an unreadable usage response', { cause: error })
  }
  return parseOpenAICodexUsage(value)
}
