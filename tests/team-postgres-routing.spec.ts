import { DataType, newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'
import { describe, expect, it } from 'vitest'
import { TeamInviteCipher } from '../src/team/invite-cipher.ts'
import { Aes256GcmTeamInviteKeyEncryptionProvider } from '../src/team/invite-key-encryption.ts'
import { PostgresTeamRequestRouter } from '../src/team/postgres-routing.ts'
import {
  POSTGRES_TEAM_MIGRATION_12_LOCK_SQL,
  POSTGRES_TEAM_MIGRATION_20_LOCK_SQL,
  PostgresTeamStore,
} from '../src/team/postgres-store.ts'
import { TeamRouteCapacityError } from '../src/team/routing.ts'

function testPool(): PgPool {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true })
  memory.public.interceptQueries((query) => {
    const normalized = query.trim()
    return normalized === POSTGRES_TEAM_MIGRATION_12_LOCK_SQL
      || normalized === POSTGRES_TEAM_MIGRATION_20_LOCK_SQL
      ? []
      : null
  })
  memory.public.registerFunction({
    name: 'pg_advisory_xact_lock',
    args: [DataType.integer, DataType.integer],
    returns: DataType.integer,
    implementation: () => 1,
  })
  memory.public.registerFunction({
    name: 'char_length',
    args: [DataType.text],
    returns: DataType.integer,
    implementation: (value: string) => value.length,
  })
  const adapter = memory.adapters.createPg()
  return new adapter.Pool() as unknown as PgPool
}

function testStore(pool: PgPool): PostgresTeamStore {
  return new PostgresTeamStore({
    pool,
    inviteCipher: new TeamInviteCipher({
      keyEncryptionProvider: new Aes256GcmTeamInviteKeyEncryptionProvider(Buffer.alloc(32, 0x5a)),
    }),
  })
}

