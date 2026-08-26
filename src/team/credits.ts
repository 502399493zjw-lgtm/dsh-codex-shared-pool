/** Host-only conversion of provider-reported Responses usage into Team Credits. */

export const TEAM_CREDITS_FORMULA_VERSION = 'credits-v1' as const
export type TeamCreditsFormulaVersion = typeof TEAM_CREDITS_FORMULA_VERSION

/** Defensive single-request ceiling used to reject corrupt or hostile metadata. */
export const MAX_TEAM_PROVIDER_TOKEN_COUNT = 1_000_000_000

/**
 * Admission estimate held for one shared provider attempt. The measured value
 * replaces it at settlement; it is a guard for new admissions, not a promise
 * that the provider cannot report a larger final request.
 */
export const TEAM_SHARED_CREDIT_RESERVATION = 50_000

export interface TeamProviderTokenUsage {
  readonly inputTokens: number
  readonly cachedInputTokens: number
  readonly outputTokens: number
}

export interface TeamCreditsCalculation {
  readonly credits: number
  readonly formulaVersion: TeamCreditsFormulaVersion
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTokenCounter(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= 0
    && (value as number) <= MAX_TEAM_PROVIDER_TOKEN_COUNT
}

function assertTokenCounter(value: unknown): asserts value is number {
  if (!isTokenCounter(value)) {
    throw new Error(`provider token counter must be a safe integer from 0 to ${MAX_TEAM_PROVIDER_TOKEN_COUNT}`)
  }
}

/**
 * Parse the numeric subset of an OpenAI Responses `usage` object.
 * Content and unknown provider fields are deliberately ignored.
 */
export function parseTeamProviderTokenUsage(value: unknown): TeamProviderTokenUsage | undefined {
  if (!isRecord(value)) return undefined
  const inputTokens = value['input_tokens']
  const outputTokens = value['output_tokens']
  if (!isTokenCounter(inputTokens) || !isTokenCounter(outputTokens)) return undefined

  const rawDetails = value['input_tokens_details']
  if (!isRecord(rawDetails)) return undefined
  const cachedInputTokens = rawDetails['cached_tokens']
  if (!isTokenCounter(cachedInputTokens) || cachedInputTokens > inputTokens) return undefined

  return { inputTokens, cachedInputTokens, outputTokens }
}

/**
 * `credits-v1 = ceil(uncached input + cached input * 0.25 + output * 4)`.
 * Credits are an internal weighted-token unit, not money or subscription percent.
 */
export function calculateTeamCredits(usage: TeamProviderTokenUsage): TeamCreditsCalculation {
  assertTokenCounter(usage.inputTokens)
  assertTokenCounter(usage.cachedInputTokens)
  assertTokenCounter(usage.outputTokens)
  if (usage.cachedInputTokens > usage.inputTokens) {
    throw new Error('cached input token counter must not exceed input token counter')
  }
  const uncachedInputTokens = usage.inputTokens - usage.cachedInputTokens
  return {
    credits: Math.ceil(uncachedInputTokens + usage.cachedInputTokens * 0.25 + usage.outputTokens * 4),
    formulaVersion: TEAM_CREDITS_FORMULA_VERSION,
  }
}
