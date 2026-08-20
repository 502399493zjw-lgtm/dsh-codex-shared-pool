import { describe, expect, it, vi } from 'vitest'
import { MemoryTeamStore } from '../src/team/store.ts'
import { TeamService } from '../src/team/service.ts'
import type { TeamCredentialBroker, TeamCredentialRef } from '../src/team/credentials.ts'
import { TeamRequestRouter } from '../src/team/routing.ts'

class FakeCredentialBroker implements TeamCredentialBroker {
  readonly started: TeamCredentialRef[] = []
  readonly restarted: TeamCredentialRef[] = []
  readonly cancelled: TeamCredentialRef[] = []
  readonly revoked: TeamCredentialRef[] = []
  readonly inspected: TeamCredentialRef[] = []

  constructor(
    private readonly onCancel: (ref: TeamCredentialRef) => Promise<void> = async () => undefined,
    private readonly authorizationStatus: 'active' | 'reauth_required' = 'active',
  ) {}

  startOAuth(ref: TeamCredentialRef): Promise<{ method: 'device_code'; verificationUrl: string; userCode: string; expiresAt: number }> {
    this.started.push(ref)
    return Promise.resolve({
      method: 'device_code',
      verificationUrl: 'https://auth.example.test/codex/device',
      userCode: 'ABCD-EFGH',
      expiresAt: 1_800_000,
    })
  }

  restartOAuth(ref: TeamCredentialRef): Promise<{ method: 'device_code'; verificationUrl: string; userCode: string; expiresAt: number }> {
    this.restarted.push(ref)
    return this.startOAuth(ref)
  }

  async cancelOAuth(ref: TeamCredentialRef): Promise<void> {
    this.cancelled.push(ref)
    await this.onCancel(ref)
  }

  inspectAuthorization(ref: TeamCredentialRef): Promise<{ status: 'active' | 'reauth_required' }> {
    this.inspected.push(ref)
    return Promise.resolve({ status: this.authorizationStatus })
  }

  readUsage(): Promise<{ rateLimits: [] }> {
    return Promise.resolve({ rateLimits: [] })
  }

  forwardResponses(): Promise<Response> {
    return Promise.resolve(new Response(null, { status: 204 }))
  }

  revoke(ref: TeamCredentialRef): Promise<void> {
    this.revoked.push(ref)
    return Promise.resolve()
  }

  dispose(): Promise<void> {
    return Promise.resolve()
  }
}

