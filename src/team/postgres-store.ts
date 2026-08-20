/** PostgreSQL-backed Team control-plane store for restart-safe central Hosts. */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { Pool } from 'pg'
import type { PoolClient, PoolConfig, QueryResultRow } from 'pg'
import type { TeamAuthContext, TeamStore } from './store.ts'
import { safeTeamErrorMessage } from './safe-message.ts'
import type {
  TeamApiKeySummary,
  TeamBootstrapResult,
  TeamContributionAccountPatch,
  TeamContributionAccountSummary,
  TeamContributionStatus,
  TeamInviteResult,
  TeamInviteStatus,
  TeamInviteSummary,
  TeamJoinResult,
  TeamMemberDepartureResult,
  TeamMemberStatus,
  TeamMemberSummary,
  TeamOwnershipTransferResult,
  TeamOverview,
  TeamRole,
  TeamStatus,
  TeamSummary,
  TeamUsageEventStatus,
  TeamUsageEventSummary,
} from './types.ts'

const MAX_TEAM_NAME_LENGTH = 120
const MAX_MEMBER_NAME_LENGTH = 120
const MAX_KEY_LABEL_LENGTH = 80
const MAX_MODEL_NAME_LENGTH = 120
const DEFAULT_PERSONAL_RESERVE_PERCENT = 20
const DEFAULT_MAX_SHARED_CONCURRENCY = 1
const MIGRATION_LOCK_NAMESPACE = 1_643_724_299
const MIGRATION_LOCK_KEY = 1

/**
 * Kept public so the admission lock can be asserted without pretending pg-mem
 * provides PostgreSQL's real concurrent row-lock semantics.
 */
export const POSTGRES_BEGIN_USAGE_TEAM_LOCK_SQL = 'SELECT * FROM teams WHERE id = $1 FOR SHARE'

export interface PostgresTeamStoreOptions {
  /** Existing pool, useful when the Host owns database lifecycle. */
  readonly pool?: Pool
  /** Connection string used to create an owned pool when `pool` is omitted. */
  readonly connectionString?: string
  /** Additional node-postgres options; `connectionString` wins when supplied. */
  readonly poolConfig?: Omit<PoolConfig, 'connectionString'>
  readonly now?: () => number
  readonly id?: () => string
  readonly token?: () => string
}

export interface PostgresTeamMigration {
  readonly version: number
  readonly sql: string
}

