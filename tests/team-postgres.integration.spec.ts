import { createHash, randomInt, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { TeamInviteCipher } from '../src/team/invite-cipher.ts'
import { Aes256GcmTeamInviteKeyEncryptionProvider } from '../src/team/invite-key-encryption.ts'
import { fallbackTeamMemberDisplayName } from '../src/team/member-display-name.ts'
import { POSTGRES_TEAM_RUNTIME_ROLES_SQL } from '../src/team/postgres-roles.ts'
import { POSTGRES_TEAM_MIGRATIONS, PostgresTeamStore } from '../src/team/postgres-store.ts'
import {
  TEAM_DISSOLUTION_RECOVERY_RATE_LIMIT_MAX_ATTEMPTS,
  TEAM_DISSOLUTION_RECOVERY_RATE_LIMIT_WINDOW_MS,
  TEAM_INVITE_REVEAL_RATE_LIMIT_MAX_ATTEMPTS,
  TEAM_INVITE_REVEAL_RATE_LIMIT_WINDOW_MS,
  TeamDissolutionRecoveryRateLimitError,
  TeamInviteRevealRateLimitError,
} from '../src/team/store.ts'
import { PostgresTeamTrafficGuard, TeamTrafficGuardError } from '../src/team/traffic-guard.ts'
import {
  Aes256GcmTeamKeyEncryptionProvider,
  POSTGRES_CREDENTIAL_MUTATION_LOCK_SQL,
  PostgresTeamEnvelopeCredentialBackend,
} from '../src/team/envelope-credentials.ts'
import type { TeamKeyEncryptionProvider } from '../src/team/envelope-credentials.ts'
import { OPENAI_CODEX_PROVIDER } from '../src/store.ts'

const databaseUrl = cleanDatabaseUrl(process.env.DSH_TEAM_POSTGRES_TEST_URL)
const describePostgres = databaseUrl === undefined ? describe.skip : describe

function testInviteCipher(): TeamInviteCipher {
  return new TeamInviteCipher({
    keyEncryptionProvider: new Aes256GcmTeamInviteKeyEncryptionProvider(Buffer.alloc(32, 0x5a)),
  })
}

function testStore(options: ConstructorParameters<typeof PostgresTeamStore>[0]): PostgresTeamStore {
  return new PostgresTeamStore({ ...options, inviteCipher: options.inviteCipher ?? testInviteCipher() })
}

type TestPostgresTeamAuthContext = NonNullable<Awaited<ReturnType<PostgresTeamStore['authenticateApiKey']>>>

interface TestPostgresTeamDissolutionInput {
  readonly operationId: string
  readonly expectedLifecycleRevision: number
  readonly confirmationName: string
  readonly recoverySecretHash: string
}

interface TestPostgresTeamDissolutionResult {
  readonly operationId: string
  readonly teamId: string
  readonly teamName: string
  readonly status: 'dissolved'
  readonly lifecycleRevision: number
  readonly dissolvedAt: number
  readonly terminatedMemberCount: number
  readonly revokedInviteCount: number
  readonly revokedKeyCount: number
  readonly revokedContributionCount: number
}

interface TestPostgresTeamLifecycleStore {
  setTeamStatus(
    auth: TestPostgresTeamAuthContext,
    input: {
      readonly operationId: string
      readonly expectedLifecycleRevision: number
      readonly status: 'active' | 'paused'
    },
  ): Promise<{ readonly status: 'active' | 'paused'; readonly lifecycleRevision: number }>
  dissolveTeam(
    auth: TestPostgresTeamAuthContext,
    input: TestPostgresTeamDissolutionInput,
  ): Promise<TestPostgresTeamDissolutionResult>
  diagnoseApiKey(token: string): Promise<{
    readonly code: 'member_removed' | 'member_left' | 'team_dissolved' | 'device_revoked'
  } | undefined>
}

const TEST_ONLY_RECOVERY_SECRET = 'test-only-postgres-integration-recovery-secret-000000000000000000000000000000000000000000000000'
const TEST_ONLY_RECOVERY_SECRET_HASH = createHash('sha256').update(TEST_ONLY_RECOVERY_SECRET).digest('hex')

function lifecycleStore(store: PostgresTeamStore): TestPostgresTeamLifecycleStore {
  return store as unknown as TestPostgresTeamLifecycleStore
}

describePostgres('real PostgreSQL Team concurrency', () => {
  it('serializes anonymous creation and recovery across replicas without storing recovery secrets', async () => {
    const schema = `dsh_team_it_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: requiredDatabaseUrl() })
    const pool = new Pool({ connectionString: requiredDatabaseUrl(), options: `-c search_path=${schema},public`, max: 8 })
    try {
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`)
      const first = testStore({ pool })
      await first.initialize()
      const second = testStore({ pool })
      const input = { creationToken: `dsh_create_${'a'.repeat(43)}`, teamName: 'Anonymous Team', ownerName: 'Owner', apiKey: `dsh_team_${'b'.repeat(43)}`, recoveryCode: `dsh_recovery_${'c'.repeat(43)}` }
      const created = await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 === 0 ? first : second).createAnonymousTeam(input)))
      expect(created.every(result => result.team.id === created[0]!.team.id && result.member.id === created[0]!.member.id)).toBe(true)
      expect((await pool.query('SELECT id FROM teams')).rows).toHaveLength(1)
      const newKey = `dsh_team_${'d'.repeat(43)}`
      await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 === 0 ? first : second).recoverAnonymousTeamOwner(input.recoveryCode, newKey)))
      expect((await pool.query('SELECT id FROM team_api_keys')).rows).toHaveLength(2)
      expect(await second.authenticateApiKey(newKey)).toMatchObject({ role: 'owner', teamId: created[0]!.team.id })
      const persisted = JSON.stringify((await pool.query('SELECT * FROM team_anonymous_creations')).rows)
      for (const secret of [input.creationToken, input.apiKey, input.recoveryCode, newKey]) expect(persisted).not.toContain(secret)
      await expect(second.createAnonymousTeam({ ...input, creationToken: `dsh_create_${'e'.repeat(43)}`, recoveryCode: `dsh_recovery_${'f'.repeat(43)}` })).rejects.toThrow()
      expect((await pool.query('SELECT id FROM teams')).rows).toHaveLength(1)
    } finally {
      await pool.end()
      await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`)
      await admin.end()
    }
  })

  it('shares anonymous request budgets across concurrent stores and restarts', async () => {
    const schema = `dsh_team_it_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: requiredDatabaseUrl() })
    const pool = new Pool({ connectionString: requiredDatabaseUrl(), options: `-c search_path=${schema},public`, max: 8 })
    try {
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`)
      const first = testStore({ pool })
      await first.initialize()
      const second = testStore({ pool })
      const attempts = await Promise.allSettled(Array.from({ length: 40 }, (_, index) => (index % 2 === 0 ? first : second).consumeAnonymousTeamAttempt('create')))
      expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(30)
      expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(10)
      await expect(testStore({ pool }).consumeAnonymousTeamAttempt('create')).rejects.toThrow(/rate limit/)
      await expect(second.consumeAnonymousTeamAttempt('recover-owner')).resolves.toBeUndefined()
    } finally {
      await pool.end()
      await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`)
      await admin.end()
    }
  })

  it('repairs missing invite labels and preserves existing encrypted invitations', async () => {
    const schema = `dsh_team_it_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: requiredDatabaseUrl() })
    const pool = new Pool({ connectionString: requiredDatabaseUrl(), options: `-c search_path=${schema},public` })
    try {
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`)
      const original = testStore({ pool })
      const boot = await original.bootstrap('Friends', 'Owner')
      const owner = (await original.authenticateApiKey(boot.apiKey))!
      const existing = await original.createInvite(owner, 60_000, 'Original label')
      await pool.query('ALTER TABLE team_invites DROP COLUMN label')
      await pool.query('DELETE FROM team_schema_migrations WHERE version = 22')

      const upgraded = testStore({ pool })
      await upgraded.initialize()
      expect(await pool.query('SELECT label FROM team_invites WHERE id = $1', [existing.invite.id]))
        .toMatchObject({ rows: [{ label: 'Team invitation' }] })
      expect(await upgraded.revealInvite(owner, existing.invite.id)).toMatchObject({ inviteToken: existing.inviteToken })
      const created = await upgraded.createInvite(owner, 60_000, 'New label')
      expect(created.invite.label).toBe('New label')
      await testStore({ pool }).initialize()
      expect(await upgraded.revealInvite(owner, created.invite.id)).toMatchObject({ inviteToken: created.inviteToken })

      await pool.query('ALTER TABLE team_invites DROP COLUMN label')
      await expect(testStore({ pool }).initialize()).rejects.toThrow(/Team database schema.*dsh-codex-team-migrate/)
    } finally {
      await pool.end()
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`)
      await admin.end()
    }
  })

  it('lets only the Host runtime role mutate ownership-transfer state', async () => {
    const connectionString = requiredDatabaseUrl()
    const suffix = randomUUID().replaceAll('-', '')
    const schema = `dsh_team_it_${suffix}`
    const hostRole = `dsh_team_it_host_${suffix}`
    const brokerRole = `dsh_team_it_broker_${suffix}`
    const publicRole = `dsh_team_it_public_${suffix}`
    const admin = new Pool({ connectionString, max: 4, application_name: `dsh-team-it-${suffix}-admin` })
    const pool = new Pool({
      connectionString,
      max: 4,
      application_name: `dsh-team-it-${suffix}`,
      options: `-c search_path=${schema},public`,
    })
    let host: PoolClient | undefined
    let broker: PoolClient | undefined
    let untrusted: PoolClient | undefined

    try {
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`)
      await testStore({ pool }).initialize()
      await pool.query(`
        INSERT INTO teams (id, name, status, created_at)
        VALUES ('team-role-boundary', 'Role Boundary Team', 'active', 1);
        INSERT INTO team_members
          (id, team_id, display_name, display_name_key, role, status, joined_at)
        VALUES
          ('owner-role-boundary', 'team-role-boundary', 'Owner', 'owner', 'owner', 'active', 1),
          ('target-role-boundary', 'team-role-boundary', 'Target', 'target', 'member', 'active', 2);
        INSERT INTO team_contributions
          (id, team_id, owner_member_id, label, status, personal_reserve_percent,
           max_shared_requests_per_window, max_shared_concurrency, created_at, updated_at)
        VALUES
          ('account-role-boundary', 'team-role-boundary', 'owner-role-boundary',
           'Owner Codex', 'active', 20, NULL, 1, 2, 2);
        INSERT INTO team_member_display_name_migration_audit_events
          (id, team_id, member_id, migration_version, previous_display_name,
           next_display_name, repair_reason, created_at)
        VALUES
          ('display-audit-role-boundary', 'team-role-boundary', 'target-role-boundary', 20,
           'Before', 'Target', 'normalized', 2);
      `)
      await admin.query(`CREATE ROLE ${quoteRuntimeRoleIdentifier(publicRole)} NOLOGIN`)
      await admin.query(`GRANT USAGE ON SCHEMA ${quoteIdentifier(schema)} TO ${quoteRuntimeRoleIdentifier(publicRole)}`)
      await admin.query(POSTGRES_TEAM_RUNTIME_ROLES_SQL
        .replaceAll('ON SCHEMA public', `ON SCHEMA ${quoteIdentifier(schema)}`)
        .replaceAll('public.', `${quoteIdentifier(schema)}.`)
        .replaceAll('dsh_team_host', hostRole)
        .replaceAll('dsh_team_broker', brokerRole))

      host = await pool.connect()
      await host.query(`SET ROLE ${quoteRuntimeRoleIdentifier(hostRole)}`)
      await host.query(`
        INSERT INTO team_ownership_transfers
          (id, team_id, requested_by_member_id, target_member_id, status, created_at, expires_at)
        VALUES
          ('transfer-role-boundary', 'team-role-boundary', 'owner-role-boundary',
           'target-role-boundary', 'pending', 1, 86400001)
      `)
      await expect(host.query('SELECT id FROM team_ownership_transfers')).resolves.toMatchObject({
        rows: [{ id: 'transfer-role-boundary' }],
      })
      await host.query(`
        UPDATE team_ownership_transfers
        SET status = 'accepted', resolved_at = 2, acceptance_result = '{}'::jsonb
        WHERE id = 'transfer-role-boundary'
      `)
      await host.query(`
        INSERT INTO team_ownership_transfer_audit_events
          (id, team_id, transfer_id, actor_member_id, action, created_at)
        VALUES
          ('audit-role-boundary', 'team-role-boundary', 'transfer-role-boundary',
           'target-role-boundary', 'accepted', 2)
      `)
      await expect(host.query('SELECT id FROM team_ownership_transfer_audit_events')).resolves.toMatchObject({
        rows: [{ id: 'audit-role-boundary' }],
      })
      await expect(host.query('SELECT id FROM team_member_display_name_migration_audit_events')).resolves.toMatchObject({
        rows: [{ id: 'display-audit-role-boundary' }],
      })
      await expect(host.query(`
        UPDATE team_member_display_name_migration_audit_events
        SET acknowledged_at = 3
        WHERE id = 'display-audit-role-boundary'
      `)).resolves.toMatchObject({ rowCount: 1 })
      await expect(host.query(`
        UPDATE team_member_display_name_migration_audit_events
        SET previous_display_name = 'Forbidden'
        WHERE id = 'display-audit-role-boundary'
      `)).rejects.toThrow(/permission denied/iu)
      await expect(host.query(`
        INSERT INTO team_member_display_name_migration_audit_events
          (id, team_id, member_id, migration_version, previous_display_name,
           next_display_name, repair_reason, created_at)
        VALUES
          ('forbidden-display-audit', 'team-role-boundary', 'target-role-boundary', 20,
           'Before', 'After', 'normalized', 2)
      `)).rejects.toThrow(/permission denied/iu)
      await expect(host.query(`
        DELETE FROM team_member_display_name_migration_audit_events
        WHERE id = 'display-audit-role-boundary'
      `)).rejects.toThrow(/permission denied/iu)
      await host.query("UPDATE team_ownership_transfer_audit_events SET created_at = 3 WHERE id = 'audit-role-boundary'")
      await host.query("DELETE FROM team_ownership_transfer_audit_events WHERE id = 'audit-role-boundary'")
      await host.query("DELETE FROM team_ownership_transfers WHERE id = 'transfer-role-boundary'")
      await host.query('RESET ROLE')

      broker = await pool.connect()
      await broker.query(`SET ROLE ${quoteRuntimeRoleIdentifier(brokerRole)}`)
      await expect(broker.query('SELECT id FROM team_ownership_transfers')).rejects.toThrow(/permission denied/iu)
      await expect(broker.query('SELECT id FROM team_ownership_transfer_audit_events')).rejects.toThrow(/permission denied/iu)
      await expect(broker.query('SELECT id FROM team_member_display_name_migration_audit_events')).rejects.toThrow(/permission denied/iu)
      await expect(broker.query(`
        UPDATE team_member_display_name_migration_audit_events
        SET acknowledged_at = 4
        WHERE id = 'display-audit-role-boundary'
      `)).rejects.toThrow(/permission denied/iu)
      const brokerClient = { query: broker.query.bind(broker), release: () => undefined }
      const brokerPool = {
        query: broker.query.bind(broker),
        connect: async () => brokerClient,
      } as unknown as Pool
      const credentialBackend = new PostgresTeamEnvelopeCredentialBackend({
        pool: brokerPool,
        keyEncryptionProvider: new Aes256GcmTeamKeyEncryptionProvider(Buffer.alloc(32, 0x44)),
        credentialScopeLock: 'restricted-function',
      })
      const credentialStore = credentialBackend.open({
        teamId: 'team-role-boundary', accountId: 'account-role-boundary',
      })
      await credentialStore.addProfile('Owner Codex', {
        type: 'oauth', access: 'broker-role-access', refresh: 'broker-role-refresh',
        expires: 2_000_000_000_000, accountId: 'broker-role-provider-account',
      })
      await expect(credentialStore.listProfiles()).resolves.toMatchObject([{ label: 'Owner Codex' }])
      await expect(broker.query('SELECT name FROM teams')).rejects.toThrow(/permission denied/iu)
      await expect(broker.query('SELECT label FROM team_contributions')).rejects.toThrow(/permission denied/iu)
      await broker.query('RESET ROLE')

      untrusted = await pool.connect()
      await untrusted.query(`SET ROLE ${quoteRuntimeRoleIdentifier(publicRole)}`)
      await expect(untrusted.query('SELECT id FROM team_ownership_transfers')).rejects.toThrow(/permission denied/iu)
      await expect(untrusted.query('SELECT id FROM team_ownership_transfer_audit_events')).rejects.toThrow(/permission denied/iu)
      await expect(untrusted.query('SELECT id FROM team_member_display_name_migration_audit_events')).rejects.toThrow(/permission denied/iu)
      await expect(untrusted.query(`
        UPDATE team_member_display_name_migration_audit_events
        SET acknowledged_at = 4
        WHERE id = 'display-audit-role-boundary'
      `)).rejects.toThrow(/permission denied/iu)
      await untrusted.query('RESET ROLE')
    } finally {
      await host?.query('RESET ROLE').catch(() => undefined)
      await broker?.query('RESET ROLE').catch(() => undefined)
      await untrusted?.query('RESET ROLE').catch(() => undefined)
      host?.release()
      broker?.release()
      untrusted?.release()
      await pool.end().catch(() => undefined)
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch(() => undefined)
      await admin.query(`DROP ROLE IF EXISTS ${quoteRuntimeRoleIdentifier(hostRole)}`).catch(() => undefined)
      await admin.query(`DROP ROLE IF EXISTS ${quoteRuntimeRoleIdentifier(brokerRole)}`).catch(() => undefined)
      await admin.query(`DROP ROLE IF EXISTS ${quoteRuntimeRoleIdentifier(publicRole)}`).catch(() => undefined)
      await admin.end().catch(() => undefined)
    }
  }, 20_000)

  it('migrates legacy Admins and invalidates only non-Owner pending invitations', async () => {
    const connectionString = requiredDatabaseUrl()
    const suffix = randomUUID().replaceAll('-', '')
    const schema = `dsh_team_it_${suffix}`
    const admin = new Pool({ connectionString, max: 2, application_name: `dsh-team-it-${suffix}-admin` })
    const pool = new Pool({
      connectionString,
      max: 2,
      application_name: `dsh-team-it-${suffix}`,
      options: `-c search_path=${schema},public`,
    })

    try {
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`)
      await applyTeamMigrationsThrough(pool, 11)
      await pool.query(`
        INSERT INTO teams (id, name, status, created_at)
        VALUES ('team-legacy', 'Legacy Team', 'active', 1);
        INSERT INTO team_members (id, team_id, display_name, role, status, joined_at)
        VALUES
          ('owner-current', 'team-legacy', 'Owner', 'owner', 'active', 1),
          ('admin-active', 'team-legacy', 'Legacy Admin', 'admin', 'active', 2),
          ('admin-suspended', 'team-legacy', 'Suspended Admin', 'admin', 'suspended', 3),
          ('member-former-owner', 'team-legacy', 'Former Owner', 'member', 'active', 4);
        INSERT INTO team_api_keys
          (id, team_id, member_id, label, prefix, created_at, last_used_at, revoked_at, token_hash)
        VALUES
          ('owner-key', 'team-legacy', 'owner-current', 'owner', 'dsh_team_owner', 1, NULL, NULL, 'owner-key-hash');
        INSERT INTO team_invites
          (id, team_id, invited_by_member_id, label, status, expires_at, created_at, accepted_at, token_hash)
        VALUES
          ('invite-owner', 'team-legacy', 'owner-current', 'Owner invite', 'pending', 9999999999999, 1, NULL, 'owner-invite-hash'),
          ('invite-admin', 'team-legacy', 'admin-active', 'Admin invite', 'pending', 9999999999999, 2, NULL, 'admin-invite-hash'),
          ('invite-former-owner', 'team-legacy', 'member-former-owner', 'Former Owner invite', 'pending', 9999999999999, 3, NULL, 'former-owner-invite-hash'),
          ('invite-accepted', 'team-legacy', 'admin-active', 'Accepted invite', 'accepted', 9999999999999, 4, 5, 'accepted-invite-hash');
      `)

      await testStore({ pool }).initialize()

      const members = await pool.query<{ id: string; role: string }>(
        'SELECT id, role FROM team_members ORDER BY id',
      )
      expect(members.rows).toEqual([
        { id: 'admin-active', role: 'member' },
        { id: 'admin-suspended', role: 'admin' },
        { id: 'member-former-owner', role: 'member' },
        { id: 'owner-current', role: 'owner' },
      ])
      const invites = await pool.query<{
        id: string
        status: string
        token_hash: string
        envelope_version: number | null
      }>(
        'SELECT id, status, token_hash, envelope_version FROM team_invites ORDER BY id',
      )
      expect(invites.rows).toEqual([
        { id: 'invite-accepted', status: 'accepted', token_hash: 'accepted-invite-hash', envelope_version: null },
        { id: 'invite-admin', status: 'revoked', token_hash: 'revoked:migration-12:invite-admin', envelope_version: null },
        { id: 'invite-former-owner', status: 'revoked', token_hash: 'revoked:migration-12:invite-former-owner', envelope_version: null },
        { id: 'invite-owner', status: 'pending', token_hash: 'owner-invite-hash', envelope_version: null },
      ])
      await expect(pool.query(`
        SELECT id, team_id, target_member_id, migration_version, previous_role, next_role
        FROM team_role_migration_audit_events
        ORDER BY target_member_id
      `)).resolves.toMatchObject({
        rows: [{
          id: 'migration-12:legacy-admin:admin-active',
          team_id: 'team-legacy',
          target_member_id: 'admin-active',
          migration_version: 12,
          previous_role: 'admin',
          next_role: 'member',
        }],
      })
      await testStore({ pool }).initialize()
      await expect(pool.query('SELECT COUNT(*)::integer AS count FROM team_role_migration_audit_events'))
        .resolves.toMatchObject({ rows: [{ count: 1 }] })
      await expect(pool.query('SELECT version FROM team_schema_migrations WHERE version = 12'))
        .resolves.toMatchObject({ rows: [{ version: 12 }] })
      await expect(pool.query('SELECT version FROM team_schema_migrations WHERE version = 13'))
        .resolves.toMatchObject({ rows: [{ version: 13 }] })
      await expect(pool.query('SELECT version FROM team_schema_migrations WHERE version = 14'))
        .resolves.toMatchObject({ rows: [{ version: 14 }] })
      await expect(pool.query('SELECT version FROM team_schema_migrations WHERE version = 15'))
        .resolves.toMatchObject({ rows: [{ version: 15 }] })
    } finally {
      await pool.end().catch(() => undefined)
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch(() => undefined)
      await admin.end().catch(() => undefined)
    }
  }, 20_000)

  it('rolls migration 12 back when an affected Team has no active Owner credential', async () => {
    const connectionString = requiredDatabaseUrl()
    const suffix = randomUUID().replaceAll('-', '')
    const schema = `dsh_team_it_${suffix}`
    const admin = new Pool({ connectionString, max: 2, application_name: `dsh-team-it-${suffix}-admin` })
    const pool = new Pool({
      connectionString,
      max: 2,
      application_name: `dsh-team-it-${suffix}`,
      options: `-c search_path=${schema},public`,
    })

    try {
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`)
      await applyTeamMigrationsThrough(pool, 11)
      await pool.query(`
        INSERT INTO teams (id, name, status, created_at)
        VALUES ('team-blocked', 'Blocked Team', 'active', 1);
        INSERT INTO team_members (id, team_id, display_name, role, status, joined_at)
        VALUES
          ('owner-without-key', 'team-blocked', 'Owner', 'owner', 'active', 1),
          ('admin-active', 'team-blocked', 'Legacy Admin', 'admin', 'active', 2);
        INSERT INTO team_invites
          (id, team_id, invited_by_member_id, label, status, expires_at, created_at, accepted_at, token_hash)
        VALUES
          ('invite-admin', 'team-blocked', 'admin-active', 'Admin invite', 'pending', 9999999999999, 2, NULL, 'admin-invite-hash');
      `)

      await expect(testStore({ pool }).initialize()).rejects.toThrow(/migration 12 preflight failed/iu)
      await expect(pool.query("SELECT role FROM team_members WHERE id = 'admin-active'"))
        .resolves.toMatchObject({ rows: [{ role: 'admin' }] })
      await expect(pool.query("SELECT status, token_hash FROM team_invites WHERE id = 'invite-admin'"))
        .resolves.toMatchObject({ rows: [{ status: 'pending', token_hash: 'admin-invite-hash' }] })
      await expect(pool.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = 'team_role_migration_audit_events'
      `)).resolves.toMatchObject({ rows: [] })
      await expect(pool.query('SELECT version FROM team_schema_migrations WHERE version = 12'))
        .resolves.toMatchObject({ rows: [] })
    } finally {
      await pool.end().catch(() => undefined)
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch(() => undefined)
      await admin.end().catch(() => undefined)
    }
  }, 20_000)

  it('rejects a paused Team with no Owner credential through the published migration 12 SQL', async () => {
    const connectionString = requiredDatabaseUrl()
    const suffix = randomUUID().replaceAll('-', '')
    const schema = `dsh_team_it_${suffix}`
    const admin = new Pool({ connectionString, max: 2, application_name: `dsh-team-it-${suffix}-admin` })
    const pool = new Pool({
      connectionString,
      max: 2,
      application_name: `dsh-team-it-${suffix}`,
      options: `-c search_path=${schema},public`,
    })

    try {
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`)
      await applyTeamMigrationsThrough(pool, 11)
      await pool.query(`
        INSERT INTO teams (id, name, status, created_at)
        VALUES ('team-paused-without-key', 'Paused Team', 'paused', 1);
        INSERT INTO team_members (id, team_id, display_name, role, status, joined_at)
        VALUES ('owner-paused-without-key', 'team-paused-without-key', 'Owner', 'owner', 'active', 1);
      `)
      const migration = POSTGRES_TEAM_MIGRATIONS.find(candidate => candidate.version === 12)
      if (migration === undefined) throw new Error('migration 12 should exist')

      const client = await pool.connect()
      let migrationError: Error
      try {
        await client.query('BEGIN')
        await client.query(migration.sql)
        migrationError = new Error('expected published migration 12 SQL to reject')
      } catch (error: unknown) {
        migrationError = error instanceof Error ? error : new Error(String(error))
      } finally {
        await client.query('ROLLBACK')
        client.release()
      }

      expect(migrationError.message).toMatch(/migration 12 preflight failed/iu)
      expect(migrationError.message).toContain('team-paused-without-key')
      expect(migrationError.message).toContain('owner-paused-without-key')
      expect(migrationError.message).toContain('credentialed_owner_member_ids=[]')
      await expect(pool.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = 'team_role_migration_audit_events'
      `)).resolves.toMatchObject({ rows: [] })
      await expect(pool.query('SELECT version FROM team_schema_migrations WHERE version = 12'))
        .resolves.toMatchObject({ rows: [] })
    } finally {
      await pool.end().catch(() => undefined)
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch(() => undefined)
      await admin.end().catch(() => undefined)
    }
  }, 20_000)

  it('rejects multiple active Owners through the published migration 12 SQL even when one has a key', async () => {
    const connectionString = requiredDatabaseUrl()
    const suffix = randomUUID().replaceAll('-', '')
    const schema = `dsh_team_it_${suffix}`
    const admin = new Pool({ connectionString, max: 2, application_name: `dsh-team-it-${suffix}-admin` })
    const pool = new Pool({
      connectionString,
      max: 2,
      application_name: `dsh-team-it-${suffix}`,
      options: `-c search_path=${schema},public`,
    })

    try {
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`)
      await applyTeamMigrationsThrough(pool, 11)
      await pool.query('DROP INDEX team_members_one_owner_idx')
      await pool.query(`
        INSERT INTO teams (id, name, status, created_at)
        VALUES ('team-multiple-owners', 'Multiple Owners', 'active', 1);
        INSERT INTO team_members (id, team_id, display_name, role, status, joined_at)
        VALUES
          ('owner-alpha', 'team-multiple-owners', 'Owner Alpha', 'owner', 'active', 1),
          ('owner-beta', 'team-multiple-owners', 'Owner Beta', 'owner', 'active', 2),
          ('admin-legacy', 'team-multiple-owners', 'Legacy Admin', 'admin', 'active', 3);
        INSERT INTO team_api_keys
          (id, team_id, member_id, label, prefix, created_at, last_used_at, revoked_at, token_hash)
        VALUES
          ('owner-alpha-key', 'team-multiple-owners', 'owner-alpha', 'owner', 'dsh_team_owner', 1, NULL, NULL, 'owner-alpha-key-hash');
        INSERT INTO team_invites
          (id, team_id, invited_by_member_id, label, status, expires_at, created_at, accepted_at, token_hash)
        VALUES
          ('invite-admin', 'team-multiple-owners', 'admin-legacy', 'Admin invite', 'pending', 9999999999999, 3, NULL, 'admin-invite-hash');
      `)
      const migration = POSTGRES_TEAM_MIGRATIONS.find(candidate => candidate.version === 12)
      if (migration === undefined) throw new Error('migration 12 should exist')

      const client = await pool.connect()
      let migrationError: Error
      try {
        await client.query('BEGIN')
        await client.query(migration.sql)
        migrationError = new Error('expected published migration 12 SQL to reject')
      } catch (error: unknown) {
        migrationError = error instanceof Error ? error : new Error(String(error))
      } finally {
        await client.query('ROLLBACK')
        client.release()
      }

      expect(migrationError.message).toMatch(/migration 12 preflight failed/iu)
      expect(migrationError.message).toContain('team-multiple-owners')
      expect(migrationError.message).toContain('owner-alpha')
      expect(migrationError.message).toContain('owner-beta')
      expect(migrationError.message).toContain('credentialed_owner_member_ids=["owner-alpha"]')
      await expect(pool.query("SELECT role FROM team_members WHERE id = 'admin-legacy'"))
        .resolves.toMatchObject({ rows: [{ role: 'admin' }] })
      await expect(pool.query("SELECT status, token_hash FROM team_invites WHERE id = 'invite-admin'"))
        .resolves.toMatchObject({ rows: [{ status: 'pending', token_hash: 'admin-invite-hash' }] })
      await expect(pool.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = 'team_role_migration_audit_events'
      `)).resolves.toMatchObject({ rows: [] })
      await expect(pool.query('SELECT version FROM team_schema_migrations WHERE version = 12'))
        .resolves.toMatchObject({ rows: [] })
    } finally {
      await pool.end().catch(() => undefined)
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch(() => undefined)
      await admin.end().catch(() => undefined)
    }
  }, 20_000)

  it('runs the published migration 12 SQL success path with audit and invite mutations', async () => {
    const connectionString = requiredDatabaseUrl()
    const suffix = randomUUID().replaceAll('-', '')
    const schema = `dsh_team_it_${suffix}`
    const admin = new Pool({ connectionString, max: 2, application_name: `dsh-team-it-${suffix}-admin` })
    const pool = new Pool({
      connectionString,
      max: 2,
      application_name: `dsh-team-it-${suffix}`,
      options: `-c search_path=${schema},public`,
    })

    try {
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`)
      await applyTeamMigrationsThrough(pool, 11)
      await pool.query(`
        INSERT INTO teams (id, name, status, created_at)
        VALUES ('team-static-success', 'Static Success', 'active', 1);
        INSERT INTO team_members (id, team_id, display_name, role, status, joined_at)
        VALUES
          ('owner-static', 'team-static-success', 'Owner', 'owner', 'active', 1),
          ('admin-static', 'team-static-success', 'Legacy Admin', 'admin', 'active', 2);
        INSERT INTO team_api_keys
          (id, team_id, member_id, label, prefix, created_at, last_used_at, revoked_at, token_hash)
        VALUES
          ('owner-static-key-a', 'team-static-success', 'owner-static', 'owner a', 'dsh_team_owner_a', 1, NULL, NULL, 'owner-static-key-a-hash'),
          ('owner-static-key-b', 'team-static-success', 'owner-static', 'owner b', 'dsh_team_owner_b', 2, NULL, NULL, 'owner-static-key-b-hash');
        INSERT INTO team_invites
          (id, team_id, invited_by_member_id, label, status, expires_at, created_at, accepted_at, token_hash)
        VALUES
          ('invite-static-owner', 'team-static-success', 'owner-static', 'Owner invite', 'pending', 9999999999999, 1, NULL, 'owner-static-invite-hash'),
          ('invite-static-admin', 'team-static-success', 'admin-static', 'Admin invite', 'pending', 9999999999999, 2, NULL, 'admin-static-invite-hash');
      `)
      const migration = POSTGRES_TEAM_MIGRATIONS.find(candidate => candidate.version === 12)
      if (migration === undefined) throw new Error('migration 12 should exist')

      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(migration.sql)
        await client.query(
          'INSERT INTO team_schema_migrations (version, applied_at) VALUES ($1, $2)',
          [migration.version, migration.version],
        )
        await client.query('COMMIT')
      } catch (error: unknown) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }

      await expect(pool.query("SELECT role FROM team_members WHERE id = 'admin-static'"))
        .resolves.toMatchObject({ rows: [{ role: 'member' }] })
      await expect(pool.query('SELECT id, target_member_id, previous_role, next_role FROM team_role_migration_audit_events'))
        .resolves.toMatchObject({
          rows: [{
            id: 'migration-12:legacy-admin:admin-static',
            target_member_id: 'admin-static',
            previous_role: 'admin',
            next_role: 'member',
          }],
        })
      await expect(pool.query('SELECT id, status, token_hash FROM team_invites ORDER BY id'))
        .resolves.toMatchObject({
          rows: [
            { id: 'invite-static-admin', status: 'revoked', token_hash: 'revoked:migration-12:invite-static-admin' },
            { id: 'invite-static-owner', status: 'pending', token_hash: 'owner-static-invite-hash' },
          ],
        })
      await expect(pool.query('SELECT version FROM team_schema_migrations WHERE version = 12'))
        .resolves.toMatchObject({ rows: [{ version: 12 }] })
    } finally {
      await pool.end().catch(() => undefined)
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch(() => undefined)
      await admin.end().catch(() => undefined)
    }
  }, 20_000)

  it('rolls every migration 12 mutation back when recording the migration version fails', async () => {
    const connectionString = requiredDatabaseUrl()
    const suffix = randomUUID().replaceAll('-', '')
    const schema = `dsh_team_it_${suffix}`
    const admin = new Pool({ connectionString, max: 2, application_name: `dsh-team-it-${suffix}-admin` })
    const pool = new Pool({
      connectionString,
      max: 2,
      application_name: `dsh-team-it-${suffix}`,
      options: `-c search_path=${schema},public`,
    })

    try {
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`)
      await applyTeamMigrationsThrough(pool, 11)
      await pool.query(`
        INSERT INTO teams (id, name, status, created_at)
        VALUES ('team-rollback', 'Rollback Team', 'active', 1);
        INSERT INTO team_members (id, team_id, display_name, role, status, joined_at)
        VALUES
          ('owner-rollback', 'team-rollback', 'Owner', 'owner', 'active', 1),
          ('admin-rollback', 'team-rollback', 'Legacy Admin', 'admin', 'active', 2);
        INSERT INTO team_api_keys
          (id, team_id, member_id, label, prefix, created_at, last_used_at, revoked_at, token_hash)
        VALUES
          ('owner-rollback-key', 'team-rollback', 'owner-rollback', 'owner', 'dsh_team_owner', 1, NULL, NULL, 'owner-rollback-key-hash');
        INSERT INTO team_invites
          (id, team_id, invited_by_member_id, label, status, expires_at, created_at, accepted_at, token_hash)
        VALUES
          ('invite-admin-rollback', 'team-rollback', 'admin-rollback', 'Admin invite', 'pending', 9999999999999, 2, NULL, 'admin-rollback-invite-hash');
        CREATE FUNCTION fail_migration_12_version_write() RETURNS trigger
        LANGUAGE plpgsql AS $migration_fault$
        BEGIN
          IF NEW.version = 12 THEN
            RAISE EXCEPTION 'injected migration 12 version-write failure';
          END IF;
          RETURN NEW;
        END;
        $migration_fault$;
        CREATE TRIGGER fail_migration_12_version_write
        BEFORE INSERT ON team_schema_migrations
        FOR EACH ROW EXECUTE FUNCTION fail_migration_12_version_write();
      `)

      await expect(testStore({ pool }).initialize())
        .rejects.toThrow('injected migration 12 version-write failure')
      await expect(pool.query("SELECT role FROM team_members WHERE id = 'admin-rollback'"))
        .resolves.toMatchObject({ rows: [{ role: 'admin' }] })
      await expect(pool.query(`
        SELECT status, token_hash
        FROM team_invites
        WHERE id = 'invite-admin-rollback'
      `)).resolves.toMatchObject({
        rows: [{ status: 'pending', token_hash: 'admin-rollback-invite-hash' }],
      })
      await expect(pool.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = 'team_role_migration_audit_events'
      `)).resolves.toMatchObject({ rows: [] })
      await expect(pool.query('SELECT version FROM team_schema_migrations WHERE version = 12'))
        .resolves.toMatchObject({ rows: [] })
    } finally {
      await pool.end().catch(() => undefined)
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch(() => undefined)
      await admin.end().catch(() => undefined)
    }
  }, 20_000)

  it('migrates v19 legacy display names deterministically before enforcing active uniqueness', async () => {
    const connectionString = requiredDatabaseUrl()
    const suffix = randomUUID().replaceAll('-', '')
    const schema = `dsh_team_it_${suffix}`
    const admin = new Pool({ connectionString, max: 2, application_name: `dsh-team-it-${suffix}-admin` })
    const pool = new Pool({
      connectionString,
      max: 3,
      application_name: `dsh-team-it-${suffix}`,
      options: `-c search_path=${schema},public`,
    })
    let currentNow = 20_020
    const store = testStore({ pool, now: () => currentNow })
    const invalidFallback = fallbackTeamMemberDisplayName('member-invalid')

    try {
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`)
      await applyTeamMigrationsThrough(pool, 19)
      await pool.query(`
        INSERT INTO teams (id, name, status, created_at)
        VALUES ('team-display-name-migration', 'Legacy Names', 'active', 1);
        INSERT INTO team_members (id, team_id, display_name, role, status, joined_at)
        VALUES
          ('member-z', 'team-display-name-migration', 'strasse', 'member', 'active', 0),
          ('member-a', 'team-display-name-migration', 'Straße', 'member', 'active', 1),
          ('member-b', 'team-display-name-migration', 'Strasse', 'member', 'active', 1),
          ('member-invalid', 'team-display-name-migration', 'Bad​Name', 'member', 'active', 2),
          ('member-normalized', 'team-display-name-migration', 'Ｆｏｏ', 'member', 'active', 3),
          ('member-removed', 'team-display-name-migration', 'strasse', 'member', 'removed', 4),
          ('owner-current', 'team-display-name-migration', 'STRASSE', 'owner', 'active', 9);
      `)

      const directMigration = POSTGRES_TEAM_MIGRATIONS.find(migration => migration.version === 20)
      if (directMigration === undefined) throw new Error('migration 20 should exist')
      await expect(pool.query(directMigration.sql)).rejects.toThrow(
        /requires PostgresTeamStore\.initialize|dsh-codex-team-migrate/iu,
      )
      await expect(pool.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'team_members'
          AND column_name = 'display_name_key'
      `)).resolves.toMatchObject({ rows: [] })

      await store.initialize()

      await expect(pool.query<{
        id: string
        display_name: string
        display_name_key: string
        status: string
      }>(`
        SELECT id, display_name, display_name_key, status
        FROM team_members
        WHERE team_id = 'team-display-name-migration'
        ORDER BY id
      `)).resolves.toMatchObject({ rows: [
        { id: 'member-a', display_name: 'Straße · 3', display_name_key: 'strasse · 3', status: 'active' },
        { id: 'member-b', display_name: 'Strasse · 4', display_name_key: 'strasse · 4', status: 'active' },
        {
          id: 'member-invalid',
          display_name: invalidFallback.displayName,
          display_name_key: invalidFallback.displayNameKey,
          status: 'active',
        },
        { id: 'member-normalized', display_name: 'Foo', display_name_key: 'foo', status: 'active' },
        { id: 'member-removed', display_name: 'strasse', display_name_key: 'strasse', status: 'removed' },
        { id: 'member-z', display_name: 'strasse · 2', display_name_key: 'strasse · 2', status: 'active' },
        { id: 'owner-current', display_name: 'STRASSE', display_name_key: 'strasse', status: 'active' },
      ] })
      await expect(pool.query(`
        SELECT member_id, previous_display_name, next_display_name, repair_reason,
               migration_version, created_at, acknowledged_at
        FROM team_member_display_name_migration_audit_events
        ORDER BY member_id
      `)).resolves.toMatchObject({ rows: [
        {
          member_id: 'member-a',
          previous_display_name: 'Straße',
          next_display_name: 'Straße · 3',
          repair_reason: 'collision',
          migration_version: 20,
          created_at: '20020',
          acknowledged_at: null,
        },
        {
          member_id: 'member-b',
          previous_display_name: 'Strasse',
          next_display_name: 'Strasse · 4',
          repair_reason: 'collision',
          migration_version: 20,
          created_at: '20020',
          acknowledged_at: null,
        },
        {
          member_id: 'member-invalid',
          previous_display_name: 'Bad​Name',
          next_display_name: invalidFallback.displayName,
          repair_reason: 'invalid',
          migration_version: 20,
          created_at: '20020',
          acknowledged_at: null,
        },
        {
          member_id: 'member-normalized',
          previous_display_name: 'Ｆｏｏ',
          next_display_name: 'Foo',
          repair_reason: 'normalized',
          migration_version: 20,
          created_at: '20020',
          acknowledged_at: null,
        },
        {
          member_id: 'member-z',
          previous_display_name: 'strasse',
          next_display_name: 'strasse · 2',
          repair_reason: 'collision',
          migration_version: 20,
          created_at: '20020',
          acknowledged_at: null,
        },
      ] })
      const migratedMemberToken = `dsh_team_${'n'.repeat(43)}`
      await pool.query(`
        INSERT INTO team_api_keys
          (id, team_id, member_id, label, prefix, created_at, last_used_at, revoked_at, token_hash)
        VALUES
          ('key-member-normalized', 'team-display-name-migration', 'member-normalized',
           'migration notice', 'dsh_team_nnnnnnnn', 4, NULL, NULL, $1)
      `, [createHash('sha256').update(migratedMemberToken).digest('hex')])
      const migratedMemberAuth = await store.authenticateApiKey(migratedMemberToken)
      if (migratedMemberAuth === undefined) throw new Error('migrated member authentication should succeed')

      await expect(store.overview(migratedMemberAuth)).resolves.toMatchObject({
        currentMember: { id: 'member-normalized', displayName: 'Foo' },
        displayNameMigrationNotice: { migrationVersion: 20 },
      })
      await expect(store.acknowledgeDisplayNameMigration(migratedMemberAuth, 21)).rejects.toMatchObject({
        status: 404,
        code: 'team_display_name_migration_unavailable',
      })
      currentNow = 20_021
      await expect(store.acknowledgeDisplayNameMigration(migratedMemberAuth, 20)).resolves.toEqual({
        migrationVersion: 20,
        acknowledged: true,
      })
      currentNow = 20_022
      await expect(store.acknowledgeDisplayNameMigration(migratedMemberAuth, 20)).resolves.toEqual({
        migrationVersion: 20,
        acknowledged: true,
      })
      await expect(store.overview(migratedMemberAuth)).resolves.not.toHaveProperty('displayNameMigrationNotice')
      await expect(pool.query(`
        SELECT member_id, acknowledged_at
        FROM team_member_display_name_migration_audit_events
        WHERE member_id IN ('member-a', 'member-normalized')
        ORDER BY member_id
      `)).resolves.toMatchObject({ rows: [
        { member_id: 'member-a', acknowledged_at: null },
        { member_id: 'member-normalized', acknowledged_at: '20021' },
      ] })
      await expect(pool.query(`
        SELECT is_nullable
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'team_members'
          AND column_name = 'display_name_key'
      `)).resolves.toMatchObject({ rows: [{ is_nullable: 'NO' }] })
      await expect(pool.query(`
        SELECT indexdef
        FROM pg_indexes
        WHERE schemaname = current_schema()
          AND indexname = 'team_members_active_display_name_key_idx'
      `)).resolves.toMatchObject({
        rows: [{ indexdef: expect.stringMatching(/UNIQUE[\s\S]+\(team_id, display_name_key\)[\s\S]+WHERE \(status = 'active'/iu) }],
      })
      await expect(pool.query(`
        INSERT INTO team_members
          (id, team_id, display_name, display_name_key, role, status, joined_at)
        VALUES
          ('member-active-duplicate', 'team-display-name-migration', 'Duplicate', 'strasse', 'member', 'active', 10)
      `)).rejects.toThrow(/team_members_active_display_name_key_idx|duplicate key/iu)
      await expect(pool.query(`
        INSERT INTO team_members
          (id, team_id, display_name, display_name_key, role, status, joined_at)
        VALUES
          ('member-removed-duplicate', 'team-display-name-migration', 'Duplicate', 'strasse', 'member', 'removed', 10)
      `)).resolves.toMatchObject({ rowCount: 1 })
      await expect(pool.query('SELECT version FROM team_schema_migrations WHERE version = 20'))
        .resolves.toMatchObject({ rows: [{ version: 20 }] })
    } finally {
      await store.dispose().catch(() => undefined)
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch(() => undefined)
      await admin.end().catch(() => undefined)
    }
  }, 20_000)

  it('rolls the whole v20 legacy-name repair back when one Team audit write fails', async () => {
    const connectionString = requiredDatabaseUrl()
    const suffix = randomUUID().replaceAll('-', '')
    const schema = `dsh_team_it_${suffix}`
    const admin = new Pool({ connectionString, max: 2, application_name: `dsh-team-it-${suffix}-admin` })
    const pool = new Pool({
      connectionString,
      max: 3,
      application_name: `dsh-team-it-${suffix}`,
      options: `-c search_path=${schema},public`,
    })
    const store = testStore({ pool, now: () => 20_020 })

    try {
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`)
      await applyTeamMigrationsThrough(pool, 19)
      await pool.query(`
        INSERT INTO teams (id, name, status, created_at)
        VALUES ('team-display-name-rollback', 'Legacy Rollback', 'active', 1);
        INSERT INTO team_members (id, team_id, display_name, role, status, joined_at)
        VALUES
          ('owner-display-name-rollback', 'team-display-name-rollback', 'Bad​Name', 'owner', 'active', 1);
        CREATE TABLE team_member_display_name_migration_audit_events (
          id text PRIMARY KEY,
          team_id text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          member_id text NOT NULL REFERENCES team_members(id),
          migration_version integer NOT NULL CHECK (migration_version = 20),
          previous_display_name text NOT NULL,
          next_display_name text NOT NULL,
          repair_reason text NOT NULL CHECK (repair_reason IN ('normalized', 'invalid', 'collision')),
          created_at bigint NOT NULL,
          acknowledged_at bigint,
          UNIQUE (migration_version, member_id),
          CONSTRAINT reject_display_name_migration_audit CHECK (false)
        );
      `)

      await expect(store.initialize()).rejects.toThrow(/reject_display_name_migration_audit|check constraint/iu)
      await expect(pool.query(`
        SELECT display_name
        FROM team_members
        WHERE id = 'owner-display-name-rollback'
      `)).resolves.toMatchObject({ rows: [{ display_name: 'Bad​Name' }] })
      await expect(pool.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'team_members'
          AND column_name = 'display_name_key'
      `)).resolves.toMatchObject({ rows: [] })
      await expect(pool.query('SELECT version FROM team_schema_migrations WHERE version = 20'))
        .resolves.toMatchObject({ rows: [] })
      await expect(pool.query('SELECT COUNT(*)::integer AS count FROM team_member_display_name_migration_audit_events'))
        .resolves.toMatchObject({ rows: [{ count: 0 }] })
    } finally {
      await store.dispose().catch(() => undefined)
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch(() => undefined)
      await admin.end().catch(() => undefined)
    }
  }, 20_000)

  it('lets only one concurrent invite claim an active NFKC_Casefold display name and does not consume the loser', async () => {
    const connectionString = requiredDatabaseUrl()
    const suffix = randomUUID().replaceAll('-', '')
    const schema = `dsh_team_it_${suffix}`
    const applicationName = `dsh-team-it-${suffix}`
    const admin = new Pool({ connectionString, max: 2, application_name: `${applicationName}-admin` })
    const pool = new Pool({
      connectionString,
      max: 5,
      application_name: applicationName,
      options: `-c search_path=${schema},public`,
    })
    const store = testStore({ pool })

    try {
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`)
      await store.initialize()
      const boot = await store.bootstrap('Display Name Concurrency Team', 'Owner')
      const owner = await store.authenticateApiKey(boot.apiKey)
      if (owner === undefined) throw new Error('owner should authenticate')
      const firstInvite = await store.createInvite(owner, 60_000, 'First')
      const secondInvite = await store.createInvite(owner, 60_000, 'Second')
      const attempts = [
        { invite: firstInvite, name: 'Straße' },
        { invite: secondInvite, name: 'STRASSE' },
      ] as const

      const results = await Promise.allSettled(
        attempts.map(attempt => store.acceptInvite(attempt.invite.inviteToken, attempt.name)),
      )
      const succeeded = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<PostgresTeamStore['acceptInvite']>>> => result.status === 'fulfilled')
      const failed = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      expect(succeeded).toHaveLength(1)
      expect(failed).toHaveLength(1)
      expect(String(failed[0]?.reason)).toMatch(/display name.+already in use/iu)

      const losingIndex = results.findIndex(result => result.status === 'rejected')
      const losingAttempt = attempts[losingIndex]
      if (losingAttempt === undefined) throw new Error('one invite attempt should lose the display-name race')
      await expect(store.previewInvite(losingAttempt.invite.inviteToken)).resolves.toMatchObject({
        teamName: 'Display Name Concurrency Team',
        label: losingAttempt.invite.invite.label,
      })

      const active = await pool.query<{ display_name: string; display_name_key: string }>(`
        SELECT display_name, display_name_key
        FROM team_members
        WHERE team_id = $1 AND status = 'active'
        ORDER BY joined_at, id
      `, [owner.teamId])
      expect(active.rows).toHaveLength(2)
      expect(active.rows.map(row => row.display_name_key)).toEqual(['owner', 'strasse'])

      await expect(store.acceptInvite(losingAttempt.invite.inviteToken, 'Unique member')).resolves.toMatchObject({
        member: { displayName: 'Unique member', role: 'member' },
      })
    } finally {
      await store.dispose().catch(() => undefined)
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch(() => undefined)
      await admin.end().catch(() => undefined)
    }
  }, 20_000)

  it('serializes concurrent ownership-transfer requests and leaves exactly one pending request', async () => {
    const connectionString = requiredDatabaseUrl()
    const suffix = randomUUID().replaceAll('-', '')
    const schema = `dsh_team_it_${suffix}`
    const applicationName = `dsh-team-it-${suffix}`
    const admin = new Pool({ connectionString, max: 2, application_name: `${applicationName}-admin` })
    const pool = new Pool({
      connectionString,
      max: 5,
      application_name: applicationName,
      options: `-c search_path=${schema},public`,
    })
    const store = testStore({ pool })
    let control: PoolClient | undefined
    let controlInTransaction = false
    let firstTransfer: ReturnType<PostgresTeamStore['requestOwnershipTransfer']> | undefined
    let secondTransfer: ReturnType<PostgresTeamStore['requestOwnershipTransfer']> | undefined

    try {
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`)
      await store.initialize()
      const boot = await store.bootstrap('Ownership Concurrency Team', 'Owner')
      const owner = await store.authenticateApiKey(boot.apiKey)
      if (owner === undefined) throw new Error('owner should authenticate')
      const firstInvite = await store.createInvite(owner, 60_000)
      const firstJoin = await store.acceptInvite(firstInvite.inviteToken, 'First Friend')
      const firstMember = await store.authenticateApiKey(firstJoin.apiKey)
      const secondInvite = await store.createInvite(owner, 60_000)
      const secondJoin = await store.acceptInvite(secondInvite.inviteToken, 'Second Friend')
      const secondMember = await store.authenticateApiKey(secondJoin.apiKey)
      if (firstMember === undefined || secondMember === undefined) throw new Error('invited members should authenticate')

      control = await pool.connect()
      await control.query('BEGIN')
      controlInTransaction = true
      const backend = await control.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      const controlPid = backend.rows[0]?.pid
      if (controlPid === undefined) throw new Error('control backend PID was not returned')
      await control.query(
        'SELECT * FROM teams WHERE id = $1 FOR UPDATE',
        [owner.teamId],
      )

      firstTransfer = store.requestOwnershipTransfer(owner, firstMember.memberId)
      secondTransfer = store.requestOwnershipTransfer(owner, secondMember.memberId)
      await waitForOwnershipTransferLockWait(admin, applicationName, controlPid, 2)

      await control.query('COMMIT')
      controlInTransaction = false
      const results = await Promise.allSettled([firstTransfer, secondTransfer])
      const succeeded = results.filter((result): result is PromiseFulfilledResult<Awaited<typeof firstTransfer>> => result.status === 'fulfilled')
      const failed = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      expect(succeeded).toHaveLength(1)
      expect(failed).toHaveLength(1)
      expect(failed[0]?.reason).toBeInstanceOf(Error)
      expect(String(failed[0]?.reason)).toMatch(/already has a pending ownership transfer/iu)

      const pending = succeeded[0]?.value
      if (pending === undefined) throw new Error('one ownership-transfer request should succeed')
      expect(pending.status).toBe('pending')
      const persistedPending = await pool.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count
        FROM team_ownership_transfers
        WHERE team_id = $1 AND status = 'pending'
      `, [owner.teamId])
      expect(persistedPending.rows).toEqual([{ count: '1' }])

      const roles = await pool.query<{ id: string; role: string }>(
        'SELECT id, role FROM team_members WHERE team_id = $1 ORDER BY id',
        [owner.teamId],
      )
      expect(roles.rows.filter(row => row.role === 'owner')).toEqual([{ id: owner.memberId, role: 'owner' }])

      const target = pending.targetMemberId === firstMember.memberId ? firstMember : secondMember
      const accepted = await store.acceptOwnershipTransfer(target, pending.id)
      expect(accepted).toMatchObject({
        transfer: { id: pending.id, status: 'accepted' },
        formerOwner: { id: owner.memberId, role: 'member' },
        owner: { id: target.memberId, role: 'owner' },
      })
      const acceptedRoles = await pool.query<{ id: string; role: string }>(
        'SELECT id, role FROM team_members WHERE team_id = $1 ORDER BY id',
        [owner.teamId],
      )
      expect(acceptedRoles.rows.filter(row => row.role === 'owner')).toEqual([
        { id: target.memberId, role: 'owner' },
      ])
      const refreshedOwner = await store.authenticateApiKey(
        target.memberId === firstMember.memberId ? firstJoin.apiKey : secondJoin.apiKey,
      )
      if (refreshedOwner === undefined) throw new Error('new Owner should reauthenticate')
      const audit = await store.listMembershipAuditEvents(refreshedOwner, 10)
      expect(audit.filter(event => event.action === 'ownership_transferred')).toHaveLength(1)
    } finally {
      if (controlInTransaction) await control?.query('ROLLBACK').catch(() => undefined)
      await Promise.allSettled([firstTransfer, secondTransfer].filter(isPromise))
      control?.release()
      await pool.end().catch(() => undefined)
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch(() => undefined)
      await admin.end().catch(() => undefined)
    }
  }, 20_000)

  it('accepts the same invitation exactly once under real PostgreSQL concurrency', async () => {
    const connectionString = requiredDatabaseUrl()
    const suffix = randomUUID().replaceAll('-', '')
    const schema = `dsh_team_it_${suffix}`
    const applicationName = `dsh-team-it-${suffix}`
    const admin = new Pool({ connectionString, max: 2, application_name: `${applicationName}-admin` })
    const pool = new Pool({
      connectionString,
      max: 4,
      application_name: applicationName,
      options: `-c search_path=${schema},public`,
    })
    const store = testStore({ pool })
    const suppliedKeys = [
      'dsh_team_concurrent-first-key-1234567890',
      'dsh_team_concurrent-second-key-1234567890',
    ] as const

    try {
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`)
      await store.initialize()
      const boot = await store.bootstrap('Invite Concurrency Team', 'Owner')
      const owner = await store.authenticateApiKey(boot.apiKey)
      if (owner === undefined) throw new Error('owner should authenticate')
      const invite = await store.createInvite(owner, 60_000, 'Concurrent join')

      const results = await Promise.allSettled(suppliedKeys.map((apiKey, index) =>
        store.acceptInviteWithApiKey(invite.inviteToken, `Friend ${index + 1}`, apiKey)))
      const succeededIndex = results.findIndex(result => result.status === 'fulfilled')
      const failedIndex = results.findIndex(result => result.status === 'rejected')

      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
      expect(String((results[failedIndex] as PromiseRejectedResult | undefined)?.reason)).toMatch(/invite is invalid or expired/iu)
      const memberCount = await pool.query<{ count: string }>('SELECT COUNT(*) AS count FROM team_members WHERE team_id = $1', [owner.teamId])
      expect(Number(memberCount.rows[0]?.count)).toBe(2)
      const inviteRow = await pool.query<{ status: string }>('SELECT status FROM team_invites WHERE id = $1', [invite.invite.id])
      expect(inviteRow.rows).toEqual([{ status: 'accepted' }])
      await expect(store.authenticateApiKey(suppliedKeys[succeededIndex]!)).resolves.toMatchObject({ role: 'member' })
      await expect(store.authenticateApiKey(suppliedKeys[failedIndex]!)).resolves.toBeUndefined()
    } finally {
      await pool.end().catch(() => undefined)
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch(() => undefined)
      await admin.end().catch(() => undefined)
    }
  }, 20_000)

  it('enforces one invitation reveal window across real PostgreSQL Host replicas', async () => {
    const connectionString = requiredDatabaseUrl()
    const suffix = randomUUID().replaceAll('-', '')
    const schema = `dsh_team_it_${suffix}`
    const applicationName = `dsh-team-it-${suffix}`
    const admin = new Pool({ connectionString, max: 2, application_name: `${applicationName}-admin` })
    const pool = new Pool({
      connectionString,
      max: TEAM_INVITE_REVEAL_RATE_LIMIT_MAX_ATTEMPTS + 2,
      application_name: applicationName,
      options: `-c search_path=${schema},public`,
    })
    const now = 180_000
    const firstHost = testStore({ pool, now: () => now })
    const secondHost = testStore({ pool, now: () => now })

    try {
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`)
      await firstHost.initialize()
      await secondHost.initialize()
      const boot = await firstHost.bootstrap('Reveal Concurrency Team', 'Owner')
      const owner = await secondHost.authenticateApiKey(boot.apiKey)
      if (owner === undefined) throw new Error('owner should authenticate')
      const invite = await firstHost.createInvite(
        owner,
        2 * TEAM_INVITE_REVEAL_RATE_LIMIT_WINDOW_MS,
        'Concurrent reveal',
      )

      const results = await Promise.allSettled(Array.from(
        { length: TEAM_INVITE_REVEAL_RATE_LIMIT_MAX_ATTEMPTS + 1 },
        (_, index) => (index % 2 === 0 ? firstHost : secondHost).revealInvite(owner, invite.invite.id),
      ))
      const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')

      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(
        TEAM_INVITE_REVEAL_RATE_LIMIT_MAX_ATTEMPTS,
      )
      expect(rejected).toHaveLength(1)
      expect(rejected[0]?.reason).toBeInstanceOf(TeamInviteRevealRateLimitError)
      expect(rejected[0]?.reason).toMatchObject({
        retryAfterSeconds: TEAM_INVITE_REVEAL_RATE_LIMIT_WINDOW_MS / 1_000,
      })
      await expect(pool.query(`
        SELECT attempt_count
        FROM team_invite_reveal_rate_limits
        WHERE team_id = $1 AND actor_member_id = $2 AND invite_id = $3
      `, [owner.teamId, owner.memberId, invite.invite.id])).resolves.toMatchObject({
        rows: [{ attempt_count: TEAM_INVITE_REVEAL_RATE_LIMIT_MAX_ATTEMPTS + 1 }],
      })
      await expect(pool.query(
        'SELECT COUNT(*) AS count FROM team_invite_reveal_audit_events WHERE team_id = $1 AND invite_id = $2',
        [owner.teamId, invite.invite.id],
      )).resolves.toMatchObject({ rows: [{ count: String(TEAM_INVITE_REVEAL_RATE_LIMIT_MAX_ATTEMPTS) }] })
    } finally {
      await pool.end().catch(() => undefined)
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch(() => undefined)
      await admin.end().catch(() => undefined)
    }
  }, 20_000)

  it('atomically enforces one dissolution recovery window across real PostgreSQL Host replicas', async () => {
    const connectionString = requiredDatabaseUrl()
    const suffix = randomUUID().replaceAll('-', '')
    const schema = `dsh_team_it_${suffix}`
    const applicationName = `dsh-team-it-${suffix}`
    const admin = new Pool({ connectionString, max: 2, application_name: `${applicationName}-admin` })
    const pool = new Pool({
      connectionString,
      max: TEAM_DISSOLUTION_RECOVERY_RATE_LIMIT_MAX_ATTEMPTS + 2,
      application_name: applicationName,
      options: `-c search_path=${schema},public`,
    })
    const now = 180_000
    const firstHost = testStore({ pool, now: () => now })
    const secondHost = testStore({ pool, now: () => now })
    const sourceDigest = 'd'.repeat(64)

    try {
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`)
      await firstHost.initialize()
      await secondHost.initialize()

      const results = await Promise.allSettled(Array.from(
        { length: TEAM_DISSOLUTION_RECOVERY_RATE_LIMIT_MAX_ATTEMPTS + 1 },
        (_, index) => (index % 2 === 0 ? firstHost : secondHost)
          .consumeDissolutionRecoveryAttempt(sourceDigest, 'result'),
      ))
      const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(
        TEAM_DISSOLUTION_RECOVERY_RATE_LIMIT_MAX_ATTEMPTS,
      )
      expect(rejected).toHaveLength(1)
      expect(rejected[0]?.reason).toBeInstanceOf(TeamDissolutionRecoveryRateLimitError)
      expect(rejected[0]?.reason.retryAfterSeconds).toBeGreaterThanOrEqual(1)
      expect(rejected[0]?.reason.retryAfterSeconds).toBeLessThanOrEqual(
        TEAM_DISSOLUTION_RECOVERY_RATE_LIMIT_WINDOW_MS / 1_000,
      )
      await expect(pool.query(`
        SELECT attempt_count
        FROM team_dissolution_recovery_rate_limits
        WHERE source_digest = $1 AND action = 'result'
      `, [sourceDigest])).resolves.toMatchObject({
        rows: [{ attempt_count: TEAM_DISSOLUTION_RECOVERY_RATE_LIMIT_MAX_ATTEMPTS + 1 }],
      })
      await expect(firstHost.consumeDissolutionRecoveryAttempt(sourceDigest, 'ack')).resolves.toBeUndefined()
    } finally {
      await pool.end().catch(() => undefined)
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch(() => undefined)
      await admin.end().catch(() => undefined)
    }
  }, 20_000)

  it('does not let emergency pause return between usage admission and its durable insert', async () => {
    const connectionString = requiredDatabaseUrl()
    const suffix = randomUUID().replaceAll('-', '')
    const schema = `dsh_team_it_${suffix}`
    const applicationName = `dsh-team-it-${suffix}`
    const lockNamespace = randomInt(1, 2_147_483_647)
    const lockKey = randomInt(1, 2_147_483_647)
    const admin = new Pool({ connectionString, max: 3, application_name: `${applicationName}-admin` })
    const pool = new Pool({
      connectionString,
      max: 5,
      application_name: applicationName,
      options: `-c search_path=${schema},public`,
    })
    const store = testStore({ pool })
    let control: PoolClient | undefined
    let advisoryLockHeld = false
    let usagePromise: Promise<unknown> | undefined
    let pausePromise: Promise<unknown> | undefined

    try {
      control = await admin.connect()
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`)
      await store.initialize()
      const boot = await store.bootstrap('Concurrency Team', 'Owner')
      const owner = await store.authenticateApiKey(boot.apiKey)
      if (owner === undefined) throw new Error('owner should authenticate')
      const created = await store.createContributionAccount(owner, 'Owner Codex')
      const contribution = await store.setContributionAccountStatus(owner.teamId, created.id, 'active')

      await pool.query(`
        CREATE FUNCTION block_usage_insert_for_test() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(${lockNamespace}, ${lockKey});
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER block_usage_insert_for_test
          BEFORE INSERT ON team_usage_events
          FOR EACH ROW EXECUTE FUNCTION block_usage_insert_for_test();
      `)
      await control.query('SELECT pg_advisory_lock($1::integer, $2::integer)', [lockNamespace, lockKey])
      advisoryLockHeld = true

      usagePromise = store.beginUsageEvent(owner, 'usage-before-pause', contribution.id, 'gpt-5-codex')
      await waitForAdvisoryLockWait(admin, applicationName)

      let pauseSettled = false
      pausePromise = lifecycleStore(store).setTeamStatus(owner, {
        operationId: '00000000-0000-4000-8000-000000001501',
        expectedLifecycleRevision: 1,
        status: 'paused',
      }).then((value) => {
        pauseSettled = true
        return value
      })
      await waitForTeamUpdateLockWait(admin, applicationName)
      expect(pauseSettled).toBe(false)

      await control.query('SELECT pg_advisory_unlock($1::integer, $2::integer)', [lockNamespace, lockKey])
      advisoryLockHeld = false
      await expect(usagePromise).resolves.toMatchObject({ id: 'usage-before-pause', status: 'in_progress' })
      await expect(pausePromise).resolves.toMatchObject({ id: owner.teamId, status: 'paused' })

      await expect(store.beginUsageEvent(owner, 'usage-after-pause', contribution.id, 'gpt-5-codex'))
        .rejects.toThrow('team is paused')
      const usageCount = await pool.query<{ count: string }>('SELECT COUNT(*) AS count FROM team_usage_events')
      expect(Number(usageCount.rows[0]?.count)).toBe(1)
    } finally {
      if (advisoryLockHeld) {
        await control?.query('SELECT pg_advisory_unlock($1::integer, $2::integer)', [lockNamespace, lockKey]).catch(() => undefined)
      }
      await Promise.allSettled([usagePromise, pausePromise].filter(isPromise))
      control?.release()
      await pool.end().catch(() => undefined)
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch(() => undefined)
      await admin.end().catch(() => undefined)
    }
  }, 20_000)

  it('serializes refresh-token mutation across Host replicas inside the Team-first credential scope', async () => {
    const connectionString = requiredDatabaseUrl()
    const suffix = randomUUID().replaceAll('-', '')
    const schema = `dsh_team_it_${suffix}`
    const applicationName = `dsh-team-it-${suffix}`
    const admin = new Pool({ connectionString, max: 2, application_name: `${applicationName}-admin` })
    const pool = new Pool({
      connectionString,
      max: 4,
      application_name: applicationName,
      options: `-c search_path=${schema},public`,
    })
    const store = testStore({ pool })
    const provider = new Aes256GcmTeamKeyEncryptionProvider(Buffer.alloc(32, 0x41))
    const backend = new PostgresTeamEnvelopeCredentialBackend({ pool, keyEncryptionProvider: provider })
    const firstEntered = deferred<void>()
    const releaseFirst = deferred<void>()
    let firstPromise: Promise<unknown> | undefined
    let secondPromise: Promise<unknown> | undefined
    let secondSawRefresh: string | undefined

    try {
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`)
      await store.initialize()
      const boot = await store.bootstrap('Credential Concurrency Team', 'Owner')
      const owner = await store.authenticateApiKey(boot.apiKey)
      if (owner === undefined) throw new Error('owner should authenticate')
      const account = await store.createContributionAccount(owner, 'Owner Codex')
      const credentialStore = backend.open({ teamId: account.teamId, accountId: account.id })
      await credentialStore.addProfile('Owner Codex', {
        type: 'oauth', access: 'access-before', refresh: 'refresh-before', expires: Date.now() + 60_000, accountId: 'provider-account',
      })

      firstPromise = credentialStore.modify(OPENAI_CODEX_PROVIDER, async current => {
        if (current?.type !== 'oauth') throw new Error('OAuth credential expected')
        firstEntered.resolve()
        await releaseFirst.promise
        return { ...current, access: 'access-first', refresh: 'refresh-first' }
      })
      await firstEntered.promise

      secondPromise = backend.open({ teamId: account.teamId, accountId: account.id })
        .modify(OPENAI_CODEX_PROVIDER, async current => {
          if (current?.type !== 'oauth') throw new Error('OAuth credential expected')
          secondSawRefresh = current.refresh
          return { ...current, access: 'access-second', refresh: 'refresh-second' }
        })
      await waitForCredentialScopeLockWait(admin, applicationName)
      expect(secondSawRefresh).toBeUndefined()

      releaseFirst.resolve()
      await expect(firstPromise).resolves.toMatchObject({ refresh: 'refresh-first' })
      await expect(secondPromise).resolves.toMatchObject({ refresh: 'refresh-second' })
      expect(secondSawRefresh).toBe('refresh-first')
      await expect(credentialStore.read(OPENAI_CODEX_PROVIDER)).resolves.toMatchObject({
        access: 'access-second',
        refresh: 'refresh-second',
      })
    } finally {
      releaseFirst.resolve()
      await Promise.allSettled([firstPromise, secondPromise].filter(isPromise))
      await pool.end().catch(() => undefined)
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch(() => undefined)
      await admin.end().catch(() => undefined)
    }
  }, 20_000)

  it('blocks a credential mutation at the encrypted credential-row barrier', async () => {
    const connectionString = requiredDatabaseUrl()
    const suffix = randomUUID().replaceAll('-', '')
    const schema = `dsh_team_it_${suffix}`
    const applicationName = `dsh-team-it-${suffix}`
    const admin = new Pool({ connectionString, max: 2, application_name: `${applicationName}-admin` })
    const pool = new Pool({
      connectionString,
      max: 4,
      application_name: applicationName,
      options: `-c search_path=${schema},public`,
    })
    const store = testStore({ pool })
    const provider = new Aes256GcmTeamKeyEncryptionProvider(Buffer.alloc(32, 0x43))
    const backend = new PostgresTeamEnvelopeCredentialBackend({ pool, keyEncryptionProvider: provider })
    let control: PoolClient | undefined
    let controlInTransaction = false
    let mutationPromise: Promise<unknown> | undefined
    let mutationEntered = false

    try {
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`)
      await store.initialize()
      const boot = await store.bootstrap('Credential Row Lock Team', 'Owner')
      const owner = await store.authenticateApiKey(boot.apiKey)
      if (owner === undefined) throw new Error('owner should authenticate')
      const account = await store.createContributionAccount(owner, 'Owner Codex')
      const credentialStore = backend.open({ teamId: account.teamId, accountId: account.id })
      await credentialStore.addProfile('Owner Codex', {
        type: 'oauth', access: 'access-before', refresh: 'refresh-before', expires: Date.now() + 60_000, accountId: 'provider-account',
      })

      control = await pool.connect()
      await control.query('BEGIN')
      controlInTransaction = true
      await control.query(POSTGRES_CREDENTIAL_MUTATION_LOCK_SQL, [account.teamId, account.id])

      mutationPromise = credentialStore.modify(OPENAI_CODEX_PROVIDER, async current => {
        mutationEntered = true
        if (current?.type !== 'oauth') throw new Error('OAuth credential expected')
        return { ...current, access: 'access-after', refresh: 'refresh-after' }
      })
      await waitForCredentialRowLockWait(admin, applicationName)
      expect(mutationEntered).toBe(false)

      await control.query('COMMIT')
      controlInTransaction = false
      await expect(mutationPromise).resolves.toMatchObject({ refresh: 'refresh-after' })
      expect(mutationEntered).toBe(true)
      await expect(credentialStore.read(OPENAI_CODEX_PROVIDER)).resolves.toMatchObject({
        access: 'access-after',
        refresh: 'refresh-after',
      })
    } finally {
      if (controlInTransaction) await control?.query('ROLLBACK').catch(() => undefined)
      await Promise.allSettled([mutationPromise].filter(isPromise))
      control?.release()
      await pool.end().catch(() => undefined)
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch(() => undefined)
      await admin.end().catch(() => undefined)
    }
  }, 20_000)

  it('serializes online key rewrap with live credential mutation inside the Team-first credential scope', async () => {
    const connectionString = requiredDatabaseUrl()
    const suffix = randomUUID().replaceAll('-', '')
    const schema = `dsh_team_it_${suffix}`
    const applicationName = `dsh-team-it-${suffix}`
    const admin = new Pool({ connectionString, max: 2, application_name: `${applicationName}-admin` })
    const pool = new Pool({
      connectionString,
      max: 4,
      application_name: applicationName,
      options: `-c search_path=${schema},public`,
    })
    const store = testStore({ pool })
    const provider = new Aes256GcmTeamKeyEncryptionProvider(Buffer.alloc(32, 0x42))
    const backend = new PostgresTeamEnvelopeCredentialBackend({ pool, keyEncryptionProvider: provider })
    const rewrapEntered = deferred<void>()
    const releaseRewrap = deferred<void>()
    let rewrapPromise: Promise<unknown> | undefined
    let mutationPromise: Promise<unknown> | undefined
    let mutationEntered = false

    const blockingTarget: TeamKeyEncryptionProvider = {
      wrapKey: async (ref, plaintextKey) => {
        rewrapEntered.resolve()
        await releaseRewrap.promise
        return provider.wrapKey(ref, plaintextKey)
      },
      unwrapKey: (ref, wrappedKey) => provider.unwrapKey(ref, wrappedKey),
    }

    try {
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`)
      await store.initialize()
      const boot = await store.bootstrap('Rewrap Concurrency Team', 'Owner')
      const owner = await store.authenticateApiKey(boot.apiKey)
      if (owner === undefined) throw new Error('owner should authenticate')
      const account = await store.createContributionAccount(owner, 'Owner Codex')
      const credentialStore = backend.open({ teamId: account.teamId, accountId: account.id })
      await credentialStore.addProfile('Owner Codex', {
        type: 'oauth', access: 'access-before', refresh: 'refresh-before', expires: Date.now() + 60_000, accountId: 'provider-account',
      })

      rewrapPromise = backend.rewrapCredentialKeys({ targetKeyEncryptionProvider: blockingTarget, force: true })
      await rewrapEntered.promise
      mutationPromise = backend.open({ teamId: account.teamId, accountId: account.id })
        .modify(OPENAI_CODEX_PROVIDER, async current => {
          mutationEntered = true
          if (current?.type !== 'oauth') throw new Error('OAuth credential expected')
          return { ...current, access: 'access-after', refresh: 'refresh-after' }
        })
      await waitForCredentialScopeLockWait(admin, applicationName)
      expect(mutationEntered).toBe(false)

      releaseRewrap.resolve()
      await expect(rewrapPromise).resolves.toMatchObject({ scanned: 1, rewrapped: 1 })
      await expect(mutationPromise).resolves.toMatchObject({ refresh: 'refresh-after' })
      expect(mutationEntered).toBe(true)
      await expect(credentialStore.read(OPENAI_CODEX_PROVIDER)).resolves.toMatchObject({
        access: 'access-after',
        refresh: 'refresh-after',
      })
    } finally {
      releaseRewrap.resolve()
      await Promise.allSettled([rewrapPromise, mutationPromise].filter(isPromise))
      await pool.end().catch(() => undefined)
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch(() => undefined)
      await admin.end().catch(() => undefined)
    }
  }, 20_000)

  it('atomically admits only one request at the cross-Host API-key concurrency boundary', async () => {
    const connectionString = requiredDatabaseUrl()
    const suffix = randomUUID().replaceAll('-', '')
    const schema = `dsh_team_it_${suffix}`
    const applicationName = `dsh-team-it-${suffix}`
    const admin = new Pool({ connectionString, max: 2, application_name: `${applicationName}-admin` })
    const pool = new Pool({
      connectionString,
      max: 5,
      application_name: applicationName,
      options: `-c search_path=${schema},public`,
    })
    const store = testStore({ pool })
    const guardOptions = {
      pool,
      requestsPerMinute: 60,
      maxConcurrency: 1,
      failureThreshold: 8,
      circuitOpenMs: 60_000,
      leaseTtlMs: 60_000,
    }
    const firstGuard = new PostgresTeamTrafficGuard(guardOptions)
    const secondGuard = new PostgresTeamTrafficGuard(guardOptions)
    let control: PoolClient | undefined
    let controlInTransaction = false
    let firstPromise: ReturnType<PostgresTeamTrafficGuard['acquire']> | undefined
    let secondPromise: ReturnType<PostgresTeamTrafficGuard['acquire']> | undefined

    try {
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`)
      await store.initialize()
      const boot = await store.bootstrap('Traffic Concurrency Team', 'Owner')
      const owner = await store.authenticateApiKey(boot.apiKey)
      if (owner === undefined) throw new Error('owner should authenticate')
      const seed = await firstGuard.acquire(owner.keyId)
      await seed.finish('neutral')

      control = await pool.connect()
      await control.query('BEGIN')
      controlInTransaction = true
      const backend = await control.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      const controlPid = backend.rows[0]?.pid
      if (controlPid === undefined) throw new Error('control backend PID was not returned')
      await control.query(
        'SELECT * FROM team_api_key_traffic_state WHERE key_id = $1 FOR UPDATE',
        [owner.keyId],
      )

      firstPromise = firstGuard.acquire(owner.keyId)
      secondPromise = secondGuard.acquire(owner.keyId)
      await waitForTrafficStateLockWait(admin, applicationName, controlPid, 2)

      await control.query('COMMIT')
      controlInTransaction = false
      const results = await Promise.allSettled([firstPromise, secondPromise])
      const admitted = results.filter((result): result is PromiseFulfilledResult<Awaited<typeof firstPromise>> => result.status === 'fulfilled')
      const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      expect(admitted).toHaveLength(1)
      expect(rejected).toHaveLength(1)
      expect(rejected[0]?.reason).toBeInstanceOf(TeamTrafficGuardError)
      expect(rejected[0]?.reason).toMatchObject({ reason: 'concurrency' })
      await admitted[0]?.value?.finish('neutral')
    } finally {
      if (controlInTransaction) await control?.query('ROLLBACK').catch(() => undefined)
      await Promise.allSettled([firstPromise, secondPromise].filter(isPromise))
      control?.release()
      await pool.end().catch(() => undefined)
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch(() => undefined)
      await admin.end().catch(() => undefined)
    }
  }, 20_000)

  it('atomically admits only one shared request at the contributor daily Credits boundary', async () => {
    const connectionString = requiredDatabaseUrl()
    const suffix = randomUUID().replaceAll('-', '')
    const schema = `dsh_team_it_${suffix}`
    const applicationName = `dsh-team-it-${suffix}`
    const admin = new Pool({ connectionString, max: 2, application_name: `${applicationName}-admin` })
    const pool = new Pool({
      connectionString,
      max: 5,
      application_name: applicationName,
      options: `-c search_path=${schema},public`,
    })
    const store = testStore({ pool, now: () => Date.UTC(2026, 7, 20, 12) })
    let control: PoolClient | undefined
    let controlInTransaction = false
    let firstPromise: ReturnType<PostgresTeamStore['beginUsageEvent']> | undefined
    let secondPromise: ReturnType<PostgresTeamStore['beginUsageEvent']> | undefined

    try {
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`)
      await store.initialize()
      const boot = await store.bootstrap('Credits Concurrency Team', 'Owner')
      const owner = await store.authenticateApiKey(boot.apiKey)
      if (owner === undefined) throw new Error('owner should authenticate')
      const invite = await store.createInvite(owner, 60_000)
      const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
      const friend = await store.authenticateApiKey(joined.apiKey)
      if (friend === undefined) throw new Error('friend should authenticate')
      const created = await store.createContributionAccount(owner, 'Owner Codex')
      await store.updateContributionAccount(owner, created.id, { dailySharedCreditLimit: 50_000 })
      const account = await store.setContributionAccountStatus(owner.teamId, created.id, 'active')

      control = await pool.connect()
      await control.query('BEGIN')
      controlInTransaction = true
      const backend = await control.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      const controlPid = backend.rows[0]?.pid
      if (controlPid === undefined) throw new Error('control backend PID was not returned')
      await control.query('SELECT * FROM team_contributions WHERE id = $1 AND team_id = $2 FOR UPDATE', [account.id, owner.teamId])

      firstPromise = store.beginUsageEvent(friend, 'credits-first', account.id, 'gpt-5-codex', 50_000)
      secondPromise = store.beginUsageEvent(friend, 'credits-second', account.id, 'gpt-5-codex', 50_000)
      await waitForContributionLockWait(admin, applicationName, controlPid, 2)

      await control.query('COMMIT')
      controlInTransaction = false
      const results = await Promise.allSettled([firstPromise, secondPromise])
      const admitted = results.filter(result => result.status === 'fulfilled')
      const rejected = results.filter(result => result.status === 'rejected')
      expect(admitted).toHaveLength(1)
      expect(rejected).toHaveLength(1)
      expect(String((rejected[0] as PromiseRejectedResult | undefined)?.reason)).toMatch(/daily shared Credits limit/iu)
      const rows = await pool.query<{ reserved_credits: string; status: string }>(
        'SELECT reserved_credits, status FROM team_usage_events WHERE upstream_account_id = $1',
        [account.id],
      )
      expect(rows.rows).toEqual([{ reserved_credits: '50000', status: 'in_progress' }])
    } finally {
      if (controlInTransaction) await control?.query('ROLLBACK').catch(() => undefined)
      await Promise.allSettled([firstPromise, secondPromise].filter(isPromise))
      control?.release()
      await pool.end().catch(() => undefined)
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch(() => undefined)
      await admin.end().catch(() => undefined)
    }
  }, 20_000)

  it('serializes Team dissolution with API-key issuance at the Team-first barrier', async () => {
    await assertDissolutionSerializesWithCreation('api-key')
  }, 20_000)

  it('serializes Team dissolution with contribution creation at the Team-first barrier', async () => {
    await assertDissolutionSerializesWithCreation('contribution')
  }, 20_000)

  it('serializes Team dissolution before a late cross-Host credential write', async () => {
    const connectionString = requiredDatabaseUrl()
    const suffix = randomUUID().replaceAll('-', '')
    const schema = `dsh_team_it_${suffix}`
    const applicationName = `dsh-team-it-${suffix}`
    const admin = new Pool({ connectionString, max: 2, application_name: `${applicationName}-admin` })
    const pool = new Pool({
      connectionString,
      max: 5,
      application_name: applicationName,
      options: `-c search_path=${schema},public`,
    })
    const store = testStore({ pool })
    const backend = new PostgresTeamEnvelopeCredentialBackend({
      pool,
      keyEncryptionProvider: new Aes256GcmTeamKeyEncryptionProvider(Buffer.alloc(32, 0x43)),
    })
    let control: PoolClient | undefined
    let controlInTransaction = false
    let dissolutionPromise: Promise<TestPostgresTeamDissolutionResult> | undefined
    let credentialPromise: Promise<unknown> | undefined

    try {
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`)
      await store.initialize()
      const boot = await store.bootstrap('Credential Dissolution Race Team', 'Owner')
      const owner = await store.authenticateApiKey(boot.apiKey)
      if (owner === undefined) throw new Error('owner should authenticate')
      const account = await store.createContributionAccount(owner, 'Owner Codex')

      control = await pool.connect()
      await control.query('BEGIN')
      controlInTransaction = true
      const controlBackend = await control.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      const controlPid = controlBackend.rows[0]?.pid
      if (controlPid === undefined) throw new Error('control backend PID was not returned')
      await control.query('SELECT * FROM teams WHERE id = $1 FOR UPDATE', [owner.teamId])

      dissolutionPromise = lifecycleStore(store).dissolveTeam(owner, {
        operationId: '00000000-0000-4000-8000-000000001504',
        expectedLifecycleRevision: 1,
        confirmationName: 'Credential Dissolution Race Team',
        recoverySecretHash: TEST_ONLY_RECOVERY_SECRET_HASH,
      })
      await waitForTeamLifecycleLockWait(admin, applicationName, controlPid, 1)
      credentialPromise = backend.open({ teamId: account.teamId, accountId: account.id }).addProfile('Owner Codex', {
        type: 'oauth',
        access: 'late-access-secret',
        refresh: 'late-refresh-secret',
        expires: Date.now() + 60_000,
        accountId: 'provider-account',
      })
      await waitForTeamLifecycleLockWait(admin, applicationName, controlPid, 2)

      await control.query('COMMIT')
      controlInTransaction = false
      await expect(dissolutionPromise).resolves.toMatchObject({ status: 'dissolved' })
      await expect(credentialPromise).rejects.toThrow(/credential.*unavailable/iu)
      await expect(pool.query(
        'SELECT COUNT(*) AS count FROM team_contribution_credentials WHERE team_id = $1',
        [owner.teamId],
      )).resolves.toMatchObject({ rows: [{ count: '0' }] })
    } finally {
      if (controlInTransaction) await control?.query('ROLLBACK').catch(() => undefined)
      await Promise.allSettled([dissolutionPromise, credentialPromise].filter(isPromise))
      control?.release()
      await backend.dispose().catch(() => undefined)
      await pool.end().catch(() => undefined)
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch(() => undefined)
      await admin.end().catch(() => undefined)
    }
  }, 20_000)
})

async function assertDissolutionSerializesWithCreation(
  kind: 'api-key' | 'contribution',
): Promise<void> {
  const connectionString = requiredDatabaseUrl()
  const suffix = randomUUID().replaceAll('-', '')
  const schema = `dsh_team_it_${suffix}`
  const applicationName = `dsh-team-it-${suffix}`
  const admin = new Pool({ connectionString, max: 2, application_name: `${applicationName}-admin` })
  const pool = new Pool({
    connectionString,
    max: 5,
    application_name: applicationName,
    options: `-c search_path=${schema},public`,
  })
  const store = testStore({ pool })
  let control: PoolClient | undefined
  let controlInTransaction = false
  let dissolutionPromise: Promise<TestPostgresTeamDissolutionResult> | undefined
  let mutationPromise: Promise<unknown> | undefined

  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`)
    await store.initialize()
    const boot = await store.bootstrap('Dissolution Race Team', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner should authenticate')

    control = await pool.connect()
    await control.query('BEGIN')
    controlInTransaction = true
    const backend = await control.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
    const controlPid = backend.rows[0]?.pid
    if (controlPid === undefined) throw new Error('control backend PID was not returned')
    await control.query('SELECT * FROM teams WHERE id = $1 FOR UPDATE', [owner.teamId])

    dissolutionPromise = lifecycleStore(store).dissolveTeam(owner, {
      operationId: kind === 'api-key'
        ? '00000000-0000-4000-8000-000000001502'
        : '00000000-0000-4000-8000-000000001503',
      expectedLifecycleRevision: 1,
      confirmationName: 'Dissolution Race Team',
      recoverySecretHash: TEST_ONLY_RECOVERY_SECRET_HASH,
    })
    mutationPromise = kind === 'api-key'
      ? store.issueApiKey(owner, 'Concurrent device')
      : store.createContributionAccount(owner, 'Concurrent contribution')
    await waitForTeamLifecycleLockWait(admin, applicationName, controlPid, 2)

    await control.query('COMMIT')
    controlInTransaction = false
    const [dissolutionResult, mutationResult] = await Promise.allSettled([
      dissolutionPromise,
      mutationPromise,
    ])
    if (dissolutionResult.status === 'rejected') throw dissolutionResult.reason
    expect(dissolutionResult.value).toMatchObject({
      teamId: owner.teamId,
      teamName: 'Dissolution Race Team',
      status: 'dissolved',
      lifecycleRevision: 2,
    })
    if (mutationResult.status === 'rejected') {
      expect(String(mutationResult.reason)).toMatch(/dissolv|auth|member|not found|no longer valid/iu)
      expect(String(mutationResult.reason)).not.toMatch(/deadlock detected/iu)
    }

    await expect(pool.query(
      'SELECT status, lifecycle_revision FROM teams WHERE id = $1',
      [owner.teamId],
    )).resolves.toMatchObject({ rows: [{ status: 'dissolved', lifecycle_revision: 2 }] })
    await expect(pool.query(
      'SELECT COUNT(*) AS count FROM team_api_keys WHERE team_id = $1 AND revoked_at IS NULL',
      [owner.teamId],
    )).resolves.toMatchObject({ rows: [{ count: '0' }] })
    await expect(pool.query(
      "SELECT COUNT(*) AS count FROM team_contributions WHERE team_id = $1 AND status <> 'revoked'",
      [owner.teamId],
    )).resolves.toMatchObject({ rows: [{ count: '0' }] })
    await expect(lifecycleStore(store).diagnoseApiKey(boot.apiKey))
      .resolves.toEqual({ code: 'team_dissolved' })

    if (mutationResult.status === 'fulfilled' && kind === 'api-key') {
      const issued = mutationResult.value as Awaited<ReturnType<PostgresTeamStore['issueApiKey']>>
      await expect(lifecycleStore(store).diagnoseApiKey(issued.token))
        .resolves.toEqual({ code: 'team_dissolved' })
    }
    if (mutationResult.status === 'fulfilled' && kind === 'contribution') {
      const created = mutationResult.value as Awaited<ReturnType<PostgresTeamStore['createContributionAccount']>>
      await expect(pool.query(
        'SELECT status FROM team_contributions WHERE id = $1',
        [created.id],
      )).resolves.toMatchObject({ rows: [{ status: 'revoked' }] })
    }
  } finally {
    if (controlInTransaction) await control?.query('ROLLBACK').catch(() => undefined)
    await Promise.allSettled([dissolutionPromise, mutationPromise].filter(isPromise))
    control?.release()
    await pool.end().catch(() => undefined)
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch(() => undefined)
    await admin.end().catch(() => undefined)
  }
}

async function waitForAdvisoryLockWait(pool: Pool, applicationName: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const result = await pool.query<{ waiting: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE application_name = $1
          AND wait_event_type = 'Lock'
          AND wait_event = 'advisory'
          AND query LIKE '%INSERT INTO team_usage_events%'
      ) AS waiting
    `, [applicationName])
    if (result.rows[0]?.waiting === true) return
    await delay(20)
  }
  throw new Error('usage insert did not reach the PostgreSQL advisory-lock barrier')
}

async function waitForTeamUpdateLockWait(pool: Pool, applicationName: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const result = await pool.query<Pick<LockWaitObservation, 'wait_event_type' | 'query'>>(`
      SELECT wait_event_type, query
      FROM pg_stat_activity
      WHERE application_name = $1
        AND pid <> pg_backend_pid()
    `, [applicationName])
    const waiting = result.rows.some(row => row.wait_event_type === 'Lock'
      && (row.query.startsWith('UPDATE teams SET status') || isTeamRowLockQuery(row.query)))
    if (waiting) return
    await delay(20)
  }
  throw new Error('Team pause did not reach the PostgreSQL row-lock barrier')
}

async function waitForTeamLifecycleLockWait(
  pool: Pool,
  applicationName: string,
  controlPid: number,
  expectedWaiters: number,
): Promise<void> {
  const deadline = Date.now() + 5_000
  let observed: readonly LockWaitObservation[] = []
  while (Date.now() < deadline) {
    const result = await pool.query<LockWaitObservation>(`
      SELECT pid, wait_event_type, wait_event, query, pg_blocking_pids(pid) AS blocking_pids
      FROM pg_stat_activity
      WHERE application_name = $1
        AND pid <> pg_backend_pid()
    `, [applicationName])
    observed = result.rows
    const waiters = observed.filter(row => row.wait_event_type === 'Lock'
      && isTeamRowLockQuery(row.query))
    if (waiters.length >= expectedWaiters
      && waiters.every(row => hasBlockingPath(row.pid, controlPid, observed))) return
    await delay(20)
  }
  throw new Error(`Team lifecycle mutations did not reach the Team-first row-lock barrier: ${JSON.stringify(observed)}`)
}

function isTeamRowLockQuery(query: string): boolean {
  const normalized = query.replaceAll(/\s+/gu, ' ').toLowerCase()
  return normalized.includes('from teams') && normalized.includes('for update')
}

async function waitForCredentialScopeLockWait(pool: Pool, applicationName: string): Promise<void> {
  const deadline = Date.now() + 5_000
  let observed: readonly Pick<LockWaitObservation, 'wait_event_type' | 'query'>[] = []
  while (Date.now() < deadline) {
    const result = await pool.query<Pick<LockWaitObservation, 'wait_event_type' | 'query'>>(`
      SELECT wait_event_type, query
      FROM pg_stat_activity
      WHERE application_name = $1
        AND pid <> pg_backend_pid()
    `, [applicationName])
    observed = result.rows
    if (observed.some(row => row.wait_event_type === 'Lock' && isCredentialScopeLockQuery(row.query))) return
    await delay(20)
  }
  throw new Error(`credential mutation did not reach the Team-first writable-scope barrier: ${JSON.stringify(observed)}`)
}

async function waitForCredentialRowLockWait(pool: Pool, applicationName: string): Promise<void> {
  const deadline = Date.now() + 5_000
  let observed: readonly Pick<LockWaitObservation, 'wait_event_type' | 'query'>[] = []
  while (Date.now() < deadline) {
    const result = await pool.query<Pick<LockWaitObservation, 'wait_event_type' | 'query'>>(`
      SELECT wait_event_type, query
      FROM pg_stat_activity
      WHERE application_name = $1
        AND pid <> pg_backend_pid()
    `, [applicationName])
    observed = result.rows
    if (observed.some(row => row.wait_event_type === 'Lock' && isCredentialRowLockQuery(row.query))) return
    await delay(20)
  }
  throw new Error(`credential mutation did not reach the encrypted credential-row barrier: ${JSON.stringify(observed)}`)
}

function isCredentialScopeLockQuery(query: string): boolean {
  const normalized = query.replaceAll(/\s+/gu, ' ').toLowerCase()
  return isTeamRowLockQuery(normalized)
    || (normalized.includes('from team_contributions') && normalized.includes('for update'))
    || isCredentialRowLockQuery(normalized)
}

function isCredentialRowLockQuery(query: string): boolean {
  const normalized = query.replaceAll(/\s+/gu, ' ').toLowerCase()
  return normalized.includes('from team_contribution_credentials') && normalized.includes('for update')
}

async function waitForTrafficStateLockWait(
  pool: Pool,
  applicationName: string,
  controlPid: number,
  expectedWaiters: number,
): Promise<void> {
  const deadline = Date.now() + 5_000
  let observed: readonly LockWaitObservation[] = []
  while (Date.now() < deadline) {
    const result = await pool.query<LockWaitObservation>(`
      SELECT pid, wait_event_type, wait_event, query, pg_blocking_pids(pid) AS blocking_pids
      FROM pg_stat_activity
      WHERE application_name = $1
        AND pid <> pg_backend_pid()
    `, [applicationName])
    observed = result.rows
    const waiters = observed.filter(row => row.wait_event_type === 'Lock'
      && row.query.includes('team_api_key_traffic_state'))
    if (waiters.length >= expectedWaiters
      && waiters.every(row => hasBlockingPath(row.pid, controlPid, observed))) return
    await delay(20)
  }
  throw new Error(`traffic admissions did not reach the PostgreSQL state-row lock barrier: ${JSON.stringify(observed)}`)
}

async function waitForOwnershipTransferLockWait(
  pool: Pool,
  applicationName: string,
  controlPid: number,
  expectedWaiters: number,
): Promise<void> {
  const deadline = Date.now() + 5_000
  let observed: readonly LockWaitObservation[] = []
  while (Date.now() < deadline) {
    const result = await pool.query<LockWaitObservation>(`
      SELECT pid, wait_event_type, wait_event, query, pg_blocking_pids(pid) AS blocking_pids
      FROM pg_stat_activity
      WHERE application_name = $1
        AND pid <> pg_backend_pid()
    `, [applicationName])
    observed = result.rows
    const waiters = observed.filter(row => row.wait_event_type === 'Lock'
      && row.query.includes('SELECT * FROM teams WHERE id')
      && row.query.includes('FOR UPDATE'))
    if (waiters.length >= expectedWaiters
      && waiters.every(row => hasBlockingPath(row.pid, controlPid, observed))) return
    await delay(20)
  }
  throw new Error(`ownership transfers did not reach the PostgreSQL owner-row lock barrier: ${JSON.stringify(observed)}`)
}

async function waitForContributionLockWait(
  pool: Pool,
  applicationName: string,
  controlPid: number,
  expectedWaiters: number,
): Promise<void> {
  const deadline = Date.now() + 5_000
  let observed: readonly LockWaitObservation[] = []
  while (Date.now() < deadline) {
    const result = await pool.query<LockWaitObservation>(`
      SELECT pid, wait_event_type, wait_event, query, pg_blocking_pids(pid) AS blocking_pids
      FROM pg_stat_activity
      WHERE application_name = $1
        AND pid <> pg_backend_pid()
    `, [applicationName])
    observed = result.rows
    const waiters = observed.filter(row => row.wait_event_type === 'Lock'
      && row.query.includes('SELECT * FROM team_contributions WHERE id')
      && row.query.includes('FOR UPDATE'))
    if (waiters.length >= expectedWaiters
      && waiters.every(row => hasBlockingPath(row.pid, controlPid, observed))) return
    await delay(20)
  }
  throw new Error(`Credits admissions did not reach the PostgreSQL contribution-row lock barrier: ${JSON.stringify(observed)}`)
}

interface LockWaitObservation {
  readonly pid: number
  readonly wait_event_type: string | null
  readonly wait_event: string | null
  readonly query: string
  readonly blocking_pids: number[]
}

function hasBlockingPath(
  waiterPid: number,
  controlPid: number,
  observations: readonly LockWaitObservation[],
  visited: ReadonlySet<number> = new Set(),
): boolean {
  if (waiterPid === controlPid) return true
  if (visited.has(waiterPid)) return false
  const current = observations.find(row => row.pid === waiterPid)
  if (current === undefined) return false
  const nextVisited = new Set(visited).add(waiterPid)
  return current.blocking_pids.some(blockerPid => blockerPid === controlPid
    || hasBlockingPath(blockerPid, controlPid, observations, nextVisited))
}

function cleanDatabaseUrl(value: string | undefined): string | undefined {
  const result = value?.trim()
  return result === undefined || result.length === 0 ? undefined : result
}

function requiredDatabaseUrl(): string {
  if (databaseUrl === undefined) throw new Error('DSH_TEAM_POSTGRES_TEST_URL is required')
  return databaseUrl
}

async function applyTeamMigrationsThrough(pool: Pool, lastVersion: number): Promise<void> {
  await pool.query(`
    CREATE TABLE team_schema_migrations (
      version integer PRIMARY KEY,
      applied_at bigint NOT NULL
    )
  `)
  for (const migration of POSTGRES_TEAM_MIGRATIONS) {
    if (migration.version > lastVersion) continue
    await pool.query(migration.sql)
    await pool.query(
      'INSERT INTO team_schema_migrations (version, applied_at) VALUES ($1, $2)',
      [migration.version, migration.version],
    )
  }
}

function quoteIdentifier(value: string): string {
  if (!/^dsh_team_it_[a-f0-9]{32}$/u.test(value)) throw new Error('unsafe PostgreSQL integration schema name')
  return `"${value}"`
}

function quoteRuntimeRoleIdentifier(value: string): string {
  if (!/^dsh_team_it_(?:host|broker|public)_[a-f0-9]{32}$/u.test(value)) {
    throw new Error('unsafe PostgreSQL integration role name')
  }
  return `"${value}"`
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function isPromise(value: Promise<unknown> | undefined): value is Promise<unknown> {
  return value !== undefined
}

function deferred<T>(): { promise: Promise<T>; resolve(value?: T): void } {
  let resolvePromise: (value: T) => void = () => undefined
  const promise = new Promise<T>(resolve => { resolvePromise = resolve })
  return {
    promise,
    resolve: value => resolvePromise(value as T),
  }
}
