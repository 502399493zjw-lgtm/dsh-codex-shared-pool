import { describe, expect, it, vi } from 'vitest'
import { TeamCapacityProvider } from '../src/team/capacity.ts'
import type { TeamCredentialBroker, TeamCredentialRef } from '../src/team/credentials.ts'
import { TeamRequestRouter } from '../src/team/routing.ts'
import { TeamService } from '../src/team/service.ts'
import { MemoryTeamStore } from '../src/team/store.ts'

class NoopCredentialBroker implements TeamCredentialBroker {
  startOAuth(_ref: TeamCredentialRef): Promise<{ method: 'device_code'; verificationUrl: string; userCode: string; expiresAt: number }> {
    return Promise.resolve({ method: 'device_code', verificationUrl: 'https://auth.example.test/codex/device', userCode: 'ABCD-EFGH', expiresAt: 1_800_000 })
  }
  restartOAuth(ref: TeamCredentialRef): ReturnType<TeamCredentialBroker['startOAuth']> { return this.startOAuth(ref) }

  cancelOAuth(_ref: TeamCredentialRef): Promise<void> {
    return Promise.resolve()
  }

  inspectAuthorization(): Promise<{ status: 'active' }> {
    return Promise.resolve({ status: 'active' })
  }

  readUsage(_ref: TeamCredentialRef): Promise<{ rateLimits: [] }> {
    return Promise.resolve({ rateLimits: [] })
  }

  forwardResponses(): Promise<Response> {
    return Promise.resolve(new Response(null, { status: 204 }))
  }

  revoke(_ref: TeamCredentialRef): Promise<void> {
    return Promise.resolve()
  }

  dispose(): Promise<void> {
    return Promise.resolve()
  }
}

class CapacityBroker extends NoopCredentialBroker {
  readonly reads: TeamCredentialRef[] = []
  readonly remainingByAccount = new Map<string, number>()

  override readUsage(ref: TeamCredentialRef): Promise<{
    rateLimits: [{ id: 'codex'; windows: [{ remainingPercent: number; windowSeconds: number; resetsAt: number }] }]
  }> {
    this.reads.push(ref)
    return Promise.resolve({
      rateLimits: [{
        id: 'codex',
        windows: [{
          remainingPercent: this.remainingByAccount.get(ref.accountId) ?? 90,
          windowSeconds: 604_800,
          resetsAt: 10_000,
        }],
      }],
    })
  }
}