/** Public so operators can inspect the exact schema before deployment. */
export const POSTGRES_TEAM_MIGRATIONS: readonly PostgresTeamMigration[] = [{
  version: 1,
  sql: `
    CREATE TABLE IF NOT EXISTS teams (
      id text PRIMARY KEY,
      name text NOT NULL,
      status text NOT NULL CHECK (status IN ('active', 'paused')),
      created_at bigint NOT NULL
    );
    CREATE TABLE IF NOT EXISTS team_members (
      id text PRIMARY KEY,
      team_id text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      display_name text NOT NULL,
      role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
      status text NOT NULL CHECK (status IN ('active', 'suspended', 'removed')),
      joined_at bigint NOT NULL
    );
    CREATE INDEX IF NOT EXISTS team_members_team_idx ON team_members(team_id, joined_at, id);
    CREATE TABLE IF NOT EXISTS team_invites (
      id text PRIMARY KEY,
      team_id text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      invited_by_member_id text NOT NULL REFERENCES team_members(id),
      status text NOT NULL CHECK (status IN ('pending', 'accepted', 'expired', 'revoked')),
      expires_at bigint NOT NULL,
      created_at bigint NOT NULL,
      accepted_at bigint,
      token_hash text NOT NULL UNIQUE
    );
    CREATE INDEX IF NOT EXISTS team_invites_team_idx ON team_invites(team_id, created_at, id);
    CREATE TABLE IF NOT EXISTS team_api_keys (
      id text PRIMARY KEY,
      team_id text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      member_id text NOT NULL REFERENCES team_members(id),
      label text NOT NULL,
      prefix text NOT NULL,
      created_at bigint NOT NULL,
      last_used_at bigint,
      revoked_at bigint,
      token_hash text NOT NULL UNIQUE
    );
    CREATE INDEX IF NOT EXISTS team_api_keys_team_idx ON team_api_keys(team_id, created_at, id);
    CREATE INDEX IF NOT EXISTS team_api_keys_member_idx ON team_api_keys(member_id, created_at, id);
    CREATE TABLE IF NOT EXISTS team_contributions (
      id text PRIMARY KEY,
      team_id text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      owner_member_id text NOT NULL REFERENCES team_members(id),
      label text NOT NULL,
      status text NOT NULL CHECK (status IN ('authorizing', 'active', 'paused', 'revoked', 'reauth_required')),
      personal_reserve_percent integer NOT NULL CHECK (personal_reserve_percent BETWEEN 0 AND 99),
      max_shared_requests_per_window integer,
      max_shared_concurrency integer NOT NULL CHECK (max_shared_concurrency BETWEEN 1 AND 16),
      allowed_models jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL,
      last_error text
    );
    CREATE INDEX IF NOT EXISTS team_contributions_team_idx ON team_contributions(team_id, created_at, id);
    CREATE TABLE IF NOT EXISTS team_usage_events (
      id text PRIMARY KEY,
      team_id text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      consumer_member_id text NOT NULL REFERENCES team_members(id),
      upstream_owner_member_id text NOT NULL REFERENCES team_members(id),
      upstream_account_id text NOT NULL REFERENCES team_contributions(id),
      model text NOT NULL,
      unit text NOT NULL CHECK (unit = 'request'),
      status text NOT NULL CHECK (status IN ('in_progress', 'succeeded', 'failed', 'cancelled')),
      started_at bigint NOT NULL,
      finished_at bigint
    );
    CREATE INDEX IF NOT EXISTS team_usage_events_team_idx ON team_usage_events(team_id, started_at DESC, id);
  `,
}, {
  version: 2,
  sql: `
    CREATE TABLE IF NOT EXISTS team_route_leases (
      id text PRIMARY KEY,
      team_id text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      consumer_member_id text NOT NULL REFERENCES team_members(id),
      account_id text NOT NULL REFERENCES team_contributions(id) ON DELETE CASCADE,
      session_id text NOT NULL,
      model text NOT NULL,
      source text NOT NULL CHECK (source IN ('session', 'own', 'shared')),
      is_shared boolean NOT NULL,
      status text NOT NULL CHECK (status IN ('in_progress', 'succeeded', 'failed', 'cancelled', 'expired')),
      reset_at bigint,
      reserved_at bigint NOT NULL,
      expires_at bigint NOT NULL,
      settled_at bigint
    );
    CREATE INDEX IF NOT EXISTS team_route_leases_account_active_idx
      ON team_route_leases(account_id, status, expires_at);
    CREATE INDEX IF NOT EXISTS team_route_leases_account_window_idx
      ON team_route_leases(account_id, is_shared, reset_at);
    CREATE TABLE IF NOT EXISTS team_session_bindings (
      team_id text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      consumer_member_id text NOT NULL REFERENCES team_members(id),
      session_id text NOT NULL,
      account_id text NOT NULL REFERENCES team_contributions(id) ON DELETE CASCADE,
      bound_at bigint NOT NULL,
      updated_at bigint NOT NULL,
      PRIMARY KEY (team_id, consumer_member_id, session_id)
    );
    CREATE INDEX IF NOT EXISTS team_session_bindings_account_idx
      ON team_session_bindings(account_id);
  `,
}, {
  version: 3,
  sql: `
    CREATE UNIQUE INDEX IF NOT EXISTS team_contributions_team_account_key
      ON team_contributions(team_id, id);
    CREATE TABLE IF NOT EXISTS team_contribution_credentials (
      account_id text PRIMARY KEY,
      team_id text NOT NULL,
      envelope_version integer NOT NULL CHECK (envelope_version = 1),
      key_id text NOT NULL CHECK (char_length(key_id) BETWEEN 1 AND 255),
      wrapped_dek text NOT NULL
        CONSTRAINT team_contribution_credentials_wrapped_dek_check CHECK (char_length(wrapped_dek) = 43),
      wrapped_dek_nonce text NOT NULL
        CONSTRAINT team_contribution_credentials_wrapped_dek_nonce_check CHECK (char_length(wrapped_dek_nonce) = 16),
      wrapped_dek_tag text NOT NULL
        CONSTRAINT team_contribution_credentials_wrapped_dek_tag_check CHECK (char_length(wrapped_dek_tag) = 22),
      encrypted_document text NOT NULL CHECK (char_length(encrypted_document) BETWEEN 1 AND 262144),
      document_nonce text NOT NULL CHECK (char_length(document_nonce) = 16),
      document_tag text NOT NULL CHECK (char_length(document_tag) = 22),
      updated_at bigint NOT NULL,
      FOREIGN KEY (team_id, account_id)
        REFERENCES team_contributions(team_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS team_contribution_credentials_team_idx
      ON team_contribution_credentials(team_id, account_id);
  `,
}, {
  version: 4,
  sql: `
    CREATE TABLE IF NOT EXISTS team_api_key_traffic_state (
      key_id text PRIMARY KEY REFERENCES team_api_keys(id) ON DELETE CASCADE,
      consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
      open_until bigint NOT NULL DEFAULT 0 CHECK (open_until >= 0),
      updated_at bigint NOT NULL
    );
    CREATE TABLE IF NOT EXISTS team_api_key_traffic_leases (
      id text PRIMARY KEY,
      key_id text NOT NULL REFERENCES team_api_keys(id) ON DELETE CASCADE,
      started_at bigint NOT NULL,
      expires_at bigint NOT NULL CHECK (expires_at >= started_at),
      finished_at bigint,
      result text CHECK (result IS NULL OR result IN ('success', 'failure', 'neutral')),
      CHECK ((finished_at IS NULL) = (result IS NULL))
    );
    CREATE INDEX IF NOT EXISTS team_api_key_traffic_leases_window_idx
      ON team_api_key_traffic_leases(key_id, started_at);
    CREATE INDEX IF NOT EXISTS team_api_key_traffic_leases_active_idx
      ON team_api_key_traffic_leases(key_id, finished_at, expires_at);
  `,
}, {
  version: 5,
  sql: `
    ALTER TABLE team_contribution_credentials
      DROP CONSTRAINT IF EXISTS team_contribution_credentials_wrapped_dek_check;
    ALTER TABLE team_contribution_credentials
      DROP CONSTRAINT IF EXISTS team_contribution_credentials_wrapped_dek_nonce_check;
    ALTER TABLE team_contribution_credentials
      DROP CONSTRAINT IF EXISTS team_contribution_credentials_wrapped_dek_tag_check;
    ALTER TABLE team_contribution_credentials
      ALTER COLUMN wrapped_dek_nonce DROP NOT NULL;
    ALTER TABLE team_contribution_credentials
      ALTER COLUMN wrapped_dek_tag DROP NOT NULL;
    ALTER TABLE team_contribution_credentials
      ADD CONSTRAINT team_contribution_credentials_wrapped_dek_check
        CHECK (char_length(wrapped_dek) BETWEEN 1 AND 262144);
    ALTER TABLE team_contribution_credentials
      ADD CONSTRAINT team_contribution_credentials_wrapped_dek_nonce_check
        CHECK (wrapped_dek_nonce IS NULL OR char_length(wrapped_dek_nonce) BETWEEN 1 AND 65536);
    ALTER TABLE team_contribution_credentials
      ADD CONSTRAINT team_contribution_credentials_wrapped_dek_tag_check
        CHECK (wrapped_dek_tag IS NULL OR char_length(wrapped_dek_tag) BETWEEN 1 AND 65536);
  `,
}, {
  version: 6,
  sql: `
    CREATE UNIQUE INDEX IF NOT EXISTS team_members_one_owner_idx
      ON team_members(team_id) WHERE role = 'owner';
  `,
}]

