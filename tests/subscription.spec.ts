import { describe, expect, it } from 'vitest'
import { parseSubscription, projectSubscription, subscriptionFromUsage } from '../src/shared/subscription.ts'
import { projectTeamQuota } from '../src/team/capacity.ts'

describe('subscription capacity estimates', () => {
  it('sanitizes remote projections and malformed usage', () => {
    expect(parseSubscription({ planType: 'pro', weeklyEstimatedUsd: 999999, weeklyRemainingEstimatedUsd: 99999, token: 'secret' }))
      .toEqual({ planType: 'pro', weeklyEstimatedUsd: 2100 })
    expect(subscriptionFromUsage({ planType: 'plus', rateLimits: [null, { id: 'codex', windows: [null] }] }))
      .toEqual({ planType: 'plus', weeklyEstimatedUsd: 100 })
  })
  it('keeps Team admission independent of display estimates', () => {
    const quota = projectTeamQuota({ planType: 'pro', rateLimits: [{ id: 'codex', windows: [
      { windowSeconds: 18000, remainingPercent: 10 },
      { windowSeconds: 604800, remainingPercent: 75 },
    ] }] }, 'gpt-5.4')
    expect(quota.remainingPercent).toBe(10)
    expect(quota.subscription).toEqual({ planType: 'pro', weeklyEstimatedUsd: 2100 })
  })
  it.each([['plus', 100], ['prolite', 600], ['pro', 2100]] as const)('estimates %s directly', (plan, total) => {
    expect(projectSubscription(plan)).toEqual({
      planType: plan, weeklyEstimatedUsd: total,
    })
  })
  it('drops legacy remaining dollar fields even when valid', () => {
    expect(parseSubscription({ planType: 'pro', weeklyRemainingEstimatedUsd: 1575 }))
      .toEqual({ planType: 'pro', weeklyEstimatedUsd: 2100 })
  })
  it.each(['business', 'free', 'enterprise', 'unknown'])('does not price %s', plan => {
    expect(projectSubscription(plan)).toEqual({ planType: plan })
  })
  it('normalizes unknown text without exposing arbitrary provider strings', () => {
    expect(projectSubscription('unexpected-secret')).toEqual({ planType: 'unknown' })
    expect(projectSubscription(undefined)).toBeUndefined()
    expect(projectSubscription({ token: 'secret' })).toBeUndefined()
  })
  it.each([undefined, NaN, Infinity, -1, 0, 75, 100, 101])('keeps the total independent of remaining quota %s', percent => {
    expect(subscriptionFromUsage({ planType: 'plus', rateLimits: [{ id: 'codex', windows: [
      { windowSeconds: 604800, remainingPercent: percent },
    ] }] })).toEqual({ planType: 'plus', weeklyEstimatedUsd: 100 })
  })
  it('does not derive dollars from any quota window', () => {
    expect(subscriptionFromUsage({ planType: 'plus', rateLimits: [
      { id: 'codex_spark', windows: [{ windowSeconds: 604800, remainingPercent: 99 }] },
      { id: 'codex', windows: [{ windowSeconds: 18000, remainingPercent: 10 }, { windowSeconds: 604800, remainingPercent: 75 }] },
    ] })).toEqual({ planType: 'plus', weeklyEstimatedUsd: 100 })
    expect(subscriptionFromUsage({ planType: 'plus', rateLimits: [
      { id: 'codex', windows: [{ windowSeconds: 18000, remainingPercent: 10 }] },
    ] })).toEqual({ planType: 'plus', weeklyEstimatedUsd: 100 })
  })
})
