const NON_NEGATIVE_DECIMAL = /^(?:0|[1-9]\d*)$/u
const MICROS_PER_CENT = 10_000n
const CENTS_PER_DOLLAR = 100n

export interface TeamUsageAggregateInput {
  readonly requestCount: number
  readonly tokenMeasuredRequestCount: number
  readonly pricedRequestCount: number
  readonly totalTokens: string | null
  readonly estimatedCostUsdMicros: string | null
}

export type TeamUsageState = 'complete' | 'partial' | 'unpriced' | 'unmeasured' | 'zero'

export interface TeamUsageViewModel {
  readonly state: TeamUsageState
  readonly statusText: string
  readonly estimatedCostText: string
  readonly tokenCountText: string
  readonly requestCountText: string
  readonly tokenCoverageText: string
  readonly pricedCoverageText: string
}

function parseDecimal(value: string, field: string): bigint {
  if (!NON_NEGATIVE_DECIMAL.test(value)) {
    throw new TypeError(`${field} must be a non-negative decimal integer`)
  }
  return BigInt(value)
}

function groupInteger(value: bigint): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/gu, ',')
}

function assertCount(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`)
  }
}

function validateAggregate(aggregate: TeamUsageAggregateInput): void {
  assertCount(aggregate.requestCount, 'requestCount')
  assertCount(aggregate.tokenMeasuredRequestCount, 'tokenMeasuredRequestCount')
  assertCount(aggregate.pricedRequestCount, 'pricedRequestCount')

  if (aggregate.tokenMeasuredRequestCount > aggregate.requestCount) {
    throw new RangeError('tokenMeasuredRequestCount cannot exceed requestCount')
  }
  if (aggregate.pricedRequestCount > aggregate.tokenMeasuredRequestCount) {
    throw new RangeError('pricedRequestCount cannot exceed tokenMeasuredRequestCount')
  }

  const totalTokens = aggregate.totalTokens === null
    ? null
    : parseDecimal(aggregate.totalTokens, 'totalTokens')
  const estimatedCost = aggregate.estimatedCostUsdMicros === null
    ? null
    : parseDecimal(aggregate.estimatedCostUsdMicros, 'estimatedCostUsdMicros')

  if (aggregate.requestCount === 0) {
    if (totalTokens !== 0n || estimatedCost !== 0n) {
      throw new TypeError('zero-request usage must contain reliable zero totals')
    }
    return
  }

  if ((aggregate.tokenMeasuredRequestCount === 0) !== (totalTokens === null)) {
    throw new TypeError('totalTokens must match Token measurement coverage')
  }
  if ((aggregate.pricedRequestCount === 0) !== (estimatedCost === null)) {
    throw new TypeError('estimatedCostUsdMicros must match price coverage')
  }
}

function deriveState(aggregate: TeamUsageAggregateInput): TeamUsageState {
  if (aggregate.requestCount === 0) return 'zero'
  if (aggregate.tokenMeasuredRequestCount === 0) return 'unmeasured'
  if (aggregate.tokenMeasuredRequestCount < aggregate.requestCount) return 'partial'
  if (aggregate.pricedRequestCount === 0) return 'unpriced'
  if (aggregate.pricedRequestCount < aggregate.requestCount) return 'partial'
  return 'complete'
}

function createStatusText(
  state: TeamUsageState,
  aggregate: TeamUsageAggregateInput,
  tokenCoverageText: string,
  pricedCoverageText: string,
): string {
  switch (state) {
    case 'complete':
      return '完整数据'
    case 'partial':
      return aggregate.tokenMeasuredRequestCount === aggregate.pricedRequestCount
        ? `部分数据 · 已计量 ${tokenCoverageText} 次`
        : `部分数据 · Token ${tokenCoverageText} · 费用 ${pricedCoverageText}`
    case 'unpriced':
      return `Token 已计量 ${tokenCoverageText} · 费用已计量 ${pricedCoverageText}`
    case 'unmeasured':
      return `暂无计量数据 · ${aggregate.requestCount} 次请求`
    case 'zero':
      return '暂无请求'
  }
}

export function formatTeamTokenCount(value: string): string {
  return `${groupInteger(parseDecimal(value, 'totalTokens'))} Token`
}

export function formatTeamUsdMicros(value: string): string {
  const micros = parseDecimal(value, 'estimatedCostUsdMicros')
  if (micros === 0n) return 'US$0.00'
  if (micros < MICROS_PER_CENT) return '< US$0.01'

  const roundedCents = (micros + (MICROS_PER_CENT / 2n)) / MICROS_PER_CENT
  const dollars = roundedCents / CENTS_PER_DOLLAR
  const cents = (roundedCents % CENTS_PER_DOLLAR).toString().padStart(2, '0')
  return `US$${groupInteger(dollars)}.${cents}`
}

export function createTeamUsageViewModel(aggregate: TeamUsageAggregateInput): TeamUsageViewModel {
  validateAggregate(aggregate)

  const state = deriveState(aggregate)
  const tokenCoverageText = `${aggregate.tokenMeasuredRequestCount} / ${aggregate.requestCount}`
  const pricedCoverageText = `${aggregate.pricedRequestCount} / ${aggregate.requestCount}`

  return {
    state,
    statusText: createStatusText(state, aggregate, tokenCoverageText, pricedCoverageText),
    estimatedCostText: aggregate.estimatedCostUsdMicros === null
      ? '—'
      : formatTeamUsdMicros(aggregate.estimatedCostUsdMicros),
    tokenCountText: aggregate.totalTokens === null
      ? '—'
      : formatTeamTokenCount(aggregate.totalTokens),
    requestCountText: String(aggregate.requestCount),
    tokenCoverageText,
    pricedCoverageText,
  }
}
