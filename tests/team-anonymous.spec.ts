import { createHash } from 'node:crypto'
import { DataType, newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'
import { describe, expect, it } from 'vitest'
import { MemoryTeamStore, type TeamStore } from '../src/team/store.ts'
import { PostgresTeamStore, POSTGRES_TEAM_MIGRATION_12_LOCK_SQL, POSTGRES_TEAM_MIGRATION_20_LOCK_SQL } from '../src/team/postgres-store.ts'
import { TeamInviteCipher } from '../src/team/invite-cipher.ts'
import { Aes256GcmTeamInviteKeyEncryptionProvider } from '../src/team/invite-key-encryption.ts'

function testPool(
  onMigrationLock: () => void = () => undefined,
  databaseNow: () => number = () => 180_000,
): PgPool {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true })
  // pg-mem does not implement PostgreSQL LOCK TABLE. Only that exact statement
  // is intercepted; migration 12 preflight and mutations still execute.
  memory.public.interceptQueries(query => (
    query.trim() === POSTGRES_TEAM_MIGRATION_12_LOCK_SQL
      || query.trim() === POSTGRES_TEAM_MIGRATION_20_LOCK_SQL
  ) ? [] : null)
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
  memory.public.registerFunction({
    name: 'clock_timestamp',
    returns: DataType.timestamptz,
    impure: true,
    implementation: () => new Date(databaseNow()),
  })
  memory.public.registerFunction({
    name: 'floor',
    args: [DataType.float],
    returns: DataType.float,
    implementation: Math.floor,
  })
  const adapter = memory.adapters.createPg()
  return new adapter.Pool() as unknown as PgPool
}


const input = {
  creationToken: `dsh_create_${'a'.repeat(43)}`,
  teamName: 'New Team',
  ownerName: 'Creator',
  apiKey: `dsh_team_${'b'.repeat(43)}`,
  recoveryCode: `dsh_recovery_${'c'.repeat(43)}`,
}
const recoveredKey = `dsh_team_${'d'.repeat(43)}`

