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
export const TEAM_SHARED_ESTIMATED_COST_RESERVATION_USD_MICROS = 250_000n
/** OpenAI ChatGPT Work/Codex token rate card captured on 2026-08-26. */
export const TEAM_ESTIMATED_COST_PRICING_CATALOG_VERSION = 'openai-chatgpt-work-2026-08-26'

const API_RATES_USD_MICROS_PER_MILLION = {
  'gpt-5.6-sol': [4_000_000n, 400_000n, 20_000_000n],
  'gpt-5.6-terra': [2_000_000n, 200_000n, 12_000_000n],
  'gpt-5.6-luna': [200_000n, 20_000n, 1_200_000n],
  'gpt-5.5': [5_000_000n, 500_000n, 30_000_000n],
  'gpt-5.4': [2_500_000n, 250_000n, 15_000_000n],
  'gpt-5.4-mini': [750_000n, 75_000n, 4_500_000n],
  'gpt-5.3-codex': [1_750_000n, 175_000n, 14_000_000n],
  'gpt-5-codex': [1_250_000n, 125_000n, 10_000_000n],
  'gpt-5-mini': [250_000n, 25_000n, 2_000_000n],
} as const

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

/** ChatGPT Work/Codex token-rate estimate. Unknown models remain unpriced. */
export function estimateTeamUsageCostUsdMicros(
  model: string,
  usage: TeamProviderTokenUsage,
): bigint | undefined {
  const rates = API_RATES_USD_MICROS_PER_MILLION[model as keyof typeof API_RATES_USD_MICROS_PER_MILLION]
  if (rates === undefined) return undefined
  assertTokenCounter(usage.inputTokens)
  assertTokenCounter(usage.cachedInputTokens)
  assertTokenCounter(usage.outputTokens)
  if (usage.cachedInputTokens > usage.inputTokens) throw new Error('cached input token counter must not exceed input token counter')
  const uncached = BigInt(usage.inputTokens - usage.cachedInputTokens)
  const cached = BigInt(usage.cachedInputTokens)
  const output = BigInt(usage.outputTokens)
  const numerator = uncached * rates[0] + cached * rates[1] + output * rates[2]
  return numerator === 0n ? 0n : (numerator + 999_999n) / 1_000_000n
}
