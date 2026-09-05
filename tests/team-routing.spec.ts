import { describe, expect, it } from 'vitest'
import { TeamRequestRouter, TeamRouteCapacityError } from '../src/team/routing.ts'
import type { TeamContributionAccountSummary } from '../src/team/types.ts'

function account(overrides: Partial<TeamContributionAccountSummary> = {}): TeamContributionAccountSummary {
  return {
    id: overrides.id ?? 'account-1',
    teamId: overrides.teamId ?? 'team-1',
    ownerMemberId: overrides.ownerMemberId ?? 'member-owner',
    label: overrides.label ?? 'Codex',
    status: overrides.status ?? 'active',
    personalReservePercent: overrides.personalReservePercent ?? 20,
    maxSharedRequestsPerWindow: overrides.maxSharedRequestsPerWindow ?? null,
    dailySharedCreditLimit: overrides.dailySharedCreditLimit ?? null,
    maxSharedConcurrency: overrides.maxSharedConcurrency ?? 1,
    allowedModels: overrides.allowedModels ?? [],
    createdAt: overrides.createdAt ?? 1,
    updatedAt: overrides.updatedAt ?? 1,
    ...(overrides.lastError === undefined ? {} : { lastError: overrides.lastError }),
  }
}

function candidate(accountValue: TeamContributionAccountSummary, remainingPercent = 80, resetAt = 10_000) {
  return {
    account: accountValue,
    quota: { healthy: true, remainingPercent, resetAt },
  }
}