interface TeamRow extends QueryResultRow {
  id: string
  name: string
  status: TeamStatus
  created_at: string | number
}

interface MemberRow extends QueryResultRow {
  id: string
  team_id: string
  display_name: string
  role: TeamRole
  status: TeamMemberStatus
  joined_at: string | number
}

interface InviteRow extends QueryResultRow {
  id: string
  team_id: string
  invited_by_member_id: string
  status: TeamInviteStatus
  expires_at: string | number
  created_at: string | number
  accepted_at: string | number | null
  token_hash: string
}

interface KeyRow extends QueryResultRow {
  id: string
  team_id: string
  member_id: string
  label: string
  prefix: string
  created_at: string | number
  last_used_at: string | number | null
  revoked_at: string | number | null
  token_hash: string
}

interface ContributionRow extends QueryResultRow {
  id: string
  team_id: string
  owner_member_id: string
  label: string
  status: TeamContributionStatus
  personal_reserve_percent: number
  max_shared_requests_per_window: number | null
  max_shared_concurrency: number
  allowed_models: unknown
  created_at: string | number
  updated_at: string | number
  last_error: string | null
}

interface UsageRow extends QueryResultRow {
  id: string
  team_id: string
  consumer_member_id: string
  upstream_owner_member_id: string
  upstream_account_id: string
  model: string
  unit: 'request'
  status: TeamUsageEventStatus
  started_at: string | number
  finished_at: string | number | null
}

interface AuthRow extends QueryResultRow {
  key_id: string
  team_id: string
  member_id: string
  role: TeamRole
  token_hash: string
}

interface AuthContextRow extends AuthRow {
  name: string
  team_status: TeamStatus
  created_at: string | number
  display_name: string
  member_status: TeamMemberStatus
  joined_at: string | number
}

/** Durable implementation of the same secret-free interface as MemoryTeamStore. */
export class PostgresTeamStore implements TeamStore {
  readonly pool: Pool
  private readonly ownsPool: boolean
  private readonly now: () => number
  private readonly id: () => string
  private readonly token: () => string
  private initializing: Promise<void> | undefined

  constructor(options: PostgresTeamStoreOptions) {
    if (options.pool === undefined && (options.connectionString === undefined || options.connectionString.trim().length === 0)) {
      throw new Error('PostgresTeamStore requires a pool or non-empty connectionString')
    }
    this.pool = options.pool ?? new Pool({ ...options.poolConfig, connectionString: options.connectionString })
    this.ownsPool = options.pool === undefined
    this.now = options.now ?? Date.now
    this.id = options.id ?? randomUUID
    this.token = options.token ?? (() => randomBytes(32).toString('base64url'))
  }

  initialize(): Promise<void> {
    if (this.initializing !== undefined) return this.initializing
    const pending = this.initializeSchema().catch((error: unknown) => {
      if (this.initializing === pending) this.initializing = undefined
      throw error
    })
    this.initializing = pending
    return pending
  }

  private async initializeSchema(): Promise<void> {
    if (await this.hasCurrentSchema()) return
    await this.runMigrations()
  }

  private async hasCurrentSchema(): Promise<boolean> {
    const required = POSTGRES_TEAM_MIGRATIONS.map(migration => migration.version)
    try {
      const result = await this.pool.query<{ version: number }>(`
        SELECT version FROM team_schema_migrations
        WHERE version = ANY($1::integer[])
      `, [required])
      const present = new Set(result.rows.map(row => row.version))
      return required.every(version => present.has(version))
    } catch {
      // A fresh database has no migration table yet. The migration transaction
      // below remains the authoritative error path for missing privileges.
      return false
    }
  }

  async bootstrap(teamName: string, ownerName: string): Promise<TeamBootstrapResult> {
    await this.initialize()
    return this.transaction(async (client) => {
      const now = this.now()
      const team: TeamRow = {
        id: this.id(),
        name: nonEmpty(teamName, 'teamName', MAX_TEAM_NAME_LENGTH),
        status: 'active',
        created_at: now,
      }
      const member: MemberRow = {
        id: this.id(),
        team_id: team.id,
        display_name: nonEmpty(ownerName, 'ownerName', MAX_MEMBER_NAME_LENGTH),
        role: 'owner',
        status: 'active',
        joined_at: now,
      }
      await client.query(
        'INSERT INTO teams (id, name, status, created_at) VALUES ($1, $2, $3, $4)',
        [team.id, team.name, team.status, team.created_at],
      )
      await client.query(
        'INSERT INTO team_members (id, team_id, display_name, role, status, joined_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [member.id, member.team_id, member.display_name, member.role, member.status, member.joined_at],
      )
      const key = await this.createKey(client, team.id, member.id, 'bootstrap', now)
      return { team: summaryTeam(team), member: summaryMember(member), apiKey: key.token }
    })
  }

  async authenticateApiKey(token: string): Promise<TeamAuthContext | undefined> {
    await this.initialize()
    if (token.trim().length < 16) return undefined
    const tokenHash = hashToken(token)
    const result = await this.pool.query<AuthRow>(`
      SELECT k.id AS key_id, k.team_id, k.member_id, m.role, k.token_hash
      FROM team_api_keys k
      JOIN team_members m ON m.id = k.member_id AND m.team_id = k.team_id
      JOIN teams t ON t.id = k.team_id
      WHERE k.token_hash = $1 AND k.revoked_at IS NULL
        AND m.status = 'active'
    `, [tokenHash])
    const row = result.rows[0]
    if (row === undefined || !sameHash(row.token_hash, tokenHash)) return undefined
    await this.pool.query('UPDATE team_api_keys SET last_used_at = $1 WHERE id = $2 AND revoked_at IS NULL', [this.now(), row.key_id])
    return { teamId: row.team_id, memberId: row.member_id, role: row.role, keyId: row.key_id }
  }

