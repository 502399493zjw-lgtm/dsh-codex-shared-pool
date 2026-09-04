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
    expect(quota.subscription).toEqual({ planType: 'pro', weeklyEstimatedUsd: 2100, weeklyRemainingEstimatedUsd: 1575 })
  })
  it.each([['plus', 100], ['prolite', 600], ['pro', 2100]] as const)('estimates %s directly', (plan, total) => {
    expect(projectSubscription(plan, 75)).toEqual({
      planType: plan, weeklyEstimatedUsd: total, weeklyRemainingEstimatedUsd: total * 0.75,
    })
  })
  it('preserves zero and rounds fractional dollars', () => {
    expect(projectSubscription('pro', 0)?.weeklyRemainingEstimatedUsd).toBe(0)
    expect(projectSubscription('pro', 33.333)?.weeklyRemainingEstimatedUsd).toBe(699.99)
  })
  it.each(['business', 'free', 'enterprise', 'unknown'])('does not price %s', plan => {
    expect(projectSubscription(plan, 50)).toEqual({ planType: plan })
  })
  it('normalizes unknown text without exposing arbitrary provider strings', () => {
    expect(projectSubscription('unexpected-secret')).toEqual({ planType: 'unknown' })
    expect(projectSubscription(undefined)).toBeUndefined()
    expect(projectSubscription({ token: 'secret' })).toBeUndefined()
  })
  it.each([undefined, NaN, Infinity, -1, 101])('does not fabricate remaining dollars for %s', percent => {
    expect(projectSubscription('plus', percent)).toEqual({ planType: 'plus', weeklyEstimatedUsd: 100 })
  })
  it('uses only the main seven-day window regardless of order', () => {
    expect(subscriptionFromUsage({ planType: 'plus', rateLimits: [
      { id: 'codex_spark', windows: [{ windowSeconds: 604800, remainingPercent: 99 }] },
      { id: 'codex', windows: [{ windowSeconds: 18000, remainingPercent: 10 }, { windowSeconds: 604800, remainingPercent: 75 }] },
    ] })?.weeklyRemainingEstimatedUsd).toBe(75)
    expect(subscriptionFromUsage({ planType: 'plus', rateLimits: [
      { id: 'codex', windows: [{ windowSeconds: 18000, remainingPercent: 10 }] },
    ] })?.weeklyRemainingEstimatedUsd).toBeUndefined()
  })
})