describe('Team request routing', () => {
  it('distinguishes temporary quota failures from occupied shared capacity', () => {
    const router = new TeamRequestRouter()
    const request = {
      teamId: 'team-1', teamStatus: 'active' as const,
      consumerMemberId: 'friend', sessionId: 'first', model: 'gpt-5.6-sol',
      candidates: [candidate(account())],
    }
    const reasons = (operation: () => unknown) => {
      try { operation() } catch (error) {
        expect(error).toBeInstanceOf(TeamRouteCapacityError)
        return (error as TeamRouteCapacityError).reasons
      }
      throw new Error('expected capacity rejection')
    }
    expect(reasons(() => router.route({ ...request, candidates: [{ account: account(), quota: { healthy: false } }] })))
      .toContain('quota_unavailable')
    expect(reasons(() => router.route({ ...request, candidates: [candidate(account(), 20)] })))
      .toContain('reserve_reached')
    const first = router.route(request)
    expect(reasons(() => router.route({ ...request, sessionId: 'second' })))
      .toContain('shared_concurrency_reached')
    router.settle(first.lease, 'success')
    expect(router.route({ ...request, sessionId: 'second' }).source).toBe('shared')
  })

  it('prefers the requester account and then keeps a healthy session binding', () => {
    const router = new TeamRequestRouter({ id: (() => { let i = 0; return () => `lease-${++i}` })() })
    const own = account({ id: 'own', ownerMemberId: 'member-requester' })
    const shared = account({ id: 'shared', ownerMemberId: 'member-friend' })
    const request = {
      teamId: 'team-1',
      teamStatus: 'active' as const,
      consumerMemberId: 'member-requester',
      sessionId: 'session-1',
      model: 'gpt-5-codex',
      candidates: [candidate(shared), candidate(own)],
    }

    const first = router.route(request)
    expect(first.account.id).toBe('own')
    expect(first.source).toBe('own')
    router.settle(first.lease, 'success')

    const second = router.route({
      ...request,
      candidates: [candidate(own, 0), candidate(shared, 80)],
    })
    expect(second.account.id).toBe('shared')
    expect(second.source).toBe('shared')
  })

  it('applies reserve, model, request-window, and concurrency guards atomically', () => {
    const router = new TeamRequestRouter()
    const shared = account({
      id: 'shared',
      ownerMemberId: 'member-friend',
      personalReservePercent: 30,
      maxSharedRequestsPerWindow: 1,
      maxSharedConcurrency: 1,
      allowedModels: ['gpt-5-codex'],
    })
    const request = {
      teamId: 'team-1',
      teamStatus: 'active' as const,
      consumerMemberId: 'member-requester',
      sessionId: 'session-2',
      model: 'gpt-5-codex',
      candidates: [candidate(shared, 40)],
    }

    const first = router.route(request)
    expect(() => router.route({ ...request, sessionId: 'session-3' })).toThrowError(TeamRouteCapacityError)
    router.settle(first.lease, 'success')
    expect(() => router.route({ ...request, sessionId: 'session-4' })).toThrowError(/no shared capacity/u)

    expect(() => router.route({
      ...request,
      sessionId: 'session-5',
      model: 'gpt-5-mini',
      candidates: [candidate(shared, 90)],
    })).toThrowError(/no shared capacity/u)
    expect(() => router.route({
      ...request,
      sessionId: 'session-6',
      candidates: [candidate(shared, 30)],
    })).toThrowError(/no shared capacity/u)
  })

  it('preserves each provider-window counter when requests switch model buckets', () => {
    const router = new TeamRequestRouter()
    const shared = account({
      id: 'shared',
      ownerMemberId: 'member-friend',
      maxSharedRequestsPerWindow: 1,
    })
    const request = (sessionId: string, model: string, resetAt: number) => ({
      teamId: 'team-1',
      teamStatus: 'active' as const,
      consumerMemberId: 'member-requester',
      sessionId,
      model,
      candidates: [candidate(shared, 80, resetAt)],
    })

    const codex = router.route(request('codex-1', 'gpt-5-codex', 10_000))
    router.settle(codex.lease, 'success')
    const spark = router.route(request('spark-1', 'gpt-5.3-codex-spark', 20_000))
    router.settle(spark.lease, 'success')

    expect(() => router.route(request('codex-2', 'gpt-5-codex', 10_000)))
      .toThrowError(/no shared capacity/u)
    expect(() => router.route(request('spark-2', 'gpt-5.3-codex-spark', 20_000)))
      .toThrowError(/no shared capacity/u)
  })

  it('does not spend a shared account when the provider reserve signal is missing', () => {
    const router = new TeamRequestRouter()
    const shared = account({ id: 'shared', ownerMemberId: 'member-friend' })
    expect(() => router.route({
      teamId: 'team-1',
      teamStatus: 'active',
      consumerMemberId: 'member-requester',
      sessionId: 'session-7',
      model: 'gpt-5-codex',
      candidates: [{ account: shared, quota: { healthy: true, resetAt: 10_000 } }],
    })).toThrowError(/no shared capacity/u)
  })

  it('counts only borrowed requests against shared concurrency', () => {
    const router = new TeamRequestRouter()
    const contributed = account({ id: 'shared', ownerMemberId: 'member-owner', maxSharedConcurrency: 1 })
    const own = router.route({
      teamId: 'team-1',
      teamStatus: 'active',
      consumerMemberId: 'member-owner',
      sessionId: 'owner-session',
      model: 'gpt-5-codex',
      candidates: [candidate(contributed)],
    })
    const borrowed = router.route({
      teamId: 'team-1',
      teamStatus: 'active',
      consumerMemberId: 'member-friend',
      sessionId: 'friend-session',
      model: 'gpt-5-codex',
      candidates: [candidate(contributed)],
    })
    expect(borrowed.source).toBe('shared')
    expect(() => router.route({
      teamId: 'team-1',
      teamStatus: 'active',
      consumerMemberId: 'member-second-friend',
      sessionId: 'second-friend-session',
      model: 'gpt-5-codex',
      candidates: [candidate(contributed)],
    })).toThrowError(TeamRouteCapacityError)
    router.settle(own.lease, 'success')
    router.settle(borrowed.lease, 'success')
  })

  it('isolates identical session ids between different Team members', () => {
    const router = new TeamRequestRouter()
    const firstAccount = account({ id: 'first-account', ownerMemberId: 'first-member' })
    const secondAccount = account({ id: 'second-account', ownerMemberId: 'second-member' })
    const candidates = [candidate(firstAccount), candidate(secondAccount)]

    const first = router.route({
      teamId: 'team-1',
      teamStatus: 'active',
      consumerMemberId: 'first-member',
      sessionId: 'same-client-session',
      model: 'gpt-5-codex',
      candidates,
    })
    router.settle(first.lease, 'success')
    const second = router.route({
      teamId: 'team-1',
      teamStatus: 'active',
      consumerMemberId: 'second-member',
      sessionId: 'same-client-session',
      model: 'gpt-5-codex',
      candidates,
    })

    expect(first.account.id).toBe(firstAccount.id)
    expect(second.account.id).toBe(secondAccount.id)
    expect(second.source).toBe('own')
    router.settle(second.lease, 'success')
  })
})