  async overview(auth: TeamAuthContext): Promise<TeamOverview> {
    await this.initialize()
    return this.transaction(async (client) => {
      const { team, member } = await this.requireAuthContext(client, auth)
      const members = await client.query<MemberRow>('SELECT * FROM team_members WHERE team_id = $1 ORDER BY joined_at, id', [team.id])
      const invites = await client.query<InviteRow>("SELECT * FROM team_invites WHERE team_id = $1 AND status <> 'revoked' ORDER BY created_at, id", [team.id])
      const keys = await client.query<KeyRow>('SELECT * FROM team_api_keys WHERE team_id = $1 ORDER BY created_at, id', [team.id])
      const contributions = await client.query<ContributionRow>('SELECT * FROM team_contributions WHERE team_id = $1 ORDER BY created_at, id', [team.id])
      return {
        team: summaryTeam(team),
        currentMember: summaryMember(member),
        members: members.rows.map(summaryMember),
        invites: invites.rows.map(row => summaryInvite(row, this.now())),
        apiKeys: keys.rows.map(summaryKey),
        contributions: contributions.rows.map(summaryContribution),
      }
    })
  }

  async createInvite(auth: TeamAuthContext, expiresInMs: number): Promise<TeamInviteResult> {
    await this.initialize()
    if (!Number.isSafeInteger(expiresInMs) || expiresInMs < 60_000 || expiresInMs > 30 * 24 * 60 * 60 * 1000) {
      throw new Error('expiresInMs is outside the allowed range')
    }
    return this.transaction(async (client) => {
      const { member } = await this.requireOperator(client, auth)
      const now = this.now()
      const token = createSecret('dsh_invite', this.token)
      const invite: InviteRow = {
        id: this.id(),
        team_id: member.team_id,
        invited_by_member_id: member.id,
        status: 'pending',
        expires_at: now + expiresInMs,
        created_at: now,
        accepted_at: null,
        token_hash: hashToken(token),
      }
      await client.query(`
        INSERT INTO team_invites
          (id, team_id, invited_by_member_id, status, expires_at, created_at, accepted_at, token_hash)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [invite.id, invite.team_id, invite.invited_by_member_id, invite.status, invite.expires_at, invite.created_at, null, invite.token_hash])
      return { invite: summaryInvite(invite, now), inviteToken: token }
    })
  }

  async revokeInvite(auth: TeamAuthContext, inviteId: string): Promise<TeamInviteSummary> {
    await this.initialize()
    return this.transaction(async (client) => {
      await this.requireOperator(client, auth)
      const result = await client.query<InviteRow>(
        'SELECT * FROM team_invites WHERE id = $1 AND team_id = $2 FOR UPDATE',
        [inviteId, auth.teamId],
      )
      const invite = result.rows[0]
      if (invite === undefined) throw new Error('invite not found')
      if (invite.status === 'accepted') throw new Error('accepted invite cannot be revoked')
      if (invite.status === 'revoked') return summaryInvite(invite, this.now())
      const revoked: InviteRow = {
        ...invite,
        status: 'revoked',
        token_hash: revokedTokenHash(invite.id),
      }
      await client.query(
        "UPDATE team_invites SET status = 'revoked', token_hash = $1 WHERE id = $2",
        [revoked.token_hash, revoked.id],
      )
      return summaryInvite(revoked, this.now())
    })
  }

  async acceptInvite(token: string, displayName: string): Promise<TeamJoinResult> {
    await this.initialize()
    return this.transaction(async (client) => {
      const now = this.now()
      const result = await client.query<InviteRow>('SELECT * FROM team_invites WHERE token_hash = $1 FOR UPDATE', [hashToken(token)])
      const invite = result.rows[0]
      if (invite === undefined || invite.status !== 'pending' || numberValue(invite.expires_at) <= now) {
        throw new Error('invite is invalid or expired')
      }
      const teamResult = await client.query<TeamRow>('SELECT * FROM teams WHERE id = $1 FOR UPDATE', [invite.team_id])
      const team = teamResult.rows[0]
      if (team === undefined) throw new Error('team not found')
      if (team.status !== 'active') throw new Error('team is paused')
      const member: MemberRow = {
        id: this.id(),
        team_id: team.id,
        display_name: nonEmpty(displayName, 'displayName', MAX_MEMBER_NAME_LENGTH),
        role: 'member',
        status: 'active',
        joined_at: now,
      }
      await client.query(
        'INSERT INTO team_members (id, team_id, display_name, role, status, joined_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [member.id, member.team_id, member.display_name, member.role, member.status, member.joined_at],
      )
      await client.query("UPDATE team_invites SET status = 'accepted', accepted_at = $1, token_hash = $2 WHERE id = $3", [
        now,
        revokedTokenHash(invite.id),
        invite.id,
      ])
      const key = await this.createKey(client, team.id, member.id, 'member', now)
      return { team: summaryTeam(team), member: summaryMember(member), apiKey: key.token }
    })
  }

  async issueApiKey(auth: TeamAuthContext, label: string): Promise<{ summary: TeamApiKeySummary; token: string }> {
    await this.initialize()
    return this.transaction(async (client) => {
      const { member } = await this.requireAuthContext(client, auth)
      const key = await this.createKey(client, member.team_id, member.id, nonEmpty(label, 'label', MAX_KEY_LABEL_LENGTH), this.now())
      return { summary: summaryKey(key), token: key.token }
    })
  }

  async revokeApiKey(auth: TeamAuthContext, keyId: string): Promise<void> {
    await this.initialize()
    await this.transaction(async (client) => {
      const { member } = await this.requireAuthContext(client, auth)
      const result = await client.query<KeyRow>('SELECT * FROM team_api_keys WHERE id = $1 AND team_id = $2 FOR UPDATE', [keyId, member.team_id])
      const key = result.rows[0]
      if (key === undefined) throw new Error('api key not found')
      if (key.member_id !== member.id && member.role !== 'owner' && member.role !== 'admin') {
        throw new Error('only the key owner or a Team administrator can revoke this key')
      }
      if (key.revoked_at === null) await client.query('UPDATE team_api_keys SET revoked_at = $1 WHERE id = $2', [this.now(), key.id])
    })
  }

  async transferOwnership(auth: TeamAuthContext, targetMemberId: string): Promise<TeamOwnershipTransferResult> {
    await this.initialize()
    return this.transaction(async (client) => {
      const { member: formerOwner } = await this.requireAuthContext(client, auth, 'update')
      if (formerOwner.role !== 'owner') throw new Error('only the owner can transfer Team ownership')
      if (targetMemberId === formerOwner.id) throw new Error('ownership target must be a different Team member')
      const targetResult = await client.query<MemberRow>(
        'SELECT * FROM team_members WHERE id = $1 AND team_id = $2 FOR UPDATE',
        [targetMemberId, formerOwner.team_id],
      )
      const target = targetResult.rows[0]
      if (target === undefined) throw new Error('member not found in this Team')
      if (target.status !== 'active') throw new Error('member is not active in this Team')
      const keyResult = await client.query<{ present: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM team_api_keys
          WHERE team_id = $1 AND member_id = $2 AND revoked_at IS NULL
        ) AS present
      `, [formerOwner.team_id, target.id])
      if (keyResult.rows[0]?.present !== true) throw new Error('ownership target must have an active Team API key')
      const formerOwnerResult = await client.query<MemberRow>(`
        UPDATE team_members SET role = 'admin'
        WHERE id = $1 AND team_id = $2 RETURNING *
      `, [formerOwner.id, formerOwner.team_id])
      const ownerResult = await client.query<MemberRow>(`
        UPDATE team_members SET role = 'owner'
        WHERE id = $1 AND team_id = $2 RETURNING *
      `, [target.id, formerOwner.team_id])
      return {
        formerOwner: summaryMember(requiredRow(formerOwnerResult.rows[0], 'former Team owner')),
        owner: summaryMember(requiredRow(ownerResult.rows[0], 'new Team owner')),
      }
    })
  }