describe('Team control plane', () => {
  it('bootstraps a Team and only returns the API key once', async () => {
    const store = new MemoryTeamStore({ id: (() => { let i = 0; return () => `id-${++i}` })() })
    const result = await store.bootstrap('Friends', 'Owner')

    expect(result.team.name).toBe('Friends')
    expect(result.member.role).toBe('owner')
    expect(result.apiKey).toMatch(/^dsh_team_/u)
    expect((await store.overview(await store.authenticateApiKey(result.apiKey)!)).apiKeys[0]).not.toHaveProperty('token')
  })

  it('accepts an invite once and rejects it after use', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invite = await store.createInvite(owner, 60_000)

    const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
    expect(joined.member.role).toBe('member')
    await expect(store.acceptInvite(invite.inviteToken, 'Second')).rejects.toThrow(/invalid or expired/u)
  })

  it('lets an operator revoke an unused invite immediately and idempotently', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const memberInvite = await store.createInvite(owner, 60_000)
    const joined = await store.acceptInvite(memberInvite.inviteToken, 'Friend')
    const member = await store.authenticateApiKey(joined.apiKey)
    if (member === undefined) throw new Error('member key should authenticate')
    const pending = await store.createInvite(owner, 60_000)

    await expect(store.revokeInvite(member, pending.invite.id)).rejects.toThrow(/administrator role/u)
    await expect(store.revokeInvite(owner, pending.invite.id)).resolves.toMatchObject({ status: 'revoked' })
    await expect(store.revokeInvite(owner, pending.invite.id)).resolves.toMatchObject({ status: 'revoked' })
    await expect(store.acceptInvite(pending.inviteToken, 'Outsider')).rejects.toThrow(/invalid or expired/u)
    expect((await store.overview(owner)).invites).not.toContainEqual(expect.objectContaining({ id: pending.invite.id }))
  })

  it('enforces tenant isolation and revocation', async () => {
    const store = new MemoryTeamStore()
    const first = await store.bootstrap('First', 'Alice')
    const second = await store.bootstrap('Second', 'Bob')
    const firstAuth = await store.authenticateApiKey(first.apiKey)
    if (firstAuth === undefined) throw new Error('first key should authenticate')

    expect((await store.overview(firstAuth)).team.name).toBe('First')
    expect(await store.authenticateApiKey(second.apiKey)).not.toBeUndefined()
    await store.revokeApiKey(firstAuth, firstAuth.keyId)
    expect(await store.authenticateApiKey(first.apiKey)).toBeUndefined()
    await expect(store.overview({ ...firstAuth, role: 'owner' })).rejects.toThrow(/revoked/u)
  })

  it('keeps member keys scoped to their Team', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invite = await store.createInvite(owner, 60_000)
    const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
    const member = await store.authenticateApiKey(joined.apiKey)
    if (member === undefined) throw new Error('member key should authenticate')

    const key = await store.issueApiKey(member, 'laptop')
    expect(key.summary.teamId).toBe(owner.teamId)
    expect(key.summary.memberId).toBe(member.memberId)
    await expect(store.createInvite(member, 60_000)).rejects.toThrow(/administrator role/u)
  })

  it('atomically transfers ownership while preserving keys and contribution ownership', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invite = await store.createInvite(owner, 60_000)
    const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
    const member = await store.authenticateApiKey(joined.apiKey)
    if (member === undefined) throw new Error('member key should authenticate')
    const contribution = await store.createContributionAccount(owner, 'Owner Codex')

    const result = await store.transferOwnership(owner, member.memberId)

    expect(result).toEqual({
      formerOwner: expect.objectContaining({ id: owner.memberId, role: 'admin', status: 'active' }),
      owner: expect.objectContaining({ id: member.memberId, role: 'owner', status: 'active' }),
    })
    await expect(store.overview(owner)).rejects.toThrow(/role is stale/iu)
    await expect(store.overview(member)).rejects.toThrow(/role is stale/iu)
    const formerOwner = await store.authenticateApiKey(boot.apiKey)
    const currentOwner = await store.authenticateApiKey(joined.apiKey)
    if (formerOwner === undefined || currentOwner === undefined) throw new Error('existing keys should remain active')
    expect(formerOwner.role).toBe('admin')
    expect(currentOwner.role).toBe('owner')
    const overview = await store.overview(currentOwner)
    expect(overview.members.filter(candidate => candidate.role === 'owner')).toEqual([
      expect.objectContaining({ id: member.memberId }),
    ])
    expect(overview.contributions).toContainEqual(expect.objectContaining({
      id: contribution.id,
      ownerMemberId: owner.memberId,
      status: 'authorizing',
    }))
    await expect(store.leaveTeam(formerOwner)).resolves.toMatchObject({
      member: { id: owner.memberId, role: 'admin', status: 'removed' },
    })
  })

  it('rejects ineligible ownership transfers without changing either role', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invite = await store.createInvite(owner, 60_000)
    const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
    const member = await store.authenticateApiKey(joined.apiKey)
    if (member === undefined) throw new Error('member key should authenticate')

    await expect(store.transferOwnership(member, owner.memberId)).rejects.toThrow(/only the owner/iu)
    await expect(store.transferOwnership(owner, owner.memberId)).rejects.toThrow(/different Team member/iu)
    const foreign = await store.bootstrap('Other', 'Outsider')
    await expect(store.transferOwnership(owner, foreign.member.id)).rejects.toThrow(/not found/iu)

    const removedInvite = await store.createInvite(owner, 60_000)
    const removedJoin = await store.acceptInvite(removedInvite.inviteToken, 'Former Friend')
    const removedMember = await store.authenticateApiKey(removedJoin.apiKey)
    if (removedMember === undefined) throw new Error('departing key should authenticate')
    await store.leaveTeam(removedMember)
    await expect(store.transferOwnership(owner, removedMember.memberId)).rejects.toThrow(/not active/iu)

    await store.revokeApiKey(owner, member.keyId)
    await expect(store.transferOwnership(owner, member.memberId)).rejects.toThrow(/active Team API key/iu)
    await expect(store.overview(owner)).resolves.toMatchObject({
      currentMember: { role: 'owner' },
      members: expect.arrayContaining([expect.objectContaining({ id: member.memberId, role: 'member' })]),
    })
  })

  it('atomically removes a departing member, every key, and every owned contribution', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invite = await store.createInvite(owner, 60_000)
    const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
    const member = await store.authenticateApiKey(joined.apiKey)
    if (member === undefined) throw new Error('member key should authenticate')
    const secondKey = await store.issueApiKey(member, 'laptop')
    const firstContribution = await store.createContributionAccount(member, 'Friend Codex')
    const secondContribution = await store.createContributionAccount(member, 'Friend Codex backup')
    const ownerContribution = await store.createContributionAccount(owner, 'Owner Codex')

    const result = await store.leaveTeam(member)

    expect(result.member).toMatchObject({ id: member.memberId, status: 'removed' })
    expect(result.contributions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: firstContribution.id, status: 'revoked' }),
      expect.objectContaining({ id: secondContribution.id, status: 'revoked' }),
    ]))
    expect(await store.authenticateApiKey(joined.apiKey)).toBeUndefined()
    expect(await store.authenticateApiKey(secondKey.token)).toBeUndefined()
    const overview = await store.overview(owner)
    expect(overview.members).toContainEqual(expect.objectContaining({ id: member.memberId, status: 'removed' }))
    expect(overview.contributions).toContainEqual(expect.objectContaining({ id: ownerContribution.id, status: 'authorizing' }))
    expect(overview.contributions.filter(account => account.ownerMemberId === member.memberId))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: firstContribution.id, status: 'revoked' }),
        expect.objectContaining({ id: secondContribution.id, status: 'revoked' }),
      ]))
  })

  it('rejects owner departure without changing the Team', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')

    await expect(store.leaveTeam(owner)).rejects.toThrow(/owner.*cannot leave/iu)

    expect(await store.authenticateApiKey(boot.apiKey)).toEqual(owner)
    await expect(store.overview(owner)).resolves.toMatchObject({ currentMember: { status: 'active', role: 'owner' } })
  })

  it('keeps control-plane authentication available while paused but rejects new usage', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const contribution = await store.createContributionAccount(owner, 'Owner Codex')
    await store.setContributionAccountStatus(owner.teamId, contribution.id, 'active')

    await store.setTeamStatus(owner, 'paused')
    const pausedOwner = await store.authenticateApiKey(boot.apiKey)
    expect(pausedOwner).not.toBeUndefined()
    if (pausedOwner === undefined) throw new Error('paused Team key should still authenticate')
    await expect(store.beginUsageEvent(pausedOwner, 'paused-event', contribution.id, 'gpt-5-codex'))
      .rejects.toThrow(/team is paused/iu)
    await expect(store.setTeamStatus(pausedOwner, 'active')).resolves.toMatchObject({ status: 'active' })
  })

  it('keeps contribution controls owned by the contributor', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invite = await store.createInvite(owner, 60_000)
    const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
    const member = await store.authenticateApiKey(joined.apiKey)
    if (member === undefined) throw new Error('member key should authenticate')

    const account = await store.createContributionAccount(member, 'Friend Codex')
    expect(account.ownerMemberId).toBe(member.memberId)
    expect(account.status).toBe('authorizing')
    expect(account.personalReservePercent).toBe(20)
    await expect(store.updateContributionAccount(owner, account.id, { personalReservePercent: 50 }))
      .rejects.toThrow(/owner of the contribution account/u)

    await expect(store.updateContributionAccount(member, account.id, { status: 'active' }))
      .rejects.toThrow(/authorization status cannot be changed manually/iu)
    await store.setContributionAccountStatus(member.teamId, account.id, 'active')

    const updated = await store.updateContributionAccount(member, account.id, {
      status: 'paused',
      personalReservePercent: 50,
      maxSharedRequestsPerWindow: 12,
    })
    expect(updated).toMatchObject({ status: 'paused', personalReservePercent: 50, maxSharedRequestsPerWindow: 12 })
    expect((await store.overview(owner)).contributions).toEqual([updated])
    const revoked = await store.revokeContributionAccount(member, account.id)
    expect(revoked.status).toBe('revoked')
  })

  it('keeps revoked contributions terminal when a late OAuth callback arrives', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const contribution = await store.createContributionAccount(owner, 'Owner Codex')

    await store.revokeContributionAccount(owner, contribution.id)
    await expect(store.setContributionAccountStatus(owner.teamId, contribution.id, 'active'))
      .resolves.toMatchObject({ status: 'revoked' })
    await expect(store.listContributionAccountsByStatus('revoked'))
      .resolves.toMatchObject([{ id: contribution.id, status: 'revoked' }])
  })

  it('begins reauthorization only for the contributor and preserves sharing protections', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invite = await store.createInvite(owner, 60_000)
    const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
    const member = await store.authenticateApiKey(joined.apiKey)
    if (member === undefined) throw new Error('member key should authenticate')
    const contribution = await store.createContributionAccount(member, 'Friend Codex')
    await store.setContributionAccountStatus(member.teamId, contribution.id, 'active')
    await store.updateContributionAccount(member, contribution.id, {
      personalReservePercent: 45,
      maxSharedRequestsPerWindow: 17,
      maxSharedConcurrency: 2,
      allowedModels: ['gpt-5-codex'],
    })
    await store.setContributionAccountStatus(member.teamId, contribution.id, 'reauth_required', 'sign in again')

    await expect(store.beginContributionReauthorization(owner, contribution.id))
      .rejects.toThrow(/owner of the contribution account/iu)
    await expect(store.beginContributionReauthorization(member, contribution.id)).resolves.toMatchObject({
      id: contribution.id,
      status: 'authorizing',
      personalReservePercent: 45,
      maxSharedRequestsPerWindow: 17,
      maxSharedConcurrency: 2,
      allowedModels: ['gpt-5-codex'],
    })
    expect((await store.listContributionAccounts(member))[0]).not.toHaveProperty('lastError')
    await expect(store.beginContributionReauthorization(member, contribution.id))
      .rejects.toThrow(/reauthorization/iu)
  })

  it('redacts diagnostics before contribution state is returned or retained', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const contribution = await store.createContributionAccount(owner, 'Owner Codex')

    const updated = await store.setContributionAccountStatus(
      owner.teamId,
      contribution.id,
      'reauth_required',
      'OAuth failed Authorization: Bearer opaque-provider-token client_secret=provider-client-secret',
    )

    expect(updated.lastError).toContain('[redacted]')
    expect(updated.lastError).not.toMatch(/opaque-provider-token|provider-client-secret/u)
    expect(JSON.stringify(await store.listContributionAccounts(owner)))
      .not.toMatch(/opaque-provider-token|provider-client-secret/u)
  })

  it('rejects a new usage event after a contribution is paused', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const contribution = await store.createContributionAccount(owner, 'Owner Codex')
    await store.setContributionAccountStatus(owner.teamId, contribution.id, 'active')
    await store.setContributionAccountStatus(owner.teamId, contribution.id, 'paused')

    await expect(store.beginUsageEvent(owner, 'late-event', contribution.id, 'gpt-5-codex'))
      .rejects.toThrow(/not active/u)
  })

  it('starts contribution OAuth through a Host-only broker', async () => {
    const broker = new FakeCredentialBroker()
    const service = new TeamService({ store: new MemoryTeamStore(), broker })
    const boot = await service.store.bootstrap('Friends', 'Owner')
    const owner = await service.store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')

    const started = await service.startContributionOAuth(owner, 'Owner Codex')
    expect(started).toMatchObject({
      method: 'device_code',
      verificationUrl: 'https://auth.example.test/codex/device',
      userCode: 'ABCD-EFGH',
      expiresAt: 1_800_000,
    })
    expect(started.account.ownerMemberId).toBe(owner.memberId)
    expect(broker.started).toEqual([{ teamId: owner.teamId, accountId: started.account.id }])

    const cancelled = await service.cancelContributionOAuth(owner, started.account.id)
    expect(cancelled).toMatchObject({ id: started.account.id, status: 'reauth_required' })
    await service.revokeContributionAccount(owner, started.account.id)
    expect(broker.revoked).toEqual([{ teamId: owner.teamId, accountId: started.account.id }])
  })

  it('drains every departing member contribution before deleting broker credentials', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invite = await store.createInvite(owner, 60_000)
    const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
    const member = await store.authenticateApiKey(joined.apiKey)
    if (member === undefined) throw new Error('member key should authenticate')
    const first = await store.createContributionAccount(member, 'Friend Codex')
    const second = await store.createContributionAccount(member, 'Friend Codex backup')
    const events: string[] = []
    const router = new TeamRequestRouter()
    vi.spyOn(router, 'drainAccount').mockImplementation(async (accountId) => { events.push(`drain:${accountId}`) })
    class OrderedBroker extends FakeCredentialBroker {
      override revoke(ref: TeamCredentialRef): Promise<void> {
        events.push(`revoke:${ref.accountId}`)
        return super.revoke(ref)
      }
    }
    const broker = new OrderedBroker()
    const service = new TeamService({ store, broker, router })

    const result = await service.leaveTeam(member)

    expect(result.member.status).toBe('removed')
    expect(events.slice(0, 2)).toEqual(expect.arrayContaining([`drain:${first.id}`, `drain:${second.id}`]))
    expect(events.slice(2)).toEqual(expect.arrayContaining([`revoke:${first.id}`, `revoke:${second.id}`]))
    expect(await store.authenticateApiKey(joined.apiKey)).toBeUndefined()
  })

  it('retries drain and credential deletion for persisted revoked contributions', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const contribution = await store.createContributionAccount(owner, 'Owner Codex')
    await store.revokeContributionAccount(owner, contribution.id)
    const router = new TeamRequestRouter()
    const drain = vi.spyOn(router, 'drainAccount')
    const broker = new FakeCredentialBroker()
    const service = new TeamService({ store, broker, router })

    await service.reconcileContributionAuthorizations()

    expect(drain).toHaveBeenCalledWith(contribution.id)
    expect(broker.revoked).toEqual([{ teamId: owner.teamId, accountId: contribution.id }])
  })

  it('does not overwrite an OAuth success that races with cancellation', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const broker = new FakeCredentialBroker(async ref => {
      await store.setContributionAccountStatus(ref.teamId, ref.accountId, 'active')
    })
    const service = new TeamService({ store, broker })
    const started = await service.startContributionOAuth(owner, 'Owner Codex')

    await expect(service.cancelContributionOAuth(owner, started.account.id))
      .resolves.toMatchObject({ id: started.account.id, status: 'active' })
    await expect(store.listContributionAccounts(owner))
      .resolves.toMatchObject([{ id: started.account.id, status: 'active' }])
  })

  it('reauthorizes an existing contribution in place', async () => {
    const broker = new FakeCredentialBroker()
    const service = new TeamService({ store: new MemoryTeamStore(), broker })
    const boot = await service.store.bootstrap('Friends', 'Owner')
    const owner = await service.store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const contribution = await service.store.createContributionAccount(owner, 'Owner Codex')
    await service.store.setContributionAccountStatus(owner.teamId, contribution.id, 'reauth_required', 'expired')

    const result = await service.reauthorizeContributionOAuth(owner, contribution.id)

    expect(result).toMatchObject({ account: { id: contribution.id, status: 'authorizing' }, method: 'device_code' })
    expect(broker.restarted).toEqual([{ teamId: owner.teamId, accountId: contribution.id }])
    expect(await service.store.listContributionAccounts(owner)).toHaveLength(1)
  })

  it('restores reauth_required when restarting OAuth fails', async () => {
    class FailingRestartBroker extends FakeCredentialBroker {
      override restartOAuth(ref: TeamCredentialRef): ReturnType<TeamCredentialBroker['restartOAuth']> {
        this.restarted.push(ref)
        return Promise.reject(new Error('provider refused Authorization: Bearer opaque-provider-token'))
      }
    }
    const broker = new FailingRestartBroker()
    const service = new TeamService({ store: new MemoryTeamStore(), broker })
    const boot = await service.store.bootstrap('Friends', 'Owner')
    const owner = await service.store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const contribution = await service.store.createContributionAccount(owner, 'Owner Codex')
    await service.store.setContributionAccountStatus(owner.teamId, contribution.id, 'reauth_required')

    await expect(service.reauthorizeContributionOAuth(owner, contribution.id)).rejects.toThrow(/provider refused/iu)
    const persisted = (await service.store.listContributionAccounts(owner))[0]
    expect(persisted).toMatchObject({ id: contribution.id, status: 'reauth_required' })
    expect(persisted?.lastError).toContain('[redacted]')
    expect(persisted?.lastError).not.toContain('opaque-provider-token')
  })

  it('cleans up a restarted credential when revocation wins the race', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    class RevokingRestartBroker extends FakeCredentialBroker {
      override async restartOAuth(ref: TeamCredentialRef): ReturnType<TeamCredentialBroker['restartOAuth']> {
        this.restarted.push(ref)
        await store.revokeContributionAccount(owner, ref.accountId)
        return super.startOAuth(ref)
      }
    }
    const broker = new RevokingRestartBroker()
    const service = new TeamService({ store, broker })
    const contribution = await store.createContributionAccount(owner, 'Owner Codex')
    await store.setContributionAccountStatus(owner.teamId, contribution.id, 'reauth_required')

    await expect(service.reauthorizeContributionOAuth(owner, contribution.id)).rejects.toThrow(/revoked during authorization/iu)
    expect(broker.revoked).toEqual([{ teamId: owner.teamId, accountId: contribution.id }])
    await expect(store.listContributionAccounts(owner)).resolves.toMatchObject([{ id: contribution.id, status: 'revoked' }])
  })

  it('reconciles interrupted contribution authorization from Host credential state', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const contribution = await store.createContributionAccount(owner, 'Owner Codex')
    const broker = new FakeCredentialBroker()
    const service = new TeamService({ store, broker })

    await service.reconcileContributionAuthorizations()

    expect(broker.inspected).toEqual([{ teamId: owner.teamId, accountId: contribution.id }])
    await expect(store.listContributionAccounts(owner))
      .resolves.toMatchObject([{ id: contribution.id, status: 'active' }])
  })
})
