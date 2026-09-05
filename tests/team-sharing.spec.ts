import { describe, expect, it } from 'vitest'
import { parseTeamSharing } from '../src/shared/team-sharing.ts'

const sharing = {
  personalReservePercent: 20,
  maxSharedRequestsPerWindow: null,
  weeklySharedEstimatedApiCostLimitMicros: null,
  maxSharedConcurrency: 2,
  allowedModels: ['gpt-5-codex'],
}

describe('shared account policy projection', () => {
  it('accepts unlimited policies without changing their meaning', () => {
    expect(parseTeamSharing(sharing)).toEqual(sharing)
  })

  it.each([
    { personalReservePercent: 100 },
    { maxSharedRequestsPerWindow: -1 },
    { weeklySharedEstimatedApiCostLimitMicros: Number.MAX_SAFE_INTEGER + 1 },
    { maxSharedConcurrency: 17 },
    { allowedModels: [42] },
    { refreshToken: 'private-field' },
  ])('rejects malformed or private controls: %j', patch => {
    expect(() => parseTeamSharing({ ...sharing, ...patch })).toThrow()
  })
})
