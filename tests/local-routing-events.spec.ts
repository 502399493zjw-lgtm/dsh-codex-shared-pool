import { describe, expect, it } from 'vitest'
import { LocalRoutingEventLedger } from '../src/local-routing-events.ts'

describe('local Codex routing event ledger', () => {
  it('projects only metadata with ordinal aliases and settles a real request unit', () => {
    let now = 1_000
    let nextId = 0
    const ledger = new LocalRoutingEventLedger({
      now: () => now,
      id: () => `event-${++nextId}`,
    })

    const eventId = ledger.begin({
      allocation: {
        profileId: 'raw-profile-b',
        previousProfileId: 'raw-profile-a',
        reason: 'quota_fallback',
      },
      profileOrder: ['raw-profile-a', 'raw-profile-b'],
      model: 'gpt-5.6-sol',
    })

    expect(ledger.currentProfileId()).toBe('raw-profile-b')

    expect(ledger.list()).toEqual([{
      id: 'event-1',
      profileAlias: 'B',
      previousProfileAlias: 'A',
      model: 'gpt-5.6-sol',
      reason: 'quota_fallback',
      unit: 'request',
      status: 'in_progress',
      startedAt: 1_000,
    }])

    now = 1_250
    ledger.settle(eventId, 'succeeded')
    const serialized = JSON.stringify(ledger.list())
    expect(ledger.list()[0]).toMatchObject({ status: 'succeeded', finishedAt: 1_250 })
    expect(serialized).not.toContain('raw-profile')
    expect(serialized).not.toContain('session')
    expect(serialized).not.toContain('prompt')
    expect(serialized).not.toContain('response')
    expect(serialized).not.toContain('token')
    expect(serialized).not.toContain('error')
  })

  it.each(['failed', 'cancelled'] as const)('settles a request as %s without retaining an error', status => {
    const ledger = new LocalRoutingEventLedger({ id: () => 'event-1', now: () => 1 })
    const id = ledger.begin({
      allocation: { profileId: 'profile-a', reason: 'priority' },
      profileOrder: ['profile-a'],
      model: 'gpt-5.6-sol',
    })

    ledger.settle(id, status)

    expect(ledger.list()).toEqual([{
      id: 'event-1',
      profileAlias: 'A',
      model: 'gpt-5.6-sol',
      reason: 'priority',
      unit: 'request',
      status,
      startedAt: 1,
      finishedAt: 1,
    }])
  })

  it('keeps the newest 100 events and returns at most the requested 50', () => {
    let nextId = 0
    const ledger = new LocalRoutingEventLedger({ id: () => `event-${++nextId}`, now: () => nextId })
    for (let index = 0; index < 105; index += 1) {
      ledger.begin({
        allocation: { profileId: 'profile-a', reason: 'priority' },
        profileOrder: ['profile-a'],
        model: 'gpt-5.6-sol',
      })
    }

    expect(ledger.list(50)).toHaveLength(50)
    expect(ledger.list(50)[0]?.id).toBe('event-105')
    expect(ledger.list(100)).toHaveLength(100)
    expect(ledger.list(100).at(-1)?.id).toBe('event-6')
    expect(ledger.currentProfileId()).toBe('profile-a')
  })
})
