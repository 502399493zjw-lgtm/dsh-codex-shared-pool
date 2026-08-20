import { DataType, newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import {
  POSTGRES_BEGIN_USAGE_TEAM_LOCK_SQL,
  POSTGRES_TEAM_MIGRATIONS,
  PostgresTeamStore,
} from '../src/team/postgres-store.ts'

function testPool(onMigrationLock: () => void = () => undefined): PgPool {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true })
  memory.public.registerFunction({
    name: 'pg_advisory_xact_lock',
    args: [DataType.integer, DataType.integer],
    returns: DataType.integer,
    implementation: () => {
      onMigrationLock()
      return 1
    },
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

describe('PostgreSQL Team store', () => {
  it('skips schema DDL when every migration is already present for a restricted runtime role', async () => {
    const query = vi.fn(async () => ({
      rows: POSTGRES_TEAM_MIGRATIONS.map(migration => ({ version: migration.version })),
    }))
    const connect = vi.fn(async () => { throw new Error('restricted runtime must not enter the migration transaction') })
    const pool = { query, connect, end: vi.fn(async () => undefined) } as unknown as PgPool
    const store = new PostgresTeamStore({ pool })

    await expect(store.initialize()).resolves.toBeUndefined()
    expect(query).toHaveBeenCalledWith(expect.stringMatching(/team_schema_migrations/iu), [
      POSTGRES_TEAM_MIGRATIONS.map(migration => migration.version),
    ])
    expect(connect).not.toHaveBeenCalled()
  })

  it('locks the Team row while deciding whether a new usage event may start', () => {
    expect(POSTGRES_BEGIN_USAGE_TEAM_LOCK_SQL).toMatch(/FOR SHARE/iu)
  })

  it('takes a PostgreSQL transaction lock before applying schema migrations', async () => {
    let locks = 0
    const pool = testPool(() => { locks += 1 })
    await new PostgresTeamStore({ pool }).initialize()
    expect(locks).toBe(1)
    await pool.end()
  })

  it('enforces at most one Team owner with a partial unique index', async () => {
    expect(POSTGRES_TEAM_MIGRATIONS.at(-1)?.sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS team_members_one_owner_idx[\s\S]+WHERE role = 'owner'/iu,
    )
    const pool = testPool()
    const store = new PostgresTeamStore({ pool })
    const boot = await store.bootstrap('Friends', 'Owner')

    await expect(pool.query(`
      INSERT INTO team_members (id, team_id, display_name, role, status, joined_at)
      VALUES ('second-owner', $1, 'Second Owner', 'owner', 'active', 1)
    `, [boot.team.id])).rejects.toThrow()
    await pool.end()
  })

  it('persists Team authorization and secret-free contribution state across store instances', async () => {
    const pool = testPool()
    let id = 0
    let secret = 0
    const options = {
      pool,
      id: () => `id-${++id}`,
      token: () => `secret-${++secret}-with-enough-entropy-for-tests`,
      now: () => 1_000 + id,
    }
    const first = new PostgresTeamStore(options)
    await first.initialize()
    const boot = await first.bootstrap('Friends', 'Owner')
    const owner = await first.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invite = await first.createInvite(owner, 60_000)
    const joined = await first.acceptInvite(invite.inviteToken, 'Friend')
    const member = await first.authenticateApiKey(joined.apiKey)
    if (member === undefined) throw new Error('member key should authenticate')
    const contribution = await first.createContributionAccount(member, 'Friend Codex')
    const active = await first.setContributionAccountStatus(owner.teamId, contribution.id, 'active')
    const event = await first.beginUsageEvent(member, 'lease-1', active.id, 'gpt-5-codex')
    await first.settleUsageEvent(owner.teamId, event.id, 'succeeded')

    const second = new PostgresTeamStore(options)
    await second.initialize()
    const restored = await second.authenticateApiKey(joined.apiKey)
    if (restored === undefined) throw new Error('persisted key should authenticate')
    const overview = await second.overview(restored)
    expect(overview.team.name).toBe('Friends')
    expect(overview.currentMember.displayName).toBe('Friend')
    expect(overview.contributions).toEqual([active])
    expect(await second.listUsageEvents(restored, 10)).toMatchObject([{
      id: 'lease-1',
      consumerMemberId: member.memberId,
      upstreamOwnerMemberId: member.memberId,
      upstreamAccountId: contribution.id,
      status: 'succeeded',
    }])

    const rows = await pool.query<{ token_hash: string }>('select token_hash from team_api_keys order by created_at')
    expect(rows.rows).toHaveLength(2)
    expect(JSON.stringify(rows.rows)).not.toContain(boot.apiKey)
    expect(JSON.stringify(rows.rows)).not.toContain(joined.apiKey)
    await pool.end()
  })

  it('atomically persists member departure across all keys and contributions', async () => {
    const pool = testPool()
    const store = new PostgresTeamStore({ pool })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invite = await store.createInvite(owner, 60_000)
    const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
    const member = await store.authenticateApiKey(joined.apiKey)
    if (member === undefined) throw new Error('member key should authenticate')
    const secondKey = await store.issueApiKey(member, 'laptop')
    const contribution = await store.createContributionAccount(member, 'Friend Codex')

    const result = await store.leaveTeam(member)

    expect(result).toMatchObject({
      member: { id: member.memberId, status: 'removed' },
      contributions: [{ id: contribution.id, status: 'revoked' }],
    })
    expect(await store.authenticateApiKey(joined.apiKey)).toBeUndefined()
    expect(await store.authenticateApiKey(secondKey.token)).toBeUndefined()
    const persistedMember = await pool.query<{ status: string }>('select status from team_members where id = $1', [member.memberId])
    const persistedKeys = await pool.query<{ revoked_at: string | number | null }>(
      'select revoked_at from team_api_keys where member_id = $1 order by created_at, id',
      [member.memberId],
    )
    const persistedContribution = await pool.query<{ status: string }>(
      'select status from team_contributions where id = $1',
      [contribution.id],
    )
    expect(persistedMember.rows).toEqual([{ status: 'removed' }])
    expect(persistedKeys.rows).toHaveLength(2)
    expect(persistedKeys.rows.every(key => key.revoked_at !== null)).toBe(true)
    expect(persistedContribution.rows).toEqual([{ status: 'revoked' }])
    await pool.end()
  })

  it('atomically persists an ownership transfer and keeps existing keys and contributions', async () => {
    const pool = testPool()
    const store = new PostgresTeamStore({ pool })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invite = await store.createInvite(owner, 60_000)
    const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
    const member = await store.authenticateApiKey(joined.apiKey)
    if (member === undefined) throw new Error('member key should authenticate')
    const contribution = await store.createContributionAccount(owner, 'Owner Codex')

    await expect(store.transferOwnership(owner, member.memberId)).resolves.toEqual({
      formerOwner: expect.objectContaining({ id: owner.memberId, role: 'admin' }),
      owner: expect.objectContaining({ id: member.memberId, role: 'owner' }),
    })

    await expect(store.overview(owner)).rejects.toThrow(/role is stale/iu)
    const formerOwner = await store.authenticateApiKey(boot.apiKey)
    const currentOwner = await store.authenticateApiKey(joined.apiKey)
    if (formerOwner === undefined || currentOwner === undefined) throw new Error('existing keys should remain active')
    expect(formerOwner.role).toBe('admin')
    expect(currentOwner.role).toBe('owner')
    const roles = await pool.query<{ id: string; role: string }>(
      'select id, role from team_members where team_id = $1 order by id',
      [owner.teamId],
    )
    expect(roles.rows.filter(row => row.role === 'owner')).toEqual([{ id: member.memberId, role: 'owner' }])
    const persistedContribution = await pool.query<{ owner_member_id: string }>(
      'select owner_member_id from team_contributions where id = $1',
      [contribution.id],
    )
    expect(persistedContribution.rows).toEqual([{ owner_member_id: owner.memberId }])
    await expect(store.leaveTeam(formerOwner)).resolves.toMatchObject({ member: { status: 'removed' } })
    await pool.end()
  })

  it('rejects ownership transfer to a member without a live Team key', async () => {
    const pool = testPool()
    const store = new PostgresTeamStore({ pool })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invite = await store.createInvite(owner, 60_000)
    const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
    const member = await store.authenticateApiKey(joined.apiKey)
    if (member === undefined) throw new Error('member key should authenticate')
    await store.revokeApiKey(owner, member.keyId)

    await expect(store.transferOwnership(owner, member.memberId)).rejects.toThrow(/active Team API key/iu)
    const roles = await pool.query<{ id: string; role: string }>(
      'select id, role from team_members where team_id = $1 order by id',
      [owner.teamId],
    )
    expect(roles.rows).toEqual(expect.arrayContaining([
      { id: owner.memberId, role: 'owner' },
      { id: member.memberId, role: 'member' },
    ]))
    await pool.end()
  })

  it('rejects owner departure without persisting any change', async () => {
    const pool = testPool()
    const store = new PostgresTeamStore({ pool })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')

    await expect(store.leaveTeam(owner)).rejects.toThrow(/owner.*cannot leave/iu)

    expect(await store.authenticateApiKey(boot.apiKey)).toEqual(owner)
    const persisted = await pool.query<{ status: string }>('select status from team_members where id = $1', [owner.memberId])
    expect(persisted.rows).toEqual([{ status: 'active' }])
    await pool.end()
  })

  it('keeps one-time invites and tenant data isolated', async () => {
    const pool = testPool()
    const store = new PostgresTeamStore({ pool })
    const first = await store.bootstrap('First', 'Alice')
    const second = await store.bootstrap('Second', 'Bob')
    const firstAuth = await store.authenticateApiKey(first.apiKey)
    const secondAuth = await store.authenticateApiKey(second.apiKey)
    if (firstAuth === undefined || secondAuth === undefined) throw new Error('keys should authenticate')
    const invite = await store.createInvite(firstAuth, 60_000)
    await store.acceptInvite(invite.inviteToken, 'Friend')
    await expect(store.acceptInvite(invite.inviteToken, 'Second Friend')).rejects.toThrow(/invalid or expired/u)

    const contribution = await store.createContributionAccount(firstAuth, 'Alice Codex')
    await expect(store.updateContributionAccount(secondAuth, contribution.id, { status: 'paused' }))
      .rejects.toThrow(/not found/u)
    expect((await store.overview(secondAuth)).contributions).toEqual([])
    await pool.end()
  })

  it('durably revokes an unused invite and destroys its live token hash', async () => {
    const pool = testPool()
    const store = new PostgresTeamStore({ pool })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const pending = await store.createInvite(owner, 60_000)
    const before = await pool.query<{ token_hash: string }>('select token_hash from team_invites where id = $1', [pending.invite.id])

    await expect(store.revokeInvite(owner, pending.invite.id)).resolves.toMatchObject({ status: 'revoked' })
    await expect(store.revokeInvite(owner, pending.invite.id)).resolves.toMatchObject({ status: 'revoked' })
    await expect(store.acceptInvite(pending.inviteToken, 'Outsider')).rejects.toThrow(/invalid or expired/u)
    const after = await pool.query<{ status: string; token_hash: string }>(
      'select status, token_hash from team_invites where id = $1',
      [pending.invite.id],
    )
    expect(after.rows).toEqual([{ status: 'revoked', token_hash: expect.any(String) }])
    expect(after.rows[0]?.token_hash).not.toBe(before.rows[0]?.token_hash)
    expect((await store.overview(owner)).invites).not.toContainEqual(expect.objectContaining({ id: pending.invite.id }))
    await pool.end()
  })

  it('rejects a new usage event after a contribution is paused', async () => {
    const pool = testPool()
    const store = new PostgresTeamStore({ pool })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const contribution = await store.createContributionAccount(owner, 'Owner Codex')
    await store.setContributionAccountStatus(owner.teamId, contribution.id, 'active')
    await store.setContributionAccountStatus(owner.teamId, contribution.id, 'paused')

    await expect(store.beginUsageEvent(owner, 'late-event', contribution.id, 'gpt-5-codex'))
      .rejects.toThrow(/not active/u)
    await pool.end()
  })

  it('keeps revoked contributions terminal when a late OAuth callback arrives', async () => {
    const pool = testPool()
    const store = new PostgresTeamStore({ pool })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const contribution = await store.createContributionAccount(owner, 'Owner Codex')

    await expect(store.updateContributionAccount(owner, contribution.id, { status: 'active' }))
      .rejects.toThrow(/authorization status cannot be changed manually/iu)
    await store.revokeContributionAccount(owner, contribution.id)
    await expect(store.setContributionAccountStatus(owner.teamId, contribution.id, 'active'))
      .resolves.toMatchObject({ status: 'revoked' })
    await expect(store.listContributionAccountsByStatus('revoked'))
      .resolves.toMatchObject([{ id: contribution.id, status: 'revoked' }])
    await pool.end()
  })

  it('atomically begins owner-only contribution reauthorization', async () => {
    const pool = testPool()
    const store = new PostgresTeamStore({ pool })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invite = await store.createInvite(owner, 60_000)
    const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
    const member = await store.authenticateApiKey(joined.apiKey)
    if (member === undefined) throw new Error('member key should authenticate')
    const contribution = await store.createContributionAccount(member, 'Friend Codex')
    await store.setContributionAccountStatus(member.teamId, contribution.id, 'reauth_required', 'expired')

    await expect(store.beginContributionReauthorization(owner, contribution.id))
      .rejects.toThrow(/owner of the contribution account/iu)
    await expect(store.beginContributionReauthorization(member, contribution.id))
      .resolves.toMatchObject({ id: contribution.id, status: 'authorizing' })
    const persisted = await pool.query<{ status: string; last_error: string | null }>(
      'select status, last_error from team_contributions where id = $1',
      [contribution.id],
    )
    expect(persisted.rows[0]).toEqual({ status: 'authorizing', last_error: null })
    await expect(store.beginContributionReauthorization(member, contribution.id))
      .rejects.toThrow(/reauthorization/iu)
    await pool.end()
  })

  it('redacts diagnostics before writing contribution state to PostgreSQL', async () => {
    const pool = testPool()
    const store = new PostgresTeamStore({ pool })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const contribution = await store.createContributionAccount(owner, 'Owner Codex')

    await store.setContributionAccountStatus(
      owner.teamId,
      contribution.id,
      'reauth_required',
      'OAuth failed Authorization: Bearer opaque-provider-token client_secret=provider-client-secret',
    )
    const persisted = await pool.query<{ last_error: string }>(
      'select last_error from team_contributions where id = $1',
      [contribution.id],
    )

    expect(persisted.rows[0]?.last_error).toContain('[redacted]')
    expect(persisted.rows[0]?.last_error).not.toMatch(/opaque-provider-token|provider-client-secret/u)
    await pool.end()
  })

  it('keeps control-plane authentication available while paused but rejects new usage', async () => {
    const pool = testPool()
    const store = new PostgresTeamStore({ pool })
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
    await pool.end()
  })
})
