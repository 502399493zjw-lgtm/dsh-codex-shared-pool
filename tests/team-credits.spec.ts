import { describe, expect, it } from 'vitest'
import {
  MAX_TEAM_PROVIDER_TOKEN_COUNT,
  TEAM_CREDITS_FORMULA_VERSION,
  calculateTeamCredits,
  parseTeamProviderTokenUsage,
} from '../src/team/credits.ts'

describe('Team Credits v1', () => {
  it('weights uncached input, cached input, and output with the frozen formula', () => {
    expect(calculateTeamCredits({
      inputTokens: 1_000,
      cachedInputTokens: 400,
      outputTokens: 100,
    })).toEqual({ credits: 1_100, formulaVersion: TEAM_CREDITS_FORMULA_VERSION })
  })

  it('rounds fractional cached-input weight up to a whole Credit', () => {
    expect(calculateTeamCredits({
      inputTokens: 1,
      cachedInputTokens: 1,
      outputTokens: 0,
    }).credits).toBe(1)
  })

  it('rejects invalid or implausibly oversized provider counters', () => {
    for (const invalid of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_TEAM_PROVIDER_TOKEN_COUNT + 1]) {
      expect(() => calculateTeamCredits({
        inputTokens: invalid,
        cachedInputTokens: 0,
        outputTokens: 0,
      })).toThrow(/token counter/iu)
    }
  })

  it('rejects cached input greater than total input', () => {
    expect(() => calculateTeamCredits({
      inputTokens: 3,
      cachedInputTokens: 5,
      outputTokens: 1,
    })).toThrow(/cached input.*input/iu)
  })

  it('parses only the numeric Responses usage projection', () => {
    expect(parseTeamProviderTokenUsage({
      input_tokens: 900,
      input_tokens_details: { cached_tokens: 600 },
      output_tokens: 75,
      total_tokens: 975,
    })).toEqual({
      inputTokens: 900,
      cachedInputTokens: 600,
      outputTokens: 75,
    })

    expect(parseTeamProviderTokenUsage({
      input_tokens: 10,
      input_tokens_details: {},
      output_tokens: 2,
    })).toBeUndefined()

    expect(parseTeamProviderTokenUsage({
      input_tokens: 10,
      output_tokens: 2,
    })).toBeUndefined()

    expect(parseTeamProviderTokenUsage({
      input_tokens: 3,
      input_tokens_details: { cached_tokens: 5 },
      output_tokens: 1,
    })).toBeUndefined()

    expect(parseTeamProviderTokenUsage({ input_tokens: 1, output_tokens: '2' })).toBeUndefined()
    expect(parseTeamProviderTokenUsage({ input_tokens: 1, output_tokens: 2.5 })).toBeUndefined()
    expect(parseTeamProviderTokenUsage({ input_tokens: 1, output_tokens: MAX_TEAM_PROVIDER_TOKEN_COUNT + 1 })).toBeUndefined()
  })
})