for (const backend of ['memory', 'postgres'] as const) {
  describe(`anonymous Team creation (${backend})`, () => {
    async function fixture() {
      let now = 1000
      const pool = backend === 'postgres' ? testPool(undefined, () => now) : undefined
      const store: TeamStore = pool === undefined ? new MemoryTeamStore({ now: () => now }) : new PostgresTeamStore({ pool, now: () => now,
        inviteCipher: new TeamInviteCipher({ keyEncryptionProvider: new Aes256GcmTeamInviteKeyEncryptionProvider(Buffer.alloc(32, 0x5a)) }),
      })
      return { store, pool, advance: (ms: number) => { now += ms } }
    }

    it('creates an owner without bootstrap and identical retries preserve one identity', async () => {
      const { store, pool } = await fixture()
      const created = await store.createAnonymousTeam(input)
      const retried = await store.createAnonymousTeam({ ...input, teamName: ' New Team ' })
      expect(retried).toEqual(created)
      expect(created.member).toMatchObject({ role: 'owner', status: 'active', displayName: 'Creator' })
      expect(await store.authenticateApiKey(input.apiKey)).toMatchObject({ teamId: created.team.id, memberId: created.member.id, role: 'owner' })
      expect(JSON.stringify(created)).not.toMatch(/dsh_(team|recovery|create)_/)
      if (pool !== undefined) {
        expect((await pool.query('SELECT * FROM team_anonymous_creations')).rows).toHaveLength(1)
        expect(JSON.stringify((await pool.query('SELECT * FROM team_anonymous_creations')).rows)).not.toContain(input.recoveryCode)
        const restarted = new PostgresTeamStore({ pool, inviteCipher: new TeamInviteCipher({ keyEncryptionProvider: new Aes256GcmTeamInviteKeyEncryptionProvider(Buffer.alloc(32, 0x5a)) }) })
        expect(await restarted.createAnonymousTeam(input)).toEqual(created)
      }
    })

    it('rejects idempotency-token rebinding and credential collisions without orphan Teams', async () => {
      const { store, pool } = await fixture()
      await store.createAnonymousTeam(input)
      for (const patch of [{ teamName: 'Other' }, { ownerName: 'Other' }, { recoveryCode: `dsh_recovery_${'e'.repeat(43)}` }, { apiKey: recoveredKey }]) {
        await expect(store.createAnonymousTeam({ ...input, ...patch })).rejects.toThrow(/creation request conflicts/)
      }
      await expect(store.createAnonymousTeam({ ...input, creationToken: `dsh_create_${'f'.repeat(43)}` })).rejects.toThrow()
      if (pool !== undefined) expect((await pool.query('SELECT * FROM teams')).rows).toHaveLength(1)
    })

    it('recovers only the original current owner, with idempotent supplied-key retry', async () => {
      const { store } = await fixture()
      const created = await store.createAnonymousTeam(input)
      expect(await store.recoverAnonymousTeamOwner(input.recoveryCode, recoveredKey)).toEqual(created)
      expect(await store.recoverAnonymousTeamOwner(input.recoveryCode, recoveredKey)).toEqual(created)
      const owner = (await store.authenticateApiKey(recoveredKey))!
      const invite = await store.createInvite(owner, 60000)
      const joined = await store.acceptInvite(invite.inviteToken, 'Next owner')
      const nextOwner = (await store.authenticateApiKey(joined.apiKey))!
      const transfer = await store.requestOwnershipTransfer(owner, nextOwner.memberId)
      await store.acceptOwnershipTransfer(nextOwner, transfer.id)
      await expect(store.recoverAnonymousTeamOwner(input.recoveryCode, `dsh_team_${'z'.repeat(43)}`)).rejects.toThrow('Team owner recovery is unavailable')
      await expect(store.createAnonymousTeam(input)).rejects.toThrow('Team owner recovery is unavailable')
      const currentNextOwner = (await store.authenticateApiKey(joined.apiKey))!
      const transferBack = await store.requestOwnershipTransfer(currentNextOwner, owner.memberId)
      await store.acceptOwnershipTransfer((await store.authenticateApiKey(recoveredKey))!, transferBack.id)
      await expect(store.recoverAnonymousTeamOwner(input.recoveryCode, `dsh_team_${'z'.repeat(43)}`)).rejects.toThrow('Team owner recovery is unavailable')
    })

    it('does not revive revoked keys or dissolved Teams through retry or recovery', async () => {
      const { store } = await fixture()
      await store.createAnonymousTeam(input)
      const original = (await store.authenticateApiKey(input.apiKey))!
      await store.recoverAnonymousTeamOwner(input.recoveryCode, recoveredKey)
      const recovered = (await store.authenticateApiKey(recoveredKey))!
      await store.revokeApiKey(recovered, original.keyId)
      await expect(store.createAnonymousTeam(input)).rejects.toThrow('Team owner recovery is unavailable')
      await store.dissolveTeam(recovered, { operationId: '20000000-0000-4000-8000-000000000001', expectedLifecycleRevision: 1, confirmationName: input.teamName, recoverySecretHash: createHash('sha256').update('test-only').digest('hex') })
      await expect(store.recoverAnonymousTeamOwner(input.recoveryCode, `dsh_team_${'z'.repeat(43)}`)).rejects.toThrow('Team owner recovery is unavailable')
    })

    it('rejects malformed and unknown secrets uniformly', async () => {
      const { store } = await fixture()
      await expect(store.createAnonymousTeam({ ...input, creationToken: 'short' })).rejects.toThrow()
      await expect(store.recoverAnonymousTeamOwner(input.recoveryCode, recoveredKey)).rejects.toThrow('Team owner recovery is unavailable')
    })

    it('rate limits anonymous requests globally with separate persistent action budgets', async () => {
      const { store, pool, advance } = await fixture()
      for (let i = 0; i < 30; i++) await store.consumeAnonymousTeamAttempt('create')
      await expect(store.consumeAnonymousTeamAttempt('create')).rejects.toMatchObject({ retryAfterSeconds: expect.any(Number) })
      await store.consumeAnonymousTeamAttempt('recover-owner')
      if (pool !== undefined) {
        const restarted = new PostgresTeamStore({ pool, now: () => 1000, inviteCipher: new TeamInviteCipher({ keyEncryptionProvider: new Aes256GcmTeamInviteKeyEncryptionProvider(Buffer.alloc(32, 0x5a)) }) })
        await expect(restarted.consumeAnonymousTeamAttempt('create')).rejects.toThrow(/rate limit/)
      }
      advance(3600000)
      await expect(store.consumeAnonymousTeamAttempt('create')).resolves.toBeUndefined()
    })
  })
}