describe('Team request admission service', () => {
  it('keeps teammate limits visible when their quota provider fails', async () => {
    const store = new MemoryTeamStore()
    const broker = new CapacityBroker()
    broker.readUsage = async () => { throw new Error('provider unavailable') }
    const service = new TeamService({ store, broker })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = (await store.authenticateApiKey(boot.apiKey))!
    const invite = await store.createInvite(owner, 60_000)
    const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
    const friend = (await store.authenticateApiKey(joined.apiKey))!
    const account = await store.createContributionAccount(owner, 'Owner Codex')
    await store.updateContributionAccount(owner, account.id, { personalReservePercent: 20, allowedModels: ['gpt-5-codex'] })
    await store.setContributionAccountStatus(owner.teamId, account.id, 'active')

    const projection = await service.overviewProjection(friend, true)
    expect(projection.activeSharedAccounts).toMatchObject([{
      id: account.id,
      sharing: { personalReservePercent: 20 },
      capacity: { buckets: [{ id: 'codex', reason: 'provider_unavailable' }] },
    }])
    expect(projection.activeSharedAccounts[0]?.capacity?.buckets[0]).not.toHaveProperty('remainingPercent')
  })

  it('projects live capacity only for the contribution owned by the current member', async () => {
    let id = 0
    const store = new MemoryTeamStore({ id: () => `id-${++id}` })
    const broker = new CapacityBroker()
    const service = new TeamService({ store, broker })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invite = await store.createInvite(owner, 60_000)
    const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
    const friend = await store.authenticateApiKey(joined.apiKey)
    if (friend === undefined) throw new Error('friend key should authenticate')

    const ownerCreated = await store.createContributionAccount(owner, 'Owner Codex')
    const friendCreated = await store.createContributionAccount(friend, 'Friend Codex')
    broker.remainingByAccount.set(ownerCreated.id, 40)
    await store.updateContributionAccount(owner, ownerCreated.id, {
      personalReservePercent: 45,
      maxSharedRequestsPerWindow: 2,
      allowedModels: ['gpt-5-codex'],
    })
    await store.updateContributionAccount(friend, friendCreated.id, { allowedModels: ['gpt-5-codex'] })
    await store.setContributionAccountStatus(owner.teamId, ownerCreated.id, 'active')
    await store.setContributionAccountStatus(owner.teamId, friendCreated.id, 'active')

    const memberProjection = await service.overviewProjection(friend, true)
    expect(memberProjection.activeSharedAccounts.find(account => account.id === ownerCreated.id)).toMatchObject({
      sharing: { personalReservePercent: 45, maxSharedRequestsPerWindow: 2, maxSharedConcurrency: 1,
        weeklySharedEstimatedApiCostLimitMicros: null, allowedModels: ['gpt-5-codex'] },
      capacity: { buckets: [{ id: 'codex', remainingPercent: 40, reason: 'reserve_reached' }] },
    })
    expect(memberProjection.contributions.every(account => account.ownerMemberId === friend.memberId)).toBe(true)
    broker.reads.length = 0
    service.capacity.invalidate({ teamId: owner.teamId, accountId: ownerCreated.id })
    service.capacity.invalidate({ teamId: owner.teamId, accountId: friendCreated.id })

    const ownerOverview = await service.overview(owner)
    expect(ownerOverview.contributions.find(account => account.id === ownerCreated.id)?.capacity).toEqual({
      sharedInFlight: 0,
      buckets: [{
        id: 'codex',
        reason: 'reserve_reached',
        remainingPercent: 40,
        resetAt: 10_000,
        sharedRequestsUsed: 0,
      }],
    })
    expect(ownerOverview.contributions.find(account => account.id === friendCreated.id)).not.toHaveProperty('capacity')
    expect(broker.reads).toEqual([{ teamId: owner.teamId, accountId: ownerCreated.id }])

    broker.reads.length = 0
    const friendOverview = await service.overview(friend)
    expect(friendOverview.contributions.find(account => account.id === ownerCreated.id)).not.toHaveProperty('capacity')
    expect(friendOverview.contributions.find(account => account.id === friendCreated.id)?.capacity?.buckets).toEqual([
      expect.objectContaining({ id: 'codex', reason: 'ready', remainingPercent: 90 }),
    ])
    expect(broker.reads).toEqual([{ teamId: owner.teamId, accountId: friendCreated.id }])
  })

  it('reports live shared concurrency before the durable request-window cap', async () => {
    let id = 0
    const store = new MemoryTeamStore({ id: () => `id-${++id}` })
    const broker = new CapacityBroker()
    const service = new TeamService({
      store,
      broker,
      router: new TeamRequestRouter({ id: () => `lease-${++id}`, now: () => 2_000 }),
    })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invite = await store.createInvite(owner, 60_000)
    const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
    const friend = await store.authenticateApiKey(joined.apiKey)
    if (friend === undefined) throw new Error('friend key should authenticate')
    const created = await store.createContributionAccount(owner, 'Owner Codex')
    await store.updateContributionAccount(owner, created.id, {
      maxSharedConcurrency: 1,
      maxSharedRequestsPerWindow: 1,
      allowedModels: ['gpt-5-codex'],
    })
    const account = await store.setContributionAccountStatus(owner.teamId, created.id, 'active')

    const admitted = await service.admitRequest(friend, {
      sessionId: 'shared-session',
      model: 'gpt-5-codex',
      capacities: [{ accountId: account.id, healthy: true, remainingPercent: 80, resetAt: 10_000 }],
    })
    expect((await service.overview(owner)).contributions[0]?.capacity).toEqual({
      sharedInFlight: 1,
      buckets: [expect.objectContaining({
        id: 'codex',
        reason: 'shared_concurrency_reached',
        sharedRequestsUsed: 1,
      })],
    })

    await service.settleRequest(admitted.lease, 'success')
    expect((await service.overview(owner)).contributions[0]?.capacity?.buckets[0]).toEqual(expect.objectContaining({
      id: 'codex',
      reason: 'request_cap_reached',
      sharedRequestsUsed: 1,
    }))
  })

  it('refreshes active shared quotas and moves a sticky session away from an exhausted account', async () => {
    let id = 0
    const store = new MemoryTeamStore({ id: () => `id-${++id}` })
    const broker = new CapacityBroker()
    const service = new TeamService({
      store,
      broker,
      capacity: new TeamCapacityProvider(broker, { now: () => 1_000, ttlMs: 300_000 }),
      router: new TeamRequestRouter({ id: () => `lease-${++id}` }),
    })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invite = await store.createInvite(owner, 60_000)
    const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
    const friend = await store.authenticateApiKey(joined.apiKey)
    if (friend === undefined) throw new Error('friend key should authenticate')
    const firstCreated = await store.createContributionAccount(owner, 'Primary shared Codex')
    const secondCreated = await store.createContributionAccount(owner, 'Fallback shared Codex')
    const first = await store.setContributionAccountStatus(owner.teamId, firstCreated.id, 'active')
    const second = await store.setContributionAccountStatus(owner.teamId, secondCreated.id, 'active')
    broker.remainingByAccount.set(first.id, 90)
    broker.remainingByAccount.set(second.id, 70)

    const initial = await service.admitLiveRequest(friend, {
      sessionId: 'sticky-shared-session',
      model: 'gpt-5-codex',
    })
    expect(initial.account.id).toBe(first.id)
    await service.settleRequest(initial.lease, 'success')

    broker.remainingByAccount.set(first.id, 0)
    await service.refreshActiveContributionCapacities()
    const fallback = await service.admitLiveRequest(friend, {
      sessionId: 'sticky-shared-session',
      model: 'gpt-5-codex',
    })

    expect(fallback.account.id).toBe(second.id)
    expect(fallback.source).toBe('shared')
    expect(broker.reads.filter(ref => ref.accountId === first.id)).toHaveLength(2)
    expect(broker.reads.filter(ref => ref.accountId === second.id)).toHaveLength(2)
    await service.settleRequest(fallback.lease, 'success')

    broker.remainingByAccount.set(first.id, 95)
    await service.refreshActiveContributionCapacities()
    const recovered = await service.admitLiveRequest(friend, {
      sessionId: 'new-session-after-reset',
      model: 'gpt-5-codex',
    })
    expect(recovered.account.id).toBe(first.id)
    await service.settleRequest(recovered.lease, 'success')
  })

  it('periodically refreshes only active contributions and stops the Host timer on dispose', async () => {
    vi.useFakeTimers()
    try {
      let id = 0
      const store = new MemoryTeamStore({ id: () => `id-${++id}` })
      const broker = new CapacityBroker()
      const service = new TeamService({
        store,
        broker,
        capacity: new TeamCapacityProvider(broker, { now: () => 1_000, ttlMs: 300_000 }),
      })
      const boot = await store.bootstrap('Friends', 'Owner')
      const owner = await store.authenticateApiKey(boot.apiKey)
      if (owner === undefined) throw new Error('owner key should authenticate')
      const activeCreated = await store.createContributionAccount(owner, 'Active shared Codex')
      const pausedCreated = await store.createContributionAccount(owner, 'Paused Codex')
      const active = await store.setContributionAccountStatus(owner.teamId, activeCreated.id, 'active')
      const paused = await store.setContributionAccountStatus(owner.teamId, pausedCreated.id, 'active')
      await store.updateContributionAccount(owner, paused.id, { status: 'paused' })

      service.startCapacityMonitoring({ intervalMs: 100 })
      expect(broker.reads).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(100)
      expect(broker.reads.map(ref => ref.accountId)).toEqual([active.id])

      await vi.advanceTimersByTimeAsync(100)
      expect(broker.reads.map(ref => ref.accountId)).toEqual([active.id, active.id])

      await service.dispose()
      await vi.advanceTimersByTimeAsync(500)
      expect(broker.reads.map(ref => ref.accountId)).toEqual([active.id, active.id])
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses a twelve-hour default interval for the idle Host capacity sweep', async () => {
    vi.useFakeTimers()
    try {
      let id = 0
      const store = new MemoryTeamStore({ id: () => `id-${++id}` })
      const broker = new CapacityBroker()
      const service = new TeamService({
        store,
        broker,
        capacity: new TeamCapacityProvider(broker, { now: () => 1_000, ttlMs: 300_000 }),
      })
      const boot = await store.bootstrap('Friends', 'Owner')
      const owner = await store.authenticateApiKey(boot.apiKey)
      if (owner === undefined) throw new Error('owner key should authenticate')
      const created = await store.createContributionAccount(owner, 'Active shared Codex')
      await store.setContributionAccountStatus(owner.teamId, created.id, 'active')

      service.startCapacityMonitoring()
      await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1_000 - 1)
      expect(broker.reads).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(1)
      expect(broker.reads).toHaveLength(1)
      await service.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('records metadata-only usage while preferring the consumer account', async () => {
    let id = 0
    const store = new MemoryTeamStore({ id: () => `id-${++id}` })
    const service = new TeamService({
      store,
      broker: new NoopCredentialBroker(),
      router: new TeamRequestRouter({ id: () => `lease-${++id}`, now: () => 2_000 }),
    })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invite = await store.createInvite(owner, 60_000)
    const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
    const member = await store.authenticateApiKey(joined.apiKey)
    if (member === undefined) throw new Error('member key should authenticate')

    const shared = await store.createContributionAccount(owner, 'Owner Codex')
    const own = await store.createContributionAccount(member, 'Friend Codex')
    await store.setContributionAccountStatus(owner.teamId, shared.id, 'active')
    await store.setContributionAccountStatus(owner.teamId, own.id, 'active')

    const admitted = await service.admitRequest(member, {
      sessionId: 'session-1',
      model: 'gpt-5-codex',
      capacities: [
        { accountId: shared.id, healthy: true, remainingPercent: 90, resetAt: 10_000 },
        { accountId: own.id, healthy: true, remainingPercent: 50, resetAt: 10_000 },
      ],
    })
    expect(admitted.account.id).toBe(own.id)
    expect(admitted.usage).toMatchObject({
      teamId: owner.teamId,
      consumerMemberId: member.memberId,
      upstreamOwnerMemberId: member.memberId,
      upstreamAccountId: own.id,
      model: 'gpt-5-codex',
      unit: 'request',
      status: 'in_progress',
    })
    expect(JSON.stringify(admitted.usage)).not.toMatch(/prompt|response|file|token/iu)

    const settled = await service.settleRequest(admitted.lease, 'success')
    expect(settled.status).toBe('succeeded')
    expect((await service.listUsageEvents(member, 10))).toEqual([settled])
  })

  it('atomically reserves the contributor daily Credits cap only for shared requests', async () => {
    let id = 0
    const store = new MemoryTeamStore({ id: () => `id-${++id}`, now: () => Date.UTC(2026, 7, 20, 12) })
    const service = new TeamService({
      store,
      broker: new NoopCredentialBroker(),
      router: new TeamRequestRouter({ id: () => `lease-${++id}` }),
    })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invite = await store.createInvite(owner, 60_000)
    const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
    const friend = await store.authenticateApiKey(joined.apiKey)
    if (friend === undefined) throw new Error('friend key should authenticate')
    const created = await store.createContributionAccount(owner, 'Owner Codex')
    await store.updateContributionAccount(owner, created.id, {
      dailySharedCreditLimit: 50_000,
      maxSharedConcurrency: 3,
    })
    const account = await store.setContributionAccountStatus(owner.teamId, created.id, 'active')
    const capacity = [{ accountId: account.id, healthy: true, remainingPercent: 80, resetAt: 10_000 }]

    const shared = await service.admitRequest(friend, { sessionId: 'friend-1', model: 'gpt-5-codex', capacities: capacity })
    const own = await service.admitRequest(owner, { sessionId: 'owner-1', model: 'gpt-5-codex', capacities: capacity })
    await expect(service.admitRequest(friend, {
      sessionId: 'friend-2',
      model: 'gpt-5-codex',
      capacities: capacity,
    })).rejects.toThrow(/daily shared Credits limit/iu)

    await service.settleRequest(shared.lease, 'error')
    await service.settleRequest(own.lease, 'success')
    const retried = await service.admitRequest(friend, { sessionId: 'friend-2', model: 'gpt-5-codex', capacities: capacity })
    const settled = await service.settleRequest(retried.lease, 'success', {
      inputTokens: 10_000,
      cachedInputTokens: 0,
      outputTokens: 10_000,
    })
    expect(settled).toMatchObject({ credits: 50_000, creditsFormulaVersion: 'credits-v1' })
    await expect(service.admitRequest(friend, {
      sessionId: 'friend-3',
      model: 'gpt-5-codex',
      capacities: capacity,
    })).rejects.toThrow(/daily shared Credits limit/iu)
  })

  it('stops new admission before waiting for an in-flight request to drain on revoke', async () => {
    let resolveRevoke: (() => void) | undefined
    const revoked = new Promise<void>(resolve => { resolveRevoke = resolve })
    class BlockingBroker extends NoopCredentialBroker {
      override async revoke(_ref: TeamCredentialRef): Promise<void> {
        await revoked
      }
    }
    const store = new MemoryTeamStore()
    const service = new TeamService({ store, broker: new BlockingBroker() })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const contributed = await store.createContributionAccount(owner, 'Owner Codex')
    await store.setContributionAccountStatus(owner.teamId, contributed.id, 'active')
    const admitted = await service.admitRequest(owner, {
      sessionId: 'session-2',
      model: 'gpt-5-codex',
      capacities: [{ accountId: contributed.id, healthy: true, remainingPercent: 80, resetAt: 10_000 }],
    })

    let revokeSettled = false
    const revoke = service.revokeContributionAccount(owner, contributed.id).then((value) => {
      revokeSettled = true
      return value
    })
    await Promise.resolve()
    expect(revokeSettled).toBe(false)
    await expect(service.admitRequest(owner, {
      sessionId: 'session-3',
      model: 'gpt-5-codex',
      capacities: [{ accountId: contributed.id, healthy: true, remainingPercent: 80, resetAt: 10_000 }],
    })).rejects.toThrow(/capacity/u)

    await service.settleRequest(admitted.lease, 'success')
    resolveRevoke?.()
    expect((await revoke).status).toBe('revoked')
  })
})