  async leaveTeam(auth: TeamAuthContext): Promise<TeamMemberDepartureResult> {
    await this.initialize()
    return this.transaction(async (client) => {
      const { member } = await this.requireAuthContext(client, auth, 'update')
      if (member.role === 'owner') throw new Error('Team owner cannot leave before transferring ownership')
      const now = this.now()
      const memberResult = await client.query<MemberRow>(`
        UPDATE team_members SET status = 'removed'
        WHERE id = $1 AND team_id = $2 RETURNING *
      `, [member.id, member.team_id])
      await client.query(`
        UPDATE team_api_keys SET revoked_at = COALESCE(revoked_at, $1)
        WHERE team_id = $2 AND member_id = $3
      `, [now, member.team_id, member.id])
      const contributionResult = await client.query<ContributionRow>(`
        UPDATE team_contributions SET status = 'revoked', updated_at = $1
        WHERE team_id = $2 AND owner_member_id = $3 RETURNING *
      `, [now, member.team_id, member.id])
      const contributions = contributionResult.rows
        .map(summaryContribution)
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      return {
        member: summaryMember(requiredRow(memberResult.rows[0], 'departing member')),
        contributions,
      }
    })
  }

  async createContributionAccount(auth: TeamAuthContext, label: string): Promise<TeamContributionAccountSummary> {
    await this.initialize()
    return this.transaction(async (client) => {
      const { member } = await this.requireAuthContext(client, auth)
      const now = this.now()
      const result = await client.query<ContributionRow>(`
        INSERT INTO team_contributions
          (id, team_id, owner_member_id, label, status, personal_reserve_percent,
           max_shared_requests_per_window, max_shared_concurrency, allowed_models,
           created_at, updated_at, last_error)
        VALUES ($1, $2, $3, $4, 'authorizing', $5, NULL, $6, $7::jsonb, $8, $8, NULL)
        RETURNING *
      `, [
        this.id(), member.team_id, member.id, nonEmpty(label, 'label', MAX_KEY_LABEL_LENGTH),
        DEFAULT_PERSONAL_RESERVE_PERCENT, DEFAULT_MAX_SHARED_CONCURRENCY, JSON.stringify([]), now,
      ])
      return summaryContribution(requiredRow(result.rows[0], 'contribution account'))
    })
  }

  async listContributionAccounts(auth: TeamAuthContext): Promise<readonly TeamContributionAccountSummary[]> {
    await this.initialize()
    return this.transaction(async (client) => {
      const { team } = await this.requireAuthContext(client, auth)
      const result = await client.query<ContributionRow>('SELECT * FROM team_contributions WHERE team_id = $1 ORDER BY created_at, id', [team.id])
      return result.rows.map(summaryContribution)
    })
  }

  async listContributionAccountsByStatus(
    status: TeamContributionStatus,
  ): Promise<readonly TeamContributionAccountSummary[]> {
    await this.initialize()
    const result = await this.pool.query<ContributionRow>(
      'SELECT * FROM team_contributions WHERE status = $1 ORDER BY created_at, id',
      [status],
    )
    return result.rows.map(summaryContribution)
  }

