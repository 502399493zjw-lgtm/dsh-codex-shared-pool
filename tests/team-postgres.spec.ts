import { createHash } from 'node:crypto'
import { DataType, newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { TeamInviteCipher } from '../src/team/invite-cipher.ts'
import type { TeamInviteKeyEncryptionProvider } from '../src/team/invite-cipher.ts'
import { Aes256GcmTeamInviteKeyEncryptionProvider } from '../src/team/invite-key-encryption.ts'
import {
  TEAM_DISSOLUTION_RECOVERY_RATE_LIMIT_MAX_ATTEMPTS,
  TEAM_DISSOLUTION_RECOVERY_RATE_LIMIT_WINDOW_MS,
  TEAM_INVITE_REVEAL_RATE_LIMIT_MAX_ATTEMPTS,
  TEAM_INVITE_REVEAL_RATE_LIMIT_WINDOW_MS,
  TeamDissolutionRecoveryRateLimitError,
  TeamInviteRevealRateLimitError,
} from '../src/team/store.ts'
import {
  POSTGRES_BEGIN_USAGE_TEAM_LOCK_SQL,
  POSTGRES_TEAM_MIGRATION_12_AFFECTED_TEAMS_SQL,
  POSTGRES_TEAM_MIGRATION_12_AUDIT_TABLE_SQL,
  POSTGRES_TEAM_MIGRATION_12_ELIGIBLE_OWNERS_SQL,
  POSTGRES_TEAM_MIGRATION_12_LOCK_SQL,
  POSTGRES_TEAM_MIGRATION_20_FINALIZE_SQL,
  POSTGRES_TEAM_MIGRATION_20_LOCK_SQL,
  POSTGRES_TEAM_MIGRATION_20_PREPARE_SQL,
  POSTGRES_TEAM_MIGRATIONS,
  PostgresTeamStore,
} from '../src/team/postgres-store.ts'

function testInviteCipher(): TeamInviteCipher {
  return new TeamInviteCipher({
    keyEncryptionProvider: new Aes256GcmTeamInviteKeyEncryptionProvider(Buffer.alloc(32, 0x5a)),
  })
}

function blockingRevealCipher(): {
  cipher: TeamInviteCipher
  decryptStarted: Promise<void>
  releaseDecrypt: () => void
} {
  const delegate = new Aes256GcmTeamInviteKeyEncryptionProvider(Buffer.alloc(32, 0x5a))
  let signalDecryptStarted!: () => void
  let releaseDecrypt!: () => void
  const decryptStarted = new Promise<void>(resolve => { signalDecryptStarted = resolve })
  const decryptReleased = new Promise<void>(resolve => { releaseDecrypt = resolve })
  const keyEncryptionProvider: TeamInviteKeyEncryptionProvider = {
    wrapKey: (context, plaintextKey) => delegate.wrapKey(context, plaintextKey),
    unwrapKey: async (context, wrappedKey) => {
      signalDecryptStarted()
      await decryptReleased
      return delegate.unwrapKey(context, wrappedKey)
    },
  }
  return {
    cipher: new TeamInviteCipher({ keyEncryptionProvider }),
    decryptStarted,
    releaseDecrypt,
  }
}

function testStore(options: ConstructorParameters<typeof PostgresTeamStore>[0]): PostgresTeamStore {
  return new PostgresTeamStore({ ...options, inviteCipher: options.inviteCipher ?? testInviteCipher() })
}

type TestPostgresTeamAuthContext = NonNullable<Awaited<ReturnType<PostgresTeamStore['authenticateApiKey']>>>

interface TestPostgresTeamLifecycleSummary {
  readonly id: string
  readonly name: string
  readonly status: 'active' | 'paused' | 'dissolved'
  readonly lifecycleRevision: number
  readonly createdAt: number
}

interface TestPostgresTeamLifecycleTransitionInput {
  readonly operationId: string
  readonly expectedLifecycleRevision: number
  readonly status: 'active' | 'paused'
}

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

interface TestPostgresTeamDissolutionRecoveryResult {
  readonly operationType: 'team_dissolution'
  readonly status: 'dissolved'
}

interface TestPostgresTeamLifecycleStore {
  setTeamStatus(
    auth: TestPostgresTeamAuthContext,
    input: TestPostgresTeamLifecycleTransitionInput,
  ): Promise<TestPostgresTeamLifecycleSummary>
  dissolveTeam(
    auth: TestPostgresTeamAuthContext,
    input: TestPostgresTeamDissolutionInput,
  ): Promise<TestPostgresTeamDissolutionResult>
  recoverTeamDissolution(operationId: string, recoverySecret: string): Promise<TestPostgresTeamDissolutionRecoveryResult>
  ackTeamDissolution(operationId: string, recoverySecret: string): Promise<void>
  diagnoseApiKey(token: string): Promise<{
    readonly code: 'member_removed' | 'member_left' | 'team_dissolved' | 'device_revoked'
  } | undefined>
}

const TEST_ONLY_RECOVERY_SECRET = 'test-only-postgres-recovery-secret-000000000000000000000000000000000000000000000000'
const TEST_ONLY_WRONG_RECOVERY_SECRET = 'test-only-postgres-wrong-secret-000000000000000000000000000000000000000000000000'
const TEST_ONLY_RECOVERY_SECRET_HASH = createHash('sha256').update(TEST_ONLY_RECOVERY_SECRET).digest('hex')

function lifecycleStore(store: PostgresTeamStore): TestPostgresTeamLifecycleStore {
  return store as unknown as TestPostgresTeamLifecycleStore
}

async function rejectedError(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => { throw new Error('expected operation to reject') },
    (error: unknown) => {
      if (!(error instanceof Error)) throw new Error('expected rejection to be an Error')
      return error
    },
  )
}

function errorFingerprint(error: Error): {
  readonly name: string
  readonly message: string
  readonly status?: unknown
  readonly code?: unknown
} {
  const detailed = error as Error & { readonly status?: unknown; readonly code?: unknown }
  return {
    name: detailed.name,
    message: detailed.message,
    ...(detailed.status === undefined ? {} : { status: detailed.status }),
    ...(detailed.code === undefined ? {} : { code: detailed.code }),
  }
}

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

function recordTransactionSql(pool: PgPool): string[] {
  const statements: string[] = []
  const originalConnect = pool.connect.bind(pool)
  vi.spyOn(pool, 'connect').mockImplementation(async () => {
    const client = await originalConnect()
    const query = client.query.bind(client)
    return {
      query: (async (statement: unknown, values?: readonly unknown[]) => {
        const sql = typeof statement === 'string'
          ? statement
          : String((statement as { text?: unknown }).text)
        statements.push(sql)
        return query(statement as never, values as never)
      }) as typeof client.query,
      release: client.release.bind(client),
    } as typeof client
  })
  return statements
}

function ownershipTransferLockOrder(statements: readonly string[]): string[] {
  const locks = statements.flatMap((sql) => {
    if (/SELECT \* FROM teams WHERE id = \$1 FOR UPDATE/iu.test(sql)) return ['team']
    if (/SELECT \* FROM team_ownership_transfers[\s\S]+status = 'pending'[\s\S]+FOR UPDATE/iu.test(sql)) {
      return ['transfer']
    }
    if (/SELECT \* FROM team_members[\s\S]+FOR (?:SHARE|UPDATE)/iu.test(sql)) return ['member']
    if (/SELECT id FROM team_api_keys[\s\S]+FOR UPDATE/iu.test(sql)) return ['credential']
    return []
  })
  return locks.filter((lock, index) => index === 0 || lock !== locks[index - 1])
}

async function applyTeamMigrationsThrough(pool: PgPool, lastVersion: number): Promise<void> {
  await pool.query(`
    CREATE TABLE team_schema_migrations (
      version integer PRIMARY KEY,
      applied_at bigint NOT NULL
    )
  `)
  for (const migration of POSTGRES_TEAM_MIGRATIONS) {
    if (migration.version > lastVersion) continue
    if (migration.version === 12) {
      await pool.query(POSTGRES_TEAM_MIGRATION_12_AUDIT_TABLE_SQL)
    } else {
      await pool.query(migration.sql)
    }
    await pool.query(
      'INSERT INTO team_schema_migrations (version, applied_at) VALUES ($1, $2)',
      [migration.version, migration.version],
    )
  }
}

