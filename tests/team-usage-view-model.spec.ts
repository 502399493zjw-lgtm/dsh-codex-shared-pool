import { describe, expect, it } from 'vitest'
import {
  createTeamUsageViewModel,
  formatTeamTokenCount,
  formatTeamUsdMicros,
  type TeamUsageAggregateInput,
} from '../src/client/team/team-usage-view-model.ts'

function usage(overrides: Partial<TeamUsageAggregateInput> = {}): TeamUsageAggregateInput {
  return {
    requestCount: 39,
    tokenMeasuredRequestCount: 39,
    pricedRequestCount: 39,
    totalTokens: '3900000',
    estimatedCostUsdMicros: '5880000',
    ...overrides,
  }
}

describe('Team usage view model', () => {
  it('derives the complete state when every request is measured and priced', () => {
    expect(createTeamUsageViewModel(usage())).toEqual({
      state: 'complete',
      statusText: '完整数据',
      estimatedCostText: 'US$5.88',
      tokenCountText: '3,900,000 Token',
      requestCountText: '39',
      tokenCoverageText: '39 / 39',
      pricedCoverageText: '39 / 39',
    })
  })

  it('derives the partial state and keeps Token and price coverage separate', () => {
    expect(createTeamUsageViewModel(usage({
      tokenMeasuredRequestCount: 31,
      pricedRequestCount: 17,
      totalTokens: '3100000',
      estimatedCostUsdMicros: '4720000',
    }))).toEqual({
      state: 'partial',
      statusText: '部分数据 · Token 31 / 39 · 费用 17 / 39',
      estimatedCostText: 'US$4.72',
      tokenCountText: '3,100,000 Token',
      requestCountText: '39',
      tokenCoverageText: '31 / 39',
      pricedCoverageText: '17 / 39',
    })

    expect(createTeamUsageViewModel(usage({
      tokenMeasuredRequestCount: 31,
      pricedRequestCount: 0,
      totalTokens: '3100000',
      estimatedCostUsdMicros: null,
    })).state).toBe('partial')
  })

  it('derives the unpriced state when all Token usage is measured but no price is known', () => {
    expect(createTeamUsageViewModel(usage({
      requestCount: 7,
      tokenMeasuredRequestCount: 7,
      pricedRequestCount: 0,
      totalTokens: '700000',
      estimatedCostUsdMicros: null,
    }))).toEqual({
      state: 'unpriced',
      statusText: 'Token 已计量 7 / 7 · 费用已计量 0 / 7',
      estimatedCostText: '—',
      tokenCountText: '700,000 Token',
      requestCountText: '7',
      tokenCoverageText: '7 / 7',
      pricedCoverageText: '0 / 7',
    })
  })

  it('derives the unmeasured state without inventing Token or cost totals', () => {
    expect(createTeamUsageViewModel(usage({
      requestCount: 7,
      tokenMeasuredRequestCount: 0,
      pricedRequestCount: 0,
      totalTokens: null,
      estimatedCostUsdMicros: null,
    }))).toEqual({
      state: 'unmeasured',
      statusText: '暂无计量数据 · 7 次请求',
      estimatedCostText: '—',
      tokenCountText: '—',
      requestCountText: '7',
      tokenCoverageText: '0 / 7',
      pricedCoverageText: '0 / 7',
    })
  })

  it('derives a reliable zero instead of treating it as unavailable', () => {
    expect(createTeamUsageViewModel(usage({
      requestCount: 0,
      tokenMeasuredRequestCount: 0,
      pricedRequestCount: 0,
      totalTokens: '0',
      estimatedCostUsdMicros: '0',
    }))).toEqual({
      state: 'zero',
      statusText: '暂无请求',
      estimatedCostText: 'US$0.00',
      tokenCountText: '0 Token',
      requestCountText: '0',
      tokenCoverageText: '0 / 0',
      pricedCoverageText: '0 / 0',
    })
  })

  it('formats decimal strings with BigInt precision and preserves tiny non-zero costs', () => {
    expect(formatTeamTokenCount('9007199254740993123456789')).toBe(
      '9,007,199,254,740,993,123,456,789 Token',
    )
    expect(formatTeamUsdMicros('0')).toBe('US$0.00')
    expect(formatTeamUsdMicros('1')).toBe('< US$0.01')
    expect(formatTeamUsdMicros('9999')).toBe('< US$0.01')
    expect(formatTeamUsdMicros('10000')).toBe('US$0.01')
    expect(formatTeamUsdMicros('1234567890123456789')).toBe('US$1,234,567,890,123.46')
  })
})