  async beginContributionReauthorization(
    auth: TeamAuthContext,
    accountId: string,
  ): Promise<TeamContributionAccountSummary> {
    await this.initialize()
    return this.transaction(async (client) => {
      const { member } = await this.requireAuthContext(client, auth)
      const account = await this.requireContribution(client, accountId, member.team_id, true)
      if (account.owner_member_id !== member.id) throw new Error('only the owner of the contribution account can reauthorize it')
      if (account.status !== 'reauth_required') throw new Error('contribution account is not waiting for reauthorization')
      const result = await client.query<ContributionRow>(`
        UPDATE team_contributions SET status = 'authorizing', last_error = NULL, updated_at = $1
        WHERE id = $2 AND team_id = $3 RETURNING *
      `, [this.now(), account.id, account.team_id])
      return summaryContribution(requiredRow(result.rows[0], 'contribution account'))
    })
  }

  async updateContributionAccount(
    auth: TeamAuthContext,
    accountId: string,
    patch: TeamContributionAccountPatch,
  ): Promise<TeamContributionAccountSummary> {
    await this.initialize()
    return this.transaction(async (client) => {
      const { member } = await this.requireAuthContext(client, auth)
      const account = await this.requireContribution(client, accountId, member.team_id, true)
      if (account.owner_member_id !== member.id) throw new Error('only the owner of the contribution account can update it')
      if (account.status === 'revoked') throw new Error('contribution account is revoked')
      const next = {
        label: patch.label === undefined ? account.label : nonEmpty(patch.label, 'label', MAX_KEY_LABEL_LENGTH),
        status: manualContributionStatus(account.status, patch.status),
        reserve: patch.personalReservePercent ?? account.personal_reserve_percent,
        maxRequests: patch.maxSharedRequestsPerWindow === undefined
          ? account.max_shared_requests_per_window
          : patch.maxSharedRequestsPerWindow,
        concurrency: patch.maxSharedConcurrency ?? account.max_shared_concurrency,
        models: patch.allowedModels === undefined ? parseModels(account.allowed_models) : normalizeModels(patch.allowedModels),
      }
      validateContributionLimits(next.reserve, next.maxRequests, next.concurrency)
      const result = await client.query<ContributionRow>(`
        UPDATE team_contributions
        SET label = $1, status = $2, personal_reserve_percent = $3,
            max_shared_requests_per_window = $4, max_shared_concurrency = $5,
            allowed_models = $6::jsonb, updated_at = $7
        WHERE id = $8 AND team_id = $9
        RETURNING *
      `, [next.label, next.status, next.reserve, next.maxRequests, next.concurrency, JSON.stringify(next.models), this.now(), account.id, account.team_id])
      return summaryContribution(requiredRow(result.rows[0], 'contribution account'))
    })
  }

  async revokeContributionAccount(auth: TeamAuthContext, accountId: string): Promise<TeamContributionAccountSummary> {
    await this.initialize()
    return this.transaction(async (client) => {
      const { member } = await this.requireAuthContext(client, auth)
      const account = await this.requireContribution(client, accountId, member.team_id, true)
      if (account.owner_member_id !== member.id && member.role !== 'owner' && member.role !== 'admin') {
        throw new Error('only the owner or a Team administrator can revoke this contribution account')
      }
      const result = await client.query<ContributionRow>(`
        UPDATE team_contributions SET status = 'revoked', updated_at = $1
        WHERE id = $2 AND team_id = $3 RETURNING *
      `, [this.now(), account.id, account.team_id])
      return summaryContribution(requiredRow(result.rows[0], 'contribution account'))
    })
  }

  async setContributionAccountStatus(
    teamId: string,
    accountId: string,
    status: TeamContributionStatus,
    lastError?: string,
    expectedStatus?: TeamContributionStatus,
  ): Promise<TeamContributionAccountSummary> {
    await this.initialize()
    return this.transaction(async (client) => {
      const account = await this.requireContribution(client, accountId, teamId, true)
      if (account.status === 'revoked' && status !== 'revoked') return summaryContribution(account)
      if (expectedStatus !== undefined && account.status !== expectedStatus) return summaryContribution(account)
      const result = await client.query<ContributionRow>(`
        UPDATE team_contributions SET status = $1, last_error = $2, updated_at = $3
        WHERE id = $4 AND team_id = $5 RETURNING *
      `, [
        status,
        lastError === undefined ? null : nonEmpty(safeTeamErrorMessage(lastError), 'lastError', 240),
        this.now(),
        account.id,
        account.team_id,
      ])
      return summaryContribution(requiredRow(result.rows[0], 'contribution account'))
    })
  }

  async beginUsageEvent(
    auth: TeamAuthContext,
    eventId: string,
    accountId: string,
    model: string,
  ): Promise<TeamUsageEventSummary> {
    await this.initialize()
    return this.transaction(async (client) => {
      // Hold a shared lock until the usage row is inserted. A concurrent Team
      // pause needs an exclusive row lock, so it cannot complete between this
      // status decision and the durable admission record.
      const teamResult = await client.query<TeamRow>(POSTGRES_BEGIN_USAGE_TEAM_LOCK_SQL, [auth.teamId])
      const lockedTeam = requiredRow(teamResult.rows[0], 'team')
      if (lockedTeam.status !== 'active') throw new Error('team is paused')
      const { member } = await this.requireAuthContext(client, auth)
      const account = await this.requireContribution(client, accountId, member.team_id, true)
      if (account.status !== 'active') throw new Error('contribution account is not active')
      const result = await client.query<UsageRow>(`
        INSERT INTO team_usage_events
          (id, team_id, consumer_member_id, upstream_owner_member_id,
           upstream_account_id, model, unit, status, started_at, finished_at)
        VALUES ($1, $2, $3, $4, $5, $6, 'request', 'in_progress', $7, NULL)
        RETURNING *
      `, [
        nonEmpty(eventId, 'eventId', 128), member.team_id, member.id, account.owner_member_id,
        account.id, nonEmpty(model, 'model', MAX_MODEL_NAME_LENGTH), this.now(),
      ])
      return summaryUsage(requiredRow(result.rows[0], 'usage event'))
    })
  }