describe('PostgreSQL Team request routing', () => {
  it('shares concurrency and reset-window request caps across router instances', async () => {
    const pool = testPool()
    const store = testStore(pool)
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner should authenticate')
    const invite = await store.createInvite(owner, 60_000)
    const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
    const friend = await store.authenticateApiKey(joined.apiKey)
    if (friend === undefined) throw new Error('friend should authenticate')
    const created = await store.createContributionAccount(owner, 'Owner Codex')
    const configured = await store.updateContributionAccount(owner, created.id, {
      maxSharedConcurrency: 1,
      maxSharedRequestsPerWindow: 1,
    })
    const account = await store.setContributionAccountStatus(owner.teamId, configured.id, 'active')

    let leaseId = 0
    const options = { pool, now: () => 1_000, id: () => `lease-${++leaseId}`, leaseTtlMs: 60_000 }
    const firstHost = new PostgresTeamRequestRouter(options)
    const secondHost = new PostgresTeamRequestRouter(options)
    const request = {
      teamId: owner.teamId,
      teamStatus: 'active' as const,
      consumerMemberId: friend.memberId,
      sessionId: 'session-1',
      model: 'gpt-5-codex',
      candidates: [{ account, quota: { healthy: true, remainingPercent: 80, resetAt: 10_000 } }],
    }

    const admitted = await firstHost.route(request)
    await expect(secondHost.inspectAccount(owner.teamId, account.id, 10_000)).resolves.toEqual({
      sharedInFlight: 1,
      sharedRequestsUsed: 1,
    })
    await expect(secondHost.route({ ...request, sessionId: 'session-2' })).rejects.toMatchObject({ reasons: expect.arrayContaining(['shared_concurrency_reached']) })
    await firstHost.settle(admitted.lease, 'success')
    await expect(secondHost.inspectAccount(owner.teamId, account.id, 10_000)).resolves.toEqual({
      sharedInFlight: 0,
      sharedRequestsUsed: 1,
    })
    await expect(secondHost.route({ ...request, sessionId: 'session-3' })).rejects.toMatchObject({ reasons: expect.arrayContaining(['request_cap_reached']) })
    await pool.end()
  })

  it('persists session affinity across routers and excludes own use from shared concurrency', async () => {
    const pool = testPool()
    const store = testStore(pool)
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner should authenticate')
    const invite = await store.createInvite(owner, 60_000)
    const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
    const friend = await store.authenticateApiKey(joined.apiKey)
    if (friend === undefined) throw new Error('friend should authenticate')
    const firstCreated = await store.createContributionAccount(owner, 'First Codex')
    const secondCreated = await store.createContributionAccount(owner, 'Second Codex')
    const first = await store.setContributionAccountStatus(owner.teamId, firstCreated.id, 'active')
    const second = await store.setContributionAccountStatus(owner.teamId, secondCreated.id, 'active')

    let leaseId = 0
    const options = { pool, now: () => 2_000, id: () => `lease-${++leaseId}`, leaseTtlMs: 60_000, drainPollMs: 1 }
    const firstHost = new PostgresTeamRequestRouter(options)
    const secondHost = new PostgresTeamRequestRouter(options)
    const candidates = [
      { account: first, quota: { healthy: true, remainingPercent: 90, resetAt: 10_000 } },
      { account: second, quota: { healthy: true, remainingPercent: 80, resetAt: 10_000 } },
    ]
    const selected = await firstHost.route({
      teamId: owner.teamId,
      teamStatus: 'active',
      consumerMemberId: friend.memberId,
      sessionId: 'sticky-session',
      model: 'gpt-5-codex',
      candidates,
    })
    expect(selected.account.id).toBe(first.id)
    await firstHost.settle(selected.lease, 'success')

    const sticky = await secondHost.route({
      teamId: owner.teamId,
      teamStatus: 'active',
      consumerMemberId: friend.memberId,
      sessionId: 'sticky-session',
      model: 'gpt-5-codex',
      candidates: [
        { account: first, quota: { healthy: true, remainingPercent: 50, resetAt: 10_000 } },
        { account: second, quota: { healthy: true, remainingPercent: 100, resetAt: 10_000 } },
      ],
    })
    expect(sticky.account.id).toBe(first.id)
    expect(sticky.source).toBe('session')

    const own = await secondHost.route({
      teamId: owner.teamId,
      teamStatus: 'active',
      consumerMemberId: owner.memberId,
      sessionId: 'owner-session',
      model: 'gpt-5-codex',
      candidates: [{ account: first, quota: { healthy: true, remainingPercent: 80, resetAt: 10_000 } }],
    })
    await expect(firstHost.route({
      teamId: owner.teamId,
      teamStatus: 'active',
      consumerMemberId: friend.memberId,
      sessionId: 'another-friend-session',
      model: 'gpt-5-codex',
      candidates: [{ account: first, quota: { healthy: true, remainingPercent: 80, resetAt: 10_000 } }],
    })).rejects.toBeInstanceOf(TeamRouteCapacityError)

    let drained = false
    const draining = firstHost.drainAccount(first.id).then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    await secondHost.settle(sticky.lease, 'success')
    await secondHost.settle(own.lease, 'success')
    await draining
    expect(drained).toBe(true)
    await pool.end()
  })

  it('isolates identical session ids between different Team members', async () => {
    const pool = testPool()
    try {
      const store = testStore(pool)
      const boot = await store.bootstrap('Friends', 'Owner')
      const owner = await store.authenticateApiKey(boot.apiKey)
      if (owner === undefined) throw new Error('owner should authenticate')
      const invite = await store.createInvite(owner, 60_000)
      const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
      const friend = await store.authenticateApiKey(joined.apiKey)
      if (friend === undefined) throw new Error('friend should authenticate')
      const ownerCreated = await store.createContributionAccount(owner, 'Owner Codex')
      const friendCreated = await store.createContributionAccount(friend, 'Friend Codex')
      const ownerAccount = await store.setContributionAccountStatus(owner.teamId, ownerCreated.id, 'active')
      const friendAccount = await store.setContributionAccountStatus(owner.teamId, friendCreated.id, 'active')
      const router = new PostgresTeamRequestRouter({ pool })
      const candidates = [
        { account: ownerAccount, quota: { healthy: true, remainingPercent: 80, resetAt: 10_000 } },
        { account: friendAccount, quota: { healthy: true, remainingPercent: 80, resetAt: 10_000 } },
      ]

      const first = await router.route({
        teamId: owner.teamId,
        teamStatus: 'active',
        consumerMemberId: owner.memberId,
        sessionId: 'same-client-session',
        model: 'gpt-5-codex',
        candidates,
      })
      await router.settle(first.lease, 'success')
      const second = await router.route({
        teamId: owner.teamId,
        teamStatus: 'active',
        consumerMemberId: friend.memberId,
        sessionId: 'same-client-session',
        model: 'gpt-5-codex',
        candidates,
      })

      expect(first.account.id).toBe(ownerAccount.id)
      expect(second.account.id).toBe(friendAccount.id)
      expect(second.source).toBe('own')
      await router.settle(second.lease, 'success')
    } finally {
      await pool.end()
    }
  })

  it('unbinds only the failed member session before selecting a replacement account', async () => {
    const pool = testPool()
    try {
      const store = testStore(pool)
      const boot = await store.bootstrap('Friends', 'Owner')
      const owner = await store.authenticateApiKey(boot.apiKey)
      if (owner === undefined) throw new Error('owner should authenticate')
      const invite = await store.createInvite(owner, 60_000)
      const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
      const friend = await store.authenticateApiKey(joined.apiKey)
      if (friend === undefined) throw new Error('friend should authenticate')
      const firstCreated = await store.createContributionAccount(owner, 'First Codex')
      const secondCreated = await store.createContributionAccount(owner, 'Second Codex')
      const firstAccount = await store.setContributionAccountStatus(owner.teamId, firstCreated.id, 'active')
      const secondAccount = await store.setContributionAccountStatus(owner.teamId, secondCreated.id, 'active')
      const router = new PostgresTeamRequestRouter({ pool })
      const request = {
        teamId: owner.teamId,
        teamStatus: 'active' as const,
        consumerMemberId: friend.memberId,
        sessionId: 'failed-session',
        model: 'gpt-5-codex',
      }

      const first = await router.route({
        ...request,
        candidates: [
          { account: firstAccount, quota: { healthy: true, remainingPercent: 90, resetAt: 10_000 } },
          { account: secondAccount, quota: { healthy: true, remainingPercent: 80, resetAt: 10_000 } },
        ],
      })
      await router.settle(first.lease, 'error')
      await router.unbindSession(owner.teamId, friend.memberId, request.sessionId, firstAccount.id)
      const replacement = await router.route({
        ...request,
        candidates: [
          { account: firstAccount, quota: { healthy: true, remainingPercent: 50, resetAt: 10_000 } },
          { account: secondAccount, quota: { healthy: true, remainingPercent: 80, resetAt: 10_000 } },
        ],
      })

      expect(first.account.id).toBe(firstAccount.id)
      expect(replacement.account.id).toBe(secondAccount.id)
      expect(replacement.source).toBe('shared')
      await router.settle(replacement.lease, 'success')
    } finally {
      await pool.end()
    }
  })
})
