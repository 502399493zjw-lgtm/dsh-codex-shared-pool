import { describe, expect, it } from 'vitest'
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