  async settleUsageEvent(
    teamId: string,
    eventId: string,
    status: Exclude<TeamUsageEventStatus, 'in_progress'>,
  ): Promise<TeamUsageEventSummary> {
    await this.initialize()
    return this.transaction(async (client) => {
      const current = await client.query<UsageRow>('SELECT * FROM team_usage_events WHERE id = $1 AND team_id = $2 FOR UPDATE', [eventId, teamId])
      const event = current.rows[0]
      if (event === undefined) throw new Error('usage event not found')
      if (event.status !== 'in_progress') {
        if (event.status === status) return summaryUsage(event)
        throw new Error('usage event is already settled')
      }
      const result = await client.query<UsageRow>(`
        UPDATE team_usage_events SET status = $1, finished_at = $2
        WHERE id = $3 AND team_id = $4 RETURNING *
      `, [status, this.now(), eventId, teamId])
      return summaryUsage(requiredRow(result.rows[0], 'usage event'))
    })
  }

  async listUsageEvents(auth: TeamAuthContext, limit: number): Promise<readonly TeamUsageEventSummary[]> {
    await this.initialize()
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('usage event limit must be an integer from 1 to 1000')
    }
    return this.transaction(async (client) => {
      const { team } = await this.requireAuthContext(client, auth)
      const result = await client.query<UsageRow>(`
        SELECT * FROM team_usage_events WHERE team_id = $1
        ORDER BY started_at DESC, id DESC LIMIT $2
      `, [team.id, limit])
      return result.rows.map(summaryUsage)
    })
  }

  async setTeamStatus(auth: TeamAuthContext, status: TeamStatus): Promise<TeamSummary> {
    await this.initialize()
    return this.transaction(async (client) => {
      const { team } = await this.requireOperator(client, auth)
      const result = await client.query<TeamRow>('UPDATE teams SET status = $1 WHERE id = $2 RETURNING *', [status, team.id])
      return summaryTeam(requiredRow(result.rows[0], 'team'))
    })
  }

  async dispose(): Promise<void> {
    if (this.ownsPool) await this.pool.end()
  }

  private async runMigrations(): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock($1::integer, $2::integer)',
        [MIGRATION_LOCK_NAMESPACE, MIGRATION_LOCK_KEY],
      )
      await client.query(`
        CREATE TABLE IF NOT EXISTS team_schema_migrations (
          version integer PRIMARY KEY,
          applied_at bigint NOT NULL
        )
      `)
      for (const migration of POSTGRES_TEAM_MIGRATIONS) {
        const existing = await client.query<{ version: number }>('SELECT version FROM team_schema_migrations WHERE version = $1', [migration.version])
        if (existing.rows[0] !== undefined) continue
        await client.query(migration.sql)
        await client.query(
          'INSERT INTO team_schema_migrations (version, applied_at) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING',
          [migration.version, this.now()],
        )
      }
    })
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await operation(client)
      await client.query('COMMIT')
      return result
    } catch (error: unknown) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  private async createKey(
    client: PoolClient,
    teamId: string,
    memberId: string,
    label: string,
    now: number,
  ): Promise<KeyRow & { token: string }> {
    const token = createSecret('dsh_team', this.token)
    const row: KeyRow & { token: string } = {
      id: this.id(),
      team_id: teamId,
      member_id: memberId,
      label,
      prefix: token.slice(0, 18),
      created_at: now,
      last_used_at: null,
      revoked_at: null,
      token_hash: hashToken(token),
      token,
    }
    await client.query(`
      INSERT INTO team_api_keys
        (id, team_id, member_id, label, prefix, created_at, last_used_at, revoked_at, token_hash)
      VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL, $7)
    `, [row.id, row.team_id, row.member_id, row.label, row.prefix, row.created_at, row.token_hash])
    return row
  }

  private async requireAuthContext(
    client: PoolClient,
    auth: TeamAuthContext,
    memberLock: 'share' | 'update' = 'share',
  ): Promise<{ team: TeamRow; member: MemberRow }> {
    const memberLockResult = await client.query<MemberRow>(`
      SELECT * FROM team_members WHERE id = $1 AND team_id = $2
      ${memberLock === 'update' ? 'FOR UPDATE' : 'FOR SHARE'}
    `, [auth.memberId, auth.teamId])
    const lockedMember = memberLockResult.rows[0]
    if (lockedMember === undefined || lockedMember.status !== 'active') {
      throw new Error('member is not active in this Team')
    }
    const result = await client.query<AuthContextRow>(`
      SELECT
        k.id AS key_id, k.team_id, k.member_id, k.token_hash,
        t.name, t.status AS team_status, t.created_at,
        m.display_name, m.role, m.status AS member_status, m.joined_at
      FROM team_api_keys k
      JOIN teams t ON t.id = k.team_id
      JOIN team_members m ON m.id = k.member_id AND m.team_id = k.team_id
      WHERE k.id = $1 AND k.team_id = $2 AND k.member_id = $3 AND k.revoked_at IS NULL
    `, [auth.keyId, auth.teamId, auth.memberId])
    const row = result.rows[0]
    if (row === undefined) throw new Error('Team API key is revoked or invalid')
    if (row.member_status !== 'active') throw new Error('member is not active in this Team')
    if (row.role !== auth.role) throw new Error('Team API key role is stale')
    const team: TeamRow = {
      id: row.team_id,
      name: row.name,
      status: row.team_status,
      created_at: row.created_at,
    }
    const member: MemberRow = {
      id: row.member_id,
      team_id: row.team_id,
      display_name: row.display_name,
      role: row.role,
      status: row.member_status,
      joined_at: row.joined_at,
    }
    return { team, member }
  }

  private async requireOperator(client: PoolClient, auth: TeamAuthContext): Promise<{ team: TeamRow; member: MemberRow }> {
    const value = await this.requireAuthContext(client, auth)
    if (value.member.role !== 'owner' && value.member.role !== 'admin') throw new Error('Team administrator role required')
    return value
  }

  private async requireContribution(
    client: PoolClient,
    accountId: string,
    teamId: string,
    lock = false,
  ): Promise<ContributionRow> {
    const result = await client.query<ContributionRow>(
      `SELECT * FROM team_contributions WHERE id = $1 AND team_id = $2${lock ? ' FOR UPDATE' : ''}`,
      [accountId, teamId],
    )
    const row = result.rows[0]
    if (row === undefined) throw new Error('contribution account not found')
    return row
  }
}