describe('PostgreSQL Team store', () => {
  it('skips schema DDL when every migration is already present for a restricted runtime role', async () => {
    const query = vi.fn(async () => ({
      rows: POSTGRES_TEAM_MIGRATIONS.map(migration => ({ version: migration.version })),
    }))
    const connect = vi.fn(async () => { throw new Error('restricted runtime must not enter the migration transaction') })
    const pool = { query, connect, end: vi.fn(async () => undefined) } as unknown as PgPool
    const store = testStore({ pool })

    await expect(store.initialize()).resolves.toBeUndefined()
    expect(query).toHaveBeenCalledWith(expect.stringMatching(/team_schema_migrations/iu), [
      POSTGRES_TEAM_MIGRATIONS.map(migration => migration.version),
    ])
    expect(connect).not.toHaveBeenCalled()
  })

  it('locks the Team row while deciding whether a new usage event may start', () => {
    expect(POSTGRES_BEGIN_USAGE_TEAM_LOCK_SQL).toMatch(/FOR SHARE/iu)
  })

  it('adds the versioned Credits ledger columns in migration 7', () => {
    const migration = POSTGRES_TEAM_MIGRATIONS.find(item => item.version === 7)
    expect(migration?.sql).toMatch(/daily_shared_credit_limit/iu)
    expect(migration?.sql).toMatch(/reserved_credits/iu)
    expect(migration?.sql).toMatch(/input_tokens/iu)
    expect(migration?.sql).toMatch(/cached_input_tokens/iu)
    expect(migration?.sql).toMatch(/output_tokens/iu)
    expect(migration?.sql).toMatch(/credits_formula_version/iu)
  })

  it('drops raw provider token counters after Credits settlement in migration 8', () => {
    const migration = POSTGRES_TEAM_MIGRATIONS.find(item => item.version === 8)
    expect(migration?.sql).toMatch(/DROP COLUMN IF EXISTS input_tokens/iu)
    expect(migration?.sql).toMatch(/DROP COLUMN IF EXISTS cached_input_tokens/iu)
    expect(migration?.sql).toMatch(/DROP COLUMN IF EXISTS output_tokens/iu)
  })

  it('adds durable invitation labels in migration 9', () => {
    const migration = POSTGRES_TEAM_MIGRATIONS.find(item => item.version === 9)
    expect(migration?.sql).toMatch(/team_invites[\s\S]+label/iu)
    expect(migration?.sql).toMatch(/NOT NULL/iu)
    expect(migration?.sql).toMatch(/DEFAULT\s+'Team invitation'/iu)
    expect(migration?.sql).not.toMatch(/DROP\s+DEFAULT/iu)
  })

  it('adds append-only membership audit events in migration 10', () => {
    const migration = POSTGRES_TEAM_MIGRATIONS.find(item => item.version === 10)
    expect(migration?.sql).toMatch(/CREATE TABLE IF NOT EXISTS team_membership_audit_events/iu)
    expect(migration?.sql).toMatch(/actor_member_id/iu)
    expect(migration?.sql).toMatch(/target_member_id/iu)
    expect(migration?.sql).toMatch(/previous_role/iu)
    expect(migration?.sql).toMatch(/next_role/iu)
  })

  it('adds nullable token and catalog-priced cost fields in migration 11', () => {
    const migration = POSTGRES_TEAM_MIGRATIONS.find(item => item.version === 11)
    expect(migration?.sql).toMatch(/ADD COLUMN IF NOT EXISTS total_tokens bigint/iu)
    expect(migration?.sql).toMatch(/ADD COLUMN IF NOT EXISTS estimated_cost_usd_micros bigint/iu)
    expect(migration?.sql).toMatch(/ADD COLUMN IF NOT EXISTS pricing_catalog_version text/iu)
    expect(migration?.sql).toMatch(/CHECK \(total_tokens IS NULL OR total_tokens BETWEEN 0 AND 2000000000\)/iu)
    expect(migration?.sql).toMatch(/CHECK \(estimated_cost_usd_micros IS NULL OR estimated_cost_usd_micros >= 0\)/iu)
    expect(migration?.sql).toMatch(/CHECK \(pricing_catalog_version IS NULL OR char_length\(pricing_catalog_version\) BETWEEN 1 AND 128\)/iu)
    expect(migration?.sql).toMatch(/CHECK \([\s\S]*estimated_cost_usd_micros IS NULL[\s\S]*OR[\s\S]*total_tokens IS NOT NULL[\s\S]*pricing_catalog_version IS NOT NULL[\s\S]*\)/iu)
    expect(migration?.sql).toMatch(/CREATE INDEX IF NOT EXISTS team_usage_events_consumer_window_idx\s+ON team_usage_events\(team_id, consumer_member_id, started_at\)/iu)
  })

  it('normalizes legacy active Admins and revokes non-Owner pending invites in migration 12', () => {
    const originalSchema = POSTGRES_TEAM_MIGRATIONS.find(item => item.version === 1)
    const migration = POSTGRES_TEAM_MIGRATIONS.find(item => item.version === 12)

    expect(originalSchema?.sql).toMatch(/status text NOT NULL(?:\s+CONSTRAINT\s+teams_status_check)?\s+CHECK \(status IN \('active', 'paused'\)\)/iu)
    expect(originalSchema?.sql).not.toMatch(/status text NOT NULL(?:\s+CONSTRAINT\s+teams_status_check)?\s+CHECK \(status IN \('active', 'paused', 'dissolved'\)\)/iu)
    expect(originalSchema?.sql).toMatch(/role text NOT NULL CHECK \(role IN \('owner', 'admin', 'member'\)\)/iu)
    expect(migration?.sql).toMatch(/LOCK TABLE\s+teams,\s*team_members,\s*team_invites,\s*team_api_keys\s+IN SHARE ROW EXCLUSIVE MODE/iu)
    expect(migration?.sql).toMatch(/FROM teams[\s\S]+status IN \('active', 'paused'\)/iu)
    expect(migration?.sql).toMatch(/active_owner_member_ids/iu)
    expect(migration?.sql).toMatch(/credentialed_owner_member_ids/iu)
    expect(migration?.sql).toMatch(/member\.role\s*=\s*'owner'[\s\S]+member\.status\s*=\s*'active'/iu)
    expect(migration?.sql).toMatch(/api_key\.revoked_at\s+IS NULL/iu)
    expect(migration?.sql).toMatch(/RAISE EXCEPTION[\s\S]+preflight failed/iu)
    expect(migration?.sql).toMatch(/UPDATE team_members[\s\S]+SET role\s*=\s*'member'[\s\S]+role\s*=\s*'admin'[\s\S]+status\s*=\s*'active'/iu)
    expect(migration?.sql).toMatch(/UPDATE team_invites[\s\S]+SET status\s*=\s*'revoked'[\s\S]+status\s*=\s*'pending'/iu)
    expect(migration?.sql).toMatch(/invited_by_member_id\s*<>\s*owner\.owner_member_id/iu)
    expect(migration?.sql).toMatch(/token_hash\s*=\s*'revoked:migration-12:'\s*\|\|\s*invite\.id/iu)
    expect(migration?.sql).toMatch(/CREATE TABLE IF NOT EXISTS team_role_migration_audit_events/iu)
    expect(migration?.sql).toMatch(/migration_version\s+integer\s+NOT NULL/iu)
    expect(migration?.sql).toMatch(/previous_role\s+text\s+NOT NULL[\s\S]+previous_role\s*=\s*'admin'/iu)
    expect(migration?.sql).toMatch(/next_role\s+text\s+NOT NULL[\s\S]+next_role\s*=\s*'member'/iu)
    expect(migration?.sql).not.toMatch(/team_role_migration_audit_events[\s\S]+actor_member_id/iu)
    const auditInsert = migration?.sql.indexOf('INSERT INTO team_role_migration_audit_events') ?? -1
    const roleUpdate = migration?.sql.indexOf('UPDATE team_members') ?? -1
    expect(auditInsert).toBeGreaterThan(-1)
    expect(roleUpdate).toBeGreaterThan(auditInsert)
    expect(migration?.sql).not.toMatch(/ALTER TABLE\s+team_members[\s\S]+DROP CONSTRAINT/iu)
  })

  it('adds nullable, versioned invitation-token envelopes without fabricating legacy recovery', () => {
    const migration = POSTGRES_TEAM_MIGRATIONS.find(item => item.version === 13)

    expect(migration?.sql).toMatch(/ALTER TABLE team_invites[\s\S]+envelope_version/iu)
    expect(migration?.sql).toMatch(/envelope_key_ref/iu)
    expect(migration?.sql).toMatch(/envelope_wrapped_dek/iu)
    expect(migration?.sql).toMatch(/envelope_nonce/iu)
    expect(migration?.sql).toMatch(/envelope_ciphertext/iu)
    expect(migration?.sql).toMatch(/envelope_tag/iu)
    expect(migration?.sql).toMatch(/envelope_version IS NULL OR envelope_version = 1/iu)
    expect(migration?.sql).not.toMatch(/UPDATE\s+team_invites[\s\S]+envelope_/iu)
  })

  it('adds a dedicated secret-free invitation reveal audit table in migration 14', () => {
    const migration = POSTGRES_TEAM_MIGRATIONS.find(item => item.version === 14)

    expect(migration?.sql).toMatch(/CREATE TABLE IF NOT EXISTS team_invite_reveal_audit_events/iu)
    expect(migration?.sql).toMatch(/actor_member_id/iu)
    expect(migration?.sql).toMatch(/invite_id/iu)
    expect(migration?.sql).toMatch(/created_at/iu)
    expect(migration?.sql).not.toMatch(/invite_token|token_hash|envelope|ciphertext/iu)
  })

  it('adds a durable, secret-free invitation reveal limiter in migration 15', () => {
    const migration = POSTGRES_TEAM_MIGRATIONS.find(item => item.version === 15)

    expect(migration?.sql).toMatch(/CREATE TABLE IF NOT EXISTS team_invite_reveal_rate_limits/iu)
    expect(migration?.sql).toMatch(/team_id/iu)
    expect(migration?.sql).toMatch(/actor_member_id/iu)
    expect(migration?.sql).toMatch(/invite_id/iu)
    expect(migration?.sql).toMatch(/window_started_at/iu)
    expect(migration?.sql).toMatch(/attempt_count/iu)
    expect(migration?.sql).not.toMatch(/invite_token|token_hash|envelope|ciphertext/iu)
  })

  it('adds a source-global, action-separated, secret-free dissolution recovery limiter in migration 17', () => {
    const migration = POSTGRES_TEAM_MIGRATIONS.find(item => item.version === 17)

    expect(migration?.sql).toMatch(/CREATE TABLE IF NOT EXISTS team_dissolution_recovery_rate_limits/iu)
    expect(migration?.sql).toMatch(/source_digest/iu)
    expect(migration?.sql).toMatch(/action[\s\S]+result[\s\S]+ack/iu)
    expect(migration?.sql).toMatch(/window_started_at/iu)
    expect(migration?.sql).toMatch(/attempt_count/iu)
    expect(migration?.sql).not.toMatch(/operation_id|team_id|recovery_secret|remote_address|ip_address/iu)
  })

  it('adds durable two-party ownership transfers with one pending request per Team in migration 18', () => {
    const migration = POSTGRES_TEAM_MIGRATIONS.find(item => item.version === 18)

    expect(migration?.sql).toMatch(/CREATE TABLE IF NOT EXISTS team_ownership_transfers/iu)
    expect(migration?.sql).toMatch(/status[\s\S]+pending[\s\S]+accepted[\s\S]+rejected[\s\S]+revoked[\s\S]+expired[\s\S]+canceled/iu)
    expect(migration?.sql).toMatch(/expires_at\s*=\s*created_at\s*\+\s*86400000/iu)
    expect(migration?.sql).toMatch(/acceptance_result\s+jsonb/iu)
    expect(migration?.sql).toMatch(/CREATE UNIQUE INDEX[\s\S]+team_id[\s\S]+WHERE status = 'pending'/iu)
  })

  it('adds one durable, secret-free audit event per ownership-transfer lifecycle transition in migration 19', () => {
    const migration = POSTGRES_TEAM_MIGRATIONS.find(item => item.version === 19)

    expect(migration?.sql).toMatch(/CREATE TABLE IF NOT EXISTS team_ownership_transfer_audit_events/iu)
    expect(migration?.sql).toMatch(/action[\s\S]+requested[\s\S]+accepted[\s\S]+rejected[\s\S]+revoked[\s\S]+expired[\s\S]+canceled/iu)
    expect(migration?.sql).toMatch(/UNIQUE\s*\(transfer_id,\s*action\)/iu)
    expect(migration?.sql).not.toMatch(/api.?key|token|secret|credential/iu)
  })

  it('marks migration 20 runtime-managed and exposes only fail-closed direct SQL', () => {
    const migration = POSTGRES_TEAM_MIGRATIONS.find(item => item.version === 20)

    expect(migration?.execution).toBe('runtime-managed')
    expect(migration?.sql).toMatch(/requires PostgresTeamStore\.initialize|dsh-codex-team-migrate/iu)
    expect(migration?.sql).not.toMatch(/ALTER TABLE|CREATE TABLE|CREATE UNIQUE INDEX/iu)
    expect(POSTGRES_TEAM_MIGRATION_20_PREPARE_SQL).toMatch(/ADD COLUMN IF NOT EXISTS display_name_key text/iu)
    expect(POSTGRES_TEAM_MIGRATION_20_PREPARE_SQL).toMatch(/CREATE TABLE IF NOT EXISTS team_member_display_name_migration_audit_events/iu)
    expect(POSTGRES_TEAM_MIGRATION_20_PREPARE_SQL).toMatch(/previous_display_name/iu)
    expect(POSTGRES_TEAM_MIGRATION_20_PREPARE_SQL).toMatch(/next_display_name/iu)
    expect(POSTGRES_TEAM_MIGRATION_20_PREPARE_SQL).toMatch(/repair_reason/iu)
    expect(POSTGRES_TEAM_MIGRATION_20_FINALIZE_SQL).toMatch(/ALTER COLUMN display_name_key SET NOT NULL/iu)
    expect(POSTGRES_TEAM_MIGRATION_20_FINALIZE_SQL).toMatch(
      /CREATE UNIQUE INDEX[\s\S]+ON team_members\(team_id, display_name_key\)[\s\S]+WHERE status = 'active'/iu,
    )
  })

  it('adds weekly shared-cost limits and non-negative admission reservations in migration 21', () => {
    const migration = POSTGRES_TEAM_MIGRATIONS.find(item => item.version === 21)

    expect(migration?.sql).toMatch(/weekly_shared_estimated_api_cost_limit_micros bigint/iu)
    expect(migration?.sql).toMatch(/BETWEEN 10000 AND 10000000000/iu)
    expect(migration?.sql).toMatch(/reserved_estimated_cost_usd_micros bigint NOT NULL DEFAULT 0/iu)
    expect(migration?.sql).toMatch(/reserved_estimated_cost_usd_micros >= 0/iu)
  })

  it('deterministically repairs legacy display names before establishing migration 20 uniqueness', async () => {
    const pool = testPool()
    await applyTeamMigrationsThrough(pool, 19)
    await pool.query(`
      INSERT INTO teams (id, name, status, created_at)
      VALUES ('team-display-name-migration', 'Legacy Names', 'active', 1);
      INSERT INTO team_members (id, team_id, display_name, role, status, joined_at)
      VALUES
        ('member-collision', 'team-display-name-migration', 'Straße', 'member', 'active', 1),
        ('owner-current', 'team-display-name-migration', 'STRASSE', 'owner', 'active', 9),
        ('member-removed', 'team-display-name-migration', 'strasse', 'member', 'removed', 3);
    `)
    await pool.query(`
      INSERT INTO team_members (id, team_id, display_name, role, status, joined_at)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, ['member-invalid', 'team-display-name-migration', 'Bad\u200BName', 'member', 'active', 2])

    await testStore({ pool, now: () => 20_020 }).initialize()

    const migrated = await pool.query<{
      id: string
      display_name: string
      display_name_key: string
      status: string
    }>(`
      SELECT id, display_name, display_name_key, status
      FROM team_members
      WHERE team_id = 'team-display-name-migration'
      ORDER BY id
    `)
    expect(migrated.rows).toEqual([
      {
        id: 'member-collision',
        display_name: 'Straße · 2',
        display_name_key: 'strasse · 2',
        status: 'active',
      },
      {
        id: 'member-invalid',
        display_name: expect.stringMatching(/^成员 · [a-z2-7]{10}$/u),
        display_name_key: expect.stringMatching(/^成员 · [a-z2-7]{10}$/u),
        status: 'active',
      },
      {
        id: 'member-removed',
        display_name: 'strasse',
        display_name_key: 'strasse',
        status: 'removed',
      },
      {
        id: 'owner-current',
        display_name: 'STRASSE',
        display_name_key: 'strasse',
        status: 'active',
      },
    ])
    await expect(pool.query(`
      SELECT member_id, previous_display_name, next_display_name, repair_reason, migration_version
      FROM team_member_display_name_migration_audit_events
      ORDER BY member_id
    `)).resolves.toMatchObject({
      rows: [
        {
          member_id: 'member-collision',
          previous_display_name: 'Straße',
          next_display_name: 'Straße · 2',
          repair_reason: 'collision',
          migration_version: 20,
        },
        {
          member_id: 'member-invalid',
          previous_display_name: 'Bad\u200BName',
          next_display_name: expect.stringMatching(/^成员 · [a-z2-7]{10}$/u),
          repair_reason: 'invalid',
          migration_version: 20,
        },
      ],
    })
    await expect(pool.query(`
      INSERT INTO team_members
        (id, team_id, display_name, display_name_key, role, status, joined_at)
      VALUES
        ('member-duplicate', 'team-display-name-migration', 'Strasse', 'strasse', 'member', 'active', 10)
    `)).rejects.toThrow(/unique|duplicate/iu)
    await pool.end()
  })

  it('executes migration 12 decisions and mutations against a legacy schema', async () => {
    const pool = testPool()
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
        ('owner-key-1', 'team-legacy', 'owner-current', 'owner 1', 'dsh_team_owner_1', 1, NULL, NULL, 'owner-key-hash-1'),
        ('owner-key-2', 'team-legacy', 'owner-current', 'owner 2', 'dsh_team_owner_2', 2, NULL, NULL, 'owner-key-hash-2');
      INSERT INTO team_invites
        (id, team_id, invited_by_member_id, label, status, expires_at, created_at, accepted_at, token_hash)
      VALUES
        ('invite-owner', 'team-legacy', 'owner-current', 'Owner invite', 'pending', 9999999999999, 1, NULL, 'owner-invite-hash'),
        ('invite-admin', 'team-legacy', 'admin-active', 'Admin invite', 'pending', 9999999999999, 2, NULL, 'admin-invite-hash'),
        ('invite-former-owner', 'team-legacy', 'member-former-owner', 'Former Owner invite', 'pending', 9999999999999, 3, NULL, 'former-owner-invite-hash'),
        ('invite-accepted', 'team-legacy', 'admin-active', 'Accepted invite', 'accepted', 9999999999999, 4, 5, 'accepted-invite-hash');
    `)

    const affected = await pool.query<{ team_id: string }>(POSTGRES_TEAM_MIGRATION_12_AFFECTED_TEAMS_SQL)
    expect(affected.rows).toEqual([{ team_id: 'team-legacy' }])
    await expect(pool.query<{ team_id: string; owner_member_id: string }>(
      POSTGRES_TEAM_MIGRATION_12_ELIGIBLE_OWNERS_SQL,
    )).resolves.toMatchObject({
      rows: [{ team_id: 'team-legacy', owner_member_id: 'owner-current' }],
    })

    await testStore({ pool, now: () => 12_345 }).initialize()

    await expect(pool.query('SELECT id, role FROM team_members ORDER BY id')).resolves.toMatchObject({
      rows: [
        { id: 'admin-active', role: 'member' },
        { id: 'admin-suspended', role: 'admin' },
        { id: 'member-former-owner', role: 'member' },
        { id: 'owner-current', role: 'owner' },
      ],
    })
    await expect(pool.query('SELECT id, status, token_hash, envelope_version FROM team_invites ORDER BY id')).resolves.toMatchObject({
      rows: [
        { id: 'invite-accepted', status: 'accepted', token_hash: 'accepted-invite-hash', envelope_version: null },
        { id: 'invite-admin', status: 'revoked', token_hash: 'revoked:migration-12:invite-admin', envelope_version: null },
        { id: 'invite-former-owner', status: 'revoked', token_hash: 'revoked:migration-12:invite-former-owner', envelope_version: null },
        { id: 'invite-owner', status: 'pending', token_hash: 'owner-invite-hash', envelope_version: null },
      ],
    })
    await expect(pool.query(`
      SELECT id, team_id, target_member_id, migration_version, previous_role, next_role, created_at
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
        created_at: 12_345,
      }],
    })
    await testStore({ pool, now: () => 99_999 }).initialize()
    await expect(pool.query('SELECT COUNT(*)::integer AS count FROM team_role_migration_audit_events')).resolves.toMatchObject({
      rows: [{ count: 1 }],
    })
    await expect(pool.query('SELECT version FROM team_schema_migrations WHERE version = 12')).resolves.toMatchObject({
      rows: [{ version: 12 }],
    })
    await expect(pool.query('SELECT version FROM team_schema_migrations WHERE version = 13')).resolves.toMatchObject({
      rows: [{ version: 13 }],
    })
    await expect(pool.query('SELECT version FROM team_schema_migrations WHERE version = 14')).resolves.toMatchObject({
      rows: [{ version: 14 }],
    })
    await pool.end()
  })

  it('rejects migration 12 without an active Owner credential before changing legacy data', async () => {
    const pool = testPool()
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
    await expect(pool.query("SELECT role FROM team_members WHERE id = 'admin-active'")).resolves.toMatchObject({
      rows: [{ role: 'admin' }],
    })
    await expect(pool.query("SELECT status, token_hash FROM team_invites WHERE id = 'invite-admin'")).resolves.toMatchObject({
      rows: [{ status: 'pending', token_hash: 'admin-invite-hash' }],
    })
    await expect(pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_name = 'team_role_migration_audit_events'
    `)).resolves.toMatchObject({ rows: [] })
    await expect(pool.query('SELECT version FROM team_schema_migrations WHERE version = 12')).resolves.toMatchObject({ rows: [] })
    await pool.end()
  })

  it('preflights every active or paused Team even when it has no legacy Admin or pending invite', async () => {
    const pool = testPool()
    await applyTeamMigrationsThrough(pool, 11)
    await pool.query(`
      INSERT INTO teams (id, name, status, created_at)
      VALUES
        ('team-healthy', 'Healthy Team', 'active', 1),
        ('team-paused-without-key', 'Paused Team', 'paused', 2);
      INSERT INTO team_members (id, team_id, display_name, role, status, joined_at)
      VALUES
        ('owner-healthy', 'team-healthy', 'Healthy Owner', 'owner', 'active', 1),
        ('owner-paused-without-key', 'team-paused-without-key', 'Paused Owner', 'owner', 'active', 2);
      INSERT INTO team_api_keys
        (id, team_id, member_id, label, prefix, created_at, last_used_at, revoked_at, token_hash)
      VALUES
        ('owner-healthy-key', 'team-healthy', 'owner-healthy', 'owner', 'dsh_team_owner', 1, NULL, NULL, 'owner-healthy-key-hash');
    `)

    await expect(pool.query<{ team_id: string }>(POSTGRES_TEAM_MIGRATION_12_AFFECTED_TEAMS_SQL))
      .resolves.toMatchObject({
        rows: expect.arrayContaining([
          { team_id: 'team-healthy' },
          { team_id: 'team-paused-without-key' },
        ]),
      })
    const error = await rejectedError(testStore({ pool }).initialize())
    expect(error.message).toMatch(/migration 12 preflight failed/iu)
    expect(error.message).toContain('team-paused-without-key')
    expect(error.message).toContain('owner-paused-without-key')
    await expect(pool.query('SELECT version FROM team_schema_migrations WHERE version = 12'))
      .resolves.toMatchObject({ rows: [] })
    await expect(pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_name = 'team_role_migration_audit_events'
    `)).resolves.toMatchObject({ rows: [] })
    await pool.end()
  })

  it('rejects a Team with multiple active Owners even when only one Owner has an active key', async () => {
    const pool = testPool()
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
    `)

    const error = await rejectedError(testStore({ pool }).initialize())
    expect(error.message).toMatch(/migration 12 preflight failed/iu)
    expect(error.message).toContain('team-multiple-owners')
    expect(error.message).toContain('owner-alpha')
    expect(error.message).toContain('owner-beta')
    await expect(pool.query("SELECT role FROM team_members WHERE id = 'admin-legacy'"))
      .resolves.toMatchObject({ rows: [{ role: 'admin' }] })
    await expect(pool.query('SELECT version FROM team_schema_migrations WHERE version = 12'))
      .resolves.toMatchObject({ rows: [] })
    await pool.end()
  })

  it('reports an active Team with no active Owner before migration 12 writes anything', async () => {
    const pool = testPool()
    await applyTeamMigrationsThrough(pool, 11)
    await pool.query(`
      INSERT INTO teams (id, name, status, created_at)
      VALUES ('team-without-owner', 'No Owner', 'active', 1);
      INSERT INTO team_members (id, team_id, display_name, role, status, joined_at)
      VALUES ('member-only', 'team-without-owner', 'Member', 'member', 'active', 1);
    `)

    const error = await rejectedError(testStore({ pool }).initialize())
    expect(error.message).toMatch(/migration 12 preflight failed/iu)
    expect(error.message).toContain('team-without-owner')
    expect(error.message).toContain('active_owner_member_ids=[]')
    await expect(pool.query('SELECT version FROM team_schema_migrations WHERE version = 12'))
      .resolves.toMatchObject({ rows: [] })
    await pool.end()
  })

  it('supports labeled previews, Host-supplied join keys, and member removal without role mutation', async () => {
    const pool = testPool()
    const store = testStore({ pool, inviteCipher: testInviteCipher() })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invitation = await store.createInvite(owner, 60_000, '周末协作')

    await expect(store.previewInvite(invitation.inviteToken)).resolves.toEqual({
      teamName: 'Friends', label: '周末协作', expiresAt: expect.any(Number), teamStatus: 'active',
    })
    await expect(store.previewInvite(invitation.inviteToken)).resolves.toMatchObject({ label: '周末协作' })

    const suppliedKey = 'dsh_team_host-generated-secret-1234567890'
    const joined = await store.acceptInviteWithApiKey(invitation.inviteToken, 'Friend', suppliedKey)
    expect(joined).toEqual({
      team: expect.objectContaining({ name: 'Friends' }),
      member: expect.objectContaining({ displayName: 'Friend', role: 'member' }),
    })
    const friend = await store.authenticateApiKey(suppliedKey)
    if (friend === undefined) throw new Error('supplied member key should authenticate')
    expect(store).not.toHaveProperty('updateMemberRole')

    await expect(store.removeMember(owner, friend.memberId))
      .resolves.toMatchObject({ member: { id: friend.memberId, status: 'removed' } })
    await expect(store.authenticateApiKey(suppliedKey)).resolves.toBeUndefined()
    const auditEvents = await store.listMembershipAuditEvents(owner, 10)
    expect(auditEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'role_changed' }),
    ]))
    expect(auditEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actorMemberId: owner.memberId,
        targetMemberId: friend.memberId,
        action: 'member_removed',
        previousRole: 'member',
        result: 'succeeded',
      }),
    ]))
    await pool.end()
  })

  it('encrypts new invitation tokens, reveals them only to the current Owner, and leaves legacy rows unrevealable', async () => {
    const pool = testPool()
    let now = 1_000_000
    const store = testStore({ pool, now: () => now, inviteCipher: testInviteCipher() })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')

    const created = await store.createInvite(owner, 60_000, 'Reveal me')
    expect(created.invite).toMatchObject({ status: 'pending', revealable: true })
    await expect(store.revealInvite(owner, created.invite.id)).resolves.toEqual({
      inviteId: created.invite.id,
      inviteToken: created.inviteToken,
      expiresAt: created.invite.expiresAt,
    })
    const revealAudit = await store.listInviteRevealAuditEvents(owner, 10)
    expect(revealAudit).toEqual([{
      id: expect.any(String),
      teamId: owner.teamId,
      actorMemberId: owner.memberId,
      inviteId: created.invite.id,
      createdAt: now,
    }])
    expect(JSON.stringify(revealAudit)).not.toContain(created.inviteToken)

    const joined = await store.acceptInvite(await store.createInvite(owner, 60_000).then(value => value.inviteToken), 'Member')
    const member = await store.authenticateApiKey(joined.apiKey)
    if (member === undefined) throw new Error('member key should authenticate')
    await expect(store.revealInvite(member, created.invite.id)).rejects.toThrow(/only the owner/iu)
    await expect(store.listInviteRevealAuditEvents(member, 10)).rejects.toThrow(/only the owner/iu)
    await expect(store.listInviteRevealAuditEvents(owner, 10)).resolves.toHaveLength(1)

    await pool.query(`
      INSERT INTO team_invites
        (id, team_id, invited_by_member_id, label, status, expires_at, created_at, accepted_at, token_hash)
      VALUES ('legacy-hash-only', $1, $2, 'Legacy', 'pending', $3, $4, NULL, $5)
    `, [owner.teamId, owner.memberId, now + 60_000, now, 'a'.repeat(64)])
    await expect(store.overview(owner)).resolves.toMatchObject({
      invites: expect.arrayContaining([
        expect.objectContaining({ id: created.invite.id, revealable: true }),
        expect.objectContaining({ id: 'legacy-hash-only', revealable: false }),
      ]),
    })
    await expect(store.revealInvite(owner, 'legacy-hash-only')).rejects.toThrow(/no longer available/iu)

    now += 60_001
    await expect(store.overview(owner)).resolves.toMatchObject({ invites: [] })
    await expect(store.revealInvite(owner, created.invite.id)).rejects.toThrow(/no longer available/iu)
    await pool.end()
  })

  it('shares one atomic invitation reveal limit across PostgreSQL Host instances', async () => {
    const pool = testPool()
    let now = 180_000
    const firstHost = testStore({ pool, now: () => now })
    const secondHost = testStore({ pool, now: () => now })
    const boot = await firstHost.bootstrap('Friends', 'Owner')
    const owner = await secondHost.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const created = await firstHost.createInvite(
      owner,
      2 * TEAM_INVITE_REVEAL_RATE_LIMIT_WINDOW_MS,
      'Shared limit',
    )

    for (let attempt = 0; attempt < TEAM_INVITE_REVEAL_RATE_LIMIT_MAX_ATTEMPTS; attempt += 1) {
      const host = attempt % 2 === 0 ? firstHost : secondHost
      await expect(host.revealInvite(owner, created.invite.id)).resolves.toMatchObject({
        inviteId: created.invite.id,
      })
    }
    await expect(pool.query(`
      SELECT attempt_count
      FROM team_invite_reveal_rate_limits
      WHERE team_id = $1 AND actor_member_id = $2 AND invite_id = $3
    `, [owner.teamId, owner.memberId, created.invite.id])).resolves.toMatchObject({
      rows: [{ attempt_count: 5 }],
    })
    const limited = await secondHost.revealInvite(owner, created.invite.id).catch((error: unknown) => error)
    expect(limited).toMatchObject({
      name: 'TeamInviteRevealRateLimitError',
      message: 'Team invitation reveal rate limit exceeded',
      retryAfterSeconds: TEAM_INVITE_REVEAL_RATE_LIMIT_WINDOW_MS / 1_000,
    })
    expect(limited).toBeInstanceOf(TeamInviteRevealRateLimitError)
    await expect(pool.query(`
      SELECT attempt_count
      FROM team_invite_reveal_rate_limits
      WHERE team_id = $1 AND actor_member_id = $2 AND invite_id = $3
    `, [owner.teamId, owner.memberId, created.invite.id])).resolves.toMatchObject({
      rows: [{ attempt_count: 6 }],
    })

    now += TEAM_INVITE_REVEAL_RATE_LIMIT_WINDOW_MS
    await expect(firstHost.revealInvite(owner, created.invite.id)).resolves.toMatchObject({ inviteId: created.invite.id })
    await pool.end()
  })

  it('shares one source-global dissolution recovery limit across PostgreSQL Host instances', async () => {
    let databaseNow = 180_000
    const pool = testPool(undefined, () => databaseNow)
    let now = 180_000
    const firstHost = testStore({ pool, now: () => now })
    const secondHost = testStore({ pool, now: () => now })
    const sourceDigest = 'c'.repeat(64)
    await firstHost.initialize()
    await secondHost.initialize()

    for (let attempt = 0; attempt < TEAM_DISSOLUTION_RECOVERY_RATE_LIMIT_MAX_ATTEMPTS; attempt += 1) {
      const host = attempt % 2 === 0 ? firstHost : secondHost
      await expect(host.consumeDissolutionRecoveryAttempt(sourceDigest, 'result')).resolves.toBeUndefined()
    }
    await expect(pool.query(`
      SELECT attempt_count
      FROM team_dissolution_recovery_rate_limits
      WHERE source_digest = $1 AND action = 'result'
    `, [sourceDigest])).resolves.toMatchObject({
      rows: [{ attempt_count: TEAM_DISSOLUTION_RECOVERY_RATE_LIMIT_MAX_ATTEMPTS }],
    })

    const limited = await secondHost.consumeDissolutionRecoveryAttempt(sourceDigest, 'result')
      .catch((error: unknown) => error)
    expect(limited).toBeInstanceOf(TeamDissolutionRecoveryRateLimitError)
    expect(limited).toMatchObject({
      retryAfterSeconds: TEAM_DISSOLUTION_RECOVERY_RATE_LIMIT_WINDOW_MS / 1_000,
    })
    await expect(pool.query(`
      SELECT attempt_count
      FROM team_dissolution_recovery_rate_limits
      WHERE source_digest = $1 AND action = 'result'
    `, [sourceDigest])).resolves.toMatchObject({
      rows: [{ attempt_count: TEAM_DISSOLUTION_RECOVERY_RATE_LIMIT_MAX_ATTEMPTS + 1 }],
    })
    await expect(firstHost.consumeDissolutionRecoveryAttempt(sourceDigest, 'ack')).resolves.toBeUndefined()

    now += TEAM_DISSOLUTION_RECOVERY_RATE_LIMIT_WINDOW_MS
    databaseNow += TEAM_DISSOLUTION_RECOVERY_RATE_LIMIT_WINDOW_MS
    await expect(firstHost.consumeDissolutionRecoveryAttempt(sourceDigest, 'result')).resolves.toBeUndefined()
    await pool.end()
  })

  it('does not let skewed PostgreSQL Host clocks move a shared dissolution recovery window backwards', async () => {
    const pool = testPool()
    const firstHost = testStore({ pool, now: () => 179_999 })
    const secondHost = testStore({ pool, now: () => 180_001 })
    const sourceDigest = 'e'.repeat(64)
    await firstHost.initialize()
    await secondHost.initialize()

    const results = await Promise.allSettled(Array.from(
      { length: TEAM_DISSOLUTION_RECOVERY_RATE_LIMIT_MAX_ATTEMPTS + 1 },
      (_, index) => (index % 2 === 0 ? firstHost : secondHost)
        .consumeDissolutionRecoveryAttempt(sourceDigest, 'result'),
    ))

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(
      TEAM_DISSOLUTION_RECOVERY_RATE_LIMIT_MAX_ATTEMPTS,
    )
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    await expect(pool.query(`
      SELECT window_started_at, attempt_count
      FROM team_dissolution_recovery_rate_limits
      WHERE source_digest = $1 AND action = 'result'
    `, [sourceDigest])).resolves.toMatchObject({
      rows: [{
        window_started_at: 180_000,
        attempt_count: TEAM_DISSOLUTION_RECOVERY_RATE_LIMIT_MAX_ATTEMPTS + 1,
      }],
    })
    await pool.end()
  })

  it('does not audit a reveal that loses to a concurrent terminal mutation', async () => {
    const pool = testPool()
    const controlled = blockingRevealCipher()
    const store = testStore({ pool, inviteCipher: controlled.cipher })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const created = await store.createInvite(owner, 60_000, 'Race target')

    const reveal = store.revealInvite(owner, created.invite.id)
    await controlled.decryptStarted
    await store.revokeInvite(owner, created.invite.id)
    controlled.releaseDecrypt()

    await expect(reveal).rejects.toThrow(/no longer available/iu)
    await expect(store.listInviteRevealAuditEvents(owner, 10)).resolves.toEqual([])
    await expect(pool.query('SELECT id FROM team_invite_reveal_audit_events')).resolves.toMatchObject({ rows: [] })
    await pool.end()
  })

  it.each(['list', 'preview', 'accept', 'reveal'] as const)(
    'terminalizes an expired invitation and clears its envelope when %s first touches it',
    async (trigger) => {
      const pool = testPool()
      let now = 2_000_000
      const store = testStore({ pool, now: () => now })
      const boot = await store.bootstrap('Friends', 'Owner')
      const owner = await store.authenticateApiKey(boot.apiKey)
      if (owner === undefined) throw new Error('owner key should authenticate')
      const created = await store.createInvite(owner, 60_000, `Expire via ${trigger}`)
      const before = await pool.query<{ token_hash: string }>(
        'SELECT token_hash FROM team_invites WHERE id = $1',
        [created.invite.id],
      )
      now += 60_001

      if (trigger === 'list') {
        await expect(store.overview(owner)).resolves.toMatchObject({ invites: [] })
      } else if (trigger === 'preview') {
        await expect(store.previewInvite(created.inviteToken)).rejects.toThrow(/invalid or expired/iu)
      } else if (trigger === 'accept') {
        await expect(store.acceptInvite(created.inviteToken, 'Too late')).rejects.toThrow(/invalid or expired/iu)
      } else {
        await expect(store.revealInvite(owner, created.invite.id)).rejects.toThrow(/no longer available/iu)
      }

      const persisted = await pool.query<{
        status: string
        token_hash: string
        envelope_version: number | null
        envelope_key_ref: string | null
        envelope_wrapped_dek: string | null
        envelope_wrapped_dek_nonce: string | null
        envelope_wrapped_dek_tag: string | null
        envelope_nonce: string | null
        envelope_ciphertext: string | null
        envelope_tag: string | null
      }>('SELECT * FROM team_invites WHERE id = $1', [created.invite.id])
      expect(persisted.rows[0]).toMatchObject({
        status: 'expired',
        envelope_version: null,
        envelope_key_ref: null,
        envelope_wrapped_dek: null,
        envelope_wrapped_dek_nonce: null,
        envelope_wrapped_dek_tag: null,
        envelope_nonce: null,
        envelope_ciphertext: null,
        envelope_tag: null,
      })
      expect(persisted.rows[0]?.token_hash).not.toBe(before.rows[0]?.token_hash)
      await pool.end()
    },
  )

  it.each([
    ['missing key', "envelope_key_ref = 'missing-key'"],
    ['damaged ciphertext', "envelope_ciphertext = 'not-base64!'"],
  ] as const)('maps %s reveal failures to the public unavailable error', async (_case, mutation) => {
    const pool = testPool()
    const store = testStore({ pool })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const created = await store.createInvite(owner, 60_000, 'Tamper target')
    await pool.query(`UPDATE team_invites SET ${mutation} WHERE id = $1`, [created.invite.id])

    await expect(store.revealInvite(owner, created.invite.id))
      .rejects.toThrow(/^invite is no longer available$/u)
    await pool.end()
  })

  it('fails closed instead of creating a new hash-only invitation when the Host cipher is unavailable', async () => {
    const pool = testPool()
    const store = new PostgresTeamStore({ pool })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')

    await expect(store.createInvite(owner, 60_000)).rejects.toThrow(/encryption is not configured/iu)
    await expect(pool.query('SELECT id FROM team_invites')).resolves.toMatchObject({ rows: [] })
    await pool.end()
  })

  it('sweeps expired envelopes in deterministic Team-to-invite lock order without changing invitation records', async () => {
    const pool = testPool()
    let now = 1_000
    let nextId = 0
    const store = testStore({
      pool,
      now: () => now,
      id: () => `ordered-${String(++nextId).padStart(3, '0')}`,
    })
    const firstBoot = await store.bootstrap('First', 'First Owner')
    const secondBoot = await store.bootstrap('Second', 'Second Owner')
    const firstOwner = await store.authenticateApiKey(firstBoot.apiKey)
    const secondOwner = await store.authenticateApiKey(secondBoot.apiKey)
    if (firstOwner === undefined || secondOwner === undefined) throw new Error('owners should authenticate')
    const secondInvite = await store.createInvite(secondOwner, 60_000, 'Second expired')
    const firstInvite = await store.createInvite(firstOwner, 60_000, 'First expired')
    const firstInviteLaterId = await store.createInvite(firstOwner, 60_000, 'First expired, later ID')
    const futureInvite = await store.createInvite(firstOwner, 120_000, 'Future')
    const before = await pool.query<{ id: string; status: string; token_hash: string }>(
      'SELECT id, status, token_hash FROM team_invites ORDER BY id',
    )
    now = firstInvite.invite.expiresAt

    const poolQueries: string[] = []
    const transactionQueries: Array<{ sql: string; values: readonly unknown[] }> = []
    const originalPoolQuery = pool.query.bind(pool)
    const originalConnect = pool.connect.bind(pool)
    vi.spyOn(pool, 'query').mockImplementation((async (query: unknown, values?: readonly unknown[]) => {
      const sql = typeof query === 'string' ? query : String((query as { text?: unknown }).text)
      poolQueries.push(sql)
      return originalPoolQuery(query as never, values as never)
    }) as typeof pool.query)
    vi.spyOn(pool, 'connect').mockImplementation(async () => {
      const client = await originalConnect()
      const query = client.query.bind(client)
      return {
        query: (async (statement: unknown, values?: readonly unknown[]) => {
          const sql = typeof statement === 'string' ? statement : String((statement as { text?: unknown }).text)
          transactionQueries.push({ sql, values: values ?? [] })
          return query(statement as never, values as never)
        }) as typeof client.query,
        release: client.release.bind(client),
      } as typeof client
    })

    await expect(store.sweepExpiredInviteEnvelopes()).resolves.toBe(3)

    const candidateQuery = poolQueries.find(sql => /FROM team_invites/iu.test(sql))
    expect(candidateQuery).toMatch(/SELECT DISTINCT team_id/iu)
    expect(candidateQuery).toMatch(/ORDER BY team_id/iu)
    expect(candidateQuery).not.toMatch(/FOR UPDATE/iu)
    const rowLocks = transactionQueries
      .filter(({ sql }) => /FOR UPDATE/iu.test(sql))
      .map(({ sql, values }) => [
        /FROM teams/iu.test(sql) ? 'team' : 'invite',
        values[0],
      ])
    expect(rowLocks).toEqual([
      ['team', firstOwner.teamId],
      ['invite', firstOwner.teamId],
      ['team', secondOwner.teamId],
      ['invite', secondOwner.teamId],
    ])
    expect(rowLocks.filter(([kind, teamId]) => kind === 'team' && teamId === firstOwner.teamId)).toHaveLength(1)
    const inviteLocks = transactionQueries.filter(({ sql }) => /FROM team_invites[\s\S]+FOR UPDATE/iu.test(sql))
    expect(inviteLocks).toHaveLength(2)
    expect(inviteLocks.every(({ sql }) => /ORDER BY id\s+FOR UPDATE/iu.test(sql))).toBe(true)
    const firstTeamClear = transactionQueries.find(({ sql, values }) => (
      /UPDATE team_invites/iu.test(sql) && values[0] === firstOwner.teamId
    ))
    expect(firstTeamClear?.values.slice(1)).toEqual([
      firstInvite.invite.id,
      firstInviteLaterId.invite.id,
    ])

    const persisted = await originalPoolQuery<{
      id: string
      status: string
      token_hash: string
      label: string
      envelope_version: number | null
    }>('SELECT id, status, token_hash, label, envelope_version FROM team_invites ORDER BY id')
    expect(persisted.rows.find(row => row.id === firstInvite.invite.id)).toMatchObject({
      status: 'pending',
      token_hash: before.rows.find(row => row.id === firstInvite.invite.id)?.token_hash,
      label: 'First expired',
      envelope_version: null,
    })
    expect(persisted.rows.find(row => row.id === secondInvite.invite.id)).toMatchObject({
      status: 'pending',
      token_hash: before.rows.find(row => row.id === secondInvite.invite.id)?.token_hash,
      label: 'Second expired',
      envelope_version: null,
    })
    expect(persisted.rows.find(row => row.id === firstInviteLaterId.invite.id)).toMatchObject({
      status: 'pending',
      token_hash: before.rows.find(row => row.id === firstInviteLaterId.invite.id)?.token_hash,
      label: 'First expired, later ID',
      envelope_version: null,
    })
    expect(persisted.rows.find(row => row.id === futureInvite.invite.id)).toMatchObject({
      status: 'pending',
      label: 'Future',
      envelope_version: 1,
    })
    await pool.end()
  })

  it('rechecks expiry after locking a sweep candidate', async () => {
    const pool = testPool()
    let now = 10_000
    const store = testStore({ pool, now: () => now })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invite = await store.createInvite(owner, 60_000, 'Expiry changed')
    now = invite.invite.expiresAt

    const originalQuery = pool.query.bind(pool)
    vi.spyOn(pool, 'query').mockImplementation((async (query: unknown, values?: readonly unknown[]) => {
      const result = await originalQuery(query as never, values as never)
      if (typeof query === 'string' && /SELECT DISTINCT team_id[\s\S]+FROM team_invites/iu.test(query)) now -= 1
      return result
    }) as typeof pool.query)

    await expect(store.sweepExpiredInviteEnvelopes()).resolves.toBe(0)
    await expect(originalQuery('SELECT envelope_version FROM team_invites WHERE id = $1', [invite.invite.id]))
      .resolves.toMatchObject({ rows: [{ envelope_version: 1 }] })
    await pool.end()
  })

  it('clears invitation envelopes on acceptance, revocation, and ownership transfer', async () => {
    const pool = testPool()
    const store = testStore({ pool, inviteCipher: testInviteCipher() })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')

    const accepted = await store.createInvite(owner, 60_000, 'Accepted')
    const joined = await store.acceptInvite(accepted.inviteToken, 'Member')
    const member = await store.authenticateApiKey(joined.apiKey)
    if (member === undefined) throw new Error('member key should authenticate')
    const revoked = await store.createInvite(owner, 60_000, 'Revoked')
    await store.revokeInvite(owner, revoked.invite.id)
    const transferred = await store.createInvite(owner, 60_000, 'Transfer')
    const requested = await store.requestOwnershipTransfer(owner, member.memberId)
    await store.acceptOwnershipTransfer(member, requested.id)

    const rows = await pool.query<{
      id: string
      status: string
      envelope_version: number | null
      envelope_ciphertext: string | null
    }>(`
      SELECT id, status, envelope_version, envelope_ciphertext
      FROM team_invites
      WHERE id IN ($1, $2, $3)
      ORDER BY id
    `, [accepted.invite.id, revoked.invite.id, transferred.invite.id])
    expect(rows.rows).toEqual([
      { id: accepted.invite.id, status: 'accepted', envelope_version: null, envelope_ciphertext: null },
      { id: revoked.invite.id, status: 'revoked', envelope_version: null, envelope_ciphertext: null },
      { id: transferred.invite.id, status: 'revoked', envelope_version: null, envelope_ciphertext: null },
    ].sort((left, right) => left.id.localeCompare(right.id)))
    const currentOwner = await store.authenticateApiKey(joined.apiKey)
    if (currentOwner === undefined) throw new Error('new Owner key should authenticate')
    await expect(store.revealInvite(currentOwner, transferred.invite.id)).rejects.toThrow(/no longer available/iu)
    await pool.end()
  })

  it('treats a persisted legacy admin as a member for every Team-wide permission', async () => {
    const pool = testPool()
    const store = testStore({ pool })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const adminInvite = await store.createInvite(owner, 60_000, 'Legacy admin')
    const adminJoin = await store.acceptInvite(adminInvite.inviteToken, 'Legacy admin')
    await pool.query("UPDATE team_members SET role = 'admin' WHERE id = $1", [adminJoin.member.id])
    await pool.query(`
      INSERT INTO team_membership_audit_events
        (id, team_id, actor_member_id, target_member_id, action, previous_role, next_role, result, created_at)
      VALUES
        ('historical-role-change', $1, $2, $3, 'role_changed', 'member', 'admin', 'succeeded', 1)
    `, [owner.teamId, owner.memberId, adminJoin.member.id])
    const admin = await store.authenticateApiKey(adminJoin.apiKey)
    if (admin === undefined || admin.role !== 'admin') throw new Error('legacy admin key should authenticate')
    const memberInvite = await store.createInvite(owner, 60_000, 'Member')
    const memberJoin = await store.acceptInvite(memberInvite.inviteToken, 'Member')
    const member = await store.authenticateApiKey(memberJoin.apiKey)
    if (member === undefined) throw new Error('member key should authenticate')
    const memberKey = await store.issueApiKey(member, 'Member secondary')
    const adminKey = await store.issueApiKey(admin, 'Legacy admin secondary')
    const pending = await store.createInvite(owner, 60_000, 'Pending')

    await expect(store.createInvite(admin, 60_000, 'Forbidden')).rejects.toThrow(/only the owner/iu)
    await expect(store.revokeInvite(admin, pending.invite.id)).rejects.toThrow(/only the owner/iu)
    await expect(lifecycleStore(store).setTeamStatus(admin, {
      operationId: '00000000-0000-4000-8000-000000001001',
      expectedLifecycleRevision: 1,
      status: 'paused',
    })).rejects.toThrow(/only the owner/iu)
    await expect(store.removeMember(admin, member.memberId)).rejects.toThrow(/only the owner/iu)
    await expect(store.revokeApiKey(admin, memberKey.summary.id)).rejects.toThrow(/only the key owner or the Team owner/iu)
    await expect(store.listMembershipAuditEvents(admin, 10)).rejects.toThrow(/only the owner/iu)
    await expect(store.revokeApiKey(admin, adminKey.summary.id)).resolves.toBeUndefined()
    await expect(store.overview(owner)).resolves.toMatchObject({
      team: { status: 'active' },
      invites: expect.arrayContaining([expect.objectContaining({ id: pending.invite.id, status: 'pending' })]),
    })
    const auditEvents = await store.listMembershipAuditEvents(owner, 100)
    expect(auditEvents.filter(event => event.action === 'role_changed')).toEqual([expect.objectContaining({
      id: 'historical-role-change',
      actorMemberId: owner.memberId,
      targetMemberId: admin.memberId,
      previousRole: 'member',
      nextRole: 'admin',
      result: 'succeeded',
    })])
    await pool.end()
  })

  it('takes a PostgreSQL transaction lock before applying schema migrations', async () => {
    let locks = 0
    const pool = testPool(() => { locks += 1 })
    await testStore({ pool }).initialize()
    expect(locks).toBe(1)
    await pool.end()
  })

  it('enforces at most one Team owner with a partial unique index', async () => {
    expect(POSTGRES_TEAM_MIGRATIONS.find(migration => migration.version === 6)?.sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS team_members_one_owner_idx[\s\S]+WHERE role = 'owner'/iu,
    )
    const pool = testPool()
    const store = testStore({ pool })
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
    const first = testStore(options)
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

    const second = testStore(options)
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

  it('reserves and settles the shared UTC-day Credits cap transactionally', async () => {
    const pool = testPool()
    let id = 0
    const store = testStore({
      pool,
      id: () => `credits-${++id}`,
      now: () => Date.UTC(2026, 7, 20, 12),
    })
    const boot = await store.bootstrap('Credits Team', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invite = await store.createInvite(owner, 60_000)
    const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
    const friend = await store.authenticateApiKey(joined.apiKey)
    if (friend === undefined) throw new Error('friend key should authenticate')
    const created = await store.createContributionAccount(owner, 'Owner Codex')
    await store.updateContributionAccount(owner, created.id, { dailySharedCreditLimit: 50_000 })
    await expect(store.updateContributionAccount(owner, created.id, {
      personalReservePercent: 35,
      allowedModels: ['gpt-5-codex'],
    })).resolves.toMatchObject({
      personalReservePercent: 35,
      dailySharedCreditLimit: 50_000,
      allowedModels: ['gpt-5-codex'],
    })
    const account = await store.setContributionAccountStatus(owner.teamId, created.id, 'active')

    const first = await store.beginUsageEvent(friend, 'shared-first', account.id, 'gpt-5-codex', 50_000)
    await expect(store.beginUsageEvent(owner, 'owner-own', account.id, 'gpt-5-codex', 50_000)).resolves.toBeDefined()
    await expect(store.beginUsageEvent(friend, 'shared-blocked', account.id, 'gpt-5-codex', 50_000))
      .rejects.toThrow(/daily shared Credits limit/iu)

    await store.settleUsageEvent(owner.teamId, first.id, 'failed')
    const retried = await store.beginUsageEvent(friend, 'shared-retry', account.id, 'gpt-5-codex', 50_000)
    const settled = await store.settleUsageEvent(owner.teamId, retried.id, 'succeeded', {
      inputTokens: 10_000,
      cachedInputTokens: 0,
      outputTokens: 10_000,
    })
    expect(settled).toMatchObject({ credits: 50_000, creditsFormulaVersion: 'credits-v1' })
    await expect(store.beginUsageEvent(friend, 'shared-after-settle', account.id, 'gpt-5-codex', 50_000))
      .rejects.toThrow(/daily shared Credits limit/iu)
    await pool.end()
  })

  it('enforces the weekly estimated-cost limit for shared use and releases cancelled reservations', async () => {
    const pool = testPool()
    const store = testStore({ pool, now: () => Date.UTC(2026, 7, 24, 12) })
    const boot = await store.bootstrap('Weekly Team', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invite = await store.createInvite(owner, 60_000)
    const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
    const friend = await store.authenticateApiKey(joined.apiKey)
    if (friend === undefined) throw new Error('friend key should authenticate')
    const created = await store.createContributionAccount(owner, 'Owner Codex')
    await store.updateContributionAccount(owner, created.id, {
      weeklySharedEstimatedApiCostLimitMicros: 100_000,
    })
    const account = await store.setContributionAccountStatus(owner.teamId, created.id, 'active')

    await store.beginUsageEvent(friend, 'weekly-held', account.id, 'gpt-5-codex')
    await expect(store.beginUsageEvent(friend, 'weekly-blocked', account.id, 'gpt-5-codex'))
      .rejects.toThrow(/weekly shared estimated API cost limit/iu)
    await expect(store.beginUsageEvent(owner, 'owner-own', account.id, 'gpt-5-codex')).resolves.toBeDefined()

    await store.settleUsageEvent(owner.teamId, 'weekly-held', 'cancelled')
    await expect(store.beginUsageEvent(friend, 'weekly-after-cancel', account.id, 'gpt-5-codex')).resolves.toBeDefined()
    await pool.end()
  })

  it('aggregates shared account Credits without counting the contributor own use', async () => {
    const pool = testPool()
    const now = Date.UTC(2026, 7, 20, 12)
    const store = testStore({ pool, now: () => now })
    const boot = await store.bootstrap('Credits Team', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invite = await store.createInvite(owner, 60_000)
    const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
    const friend = await store.authenticateApiKey(joined.apiKey)
    if (friend === undefined) throw new Error('friend key should authenticate')
    const account = await store.createContributionAccount(owner, 'Owner Codex')
    await store.setContributionAccountStatus(owner.teamId, account.id, 'active')

    await store.beginUsageEvent(friend, 'shared-measured', account.id, 'gpt-5-codex')
    await store.settleUsageEvent(owner.teamId, 'shared-measured', 'succeeded', {
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 0,
    })
    await store.beginUsageEvent(friend, 'shared-unmeasured', account.id, 'gpt-5-codex')
    await store.beginUsageEvent(owner, 'own-excluded', account.id, 'gpt-5-codex')

    await expect(store.listUsageAggregates(friend)).resolves.toMatchObject({
      generatedAt: now,
      accountTotals24Hours: [{
        upstreamAccountId: account.id,
        requestCount: 2,
        measuredRequestCount: 1,
        credits: 100,
      }],
      memberDaily7Days: [{
        upstreamAccountId: account.id,
        consumerMemberId: friend.memberId,
        dayStartedAt: Date.UTC(2026, 7, 20),
        requestCount: 2,
        measuredRequestCount: 1,
        credits: 100,
      }],
    })
    await pool.end()
  })

  it('persists measured Token and validated micro-USD settlement metadata', async () => {
    const pool = testPool()
    const store = testStore({ pool, now: () => Date.UTC(2026, 7, 23, 10) })
    const boot = await store.bootstrap('Usage Team', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invite = await store.createInvite(owner, 60_000)
    const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
    const friend = await store.authenticateApiKey(joined.apiKey)
    if (friend === undefined) throw new Error('friend key should authenticate')
    const account = await store.createContributionAccount(owner, 'Owner Codex')
    await store.setContributionAccountStatus(owner.teamId, account.id, 'active')

    await store.beginUsageEvent(friend, 'priced', account.id, 'untrusted-request-model')
    await store.settleUsageEvent(owner.teamId, 'priced', 'succeeded', {
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 20,
    }, {
      estimatedCostUsdMicros: 1_234n,
      pricingCatalogVersion: 'fixture-v1',
    })

    const persisted = await pool.query<{
      total_tokens: string | number | null
      estimated_cost_usd_micros: string | number | null
      pricing_catalog_version: string | null
    }>(`
      SELECT total_tokens, estimated_cost_usd_micros, pricing_catalog_version
      FROM team_usage_events WHERE id = 'priced'
    `)
    expect(persisted.rows.map(row => ({
      totalTokens: row.total_tokens === null ? null : String(row.total_tokens),
      estimatedCostUsdMicros: row.estimated_cost_usd_micros === null ? null : String(row.estimated_cost_usd_micros),
      pricingCatalogVersion: row.pricing_catalog_version,
    }))).toEqual([{
      totalTokens: '120',
      estimatedCostUsdMicros: '1234',
      pricingCatalogVersion: 'fixture-v1',
    }])

    await store.beginUsageEvent(friend, 'cost-without-token', account.id, 'untrusted-request-model')
    await expect(store.settleUsageEvent(owner.teamId, 'cost-without-token', 'succeeded', undefined, {
      estimatedCostUsdMicros: 1n,
      pricingCatalogVersion: 'fixture-v1',
    })).rejects.toThrow(/requires measured provider Token usage/iu)

    await store.beginUsageEvent(friend, 'negative-cost', account.id, 'untrusted-request-model')
    await expect(store.settleUsageEvent(owner.teamId, 'negative-cost', 'succeeded', {
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 0,
    }, {
      estimatedCostUsdMicros: -1n,
      pricingCatalogVersion: 'fixture-v1',
    })).rejects.toThrow(/non-negative signed bigint/iu)
    await pool.end()
  })

  it('returns aggregate-only usage shaped for the exact owner, member, and admin roles', async () => {
    const pool = testPool()
    const now = Date.UTC(2026, 7, 23, 10)
    const store = testStore({ pool, now: () => now })
    const boot = await store.bootstrap('Usage Team', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')

    const friendInvite = await store.createInvite(owner, 60_000)
    const friendJoined = await store.acceptInvite(friendInvite.inviteToken, 'Friend')
    const friend = await store.authenticateApiKey(friendJoined.apiKey)
    if (friend === undefined) throw new Error('friend key should authenticate')

    const adminInvite = await store.createInvite(owner, 60_000)
    const adminJoined = await store.acceptInvite(adminInvite.inviteToken, 'Admin')
    await pool.query("UPDATE team_members SET role = 'admin' WHERE id = $1", [adminJoined.member.id])
    const admin = await store.authenticateApiKey(adminJoined.apiKey)
    if (admin === undefined || admin.role !== 'admin') throw new Error('legacy admin key should authenticate')

    const ownerAccount = await store.createContributionAccount(owner, 'Owner Codex')
    await store.setContributionAccountStatus(owner.teamId, ownerAccount.id, 'active')
    const friendAccount = await store.createContributionAccount(friend, 'Friend Codex')
    await store.setContributionAccountStatus(owner.teamId, friendAccount.id, 'active')

    await store.beginUsageEvent(friend, 'friend-priced', ownerAccount.id, 'untrusted-request-model')
    await store.settleUsageEvent(owner.teamId, 'friend-priced', 'succeeded', {
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 20,
    }, {
      estimatedCostUsdMicros: 1_234n,
      pricingCatalogVersion: 'fixture-v1',
    })
    await store.beginUsageEvent(friend, 'friend-unmeasured', ownerAccount.id, 'untrusted-request-model')
    await store.beginUsageEvent(owner, 'owner-unpriced', friendAccount.id, 'untrusted-request-model')
    await store.settleUsageEvent(owner.teamId, 'owner-unpriced', 'succeeded', {
      inputTokens: 40,
      cachedInputTokens: 0,
      outputTokens: 10,
    })
    await store.beginUsageEvent(admin, 'admin-priced', ownerAccount.id, 'untrusted-request-model')
    await store.settleUsageEvent(owner.teamId, 'admin-priced', 'succeeded', {
      inputTokens: 7,
      cachedInputTokens: 0,
      outputTokens: 3,
    }, {
      estimatedCostUsdMicros: 50n,
      pricingCatalogVersion: 'fixture-v1',
    })
    await store.beginUsageEvent(owner, 'owner-self-excluded', ownerAccount.id, 'untrusted-request-model')
    await store.settleUsageEvent(owner.teamId, 'owner-self-excluded', 'succeeded', {
      inputTokens: 10_000,
      cachedInputTokens: 0,
      outputTokens: 0,
    })

    await expect(store.readUsageProjection(owner)).resolves.toEqual({
      role: 'owner',
      window: { startedAt: now - 86_400_000, endedAt: now },
      currency: 'USD',
      team: {
        requestCount: 4,
        tokenMeasuredRequestCount: 3,
        pricedRequestCount: 2,
        totalTokens: '180',
        estimatedCostUsdMicros: '1284',
      },
      mine: {
        requestCount: 1,
        tokenMeasuredRequestCount: 1,
        pricedRequestCount: 0,
        totalTokens: '50',
        estimatedCostUsdMicros: null,
      },
      ownedAccounts: expect.any(Array),
    })
    await expect(store.readUsageProjection(friend)).resolves.toEqual({
      role: 'member',
      window: { startedAt: now - 86_400_000, endedAt: now },
      currency: 'USD',
      mine: {
        requestCount: 2,
        tokenMeasuredRequestCount: 1,
        pricedRequestCount: 1,
        totalTokens: '120',
        estimatedCostUsdMicros: '1234',
      },
      ownedAccounts: expect.any(Array),
    })
    const adminProjection = await store.readUsageProjection(admin)
    expect(adminProjection).toEqual({
      role: 'member',
      window: { startedAt: now - 86_400_000, endedAt: now },
      currency: 'USD',
      mine: {
        requestCount: 1,
        tokenMeasuredRequestCount: 1,
        pricedRequestCount: 1,
        totalTokens: '10',
        estimatedCostUsdMicros: '50',
      },
      ownedAccounts: [],
    })
    expect(adminProjection).not.toHaveProperty('team')
    const ownerOwnedUsage = (await store.readUsageProjection(owner)).ownedAccounts
    expect(ownerOwnedUsage).toHaveLength(1)
    expect(ownerOwnedUsage[0]).toMatchObject({
      accountId: ownerAccount.id,
      currentUtcWeek: {
        window: { startedAt: Date.UTC(2026, 7, 17), endedAt: now },
        resetAt: Date.UTC(2026, 7, 24),
        aggregate: {
          requestCount: 3,
          tokenMeasuredRequestCount: 2,
          pricedRequestCount: 2,
          totalTokens: '130',
          estimatedCostUsdMicros: '1284',
        },
      },
      last24Hours: {
        window: { startedAt: now - 86_400_000, endedAt: now },
        aggregate: {
          requestCount: 3,
          tokenMeasuredRequestCount: 2,
          pricedRequestCount: 2,
          totalTokens: '130',
          estimatedCostUsdMicros: '1284',
        },
      },
      aggregate: {
        requestCount: 3,
        tokenMeasuredRequestCount: 2,
        pricedRequestCount: 2,
        totalTokens: '130',
        estimatedCostUsdMicros: '1284',
      },
      recentRequests: expect.arrayContaining([
        expect.objectContaining({ id: 'friend-priced', model: 'untrusted-request-model' }),
        expect.objectContaining({ id: 'friend-unmeasured', model: 'untrusted-request-model' }),
        expect.objectContaining({ id: 'admin-priced', model: 'untrusted-request-model' }),
      ]),
    })
    expect(JSON.stringify(ownerOwnedUsage)).not.toContain(friend.memberId)
    expect(JSON.stringify(ownerOwnedUsage)).not.toContain(admin.memberId)
    await pool.end()
  })

  it('atomically persists member departure across all keys and contributions', async () => {
    const pool = testPool()
    const store = testStore({ pool })
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

  it.each(['overview', 'request', 'remove', 'leave', 'dissolve'] as const)(
    'locks Team, pending ownership transfer, members, then credentials during %s',
    async (operation) => {
      const pool = testPool()
      let now = 40_000
      const store = testStore({ pool, now: () => now })
      const lifecycle = lifecycleStore(store)
      const boot = await store.bootstrap('Ordered transfer', 'Owner')
      const owner = await store.authenticateApiKey(boot.apiKey)
      if (owner === undefined) throw new Error('owner key should authenticate')
      const invite = await store.createInvite(owner, 60_000, 'Target')
      const joined = await store.acceptInvite(invite.inviteToken, 'Target')
      const target = await store.authenticateApiKey(joined.apiKey)
      if (target === undefined) throw new Error('target key should authenticate')
      const pendingTransfer = await store.requestOwnershipTransfer(owner, target.memberId)
      const statements = recordTransactionSql(pool)

      if (operation === 'overview') await store.overview(owner)
      if (operation === 'request') {
        now = pendingTransfer.expiresAt
        await store.requestOwnershipTransfer(owner, target.memberId)
      }
      if (operation === 'remove') await store.removeMember(owner, target.memberId)
      if (operation === 'leave') await store.leaveTeam(target)
      if (operation === 'dissolve') {
        await lifecycle.dissolveTeam(owner, {
          operationId: '00000000-0000-4000-8000-000000001906',
          expectedLifecycleRevision: 1,
          confirmationName: 'Ordered transfer',
          recoverySecretHash: TEST_ONLY_RECOVERY_SECRET_HASH,
        })
      }

      expect(ownershipTransferLockOrder(statements)).toEqual([
        'team',
        'transfer',
        'member',
        'credential',
      ])
      await pool.end()
    },
  )

  it('atomically persists an ownership transfer and keeps existing keys and contributions', async () => {
    const pool = testPool()
    const store = testStore({ pool })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invite = await store.createInvite(owner, 60_000)
    const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
    const member = await store.authenticateApiKey(joined.apiKey)
    if (member === undefined) throw new Error('member key should authenticate')
    const observerInvite = await store.createInvite(owner, 60_000, 'Observer')
    const observerJoin = await store.acceptInvite(observerInvite.inviteToken, 'Observer')
    const observer = await store.authenticateApiKey(observerJoin.apiKey)
    if (observer === undefined) throw new Error('observer key should authenticate')
    const contribution = await store.createContributionAccount(owner, 'Owner Codex')

    const requested = await store.requestOwnershipTransfer(owner, member.memberId)
    expect(requested).toMatchObject({
      teamId: owner.teamId,
      requestedByMemberId: owner.memberId,
      targetMemberId: member.memberId,
      status: 'pending',
    })
    expect(requested.expiresAt).toBe(requested.createdAt + 24 * 60 * 60 * 1_000)
    await expect(store.authenticateApiKey(boot.apiKey)).resolves.toMatchObject({ role: 'owner' })
    await expect(store.authenticateApiKey(joined.apiKey)).resolves.toMatchObject({ role: 'member' })

    const accepted = await store.acceptOwnershipTransfer(member, requested.id)
    expect(accepted).toEqual({
      transfer: expect.objectContaining({ id: requested.id, status: 'accepted' }),
      formerOwner: expect.objectContaining({ id: owner.memberId, role: 'member' }),
      owner: expect.objectContaining({ id: member.memberId, role: 'owner' }),
    })

    await expect(store.overview(owner)).rejects.toThrow(/role is stale/iu)
    const formerOwner = await store.authenticateApiKey(boot.apiKey)
    const currentOwner = await store.authenticateApiKey(joined.apiKey)
    if (formerOwner === undefined || currentOwner === undefined) throw new Error('existing keys should remain active')
    expect(formerOwner.role).toBe('member')
    expect(currentOwner.role).toBe('owner')
    await expect(store.acceptOwnershipTransfer(currentOwner, requested.id)).resolves.toEqual(accepted)
    await expect(store.acceptOwnershipTransfer(observer, requested.id)).rejects.toThrow(/only.*target|unavailable/iu)
    const acceptedAudit = await pool.query<{ action: string }>(`
      SELECT action
      FROM team_ownership_transfer_audit_events
      WHERE transfer_id = $1
      ORDER BY created_at, id
    `, [requested.id])
    expect(acceptedAudit.rows).toHaveLength(2)
    expect(acceptedAudit.rows).toEqual(expect.arrayContaining([{ action: 'requested' }, { action: 'accepted' }]))
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

  it('persists ownership-transfer decisions, expiry, participant projection, and automatic cancellation', async () => {
    let now = 1_000
    const pool = testPool()
    const store = testStore({ pool, now: () => now })
    const lifecycle = lifecycleStore(store)
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const targetInvite = await store.createInvite(owner, 60_000, 'Target')
    const targetJoin = await store.acceptInvite(targetInvite.inviteToken, 'Target')
    const target = await store.authenticateApiKey(targetJoin.apiKey)
    if (target === undefined) throw new Error('target key should authenticate')
    const observerInvite = await store.createInvite(owner, 60_000, 'Observer')
    const observerJoin = await store.acceptInvite(observerInvite.inviteToken, 'Observer')
    const observer = await store.authenticateApiKey(observerJoin.apiKey)
    if (observer === undefined) throw new Error('observer key should authenticate')

    const rejected = await store.requestOwnershipTransfer(owner, target.memberId)
    await expect(store.overview(owner)).resolves.toMatchObject({ ownershipTransfer: { id: rejected.id } })
    await expect(store.overview(target)).resolves.toMatchObject({ ownershipTransfer: { id: rejected.id } })
    expect((await store.overview(observer)).ownershipTransfer).toBeUndefined()
    await expect(store.requestOwnershipTransfer(owner, observer.memberId)).rejects.toThrow(/already.*pending/iu)
    await expect(store.acceptOwnershipTransfer(observer, rejected.id)).rejects.toThrow(/unavailable/iu)
    await expect(store.rejectOwnershipTransfer(owner, rejected.id)).rejects.toThrow(/unavailable/iu)
    const rejectedResult = await store.rejectOwnershipTransfer(target, rejected.id)
    expect(rejectedResult).toMatchObject({
      status: 'rejected',
      resolvedAt: now,
    })
    await expect(store.rejectOwnershipTransfer(target, rejected.id)).resolves.toEqual(rejectedResult)

    const revoked = await store.requestOwnershipTransfer(owner, target.memberId)
    await expect(store.revokeOwnershipTransfer(target, revoked.id)).rejects.toThrow(/unavailable/iu)
    const revokedResult = await store.revokeOwnershipTransfer(owner, revoked.id)
    expect(revokedResult).toMatchObject({
      status: 'revoked',
      resolvedAt: now,
    })
    await expect(store.revokeOwnershipTransfer(owner, revoked.id)).resolves.toEqual(revokedResult)

    const expired = await store.requestOwnershipTransfer(owner, target.memberId)
    now = expired.expiresAt
    await expect(store.acceptOwnershipTransfer(target, expired.id)).rejects.toThrow(/expired|no longer pending/iu)
    expect((await store.overview(owner)).ownershipTransfer).toBeUndefined()

    const leaving = await store.requestOwnershipTransfer(owner, target.memberId)
    now += 1_000
    await store.leaveTeam(target)

    const dissolvedInvite = await store.createInvite(owner, 60_000, 'Dissolved target')
    const dissolvedJoin = await store.acceptInvite(dissolvedInvite.inviteToken, 'Dissolved target')
    const dissolvedTarget = await store.authenticateApiKey(dissolvedJoin.apiKey)
    if (dissolvedTarget === undefined) throw new Error('dissolved target key should authenticate')
    const dissolved = await store.requestOwnershipTransfer(owner, dissolvedTarget.memberId)
    now += 1_000
    await lifecycle.dissolveTeam(owner, {
      operationId: '00000000-0000-4000-8000-000000001904',
      expectedLifecycleRevision: 1,
      confirmationName: 'Friends',
      recoverySecretHash: TEST_ONLY_RECOVERY_SECRET_HASH,
    })

    const records = await pool.query<{ id: string; status: string; resolved_at: string | number | null }>(`
      SELECT id, status, resolved_at
      FROM team_ownership_transfers
      WHERE id IN ($1, $2, $3, $4, $5)
      ORDER BY id
    `, [rejected.id, revoked.id, expired.id, leaving.id, dissolved.id])
    expect(records.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: rejected.id, status: 'rejected' }),
      expect.objectContaining({ id: revoked.id, status: 'revoked' }),
      expect.objectContaining({ id: expired.id, status: 'expired' }),
      expect.objectContaining({ id: leaving.id, status: 'canceled' }),
      expect.objectContaining({ id: dissolved.id, status: 'canceled' }),
    ]))
    expect(records.rows.every(record => record.resolved_at !== null)).toBe(true)
    const audits = await pool.query<{ transfer_id: string; action: string }>(`
      SELECT transfer_id, action
      FROM team_ownership_transfer_audit_events
      WHERE transfer_id IN ($1, $2, $3, $4, $5)
      ORDER BY transfer_id, created_at, id
    `, [rejected.id, revoked.id, expired.id, leaving.id, dissolved.id])
    for (const transfer of [rejected, revoked, expired, leaving, dissolved]) {
      expect(audits.rows.filter(event => event.transfer_id === transfer.id)).toHaveLength(2)
      expect(audits.rows).toContainEqual({ transfer_id: transfer.id, action: 'requested' })
    }
    expect(audits.rows).toEqual(expect.arrayContaining([
      { transfer_id: rejected.id, action: 'rejected' },
      { transfer_id: revoked.id, action: 'revoked' },
      { transfer_id: expired.id, action: 'expired' },
      { transfer_id: leaving.id, action: 'canceled' },
      { transfer_id: dissolved.id, action: 'canceled' },
    ]))
    await pool.end()
  })

  it.each(['leave', 'remove', 'dissolve'] as const)(
    'expires a persisted ownership transfer before automatic cancellation on %s at the exact deadline',
    async (departure) => {
      let now = 20_000
      const pool = testPool()
      const store = testStore({ pool, now: () => now })
      const lifecycle = lifecycleStore(store)
      const boot = await store.bootstrap('Friends', 'Owner')
      const owner = await store.authenticateApiKey(boot.apiKey)
      if (owner === undefined) throw new Error('owner key should authenticate')
      const invite = await store.createInvite(owner, 60_000, 'Target')
      const joined = await store.acceptInvite(invite.inviteToken, 'Target')
      const target = await store.authenticateApiKey(joined.apiKey)
      if (target === undefined) throw new Error('target key should authenticate')
      const requested = await store.requestOwnershipTransfer(owner, target.memberId)

      now = requested.expiresAt
      if (departure === 'leave') await store.leaveTeam(target)
      if (departure === 'remove') await store.removeMember(owner, target.memberId)
      if (departure === 'dissolve') {
        await lifecycle.dissolveTeam(owner, {
          operationId: '00000000-0000-4000-8000-000000001905',
          expectedLifecycleRevision: 1,
          confirmationName: 'Friends',
          recoverySecretHash: TEST_ONLY_RECOVERY_SECRET_HASH,
        })
      }

      const persisted = await pool.query<{ status: string; resolved_at: string | number | null }>(`
        SELECT status, resolved_at
        FROM team_ownership_transfers
        WHERE id = $1
      `, [requested.id])
      expect(persisted.rows).toEqual([{ status: 'expired', resolved_at: now }])
      await pool.end()
    },
  )

  it('rejects ownership transfer to a member without a live Team key', async () => {
    const pool = testPool()
    const store = testStore({ pool })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invite = await store.createInvite(owner, 60_000)
    const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
    const member = await store.authenticateApiKey(joined.apiKey)
    if (member === undefined) throw new Error('member key should authenticate')
    await store.revokeApiKey(owner, member.keyId)

    await expect(store.requestOwnershipTransfer(owner, member.memberId)).rejects.toThrow(/active Team API key/iu)
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

  it('keeps an active Team manageable when its Owner revokes a device key', async () => {
    const pool = testPool()
    const store = testStore({ pool })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')

    await expect(store.revokeApiKey(owner, owner.keyId)).rejects.toThrow(/current Owner API key/iu)
    await expect(store.authenticateApiKey(boot.apiKey)).resolves.toMatchObject({ role: 'owner' })

    const replacement = await store.issueApiKey(owner, 'Owner replacement')
    const replacementOwner = await store.authenticateApiKey(replacement.token)
    if (replacementOwner === undefined) throw new Error('replacement owner key should authenticate')
    await expect(store.revokeApiKey(replacementOwner, owner.keyId)).resolves.toBeUndefined()
    await expect(store.authenticateApiKey(boot.apiKey)).resolves.toBeUndefined()
    await expect(store.overview(replacementOwner)).resolves.toMatchObject({ team: { status: 'active' } })
    await pool.end()
  })

  it('rejects owner departure without persisting any change', async () => {
    const pool = testPool()
    const store = testStore({ pool })
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
    const store = testStore({ pool })
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
    const store = testStore({ pool })
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
    const store = testStore({ pool })
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
    const store = testStore({ pool })
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

  it('lists and revokes contribution accounts only for their contributor', async () => {
    const pool = testPool()
    const store = testStore({ pool })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const ownerAccount = await store.createContributionAccount(owner, 'Owner Codex')
    const invite = await store.createInvite(owner, 60_000, 'Friend')
    const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
    const member = await store.authenticateApiKey(joined.apiKey)
    if (member === undefined) throw new Error('member key should authenticate')
    const memberAccount = await store.createContributionAccount(member, 'Friend Codex')

    await expect(store.listContributionAccounts(owner)).resolves.toEqual([
      expect.objectContaining({ id: ownerAccount.id, ownerMemberId: owner.memberId }),
    ])
    await expect(store.listContributionAccounts(member)).resolves.toEqual([
      expect.objectContaining({ id: memberAccount.id, ownerMemberId: member.memberId }),
    ])
    await expect(store.overview(member)).resolves.toMatchObject({
      contributions: expect.arrayContaining([
        expect.objectContaining({ id: ownerAccount.id }),
        expect.objectContaining({ id: memberAccount.id }),
      ]),
    })
    await expect(store.listContributionAccountsByStatus('authorizing')).resolves.toHaveLength(2)

    await expect(store.revokeContributionAccount(owner, memberAccount.id))
      .rejects.toThrow(/owner of the contribution account/iu)
    await expect(store.revokeContributionAccount(member, memberAccount.id))
      .resolves.toMatchObject({ id: memberAccount.id, status: 'revoked' })
    await expect(store.listContributionAccounts(owner)).resolves.toMatchObject([{ id: ownerAccount.id, status: 'authorizing' }])
    await pool.end()
  })

  it('atomically begins owner-only contribution reauthorization', async () => {
    const pool = testPool()
    const store = testStore({ pool })
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
    const store = testStore({ pool })
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
    const store = testStore({ pool })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const contribution = await store.createContributionAccount(owner, 'Owner Codex')
    await store.setContributionAccountStatus(owner.teamId, contribution.id, 'active')
    const pendingInvite = await store.createInvite(owner, 60_000, 'Pause-safe reveal')

    await lifecycleStore(store).setTeamStatus(owner, {
      operationId: '00000000-0000-4000-8000-000000001002',
      expectedLifecycleRevision: 1,
      status: 'paused',
    })
    const pausedOwner = await store.authenticateApiKey(boot.apiKey)
    expect(pausedOwner).not.toBeUndefined()
    if (pausedOwner === undefined) throw new Error('paused Team key should still authenticate')
    await expect(store.beginUsageEvent(pausedOwner, 'paused-event', contribution.id, 'gpt-5-codex'))
      .rejects.toThrow(/team is paused/iu)
    await expect(store.createInvite(pausedOwner, 60_000)).rejects.toThrow(/team is paused/iu)
    await expect(store.revealInvite(pausedOwner, pendingInvite.invite.id)).resolves.toMatchObject({
      inviteToken: pendingInvite.inviteToken,
    })
    await expect(store.revokeInvite(pausedOwner, pendingInvite.invite.id)).resolves.toMatchObject({ status: 'revoked' })
    await expect(lifecycleStore(store).setTeamStatus(pausedOwner, {
      operationId: '00000000-0000-4000-8000-000000001003',
      expectedLifecycleRevision: 2,
      status: 'active',
    })).resolves.toMatchObject({ status: 'active', lifecycleRevision: 3 })
    await pool.end()
  })

  it('defines durable lifecycle revision, terminal operation, audit, and key-diagnostic storage', () => {
    const lifecycleSql = POSTGRES_TEAM_MIGRATIONS.map(migration => migration.sql).join('\n')

    expect(lifecycleSql).toMatch(/lifecycle_revision/iu)
    expect(lifecycleSql).toMatch(/dissolved/iu)
    expect(lifecycleSql).toMatch(/revoked_reason/iu)
    expect(lifecycleSql).toMatch(/team_lifecycle_operations/iu)
    expect(lifecycleSql).toMatch(/team_lifecycle_audit_events/iu)
  })

  it('starts at lifecycle revision 1 and rejects id reuse and stale ABA transitions', async () => {
    const pool = testPool()
    const store = testStore({ pool })
    const lifecycle = lifecycleStore(store)

    try {
      const boot = await store.bootstrap('Lifecycle Team', 'Owner')
      expect(boot.team).toMatchObject({ status: 'active', lifecycleRevision: 1 })
      const owner = await store.authenticateApiKey(boot.apiKey)
      if (owner === undefined) throw new Error('owner key should authenticate')
      const pauseInput = {
        operationId: '00000000-0000-4000-8000-000000001101',
        expectedLifecycleRevision: 1,
        status: 'paused',
      } as const

      const paused = await lifecycle.setTeamStatus(owner, pauseInput)
      expect(paused).toMatchObject({ status: 'paused', lifecycleRevision: 2 })
      await expect(lifecycle.setTeamStatus(owner, pauseInput)).resolves.toEqual(paused)
      await expect(lifecycle.setTeamStatus(owner, {
        ...pauseInput,
        status: 'active',
      })).rejects.toMatchObject({ status: 409 })

      await expect(lifecycle.setTeamStatus(owner, {
        operationId: '00000000-0000-4000-8000-000000001102',
        expectedLifecycleRevision: 2,
        status: 'active',
      })).resolves.toMatchObject({ status: 'active', lifecycleRevision: 3 })
      await expect(lifecycle.setTeamStatus(owner, {
        operationId: '00000000-0000-4000-8000-000000001103',
        expectedLifecycleRevision: 1,
        status: 'paused',
      })).rejects.toMatchObject({ status: 409 })
      await expect(store.overview(owner)).resolves.toMatchObject({
        team: { status: 'active', lifecycleRevision: 3 },
      })
    } finally {
      await pool.end()
    }
  })

  it('allows only the current Owner to dissolve either an active or paused Team', async () => {
    const pool = testPool()
    const store = testStore({ pool, now: () => 4_000 })
    const lifecycle = lifecycleStore(store)

    try {
      const activeBoot = await store.bootstrap('Active Team', 'Owner')
      const activeOwner = await store.authenticateApiKey(activeBoot.apiKey)
      if (activeOwner === undefined) throw new Error('active Owner key should authenticate')
      const invite = await store.createInvite(activeOwner, 60_000, 'Member')
      const joined = await store.acceptInvite(invite.inviteToken, 'Member')
      const member = await store.authenticateApiKey(joined.apiKey)
      if (member === undefined) throw new Error('member key should authenticate')

      await expect(lifecycle.dissolveTeam(member, {
        operationId: '00000000-0000-4000-8000-000000001201',
        expectedLifecycleRevision: 1,
        confirmationName: 'Active Team',
        recoverySecretHash: TEST_ONLY_RECOVERY_SECRET_HASH,
      })).rejects.toThrow(/only.*owner/iu)
      await expect(lifecycle.dissolveTeam(activeOwner, {
        operationId: '00000000-0000-4000-8000-000000001202',
        expectedLifecycleRevision: 1,
        confirmationName: 'Active Team ',
        recoverySecretHash: TEST_ONLY_RECOVERY_SECRET_HASH,
      })).rejects.toThrow(/confirmation|match|name/iu)
      await expect(lifecycle.dissolveTeam(activeOwner, {
        operationId: '00000000-0000-4000-8000-000000001203',
        expectedLifecycleRevision: 1,
        confirmationName: 'Active Team',
        recoverySecretHash: TEST_ONLY_RECOVERY_SECRET_HASH,
      })).resolves.toMatchObject({
        teamId: activeOwner.teamId,
        status: 'dissolved',
        lifecycleRevision: 2,
      })

      const pausedBoot = await store.bootstrap('Paused Team', 'Owner')
      const pausedOwner = await store.authenticateApiKey(pausedBoot.apiKey)
      if (pausedOwner === undefined) throw new Error('paused Team Owner key should authenticate')
      await lifecycle.setTeamStatus(pausedOwner, {
        operationId: '00000000-0000-4000-8000-000000001204',
        expectedLifecycleRevision: 1,
        status: 'paused',
      })
      await expect(lifecycle.dissolveTeam(pausedOwner, {
        operationId: '00000000-0000-4000-8000-000000001205',
        expectedLifecycleRevision: 2,
        confirmationName: 'Paused Team',
        recoverySecretHash: TEST_ONLY_RECOVERY_SECRET_HASH,
      })).resolves.toMatchObject({
        teamId: pausedOwner.teamId,
        status: 'dissolved',
        lifecycleRevision: 3,
      })
    } finally {
      await pool.end()
    }
  })

  it('replays a bound dissolution once, rejects rebinding, and supports uniform repeatable recovery ACK', async () => {
    const pool = testPool()
    const store = testStore({ pool, now: () => 5_000 })
    const lifecycle = lifecycleStore(store)

    try {
      const boot = await store.bootstrap('Recovery Team', 'Owner')
      const owner = await store.authenticateApiKey(boot.apiKey)
      if (owner === undefined) throw new Error('owner key should authenticate')
      const operationId = '00000000-0000-4000-8000-000000001301'
      const input = {
        operationId,
        expectedLifecycleRevision: 1,
        confirmationName: 'Recovery Team',
        recoverySecretHash: TEST_ONLY_RECOVERY_SECRET_HASH,
      } as const

      const dissolved = await lifecycle.dissolveTeam(owner, input)
      await expect(lifecycle.dissolveTeam(owner, input)).resolves.toEqual(dissolved)
      await expect(lifecycle.dissolveTeam(owner, {
        ...input,
        confirmationName: 'Recovery Team ',
      })).rejects.toMatchObject({ status: 409 })
      expect(JSON.stringify(dissolved)).not.toContain(TEST_ONLY_RECOVERY_SECRET)
      expect(JSON.stringify(dissolved)).not.toContain(TEST_ONLY_RECOVERY_SECRET_HASH)

      const recovered = { operationType: 'team_dissolution', status: 'dissolved' }
      await expect(lifecycle.recoverTeamDissolution(operationId, TEST_ONLY_RECOVERY_SECRET))
        .resolves.toEqual(recovered)
      await expect(lifecycle.recoverTeamDissolution(operationId, TEST_ONLY_RECOVERY_SECRET))
        .resolves.toEqual(recovered)
      const wrongSecretError = await rejectedError(
        lifecycle.recoverTeamDissolution(operationId, TEST_ONLY_WRONG_RECOVERY_SECRET),
      )
      const unknownOperationError = await rejectedError(lifecycle.recoverTeamDissolution(
        '00000000-0000-4000-8000-000000001399',
        TEST_ONLY_RECOVERY_SECRET,
      ))
      expect(errorFingerprint(wrongSecretError)).toEqual(errorFingerprint(unknownOperationError))
      expect(JSON.stringify(errorFingerprint(wrongSecretError))).not.toContain(TEST_ONLY_WRONG_RECOVERY_SECRET)
      expect(JSON.stringify(errorFingerprint(unknownOperationError)))
        .not.toContain('00000000-0000-4000-8000-000000001399')
      const wrongAckError = await rejectedError(
        lifecycle.ackTeamDissolution(operationId, TEST_ONLY_WRONG_RECOVERY_SECRET),
      )
      expect(errorFingerprint(wrongAckError)).toEqual(errorFingerprint(wrongSecretError))

      await expect(lifecycle.ackTeamDissolution(operationId, TEST_ONLY_RECOVERY_SECRET)).resolves.toBeUndefined()
      await expect(lifecycle.ackTeamDissolution(operationId, TEST_ONLY_RECOVERY_SECRET)).resolves.toBeUndefined()
      await expect(lifecycle.recoverTeamDissolution(operationId, TEST_ONLY_RECOVERY_SECRET))
        .resolves.toEqual(recovered)
      await expect(lifecycle.diagnoseApiKey(boot.apiKey)).resolves.toEqual({ code: 'team_dissolved' })
      await expect(lifecycle.diagnoseApiKey('dsh_team_test-only-unknown-key-000000000000'))
        .resolves.toBeUndefined()

      const operationCount = await pool.query(
        'SELECT COUNT(*) AS count FROM team_lifecycle_operations WHERE team_id = $1',
        [owner.teamId],
      )
      const auditCount = await pool.query(
        'SELECT COUNT(*) AS count FROM team_lifecycle_audit_events WHERE team_id = $1',
        [owner.teamId],
      )
      expect(Number(operationCount.rows[0]?.count)).toBe(1)
      expect(Number(auditCount.rows[0]?.count)).toBe(1)
    } finally {
      await pool.end()
    }
  })

  it('atomically terminates every Team authority and ignores a late contribution activation', async () => {
    const pool = testPool()
    const store = testStore({ pool, now: () => 6_000 })
    const lifecycle = lifecycleStore(store)

    try {
      const boot = await store.bootstrap('Terminal Team', 'Owner')
      const owner = await store.authenticateApiKey(boot.apiKey)
      if (owner === undefined) throw new Error('owner key should authenticate')
      const joiningInvite = await store.createInvite(owner, 60_000, 'Member')
      const joined = await store.acceptInvite(joiningInvite.inviteToken, 'Member')
      const member = await store.authenticateApiKey(joined.apiKey)
      if (member === undefined) throw new Error('member key should authenticate')
      const memberSecondKey = await store.issueApiKey(member, 'Member test device')
      const pendingInvite = await store.createInvite(owner, 60_000, 'Pending')
      const pendingInviteBefore = await pool.query<{ token_hash: string }>(
        'SELECT token_hash FROM team_invites WHERE id = $1',
        [pendingInvite.invite.id],
      )
      const ownerContribution = await store.createContributionAccount(owner, 'Owner contribution')
      const memberContribution = await store.createContributionAccount(member, 'Member contribution')
      await store.setContributionAccountStatus(owner.teamId, ownerContribution.id, 'active')
      await store.setContributionAccountStatus(owner.teamId, memberContribution.id, 'active')

      const dissolved = await lifecycle.dissolveTeam(owner, {
        operationId: '00000000-0000-4000-8000-000000001401',
        expectedLifecycleRevision: 1,
        confirmationName: 'Terminal Team',
        recoverySecretHash: TEST_ONLY_RECOVERY_SECRET_HASH,
      })
      expect(dissolved).toMatchObject({
        teamId: owner.teamId,
        teamName: 'Terminal Team',
        status: 'dissolved',
        lifecycleRevision: 2,
        terminatedMemberCount: 2,
        revokedInviteCount: 1,
        revokedKeyCount: 3,
        revokedContributionCount: 2,
      })

      await expect(store.authenticateApiKey(boot.apiKey)).resolves.toBeUndefined()
      await expect(store.authenticateApiKey(joined.apiKey)).resolves.toBeUndefined()
      await expect(store.authenticateApiKey(memberSecondKey.token)).resolves.toBeUndefined()
      await expect(lifecycle.diagnoseApiKey(boot.apiKey)).resolves.toEqual({ code: 'team_dissolved' })
      await expect(lifecycle.diagnoseApiKey(joined.apiKey)).resolves.toEqual({ code: 'team_dissolved' })
      await expect(lifecycle.diagnoseApiKey(memberSecondKey.token)).resolves.toEqual({ code: 'team_dissolved' })
      await expect(store.previewInvite(pendingInvite.inviteToken)).rejects.toBeInstanceOf(Error)
      await expect(store.acceptInvite(pendingInvite.inviteToken, 'Late member')).rejects.toBeInstanceOf(Error)

      await expect(pool.query(
        'SELECT status, lifecycle_revision FROM teams WHERE id = $1',
        [owner.teamId],
      )).resolves.toMatchObject({ rows: [{ status: 'dissolved', lifecycle_revision: 2 }] })
      await expect(pool.query(
        'SELECT status FROM team_members WHERE team_id = $1 ORDER BY id',
        [owner.teamId],
      )).resolves.toMatchObject({ rows: [{ status: 'removed' }, { status: 'removed' }] })
      await expect(pool.query(
        'SELECT revoked_reason FROM team_api_keys WHERE team_id = $1 ORDER BY id',
        [owner.teamId],
      )).resolves.toMatchObject({
        rows: [
          { revoked_reason: 'team_dissolved' },
          { revoked_reason: 'team_dissolved' },
          { revoked_reason: 'team_dissolved' },
        ],
      })
      const pendingInviteAfter = await pool.query<{
        status: string
        token_hash: string
        envelope_version: number | null
        envelope_key_ref: string | null
        envelope_wrapped_dek: string | null
        envelope_wrapped_dek_nonce: string | null
        envelope_wrapped_dek_tag: string | null
        envelope_nonce: string | null
        envelope_ciphertext: string | null
        envelope_tag: string | null
      }>(`
        SELECT status, token_hash, envelope_version, envelope_key_ref, envelope_wrapped_dek,
          envelope_wrapped_dek_nonce, envelope_wrapped_dek_tag, envelope_nonce, envelope_ciphertext, envelope_tag
        FROM team_invites
        WHERE id = $1
      `, [pendingInvite.invite.id])
      expect(pendingInviteAfter.rows[0]).toMatchObject({
        status: 'revoked',
        envelope_version: null,
        envelope_key_ref: null,
        envelope_wrapped_dek: null,
        envelope_wrapped_dek_nonce: null,
        envelope_wrapped_dek_tag: null,
        envelope_nonce: null,
        envelope_ciphertext: null,
        envelope_tag: null,
      })
      expect(pendingInviteAfter.rows[0]?.token_hash).not.toBe(pendingInviteBefore.rows[0]?.token_hash)
      await expect(pool.query(
        'SELECT status FROM team_contributions WHERE team_id = $1 ORDER BY id',
        [owner.teamId],
      )).resolves.toMatchObject({ rows: [{ status: 'revoked' }, { status: 'revoked' }] })

      await expect(store.setContributionAccountStatus(owner.teamId, ownerContribution.id, 'active'))
        .resolves.toMatchObject({ id: ownerContribution.id, status: 'revoked' })
      await expect(pool.query(
        'SELECT status FROM team_contributions WHERE id = $1',
        [ownerContribution.id],
      )).resolves.toMatchObject({ rows: [{ status: 'revoked' }] })
    } finally {
      await pool.end()
    }
  })

  it('diagnoses each revoked PostgreSQL Team key with only its terminal reason', async () => {
    const pool = testPool()
    const store = testStore({ pool, now: () => 6_500 })
    const lifecycle = lifecycleStore(store)

    try {
      const boot = await store.bootstrap('Terminal reasons', 'Owner')
      const owner = await store.authenticateApiKey(boot.apiKey)
      if (owner === undefined) throw new Error('owner key should authenticate')
      const replacement = await store.issueApiKey(owner, 'Owner replacement')
      const replacementOwner = await store.authenticateApiKey(replacement.token)
      if (replacementOwner === undefined) throw new Error('replacement owner key should authenticate')
      await store.revokeApiKey(replacementOwner, owner.keyId)

      const leavingInvite = await store.createInvite(replacementOwner, 60_000, 'Leaving member')
      const leaving = await store.acceptInvite(leavingInvite.inviteToken, 'Leaving member')
      const leavingMember = await store.authenticateApiKey(leaving.apiKey)
      if (leavingMember === undefined) throw new Error('leaving member key should authenticate')
      await store.leaveTeam(leavingMember)

      const removedInvite = await store.createInvite(replacementOwner, 60_000, 'Removed member')
      const removed = await store.acceptInvite(removedInvite.inviteToken, 'Removed member')
      await store.removeMember(replacementOwner, removed.member.id)

      await lifecycle.dissolveTeam(replacementOwner, {
        operationId: '00000000-0000-4000-8000-000000001402',
        expectedLifecycleRevision: 1,
        confirmationName: 'Terminal reasons',
        recoverySecretHash: TEST_ONLY_RECOVERY_SECRET_HASH,
      })

      await expect(lifecycle.diagnoseApiKey(boot.apiKey)).resolves.toEqual({ code: 'device_revoked' })
      await expect(lifecycle.diagnoseApiKey(leaving.apiKey)).resolves.toEqual({ code: 'member_left' })
      await expect(lifecycle.diagnoseApiKey(removed.apiKey)).resolves.toEqual({ code: 'member_removed' })
      await expect(lifecycle.diagnoseApiKey(replacement.token)).resolves.toEqual({ code: 'team_dissolved' })
      await expect(lifecycle.diagnoseApiKey('dsh_team_test-only-unknown-key-000000000000'))
        .resolves.toBeUndefined()
    } finally {
      await pool.end()
    }
  })
})
