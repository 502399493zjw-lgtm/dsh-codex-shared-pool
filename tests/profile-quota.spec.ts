import { describe, expect, it } from 'vitest'
import { assembleOpenAICodexProfileQuota } from '../src/quota/profiles.ts'
import type { OpenAICodexUsage } from '../src/usage.ts'

function usage(remainingPercent?: number, resetsAt?: number): OpenAICodexUsage {
  return remainingPercent === undefined
    ? { rateLimits: [] }
    : {
        rateLimits: [
          {
            id: 'codex_spark',
            windows: [{ remainingPercent: 100, windowSeconds: 604_800 }],
          },
          {
            id: 'codex',
            windows: [{
              remainingPercent,
              windowSeconds: 604_800,
              ...resetsAt === undefined ? {} : { resetsAt },
            }],
          },
        ],
      }
}

function profile(label: string, remainingPercent?: number, resetsAt?: number) {
  return { label, usage: usage(remainingPercent, resetsAt) }
}

describe('stored OpenAI Codex profile quota projection', () => {
  it('tracks the stored Pool count from zero to one to three profiles', () => {
    expect(assembleOpenAICodexProfileQuota([], () => 10)).toEqual({
      currentAccountName: null,
      currentRemainingPercent: null,
      currentResetsAt: null,
      poolAccountCount: 0,
      poolRemainingPercent: null,
      refreshedAt: 10,
    })

    expect(assembleOpenAICodexProfileQuota([
      profile('钟经纬', 38, 3_800),
    ], () => 20)).toMatchObject({
      currentAccountName: '钟经纬',
      currentRemainingPercent: 38,
      currentResetsAt: 3_800,
      poolAccountCount: 1,
      poolRemainingPercent: 38,
    })

    expect(assembleOpenAICodexProfileQuota([
      profile('经纬 钟', 0),
      profile('钟经纬', 38),
      profile('EdisonZhong', 80),
    ], () => 30)).toMatchObject({
      currentAccountName: '钟经纬',
      currentRemainingPercent: 38,
      poolAccountCount: 3,
      poolRemainingPercent: 39,
      refreshedAt: 30,
    })
  })

  it('uses the first non-exhausted profile in the global allocation order', () => {
    const profiles = [
      profile('钟经纬', 38, 3_800),
      profile('经纬 钟', 0, 1_000),
      profile('EdisonZhong', 80, 8_000),
    ]

    expect(assembleOpenAICodexProfileQuota(profiles, () => 40)).toMatchObject({
      currentAccountName: '钟经纬',
      currentRemainingPercent: 38,
      currentResetsAt: 3_800,
      poolAccountCount: 3,
      poolRemainingPercent: 39,
    })
  })

  it('updates current account and count after deleting the priority profile', () => {
    const remaining = [
      profile('经纬 钟', 0),
      profile('EdisonZhong', 80),
    ]

    expect(assembleOpenAICodexProfileQuota(remaining, () => 50)).toMatchObject({
      currentAccountName: 'EdisonZhong',
      currentRemainingPercent: 80,
      poolAccountCount: 2,
      poolRemainingPercent: 40,
    })
  })

  it('falls back to the first global profile when every Codex profile is exhausted', () => {
    expect(assembleOpenAICodexProfileQuota([
      profile('经纬 钟', 0),
      profile('钟经纬', 0),
    ], () => 55)).toMatchObject({
      currentAccountName: '经纬 钟',
      currentRemainingPercent: 0,
      poolAccountCount: 2,
      poolRemainingPercent: 0,
    })
  })

  it('keeps the stored count and priority label when one profile usage read fails', () => {
    const profiles = [
      profile('钟经纬'),
      profile('经纬 钟', 0),
      profile('EdisonZhong', 80),
    ]

    expect(assembleOpenAICodexProfileQuota(profiles, () => 60)).toEqual({
      currentAccountName: '钟经纬',
      currentRemainingPercent: null,
      currentResetsAt: null,
      poolAccountCount: 3,
      poolRemainingPercent: 40,
      refreshedAt: 60,
    })
  })
})