function nonEmpty(value: string, field: string, maxLength: number): string {
  const result = value.trim().replace(/\s+/gu, ' ')
  if (result.length === 0) throw new Error(`${field} must be a non-empty string`)
  if (result.length > maxLength) throw new Error(`${field} is too long`)
  return result
}

function normalizeModels(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length > 32) throw new Error('allowedModels must contain at most 32 model names')
  return [...new Set(values.map(value => nonEmpty(value, 'allowedModels', MAX_MODEL_NAME_LENGTH)))]
}

function manualContributionStatus(
  current: TeamContributionStatus,
  requested: TeamContributionAccountPatch['status'],
): TeamContributionStatus {
  if (requested === undefined) return current
  if (current !== 'active' && current !== 'paused') {
    throw new Error('contribution authorization status cannot be changed manually')
  }
  return requested
}

function parseModels(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(model => typeof model !== 'string')) {
    throw new Error('stored contribution model allow-list is invalid')
  }
  return normalizeModels(value)
}

function validateContributionLimits(reserve: number, maxRequests: number | null, concurrency: number): void {
  if (!Number.isSafeInteger(reserve) || reserve < 0 || reserve > 99) {
    throw new Error('personalReservePercent must be an integer from 0 to 99')
  }
  if (maxRequests !== null && (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 1_000_000)) {
    throw new Error('maxSharedRequestsPerWindow must be null or an integer from 1 to 1000000')
  }
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new Error('maxSharedConcurrency must be an integer from 1 to 16')
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function revokedTokenHash(id: string): string {
  return createHash('sha256').update(`accepted:${id}`).digest('hex')
}

function sameHash(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex')
  const b = Buffer.from(right, 'hex')
  return a.byteLength === b.byteLength && timingSafeEqual(a, b)
}

function createSecret(prefix: string, tokenFactory: () => string): string {
  return `${prefix}_${tokenFactory()}`
}

function numberValue(value: string | number): number {
  const result = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(result)) throw new Error('stored timestamp is invalid')
  return result
}

function optionalNumber(value: string | number | null): number | undefined {
  return value === null ? undefined : numberValue(value)
}

function requiredRow<T>(row: T | undefined, label: string): T {
  if (row === undefined) throw new Error(`${label} was not returned by PostgreSQL`)
  return row
}

function summaryTeam(row: TeamRow): TeamSummary {
  return { id: row.id, name: row.name, status: row.status, createdAt: numberValue(row.created_at) }
}

function summaryMember(row: MemberRow): TeamMemberSummary {
  return {
    id: row.id,
    teamId: row.team_id,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    joinedAt: numberValue(row.joined_at),
  }
}

function summaryInvite(row: InviteRow, now: number): TeamInviteSummary {
  const status = row.status === 'pending' && numberValue(row.expires_at) <= now ? 'expired' : row.status
  const acceptedAt = optionalNumber(row.accepted_at)
  return {
    id: row.id,
    teamId: row.team_id,
    invitedByMemberId: row.invited_by_member_id,
    status,
    expiresAt: numberValue(row.expires_at),
    createdAt: numberValue(row.created_at),
    ...(acceptedAt === undefined ? {} : { acceptedAt }),
  }
}

function summaryKey(row: KeyRow): TeamApiKeySummary {
  const lastUsedAt = optionalNumber(row.last_used_at)
  const revokedAt = optionalNumber(row.revoked_at)
  return {
    id: row.id,
    teamId: row.team_id,
    memberId: row.member_id,
    label: row.label,
    prefix: row.prefix,
    createdAt: numberValue(row.created_at),
    ...(lastUsedAt === undefined ? {} : { lastUsedAt }),
    ...(revokedAt === undefined ? {} : { revokedAt }),
  }
}

function summaryContribution(row: ContributionRow): TeamContributionAccountSummary {
  return {
    id: row.id,
    teamId: row.team_id,
    ownerMemberId: row.owner_member_id,
    label: row.label,
    status: row.status,
    personalReservePercent: row.personal_reserve_percent,
    maxSharedRequestsPerWindow: row.max_shared_requests_per_window,
    maxSharedConcurrency: row.max_shared_concurrency,
    allowedModels: parseModels(row.allowed_models),
    createdAt: numberValue(row.created_at),
    updatedAt: numberValue(row.updated_at),
    ...(row.last_error === null ? {} : { lastError: safeTeamErrorMessage(row.last_error) }),
  }
}

function summaryUsage(row: UsageRow): TeamUsageEventSummary {
  const finishedAt = optionalNumber(row.finished_at)
  return {
    id: row.id,
    teamId: row.team_id,
    consumerMemberId: row.consumer_member_id,
    upstreamOwnerMemberId: row.upstream_owner_member_id,
    upstreamAccountId: row.upstream_account_id,
    model: row.model,
    unit: row.unit,
    status: row.status,
    startedAt: numberValue(row.started_at),
    ...(finishedAt === undefined ? {} : { finishedAt }),
  }
}
