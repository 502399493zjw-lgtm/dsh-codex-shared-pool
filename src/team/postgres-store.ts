/** PostgreSQL-backed Team control-plane store for restart-safe central Hosts. */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { Pool } from 'pg'
import type { PoolClient, PoolConfig, QueryResultRow } from 'pg'
import {
  TeamDailyCreditsLimitError,
  TeamWeeklyEstimatedCostLimitError,
  TEAM_DISSOLUTION_RECOVERY_RATE_LIMIT_MAX_ATTEMPTS,
  TEAM_DISSOLUTION_RECOVERY_RATE_LIMIT_WINDOW_MS,
  TeamDissolutionRecoveryRateLimitError,
  TeamDissolutionUnavailableError,
  TeamDissolvedError,
  TeamDisplayNameMigrationUnavailableError,
  TEAM_INVITE_REVEAL_RATE_LIMIT_MAX_ATTEMPTS,
  TEAM_INVITE_REVEAL_RATE_LIMIT_WINDOW_MS,
  TeamInviteRevealRateLimitError,
  TEAM_OWNERSHIP_TRANSFER_TTL_MS,
  TeamLifecycleConflictError,
} from './store.ts'
import type {
  TeamAuthContext,
  TeamDissolutionRecoveryAction,
  TeamStore,
  TeamUsageCostEstimate,
} from './store.ts'
import { anonymousSecret, normalizeAnonymousCreation, TEAM_ANONYMOUS_LIMITS, TeamAnonymousCreationConflictError, TeamAnonymousRateLimitError, TeamOwnerRecoveryUnavailableError, type TeamAnonymousAction } from './anonymous.ts'
import { safeTeamErrorMessage } from './safe-message.ts'
import type {
  TeamApiKeySummary,
  TeamAccountUsage24HourSummary,
  TeamBootstrapResult,
  TeamAnonymousCreationInput,
  TeamAnonymousOwnerResult,
  TeamContributionAccountPatch,
  TeamContributionAccountSummary,
  TeamContributionStatus,
  TeamConnectionTerminal,
  TeamDissolutionInput,
  TeamDissolutionRecoveryResult,
  TeamDissolutionResult,
  TeamDisplayNameMigrationAcknowledgement,
  TeamInviteResult,
  TeamInvitePreview,
  TeamInviteRevealAuditEventSummary,
  TeamInviteRevealResult,
  TeamInviteStatus,
  TeamInviteSummary,
  TeamJoinResult,
  TeamJoinAcceptedResult,
  TeamMemberDepartureResult,
  TeamMembershipAuditAction,
  TeamMembershipAuditEventSummary,
  TeamMemberStatus,
  TeamMemberSummary,
  TeamLifecycleTransitionInput,
  TeamOwnershipTransferAcceptanceResult,
  TeamOwnershipTransferStatus,
  TeamOwnershipTransferSummary,
  TeamOverview,
  TeamRole,
  TeamStatus,
  TeamSummary,
  TeamUsageEventStatus,
  TeamUsageEventSummary,
  TeamUsageAggregateSummary,
  TeamUsageAggregates,
  TeamUsageProjection,
  TeamMemberDailyUsageSummary,
} from './types.ts'
import { calculateTeamCredits } from './credits.ts'
import type { TeamProviderTokenUsage } from './credits.ts'
import { TeamInviteCipher } from './invite-cipher.ts'
import type { TeamInviteTokenEnvelope } from './invite-cipher.ts'
import {
  appendTeamMemberDisplayNameCollisionSuffix,
  fallbackTeamMemberDisplayName,
  normalizeTeamMemberDisplayName,
} from './member-display-name.ts'

const MAX_TEAM_NAME_LENGTH = 120
const MAX_INVITE_LABEL_LENGTH = 120
const MAX_KEY_LABEL_LENGTH = 80
const MAX_MODEL_NAME_LENGTH = 120
const DEFAULT_PERSONAL_RESERVE_PERCENT = 20
const DEFAULT_MAX_SHARED_CONCURRENCY = 1
const MAX_DAILY_SHARED_CREDIT_LIMIT = 1_000_000_000_000
const MIGRATION_LOCK_NAMESPACE = 1_643_724_299
const MIGRATION_LOCK_KEY = 1

/**
 * Kept public so the admission lock can be asserted without pretending pg-mem
 * provides PostgreSQL's real concurrent row-lock semantics.
 */
export const POSTGRES_BEGIN_USAGE_TEAM_LOCK_SQL = 'SELECT * FROM teams WHERE id = $1 FOR SHARE'

const POSTGRES_TEAM_MIGRATION_12_ERROR =
  'Team migration 12 preflight failed'

interface PostgresTeamMigration12OwnerCandidate {
  readonly team_id: string
  readonly owner_member_id: string
  readonly has_active_key: boolean
}

function teamMigration12PreflightError(
  teamId: string,
  ownerCandidates: readonly PostgresTeamMigration12OwnerCandidate[],
): Error {
  const activeOwnerMemberIds = ownerCandidates
    .map(candidate => candidate.owner_member_id)
    .toSorted()
  const credentialedOwnerMemberIds = ownerCandidates
    .filter(candidate => candidate.has_active_key)
    .map(candidate => candidate.owner_member_id)
    .toSorted()
  return new Error(
    `${POSTGRES_TEAM_MIGRATION_12_ERROR}: `
    + `team_id=${JSON.stringify(teamId)} `
    + `active_owner_member_ids=${JSON.stringify(activeOwnerMemberIds)} `
    + `credentialed_owner_member_ids=${JSON.stringify(credentialedOwnerMemberIds)}`,
  )
}

/**
 * Real PostgreSQL write exclusion for the one-time Owner/member migration.
 * pg-mem fixtures intercept only this exact statement because pg-mem does not
 * implement LOCK TABLE; the preflight and mutations still execute there.
 */
export const POSTGRES_TEAM_MIGRATION_12_LOCK_SQL =
  'LOCK TABLE teams, team_members, team_invites, team_api_keys IN SHARE ROW EXCLUSIVE MODE'

export const POSTGRES_TEAM_MIGRATION_12_AFFECTED_TEAMS_SQL = `
  SELECT id AS team_id
  FROM teams
  WHERE status IN ('active', 'paused')
  ORDER BY id
`

export const POSTGRES_TEAM_MIGRATION_12_ELIGIBLE_OWNERS_SQL = `
  SELECT
    member.team_id,
    member.id AS owner_member_id,
    COUNT(api_key.id) > 0 AS has_active_key
  FROM team_members AS member
  INNER JOIN teams AS team ON team.id = member.team_id
  LEFT JOIN team_api_keys AS api_key
    ON api_key.team_id = member.team_id
   AND api_key.member_id = member.id
   AND api_key.revoked_at IS NULL
  WHERE member.role = 'owner'
    AND member.status = 'active'
    AND team.status IN ('active', 'paused')
  GROUP BY member.team_id, member.id
  ORDER BY member.team_id, member.id
`

export const POSTGRES_TEAM_MIGRATION_12_NORMALIZE_ADMINS_SQL = `
  UPDATE team_members
  SET role = 'member'
  WHERE team_id IN (
      SELECT id
      FROM teams
      WHERE status IN ('active', 'paused')
    )
    AND role = 'admin'
    AND status = 'active'
`

export const POSTGRES_TEAM_MIGRATION_12_AUDIT_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS team_role_migration_audit_events (
    id text PRIMARY KEY,
    team_id text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    target_member_id text NOT NULL REFERENCES team_members(id),
    migration_version integer NOT NULL CHECK (migration_version = 12),
    previous_role text NOT NULL CHECK (previous_role = 'admin'),
    next_role text NOT NULL CHECK (next_role = 'member'),
    result text NOT NULL CHECK (result = 'succeeded'),
    created_at bigint NOT NULL,
    UNIQUE (migration_version, target_member_id)
  );
  CREATE INDEX IF NOT EXISTS team_role_migration_audit_events_team_idx
    ON team_role_migration_audit_events(team_id, created_at DESC, id DESC);
`

function teamMigration12AuditAdminsSql(createdAtExpression: string): string {
  return `
    INSERT INTO team_role_migration_audit_events
      (id, team_id, target_member_id, migration_version, previous_role, next_role, result, created_at)
    SELECT
      'migration-12:legacy-admin:' || member.id,
      member.team_id,
      member.id,
      12,
      'admin',
      'member',
      'succeeded',
      ${createdAtExpression}
    FROM team_members AS member
    INNER JOIN teams AS team ON team.id = member.team_id
    WHERE team.status IN ('active', 'paused')
      AND member.role = 'admin'
      AND member.status = 'active';
  `
}

export const POSTGRES_TEAM_MIGRATION_12_AUDIT_ADMINS_SQL =
  teamMigration12AuditAdminsSql('CAST($1 AS bigint)')

const POSTGRES_TEAM_MIGRATION_12_INLINE_AUDIT_ADMINS_SQL =
  teamMigration12AuditAdminsSql(
    'FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint',
  )

export const POSTGRES_TEAM_MIGRATION_12_REVOKE_INVITES_SQL = `
  UPDATE team_invites
  SET status = 'revoked',
      token_hash = 'revoked:migration-12:' || team_invites.id
  FROM team_members AS owner
  WHERE team_invites.team_id = owner.team_id
    AND owner.id = $1
    AND owner.role = 'owner'
    AND owner.status = 'active'
    AND team_invites.status = 'pending'
    AND team_invites.invited_by_member_id <> owner.id
`

/**
 * PostgreSQL-native preflight embedded in the published migration SQL. The
 * runtime migrator uses the equivalent split queries above so pg-mem tests can
 * exercise the real decisions and mutations instead of skipping migration 12.
 */
export const POSTGRES_TEAM_MIGRATION_12_PREFLIGHT_SQL = `
  WITH target_teams AS (
    SELECT id AS team_id
    FROM teams
    WHERE status IN ('active', 'paused')
  ), active_owners AS (
    SELECT
      member.team_id,
      member.id AS owner_member_id,
      COUNT(api_key.id) > 0 AS has_active_key
    FROM team_members AS member
    INNER JOIN target_teams AS team ON team.team_id = member.team_id
    LEFT JOIN team_api_keys AS api_key
      ON api_key.team_id = member.team_id
     AND api_key.member_id = member.id
     AND api_key.revoked_at IS NULL
    WHERE member.role = 'owner'
      AND member.status = 'active'
    GROUP BY member.team_id, member.id
  ), owner_counts AS (
    SELECT
      team.team_id,
      COUNT(owner.owner_member_id) AS active_owner_count,
      COUNT(owner.owner_member_id) FILTER (WHERE owner.has_active_key) AS credentialed_owner_count,
      COALESCE(
        jsonb_agg(owner.owner_member_id ORDER BY owner.owner_member_id)
          FILTER (WHERE owner.owner_member_id IS NOT NULL),
        '[]'::jsonb
      )::text AS active_owner_member_ids,
      COALESCE(
        jsonb_agg(owner.owner_member_id ORDER BY owner.owner_member_id)
          FILTER (WHERE owner.owner_member_id IS NOT NULL AND owner.has_active_key),
        '[]'::jsonb
      )::text AS credentialed_owner_member_ids
    FROM target_teams AS team
    LEFT JOIN active_owners AS owner ON owner.team_id = team.team_id
    GROUP BY team.team_id
  )
  SELECT team_id, active_owner_member_ids, credentialed_owner_member_ids
  FROM owner_counts
  WHERE active_owner_count <> 1 OR credentialed_owner_count <> 1
  ORDER BY team_id
  LIMIT 1
`

export const POSTGRES_TEAM_MIGRATION_12_MUTATION_SQL = `
  ${POSTGRES_TEAM_MIGRATION_12_NORMALIZE_ADMINS_SQL};

  WITH current_owners AS (
    SELECT member.team_id, member.id AS owner_member_id
    FROM team_members AS member
    INNER JOIN teams AS team ON team.id = member.team_id
    WHERE member.role = 'owner'
      AND member.status = 'active'
      AND team.status IN ('active', 'paused')
  )
  UPDATE team_invites AS invite
  SET status = 'revoked',
      token_hash = 'revoked:migration-12:' || invite.id
  FROM current_owners AS owner
  WHERE invite.team_id = owner.team_id
    AND invite.status = 'pending'
    AND invite.invited_by_member_id <> owner.owner_member_id;
`

/**
 * Excludes legacy member writes while the Unicode 15.1 comparison keys are
 * repaired. The runtime migrator performs the data-dependent repair between
 * PREPARE and FINALIZE inside its migration transaction.
 */
export const POSTGRES_TEAM_MIGRATION_20_LOCK_SQL =
  'LOCK TABLE teams, team_members IN SHARE ROW EXCLUSIVE MODE'

export const POSTGRES_TEAM_MIGRATION_20_PREPARE_SQL = `
  ALTER TABLE team_members
    ADD COLUMN IF NOT EXISTS display_name_key text COLLATE "C";
  CREATE TABLE IF NOT EXISTS team_member_display_name_migration_audit_events (
    id text PRIMARY KEY,
    team_id text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    member_id text NOT NULL REFERENCES team_members(id),
    migration_version integer NOT NULL CHECK (migration_version = 20),
    previous_display_name text NOT NULL,
    next_display_name text NOT NULL,
    repair_reason text NOT NULL CHECK (repair_reason IN ('normalized', 'invalid', 'collision')),
    created_at bigint NOT NULL,
    acknowledged_at bigint,
    UNIQUE (migration_version, member_id)
  );
  CREATE INDEX IF NOT EXISTS team_member_display_name_migration_audit_events_team_idx
    ON team_member_display_name_migration_audit_events(team_id, created_at DESC, id DESC);
`

export const POSTGRES_TEAM_MIGRATION_20_FINALIZE_SQL = `
  ALTER TABLE team_members
    ALTER COLUMN display_name_key SET NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS team_members_active_display_name_key_idx
    ON team_members(team_id, display_name_key) WHERE status = 'active';
`

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
  /** Host-owned invitation cipher. New invitations fail closed when omitted. */
  readonly inviteCipher?: TeamInviteCipher
}

export interface PostgresTeamMigration {
  readonly version: number
  /**
   * Runtime-managed migrations contain data-dependent application logic and
   * must be applied through PostgresTeamStore.initialize() (or the packaged
   * dsh-codex-team-migrate command), never by replaying `sql` directly.
   */
  readonly execution?: 'sql' | 'runtime-managed'
  /**
   * Directly executable DDL for ordinary migrations. Runtime-managed entries
   * intentionally contain fail-closed SQL so generic SQL loops cannot create
   * a partially migrated schema.
   */
  readonly sql: string
}

/**
 * Public migration manifest. Inspect `execution` before using `sql`; the
 * packaged migrator is the authoritative executor for runtime-managed entries.
 */
export const POSTGRES_TEAM_MIGRATIONS: readonly PostgresTeamMigration[] = [{
  version: 1,
  sql: `
    CREATE TABLE IF NOT EXISTS teams (
      id text PRIMARY KEY,
      name text NOT NULL,
      status text NOT NULL CONSTRAINT teams_status_check CHECK (status IN ('active', 'paused')),
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
}, {
  version: 7,
  sql: `
    ALTER TABLE team_contributions
      ADD COLUMN IF NOT EXISTS daily_shared_credit_limit bigint;
    ALTER TABLE team_usage_events
      ADD COLUMN IF NOT EXISTS reserved_credits bigint NOT NULL DEFAULT 0;
    ALTER TABLE team_usage_events
      ADD COLUMN IF NOT EXISTS input_tokens bigint;
    ALTER TABLE team_usage_events
      ADD COLUMN IF NOT EXISTS cached_input_tokens bigint;
    ALTER TABLE team_usage_events
      ADD COLUMN IF NOT EXISTS output_tokens bigint;
    ALTER TABLE team_usage_events
      ADD COLUMN IF NOT EXISTS credits bigint;
    ALTER TABLE team_usage_events
      ADD COLUMN IF NOT EXISTS credits_formula_version text;
    ALTER TABLE team_contributions
      ADD CONSTRAINT team_contributions_daily_shared_credit_limit_check
        CHECK (daily_shared_credit_limit IS NULL OR daily_shared_credit_limit BETWEEN 1 AND 1000000000000);
    ALTER TABLE team_usage_events
      ADD CONSTRAINT team_usage_events_reserved_credits_check
        CHECK (reserved_credits BETWEEN 0 AND 1000000000000);
    ALTER TABLE team_usage_events
      ADD CONSTRAINT team_usage_events_input_tokens_check
        CHECK (input_tokens IS NULL OR input_tokens BETWEEN 0 AND 1000000000);
    ALTER TABLE team_usage_events
      ADD CONSTRAINT team_usage_events_cached_input_tokens_check
        CHECK (cached_input_tokens IS NULL OR cached_input_tokens BETWEEN 0 AND 1000000000);
    ALTER TABLE team_usage_events
      ADD CONSTRAINT team_usage_events_output_tokens_check
        CHECK (output_tokens IS NULL OR output_tokens BETWEEN 0 AND 1000000000);
    ALTER TABLE team_usage_events
      ADD CONSTRAINT team_usage_events_credits_check
        CHECK (credits IS NULL OR credits BETWEEN 0 AND 4250000000);
    ALTER TABLE team_usage_events
      ADD CONSTRAINT team_usage_events_credits_formula_version_check
        CHECK (credits_formula_version IS NULL OR credits_formula_version = 'credits-v1');
    CREATE INDEX IF NOT EXISTS team_usage_events_account_day_idx
      ON team_usage_events(team_id, upstream_account_id, started_at DESC);
  `,
}, {
  version: 8,
  sql: `
    ALTER TABLE team_usage_events
      DROP COLUMN IF EXISTS input_tokens;
    ALTER TABLE team_usage_events
      DROP COLUMN IF EXISTS cached_input_tokens;
    ALTER TABLE team_usage_events
      DROP COLUMN IF EXISTS output_tokens;
  `,
}, {
  version: 9,
  sql: `
    ALTER TABLE team_invites
      ADD COLUMN IF NOT EXISTS label text NOT NULL DEFAULT 'Team invitation';
  `,
}, {
  version: 10,
  sql: `
    CREATE TABLE IF NOT EXISTS team_membership_audit_events (
      id text PRIMARY KEY,
      team_id text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      actor_member_id text NOT NULL REFERENCES team_members(id),
      target_member_id text NOT NULL REFERENCES team_members(id),
      action text NOT NULL CHECK (action IN ('ownership_transferred', 'role_changed', 'member_removed', 'member_left')),
      previous_role text NOT NULL CHECK (previous_role IN ('owner', 'admin', 'member')),
      next_role text CHECK (next_role IS NULL OR next_role IN ('owner', 'admin', 'member')),
      result text NOT NULL CHECK (result = 'succeeded'),
      created_at bigint NOT NULL
    );
    CREATE INDEX IF NOT EXISTS team_membership_audit_events_team_idx
      ON team_membership_audit_events(team_id, created_at DESC, id DESC);
  `,
}, {
  version: 11,
  sql: `
    ALTER TABLE team_usage_events
      ADD COLUMN IF NOT EXISTS total_tokens bigint;
    ALTER TABLE team_usage_events
      ADD COLUMN IF NOT EXISTS estimated_cost_usd_micros bigint;
    ALTER TABLE team_usage_events
      ADD COLUMN IF NOT EXISTS pricing_catalog_version text;
    ALTER TABLE team_usage_events
      ADD CONSTRAINT team_usage_events_total_tokens_check
        CHECK (total_tokens IS NULL OR total_tokens BETWEEN 0 AND 2000000000);
    ALTER TABLE team_usage_events
      ADD CONSTRAINT team_usage_events_estimated_cost_usd_micros_check
        CHECK (estimated_cost_usd_micros IS NULL OR estimated_cost_usd_micros >= 0);
    ALTER TABLE team_usage_events
      ADD CONSTRAINT team_usage_events_pricing_catalog_version_check
        CHECK (pricing_catalog_version IS NULL OR char_length(pricing_catalog_version) BETWEEN 1 AND 128);
    ALTER TABLE team_usage_events
      ADD CONSTRAINT team_usage_events_estimated_cost_metadata_check
        CHECK (
          estimated_cost_usd_micros IS NULL
          OR (total_tokens IS NOT NULL AND pricing_catalog_version IS NOT NULL)
        );
    CREATE INDEX IF NOT EXISTS team_usage_events_consumer_window_idx
      ON team_usage_events(team_id, consumer_member_id, started_at);
  `,
}, {
  version: 12,
  sql: `
    ${POSTGRES_TEAM_MIGRATION_12_LOCK_SQL};

    DO $team_role_migration_12$
    DECLARE
      conflict_team_id text;
      conflict_active_owner_member_ids text;
      conflict_credentialed_owner_member_ids text;
    BEGIN
      SELECT
        conflict.team_id,
        conflict.active_owner_member_ids,
        conflict.credentialed_owner_member_ids
      INTO
        conflict_team_id,
        conflict_active_owner_member_ids,
        conflict_credentialed_owner_member_ids
      FROM (
        ${POSTGRES_TEAM_MIGRATION_12_PREFLIGHT_SQL}
      ) AS conflict;
      IF conflict_team_id IS NOT NULL THEN
        RAISE EXCEPTION USING MESSAGE =
          '${POSTGRES_TEAM_MIGRATION_12_ERROR}: team_id='
          || to_jsonb(conflict_team_id)::text
          || ' active_owner_member_ids='
          || conflict_active_owner_member_ids
          || ' credentialed_owner_member_ids='
          || conflict_credentialed_owner_member_ids;
      END IF;
    END;
    $team_role_migration_12$;

    ${POSTGRES_TEAM_MIGRATION_12_AUDIT_TABLE_SQL}
    ${POSTGRES_TEAM_MIGRATION_12_INLINE_AUDIT_ADMINS_SQL}
    ${POSTGRES_TEAM_MIGRATION_12_MUTATION_SQL}
  `,
}, {
  version: 13,
  sql: `
    ALTER TABLE team_invites
      ADD COLUMN IF NOT EXISTS envelope_version integer;
    ALTER TABLE team_invites
      ADD COLUMN IF NOT EXISTS envelope_key_ref text;
    ALTER TABLE team_invites
      ADD COLUMN IF NOT EXISTS envelope_wrapped_dek text;
    ALTER TABLE team_invites
      ADD COLUMN IF NOT EXISTS envelope_wrapped_dek_nonce text;
    ALTER TABLE team_invites
      ADD COLUMN IF NOT EXISTS envelope_wrapped_dek_tag text;
    ALTER TABLE team_invites
      ADD COLUMN IF NOT EXISTS envelope_nonce text;
    ALTER TABLE team_invites
      ADD COLUMN IF NOT EXISTS envelope_ciphertext text;
    ALTER TABLE team_invites
      ADD COLUMN IF NOT EXISTS envelope_tag text;
    ALTER TABLE team_invites
      ADD CONSTRAINT team_invites_envelope_version_check
        CHECK (envelope_version IS NULL OR envelope_version = 1);
    ALTER TABLE team_invites
      ADD CONSTRAINT team_invites_envelope_complete_check
        CHECK (
          (
            envelope_version IS NULL
            AND envelope_key_ref IS NULL
            AND envelope_wrapped_dek IS NULL
            AND envelope_wrapped_dek_nonce IS NULL
            AND envelope_wrapped_dek_tag IS NULL
            AND envelope_nonce IS NULL
            AND envelope_ciphertext IS NULL
            AND envelope_tag IS NULL
          )
          OR (
            envelope_version = 1
            AND envelope_key_ref IS NOT NULL
            AND envelope_wrapped_dek IS NOT NULL
            AND envelope_nonce IS NOT NULL
            AND envelope_ciphertext IS NOT NULL
            AND envelope_tag IS NOT NULL
            AND (
              (envelope_wrapped_dek_nonce IS NULL AND envelope_wrapped_dek_tag IS NULL)
              OR (envelope_wrapped_dek_nonce IS NOT NULL AND envelope_wrapped_dek_tag IS NOT NULL)
            )
          )
        );
  `,
}, {
  version: 14,
  sql: `
    CREATE TABLE IF NOT EXISTS team_invite_reveal_audit_events (
      id text PRIMARY KEY,
      team_id text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      actor_member_id text NOT NULL REFERENCES team_members(id),
      invite_id text NOT NULL,
      created_at bigint NOT NULL
    );
    CREATE INDEX IF NOT EXISTS team_invite_reveal_audit_events_team_time_idx
      ON team_invite_reveal_audit_events(team_id, created_at DESC, id DESC);
  `,
}, {
  version: 15,
  sql: `
    CREATE TABLE IF NOT EXISTS team_invite_reveal_rate_limits (
      team_id text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      actor_member_id text NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
      invite_id text NOT NULL,
      window_started_at bigint NOT NULL,
      attempt_count integer NOT NULL CHECK (attempt_count > 0),
      PRIMARY KEY (team_id, actor_member_id, invite_id)
    );
  `,
}, {
  version: 16,
  sql: `
    ALTER TABLE teams
      DROP CONSTRAINT IF EXISTS teams_status_check;
    ALTER TABLE teams
      ADD COLUMN IF NOT EXISTS lifecycle_revision integer NOT NULL DEFAULT 1;
    ALTER TABLE teams
      ADD COLUMN IF NOT EXISTS dissolved_at bigint;
    ALTER TABLE teams
      ADD CONSTRAINT teams_status_check
        CHECK (status IN ('active', 'paused', 'dissolved'));
    ALTER TABLE teams
      ADD CONSTRAINT teams_lifecycle_revision_check
        CHECK (lifecycle_revision > 0);
    ALTER TABLE teams
      ADD CONSTRAINT teams_dissolution_state_check
        CHECK (
          (status = 'dissolved' AND dissolved_at IS NOT NULL)
          OR (status <> 'dissolved' AND dissolved_at IS NULL)
        );

    ALTER TABLE team_api_keys
      ADD COLUMN IF NOT EXISTS revoked_reason text;
    ALTER TABLE team_api_keys
      ADD CONSTRAINT team_api_keys_revoked_reason_check
        CHECK (
          revoked_reason IS NULL
          OR revoked_reason IN ('member_removed', 'member_left', 'device_revoked', 'team_dissolved')
        );
    ALTER TABLE team_api_keys
      ADD CONSTRAINT team_api_keys_revocation_state_check
        CHECK (revoked_reason IS NULL OR revoked_at IS NOT NULL);

    CREATE TABLE IF NOT EXISTS team_lifecycle_operations (
      operation_id text PRIMARY KEY,
      team_id text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      actor_member_id text NOT NULL,
      kind text NOT NULL CHECK (kind IN ('status', 'dissolution')),
      binding_hash text NOT NULL CHECK (char_length(binding_hash) = 64),
      result jsonb NOT NULL,
      recovery_secret_hash text,
      acknowledged_at bigint,
      created_at bigint NOT NULL,
      CHECK (
        (kind = 'status' AND recovery_secret_hash IS NULL)
        OR (kind = 'dissolution' AND recovery_secret_hash IS NOT NULL AND char_length(recovery_secret_hash) = 64)
      )
    );
    CREATE INDEX IF NOT EXISTS team_lifecycle_operations_team_idx
      ON team_lifecycle_operations(team_id, created_at, operation_id);

    CREATE TABLE IF NOT EXISTS team_lifecycle_audit_events (
      id text PRIMARY KEY,
      team_id text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      actor_member_id text NOT NULL,
      operation_id text NOT NULL UNIQUE REFERENCES team_lifecycle_operations(operation_id) ON DELETE CASCADE,
      kind text NOT NULL CHECK (kind IN ('status', 'dissolution')),
      previous_status text NOT NULL CHECK (previous_status IN ('active', 'paused')),
      next_status text NOT NULL CHECK (next_status IN ('active', 'paused', 'dissolved')),
      previous_lifecycle_revision integer NOT NULL CHECK (previous_lifecycle_revision > 0),
      next_lifecycle_revision integer NOT NULL CHECK (next_lifecycle_revision > 0),
      created_at bigint NOT NULL
    );
    CREATE INDEX IF NOT EXISTS team_lifecycle_audit_events_team_idx
      ON team_lifecycle_audit_events(team_id, created_at, id);
  `,
}, {
  version: 17,
  sql: `
    CREATE TABLE IF NOT EXISTS team_dissolution_recovery_rate_limits (
      source_digest text NOT NULL CHECK (char_length(source_digest) = 64),
      action text NOT NULL CHECK (action IN ('result', 'ack')),
      window_started_at bigint NOT NULL,
      attempt_count integer NOT NULL CHECK (attempt_count > 0),
      PRIMARY KEY (source_digest, action)
    );
    CREATE INDEX IF NOT EXISTS team_dissolution_recovery_rate_limits_window_idx
      ON team_dissolution_recovery_rate_limits(window_started_at);
  `,
}, {
  version: 18,
  sql: `
    CREATE TABLE IF NOT EXISTS team_ownership_transfers (
      id text PRIMARY KEY,
      team_id text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      requested_by_member_id text NOT NULL REFERENCES team_members(id),
      target_member_id text NOT NULL REFERENCES team_members(id),
      status text NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'revoked', 'expired', 'canceled')),
      created_at bigint NOT NULL,
      expires_at bigint NOT NULL,
      resolved_at bigint,
      acceptance_result jsonb,
      CHECK (requested_by_member_id <> target_member_id),
      CHECK (expires_at = created_at + 86400000),
      CHECK (
        (status = 'pending' AND resolved_at IS NULL)
        OR (status <> 'pending' AND resolved_at IS NOT NULL)
      ),
      CHECK (
        (status = 'accepted' AND acceptance_result IS NOT NULL)
        OR (status <> 'accepted' AND acceptance_result IS NULL)
      )
    );
    CREATE UNIQUE INDEX IF NOT EXISTS team_ownership_transfers_one_pending_idx
      ON team_ownership_transfers(team_id) WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS team_ownership_transfers_participants_idx
      ON team_ownership_transfers(team_id, requested_by_member_id, target_member_id, created_at);
  `,
}, {
  version: 19,
  sql: `
    CREATE TABLE IF NOT EXISTS team_ownership_transfer_audit_events (
      id text PRIMARY KEY,
      team_id text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      transfer_id text NOT NULL REFERENCES team_ownership_transfers(id) ON DELETE CASCADE,
      actor_member_id text REFERENCES team_members(id),
      action text NOT NULL CHECK (action IN ('requested', 'accepted', 'rejected', 'revoked', 'expired', 'canceled')),
      created_at bigint NOT NULL,
      UNIQUE (transfer_id, action)
    );
    CREATE INDEX IF NOT EXISTS team_ownership_transfer_audit_events_team_idx
      ON team_ownership_transfer_audit_events(team_id, created_at, id);
  `,
}, {
  version: 20,
  execution: 'runtime-managed',
  sql: `
    DO $dsh_team_runtime_managed_migration$
    BEGIN
      RAISE EXCEPTION
        'Team schema migration 20 requires PostgresTeamStore.initialize() or dsh-codex-team-migrate; direct SQL execution is unsupported';
    END
    $dsh_team_runtime_managed_migration$;
  `,
}, {
  version: 21,
  sql: `
    ALTER TABLE team_contributions
      ADD COLUMN IF NOT EXISTS weekly_shared_estimated_api_cost_limit_micros bigint;
    ALTER TABLE team_contributions
      DROP CONSTRAINT IF EXISTS team_contributions_weekly_shared_estimated_api_cost_limit_check;
    ALTER TABLE team_contributions
      ADD CONSTRAINT team_contributions_weekly_shared_estimated_api_cost_limit_check
      CHECK (weekly_shared_estimated_api_cost_limit_micros IS NULL OR weekly_shared_estimated_api_cost_limit_micros BETWEEN 10000 AND 10000000000);
    ALTER TABLE team_usage_events
      ADD COLUMN IF NOT EXISTS reserved_estimated_cost_usd_micros bigint NOT NULL DEFAULT 0;
    ALTER TABLE team_usage_events
      DROP CONSTRAINT IF EXISTS team_usage_events_reserved_estimated_cost_check;
    ALTER TABLE team_usage_events
      ADD CONSTRAINT team_usage_events_reserved_estimated_cost_check
      CHECK (reserved_estimated_cost_usd_micros >= 0);
  `,
}, {
  version: 22,
  // Some restored databases recorded migration 9 without its label column.
  // Append a repair migration so the schema-owner migrator can recover them
  // without rewriting history or changing existing invitation credentials.
  sql: `
    ALTER TABLE team_invites
      ADD COLUMN IF NOT EXISTS label text NOT NULL DEFAULT 'Team invitation';
  `,
}, {
  version: 23,
  sql: `
    CREATE TABLE IF NOT EXISTS team_anonymous_creations (
      creation_hash text PRIMARY KEY,
      binding_hash text NOT NULL,
      recovery_hash text NOT NULL UNIQUE,
      team_id text NOT NULL UNIQUE REFERENCES teams(id) ON DELETE CASCADE,
      member_id text NOT NULL REFERENCES team_members(id),
      created_at bigint NOT NULL,
      recovery_revoked_at bigint
    );
    CREATE TABLE IF NOT EXISTS team_anonymous_rate_limits (
      action text PRIMARY KEY CHECK (action IN ('create', 'recover-owner')),
      window_started_at bigint NOT NULL,
      attempt_count integer NOT NULL CHECK (attempt_count > 0)
    );
  `,
}, {
  version: 24,
  // Older deployments retained a required heartbeat column from the previous
  // accounting implementation. Route leases now own liveness; keep historical
  // timestamps but allow current usage INSERTs to omit the obsolete field.
  // Adding it when absent makes this repair work for fresh schemas as well.
  sql: `
    ALTER TABLE team_usage_events ADD COLUMN IF NOT EXISTS last_heartbeat_at bigint;
    ALTER TABLE team_usage_events ALTER COLUMN last_heartbeat_at DROP NOT NULL;
  `,
}, {
  version: 25,
  // A reservation fallback is explicitly an estimate, not measured Token usage.
  // Keep requiring Token metadata for all actual pricing catalogs.
  sql: `
    ALTER TABLE team_usage_events DROP CONSTRAINT team_usage_events_estimated_cost_metadata_check;
    ALTER TABLE team_usage_events ADD CONSTRAINT team_usage_events_estimated_cost_metadata_check
      CHECK (
        estimated_cost_usd_micros IS NULL
        OR (pricing_catalog_version IS NOT NULL AND (
          total_tokens IS NOT NULL OR pricing_catalog_version = 'admission-reservation-v1'
        ))
      );
  `,
}]

interface AnonymousCreationRow extends QueryResultRow {
  creation_hash: string
  binding_hash: string
  recovery_hash: string
  team_id: string
  member_id: string
  recovery_revoked_at: string | number | null
}

interface TeamRow extends QueryResultRow {
  id: string
  name: string
  status: TeamStatus
  lifecycle_revision: string | number
  dissolved_at: string | number | null
  created_at: string | number
}

interface MemberRow extends QueryResultRow {
  id: string
  team_id: string
  display_name: string
  display_name_key: string
  role: TeamRole
  status: TeamMemberStatus
  joined_at: string | number
}

interface DisplayNameMigrationAuditRow extends QueryResultRow {
  readonly migration_version: string | number
}

interface TeamMemberDisplayNameMigrationRow extends QueryResultRow {
  readonly id: string
  readonly team_id: string
  readonly display_name: string
  readonly role: TeamRole
  readonly status: TeamMemberStatus
  readonly joined_at: string | number
}

type TeamMemberDisplayNameRepairReason = 'normalized' | 'invalid' | 'collision'

interface TeamMemberDisplayNameMigrationPlan {
  readonly id: string
  readonly teamId: string
  readonly previousDisplayName: string
  displayName: string
  displayNameKey: string
  readonly role: TeamRole
  readonly status: TeamMemberStatus
  readonly joinedAt: number
  repairReason?: TeamMemberDisplayNameRepairReason
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareDisplayNameMigrationMembers(
  left: TeamMemberDisplayNameMigrationPlan,
  right: TeamMemberDisplayNameMigrationPlan,
): number {
  const roleOrder = Number(left.role !== 'owner') - Number(right.role !== 'owner')
  return roleOrder
    || left.joinedAt - right.joinedAt
    || compareCodeUnits(left.id, right.id)
}

function planTeamMemberDisplayNameMigration(
  rows: readonly TeamMemberDisplayNameMigrationRow[],
): TeamMemberDisplayNameMigrationPlan[] {
  const plans = rows.map((row): TeamMemberDisplayNameMigrationPlan => {
    try {
      const normalized = normalizeTeamMemberDisplayName(row.display_name, 'stored displayName')
      return {
        id: row.id,
        teamId: row.team_id,
        previousDisplayName: row.display_name,
        displayName: normalized.displayName,
        displayNameKey: normalized.displayNameKey,
        role: row.role,
        status: row.status,
        joinedAt: numberValue(row.joined_at),
        ...(normalized.displayName === row.display_name ? {} : { repairReason: 'normalized' as const }),
      }
    } catch (error: unknown) {
      if (!(error instanceof TypeError)) throw error
      const fallback = fallbackTeamMemberDisplayName(row.id)
      return {
        id: row.id,
        teamId: row.team_id,
        previousDisplayName: row.display_name,
        displayName: fallback.displayName,
        displayNameKey: fallback.displayNameKey,
        role: row.role,
        status: row.status,
        joinedAt: numberValue(row.joined_at),
        repairReason: 'invalid',
      }
    }
  })

  const activeGroups = new Map<string, TeamMemberDisplayNameMigrationPlan[]>()
  for (const plan of plans) {
    if (plan.status !== 'active') continue
    const groupId = `${plan.teamId.length}:${plan.teamId}${plan.displayNameKey}`
    const group = activeGroups.get(groupId) ?? []
    group.push(plan)
    activeGroups.set(groupId, group)
  }

  const reservedKeysByTeam = new Map<string, Set<string>>()
  const collisionLosers: TeamMemberDisplayNameMigrationPlan[] = []
  for (const group of activeGroups.values()) {
    group.sort(compareDisplayNameMigrationMembers)
    const winner = group[0]
    if (winner === undefined) continue
    const reserved = reservedKeysByTeam.get(winner.teamId) ?? new Set<string>()
    reserved.add(winner.displayNameKey)
    reservedKeysByTeam.set(winner.teamId, reserved)
    collisionLosers.push(...group.slice(1))
  }

  collisionLosers.sort((left, right) => (
    compareCodeUnits(left.teamId, right.teamId)
    || compareCodeUnits(left.displayNameKey, right.displayNameKey)
    || compareDisplayNameMigrationMembers(left, right)
  ))
  for (const plan of collisionLosers) {
    const reserved = reservedKeysByTeam.get(plan.teamId)
    if (reserved === undefined) throw new Error('display-name migration reservation is missing')
    for (let ordinal = 2; ; ordinal += 1) {
      const candidate = appendTeamMemberDisplayNameCollisionSuffix(plan.displayName, ordinal)
      if (reserved.has(candidate.displayNameKey)) continue
      plan.displayName = candidate.displayName
      plan.displayNameKey = candidate.displayNameKey
      if (plan.repairReason !== 'invalid') plan.repairReason = 'collision'
      reserved.add(candidate.displayNameKey)
      break
    }
  }

  return plans
}

interface MembershipAuditRow extends QueryResultRow {
  id: string
  team_id: string
  actor_member_id: string
  target_member_id: string
  action: TeamMembershipAuditAction
  previous_role: TeamRole
  next_role: TeamRole | null
  result: 'succeeded'
  created_at: string | number
}

interface InviteRevealAuditRow extends QueryResultRow {
  id: string
  team_id: string
  actor_member_id: string
  invite_id: string
  created_at: string | number
}

interface InviteRevealRateLimitRow extends QueryResultRow {
  window_started_at: string | number
  attempt_count: string | number
}

interface DissolutionRecoveryRateLimitRow extends QueryResultRow {
  window_started_at: string | number
  attempt_count: string | number
}

interface InviteRow extends QueryResultRow {
  id: string
  team_id: string
  invited_by_member_id: string
  label: string
  status: TeamInviteStatus
  expires_at: string | number
  created_at: string | number
  accepted_at: string | number | null
  token_hash: string
  envelope_version: string | number | null
  envelope_key_ref: string | null
  envelope_wrapped_dek: string | null
  envelope_wrapped_dek_nonce: string | null
  envelope_wrapped_dek_tag: string | null
  envelope_nonce: string | null
  envelope_ciphertext: string | null
  envelope_tag: string | null
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
  revoked_reason: 'member_removed' | 'member_left' | 'device_revoked' | 'team_dissolved' | null
  token_hash: string
}

interface LifecycleOperationRow extends QueryResultRow {
  operation_id: string
  team_id: string
  actor_member_id: string
  kind: 'status' | 'dissolution'
  binding_hash: string
  result: unknown
  recovery_secret_hash: string | null
  acknowledged_at: string | number | null
  created_at: string | number
}

interface OwnershipTransferRow extends QueryResultRow {
  id: string
  team_id: string
  requested_by_member_id: string
  target_member_id: string
  status: TeamOwnershipTransferStatus
  created_at: string | number
  expires_at: string | number
  resolved_at: string | number | null
  acceptance_result: unknown | null
}

type OwnershipTransferAuditAction =
  | 'requested'
  | 'accepted'
  | 'rejected'
  | 'revoked'
  | 'expired'
  | 'canceled'

interface ContributionRow extends QueryResultRow {
  id: string
  team_id: string
  owner_member_id: string
  label: string
  status: TeamContributionStatus
  personal_reserve_percent: number
  max_shared_requests_per_window: number | null
  daily_shared_credit_limit: string | number | null
  weekly_shared_estimated_api_cost_limit_micros: string | number | null
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
  reserved_credits: string | number
  reserved_estimated_cost_usd_micros: string | number
  credits: string | number | null
  credits_formula_version: 'credits-v1' | null
  total_tokens: string | number | null
  estimated_cost_usd_micros: string | number | null
  pricing_catalog_version: string | null
  started_at: string | number
  finished_at: string | number | null
}

interface UsageProjectionAggregateRow extends QueryResultRow {
  request_count: string | number
  token_measured_request_count: string | number
  priced_request_count: string | number
  total_tokens: string | number | bigint | null
  estimated_cost_usd_micros: string | number | bigint | null
}

interface AccountUsageAggregateRow extends QueryResultRow {
  upstream_account_id: string
  request_count: string | number
  measured_request_count: string | number
  credits: string | number
}

interface MemberDailyUsageAggregateRow extends AccountUsageAggregateRow {
  consumer_member_id: string
  day_started_at: string | number
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
  lifecycle_revision: string | number
  dissolved_at: string | number | null
  created_at: string | number
  display_name: string
  display_name_key: string
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
  private readonly inviteCipher: TeamInviteCipher | undefined
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
    this.inviteCipher = options.inviteCipher
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
    if (!await this.hasCurrentSchema()) await this.runMigrations()
    // Migration history alone does not prove restored/older databases match the
    // installed Host. Validate with a read-only query under the runtime role.
    try {
      await this.pool.query(`
        SELECT total_tokens, estimated_cost_usd_micros, pricing_catalog_version
        FROM team_usage_events WHERE false
      `)
      await this.pool.query(`
        SELECT label, envelope_version, envelope_key_ref, envelope_wrapped_dek,
          envelope_wrapped_dek_nonce, envelope_wrapped_dek_tag, envelope_nonce,
          envelope_ciphertext, envelope_tag
        FROM team_invites WHERE false
      `)
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'code' in error
        && (error.code === '42703' || error.code === '42P01')) {
        throw new Error('Team database schema is incompatible: run dsh-codex-team-migrate from the matching package with the schema-owner connection before starting Host and Broker; if migration history is current, repair the schema from a verified backup', { cause: error })
      }
      throw error
    }
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

  async createAnonymousTeam(input: TeamAnonymousCreationInput): Promise<TeamAnonymousOwnerResult> {
    const normalized = normalizeAnonymousCreation(input)
    await this.initialize()
    return this.transaction(async client => {
      // Low-volume provisioning is serialized across all replicas before checking
      // unique credentials. No caller-controlled headers participate in identity.
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [62497, 2301])
      const found = await client.query<AnonymousCreationRow>('SELECT * FROM team_anonymous_creations WHERE creation_hash = $1', [normalized.creationHash])
      const previous = found.rows[0]
      if (previous !== undefined) {
        if (!sameHash(previous.binding_hash, normalized.bindingHash)) throw new TeamAnonymousCreationConflictError()
        const result = await this.requireAnonymousOwner(client, previous)
        const keys = await client.query<KeyRow>('SELECT * FROM team_api_keys WHERE token_hash = $1 FOR UPDATE', [normalized.keyHash])
        const key = keys.rows[0]
        if (key === undefined || key.revoked_at !== null || key.member_id !== previous.member_id) throw new TeamOwnerRecoveryUnavailableError()
        return result
      }
      const recovery = await client.query('SELECT creation_hash FROM team_anonymous_creations WHERE recovery_hash = $1', [normalized.recoveryHash])
      const collision = await client.query('SELECT id FROM team_api_keys WHERE token_hash = $1', [normalized.keyHash])
      if (recovery.rows.length > 0 || collision.rows.length > 0) throw new TeamAnonymousCreationConflictError()
      const now = this.now()
      const team: TeamRow = { id: this.id(), name: normalized.teamName, status: 'active', lifecycle_revision: 1, dissolved_at: null, created_at: now }
      const member: MemberRow = { id: this.id(), team_id: team.id, display_name: normalized.owner.displayName, display_name_key: normalized.owner.displayNameKey, role: 'owner', status: 'active', joined_at: now }
      await client.query(`INSERT INTO teams (id, name, status, lifecycle_revision, dissolved_at, created_at) VALUES ($1, $2, 'active', 1, NULL, $3)`, [team.id, team.name, now])
      await client.query(`INSERT INTO team_members (id, team_id, display_name, display_name_key, role, status, joined_at) VALUES ($1, $2, $3, $4, 'owner', 'active', $5)`, [member.id, team.id, member.display_name, member.display_name_key, now])
      await this.createKey(client, team.id, member.id, 'owner device', now, input.apiKey)
      await client.query(`INSERT INTO team_anonymous_creations (creation_hash, binding_hash, recovery_hash, team_id, member_id, created_at) VALUES ($1, $2, $3, $4, $5, $6)`, [normalized.creationHash, normalized.bindingHash, normalized.recoveryHash, team.id, member.id, now])
      return { team: summaryTeam(team), member: summaryMember(member) }
    })
  }

  async recoverAnonymousTeamOwner(recoveryCode: string, apiKey: string): Promise<TeamAnonymousOwnerResult> {
    const recoveryHash = anonymousSecret(recoveryCode, 'dsh_recovery')
    const keyHash = anonymousSecret(apiKey, 'dsh_team')
    await this.initialize()
    return this.transaction(async client => {
      const found = await client.query<AnonymousCreationRow>('SELECT * FROM team_anonymous_creations WHERE recovery_hash = $1', [recoveryHash])
      const record = found.rows[0]
      if (record === undefined) throw new TeamOwnerRecoveryUnavailableError()
      const result = await this.requireAnonymousOwner(client, record)
      const existing = await client.query<KeyRow>('SELECT * FROM team_api_keys WHERE token_hash = $1 FOR UPDATE', [keyHash])
      const key = existing.rows[0]
      if (key !== undefined) {
        if (key.member_id !== record.member_id || key.revoked_at !== null) throw new TeamOwnerRecoveryUnavailableError()
      } else await this.createKey(client, record.team_id, record.member_id, 'recovered owner device', this.now(), apiKey)
      return result
    })
  }

  private async requireAnonymousOwner(client: PoolClient, record: AnonymousCreationRow): Promise<TeamAnonymousOwnerResult> {
    // Same Team-first ordering as membership transfer, removal and dissolution.
    // Re-read the recovery row after the Team lock so transfer invalidation wins.
    const teams = await client.query<TeamRow>('SELECT * FROM teams WHERE id = $1 FOR UPDATE', [record.team_id])
    const team = teams.rows[0]
    const current = await client.query<AnonymousCreationRow>('SELECT * FROM team_anonymous_creations WHERE creation_hash = $1 FOR UPDATE', [record.creation_hash])
    const members = await client.query<MemberRow>('SELECT * FROM team_members WHERE id = $1 AND team_id = $2 FOR UPDATE', [record.member_id, record.team_id])
    const member = members.rows[0]
    if (current.rows[0] === undefined || current.rows[0].recovery_revoked_at !== null || team === undefined || team.status === 'dissolved' || member === undefined || member.role !== 'owner' || member.status !== 'active') throw new TeamOwnerRecoveryUnavailableError()
    return { team: summaryTeam(team), member: summaryMember(member) }
  }

  async consumeAnonymousTeamAttempt(action: TeamAnonymousAction): Promise<void> {
    await this.initialize()
    const limit = TEAM_ANONYMOUS_LIMITS[action]
    const retryAfterSeconds = await this.transaction(async client => {
      const timing = await client.query<{ observed_at: string | number }>('SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS observed_at')
      const now = numberValue(requiredRow(timing.rows[0], 'PostgreSQL clock').observed_at)
      const startedAt = Math.floor(now / limit.windowMs) * limit.windowMs
      const updated = await client.query<{ window_started_at: string | number; attempt_count: number }>(`
        INSERT INTO team_anonymous_rate_limits (action, window_started_at, attempt_count)
        VALUES ($1, $2, 1)
        ON CONFLICT (action) DO UPDATE SET
          attempt_count = CASE
            WHEN EXCLUDED.window_started_at > team_anonymous_rate_limits.window_started_at THEN 1
            WHEN team_anonymous_rate_limits.attempt_count < $3 THEN team_anonymous_rate_limits.attempt_count + 1
            ELSE team_anonymous_rate_limits.attempt_count END,
          window_started_at = GREATEST(team_anonymous_rate_limits.window_started_at, EXCLUDED.window_started_at)
        RETURNING window_started_at, attempt_count
      `, [action, startedAt, limit.max + 1])
      const row = requiredRow(updated.rows[0], 'anonymous rate limit')
      return row.attempt_count > limit.max ? rateLimitRetryAfterSeconds(numberValue(row.window_started_at), now, limit.windowMs) : undefined
    })
    if (retryAfterSeconds !== undefined) throw new TeamAnonymousRateLimitError(retryAfterSeconds)
  }

  async bootstrap(teamName: string, ownerName: string): Promise<TeamBootstrapResult> {
    await this.initialize()
    return this.transaction(async (client) => {
      const normalizedTeamName = nonEmpty(teamName, 'teamName', MAX_TEAM_NAME_LENGTH)
      const normalizedOwnerName = normalizeTeamMemberDisplayName(ownerName, 'ownerName')
      const now = this.now()
      const team: TeamRow = {
        id: this.id(),
        name: normalizedTeamName,
        status: 'active',
        lifecycle_revision: 1,
        dissolved_at: null,
        created_at: now,
      }
      const member: MemberRow = {
        id: this.id(),
        team_id: team.id,
        display_name: normalizedOwnerName.displayName,
        display_name_key: normalizedOwnerName.displayNameKey,
        role: 'owner',
        status: 'active',
        joined_at: now,
      }
      await client.query(
        `INSERT INTO teams (id, name, status, lifecycle_revision, dissolved_at, created_at)
         VALUES ($1, $2, $3, $4, NULL, $5)`,
        [team.id, team.name, team.status, team.lifecycle_revision, team.created_at],
      )
      await client.query(
        `INSERT INTO team_members
           (id, team_id, display_name, display_name_key, role, status, joined_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          member.id,
          member.team_id,
          member.display_name,
          member.display_name_key,
          member.role,
          member.status,
          member.joined_at,
        ],
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
      const team = await this.lockTeam(client, auth.teamId)
      const pendingTransfer = await this.lockPendingOwnershipTransfer(client, team.id)
      const { member } = await this.requireAuthContext(client, auth, 'share', 'update')
      const now = this.now()
      const currentTransfer = pendingTransfer === undefined
        ? undefined
        : await this.expireLockedOwnershipTransfer(client, pendingTransfer, now)
      if (member.role === 'owner') await this.expirePendingInvites(client, team.id, now)
      const members = await client.query<MemberRow>('SELECT * FROM team_members WHERE team_id = $1 ORDER BY joined_at, id', [team.id])
      const invites = member.role === 'owner'
        ? await client.query<InviteRow>(`
          SELECT * FROM team_invites
          WHERE team_id = $1 AND status = 'pending' AND expires_at > $2
          ORDER BY created_at, id
        `, [team.id, now])
        : { rows: [] as InviteRow[] }
      const keys = await client.query<KeyRow>('SELECT * FROM team_api_keys WHERE team_id = $1 ORDER BY created_at, id', [team.id])
      const contributions = await client.query<ContributionRow>('SELECT * FROM team_contributions WHERE team_id = $1 ORDER BY created_at, id', [team.id])
      const displayNameMigrationNotice = await client.query<Pick<DisplayNameMigrationAuditRow, 'migration_version'>>(`
        SELECT migration_version
        FROM team_member_display_name_migration_audit_events
        WHERE team_id = $1
          AND member_id = $2
          AND acknowledged_at IS NULL
        ORDER BY migration_version, id
        LIMIT 1
      `, [team.id, member.id])
      const ownershipTransfer = currentTransfer?.status === 'pending' ? currentTransfer : undefined
      return {
        team: summaryTeam(team),
        currentMember: summaryMember(member),
        members: members.rows.map(summaryMember),
        invites: invites.rows.map(row => summaryInvite(row, now)),
        apiKeys: keys.rows.map(summaryKey),
        contributions: contributions.rows.map(summaryContribution),
        ...(displayNameMigrationNotice.rows[0] === undefined
          ? {}
          : {
              displayNameMigrationNotice: {
                migrationVersion: numberValue(displayNameMigrationNotice.rows[0].migration_version),
              },
            }),
        ...(
          ownershipTransfer !== undefined
          && (member.id === ownershipTransfer.requested_by_member_id
            || member.id === ownershipTransfer.target_member_id)
            ? { ownershipTransfer: summaryOwnershipTransfer(ownershipTransfer) }
            : {}
        ),
      }
    })
  }

  async acknowledgeDisplayNameMigration(
    auth: TeamAuthContext,
    migrationVersion: number,
  ): Promise<TeamDisplayNameMigrationAcknowledgement> {
    await this.initialize()
    return this.transaction(async (client) => {
      await this.requireAuthContext(client, auth)
      if (!Number.isSafeInteger(migrationVersion) || migrationVersion < 1) {
        throw new Error('migrationVersion must be a positive safe integer')
      }
      const result = await client.query<Pick<DisplayNameMigrationAuditRow, 'migration_version'>>(`
        UPDATE team_member_display_name_migration_audit_events
        SET acknowledged_at = COALESCE(acknowledged_at, $1)
        WHERE team_id = $2
          AND member_id = $3
          AND migration_version = $4
        RETURNING migration_version
      `, [this.now(), auth.teamId, auth.memberId, migrationVersion])
      const acknowledged = result.rows[0]
      if (acknowledged === undefined) throw new TeamDisplayNameMigrationUnavailableError()
      return {
        migrationVersion: numberValue(acknowledged.migration_version),
        acknowledged: true,
      }
    })
  }

  async createInvite(
    auth: TeamAuthContext,
    expiresInMs: number,
    label = 'Team invitation',
  ): Promise<TeamInviteResult> {
    await this.initialize()
    if (!Number.isSafeInteger(expiresInMs) || expiresInMs < 60_000 || expiresInMs > 30 * 24 * 60 * 60 * 1000) {
      throw new Error('expiresInMs is outside the allowed range')
    }
    const safeLabel = nonEmpty(label, 'label', MAX_INVITE_LABEL_LENGTH)
    await this.transaction(async (client) => {
      const team = await this.lockTeam(client, auth.teamId)
      await this.requireOwner(client, auth)
      if (team.status !== 'active') throw new Error('team is paused')
    })
    const cipher = this.requireInviteCipher()
    const now = this.now()
    const token = createSecret('dsh_invite', this.token)
    const inviteId = this.id()
    const tokenHash = hashToken(token)
    const envelope = await cipher.encrypt({
      teamId: auth.teamId,
      inviteId,
      createdAt: now,
      tokenDigest: tokenHash,
    }, token)
    return this.transaction(async (client) => {
      const team = await this.lockTeam(client, auth.teamId)
      const { member } = await this.requireOwner(client, auth)
      if (team.status !== 'active') throw new Error('team is paused')
      const invite: InviteRow = {
        id: inviteId,
        team_id: member.team_id,
        invited_by_member_id: member.id,
        label: safeLabel,
        status: 'pending',
        expires_at: now + expiresInMs,
        created_at: now,
        accepted_at: null,
        token_hash: tokenHash,
        ...storedInviteEnvelope(envelope),
      }
      await client.query(`
        INSERT INTO team_invites
          (id, team_id, invited_by_member_id, label, status, expires_at, created_at, accepted_at, token_hash,
           envelope_version, envelope_key_ref, envelope_wrapped_dek, envelope_wrapped_dek_nonce,
           envelope_wrapped_dek_tag, envelope_nonce, envelope_ciphertext, envelope_tag)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      `, [
        invite.id, invite.team_id, invite.invited_by_member_id, invite.label, invite.status,
        invite.expires_at, invite.created_at, null, invite.token_hash,
        invite.envelope_version, invite.envelope_key_ref, invite.envelope_wrapped_dek,
        invite.envelope_wrapped_dek_nonce, invite.envelope_wrapped_dek_tag, invite.envelope_nonce,
        invite.envelope_ciphertext, invite.envelope_tag,
      ])
      return { invite: summaryInvite(invite, now), inviteToken: token }
    })
  }

  async revealInvite(auth: TeamAuthContext, inviteId: string): Promise<TeamInviteRevealResult> {
    await this.initialize()
    const initialNow = this.now()
    const initial = await this.transaction(async (client) => {
      const team = await this.lockTeam(client, auth.teamId)
      if (team.status === 'dissolved') throw new TeamDissolvedError()
      await this.requireOwner(client, auth)
      const retryAfterSeconds = await this.consumeInviteRevealRateLimit(client, auth, inviteId, initialNow)
      if (retryAfterSeconds !== undefined) return { retryAfterSeconds }
      const result = await client.query<InviteRow>(
        'SELECT * FROM team_invites WHERE id = $1 AND team_id = $2',
        [inviteId, auth.teamId],
      )
      return { invite: result.rows[0] }
    })
    if ('retryAfterSeconds' in initial) {
      throw new TeamInviteRevealRateLimitError(initial.retryAfterSeconds)
    }
    const initialInvite = initial.invite
    if (
      initialInvite !== undefined
      && initialInvite.status === 'pending'
      && numberValue(initialInvite.expires_at) <= initialNow
    ) {
      await this.transaction(async (client) => {
        await this.lockTeam(client, auth.teamId)
        await this.requireOwner(client, auth)
        const result = await client.query<InviteRow>(
          'SELECT * FROM team_invites WHERE id = $1 AND team_id = $2 FOR UPDATE',
          [inviteId, auth.teamId],
        )
        const current = result.rows[0]
        if (current !== undefined && current.status === 'pending' && numberValue(current.expires_at) <= this.now()) {
          await this.expireLockedInvite(client, current)
        }
      })
      throw new Error('invite is no longer available')
    }
    const snapshot = revealableInviteSnapshot(initialInvite, initialNow)
    if (snapshot === undefined) throw new Error('invite is no longer available')
    let inviteToken: string
    try {
      inviteToken = await this.requireInviteCipher().decrypt({
        teamId: snapshot.invite.team_id,
        inviteId: snapshot.invite.id,
        createdAt: numberValue(snapshot.invite.created_at),
        tokenDigest: snapshot.invite.token_hash,
      }, snapshot.envelope)
    } catch {
      throw new Error('invite is no longer available')
    }
    const revealed = await this.transaction(async (client) => {
      await this.lockTeam(client, auth.teamId)
      await this.requireOwner(client, auth)
      const result = await client.query<InviteRow>(
        'SELECT * FROM team_invites WHERE id = $1 AND team_id = $2 FOR UPDATE',
        [inviteId, auth.teamId],
      )
      const current = result.rows[0]
      const now = this.now()
      if (current !== undefined && current.status === 'pending' && numberValue(current.expires_at) <= now) {
        await this.expireLockedInvite(client, current)
        return undefined
      }
      const currentSnapshot = revealableInviteSnapshot(current, now)
      if (
        currentSnapshot === undefined
        || !sameInviteSnapshot(snapshot, currentSnapshot)
      ) {
        return undefined
      }
      await this.insertInviteRevealAudit(client, {
        teamId: currentSnapshot.invite.team_id,
        actorMemberId: auth.memberId,
        inviteId: currentSnapshot.invite.id,
        createdAt: now,
      })
      return {
        inviteId: currentSnapshot.invite.id,
        inviteToken,
        expiresAt: numberValue(currentSnapshot.invite.expires_at),
      }
    })
    if (revealed === undefined) throw new Error('invite is no longer available')
    return revealed
  }

  async previewInvite(token: string): Promise<TeamInvitePreview> {
    await this.initialize()
    const tokenHash = hashToken(token)
    const locatorResult = await this.pool.query<Pick<InviteRow, 'id' | 'team_id'>>(
      'SELECT id, team_id FROM team_invites WHERE token_hash = $1',
      [tokenHash],
    )
    const locator = locatorResult.rows[0]
    if (locator === undefined) throw new Error('invite is invalid or expired')
    const preview = await this.transaction(async (client) => {
      const team = await this.lockTeam(client, locator.team_id)
      const result = await client.query<InviteRow>(
        'SELECT * FROM team_invites WHERE id = $1 AND team_id = $2 AND token_hash = $3 FOR UPDATE',
        [locator.id, locator.team_id, tokenHash],
      )
      const invite = result.rows[0]
      if (invite === undefined || invite.status !== 'pending') return undefined
      if (numberValue(invite.expires_at) <= this.now()) {
        await this.expireLockedInvite(client, invite)
        return undefined
      }
      return {
        teamName: team.name,
        label: invite.label,
        expiresAt: numberValue(invite.expires_at),
        teamStatus: team.status,
      }
    })
    if (preview === undefined) throw new Error('invite is invalid or expired')
    return preview
  }

  async revokeInvite(auth: TeamAuthContext, inviteId: string): Promise<TeamInviteSummary> {
    await this.initialize()
    return this.transaction(async (client) => {
      await this.lockTeam(client, auth.teamId)
      await this.requireOwner(client, auth)
      const result = await client.query<InviteRow>(
        'SELECT * FROM team_invites WHERE id = $1 AND team_id = $2 FOR UPDATE',
        [inviteId, auth.teamId],
      )
      const invite = result.rows[0]
      if (invite === undefined) throw new Error('invite not found')
      const now = this.now()
      if (invite.status === 'pending' && numberValue(invite.expires_at) <= now) {
        return summaryInvite(await this.expireLockedInvite(client, invite), now)
      }
      if (invite.status === 'accepted') throw new Error('accepted invite cannot be revoked')
      if (invite.status === 'expired' || invite.status === 'revoked') return summaryInvite(invite, now)
      const revoked: InviteRow = {
        ...invite,
        status: 'revoked',
        token_hash: revokedTokenHash(invite.id),
        ...emptyStoredInviteEnvelope(),
      }
      await client.query(
        `UPDATE team_invites
         SET status = 'revoked', token_hash = $1,
             envelope_version = NULL, envelope_key_ref = NULL, envelope_wrapped_dek = NULL,
             envelope_wrapped_dek_nonce = NULL, envelope_wrapped_dek_tag = NULL,
             envelope_nonce = NULL, envelope_ciphertext = NULL, envelope_tag = NULL
         WHERE id = $2`,
        [revoked.token_hash, revoked.id],
      )
      return summaryInvite(revoked, now)
    })
  }

  async acceptInvite(token: string, displayName: string): Promise<TeamJoinResult> {
    await this.initialize()
    const result = await this.transaction(client => this.acceptInviteRecord(client, token, displayName))
    if (result === undefined) throw new Error('invite is invalid or expired')
    return result
  }

  async acceptInviteWithApiKey(token: string, displayName: string, apiKey: string): Promise<TeamJoinAcceptedResult> {
    await this.initialize()
    const result = await this.transaction(client => this.acceptInviteRecord(client, token, displayName, apiKey))
    if (result === undefined) throw new Error('invite is invalid or expired')
    return { team: result.team, member: result.member }
  }

  async issueApiKey(auth: TeamAuthContext, label: string): Promise<{ summary: TeamApiKeySummary; token: string }> {
    await this.initialize()
    return this.transaction(async (client) => {
      const team = await this.lockTeam(client, auth.teamId)
      if (team.status === 'dissolved') throw new TeamDissolvedError()
      const { member } = await this.requireAuthContext(client, auth)
      const key = await this.createKey(client, member.team_id, member.id, nonEmpty(label, 'label', MAX_KEY_LABEL_LENGTH), this.now())
      return { summary: summaryKey(key), token: key.token }
    })
  }

  async revokeApiKey(auth: TeamAuthContext, keyId: string): Promise<void> {
    await this.initialize()
    await this.transaction(async (client) => {
      const team = await this.lockTeam(client, auth.teamId)
      if (team.status === 'dissolved') throw new TeamDissolvedError()
      const { member } = await this.requireAuthContext(client, auth)
      const result = await client.query<KeyRow>('SELECT * FROM team_api_keys WHERE id = $1 AND team_id = $2 FOR UPDATE', [keyId, member.team_id])
      const key = result.rows[0]
      if (key === undefined) throw new Error('api key not found')
      if (key.member_id !== member.id && member.role !== 'owner') {
        throw new Error('only the key owner or the Team owner can revoke this key')
      }
      if (member.role === 'owner' && key.id === auth.keyId && key.revoked_at === null) {
        throw new Error('the current Owner API key cannot be revoked; authenticate with another Owner key')
      }
      if (key.revoked_at === null) {
        await client.query(`
          UPDATE team_api_keys
          SET revoked_at = $1, revoked_reason = 'device_revoked'
          WHERE id = $2
        `, [this.now(), key.id])
      }
    })
  }

  async requestOwnershipTransfer(
    auth: TeamAuthContext,
    targetMemberId: string,
  ): Promise<TeamOwnershipTransferSummary> {
    await this.initialize()
    return this.transaction(async (client) => {
      const team = await this.lockTeam(client, auth.teamId)
      const pendingTransfer = await this.lockPendingOwnershipTransfer(client, team.id)
      const targetResult = await client.query<MemberRow>(
        'SELECT * FROM team_members WHERE id = $1 AND team_id = $2 FOR UPDATE',
        [targetMemberId, team.id],
      )
      const { member: formerOwner } = await this.requireAuthContext(client, auth, 'update', 'update')
      if (formerOwner.role !== 'owner') throw new Error('only the owner can transfer Team ownership')
      if (targetMemberId === formerOwner.id) throw new Error('ownership target must be a different Team member')
      const now = this.now()
      const currentTransfer = pendingTransfer === undefined
        ? undefined
        : await this.expireLockedOwnershipTransfer(client, pendingTransfer, now)
      if (currentTransfer?.status === 'pending') {
        throw new Error('this Team already has a pending ownership transfer')
      }

      const target = targetResult.rows[0]
      if (target === undefined) throw new Error('member not found in this Team')
      if (target.status !== 'active') throw new Error('member is not active in this Team')
      if (target.role !== 'member') throw new Error('ownership target must be an ordinary Team member')
      const keyResult = await client.query<Pick<KeyRow, 'id'>>(`
        SELECT id FROM team_api_keys
        WHERE team_id = $1 AND member_id = $2 AND revoked_at IS NULL
        ORDER BY created_at, id
        LIMIT 1
        FOR UPDATE
      `, [team.id, target.id])
      if (keyResult.rows[0] === undefined) throw new Error('ownership target must have an active Team API key')

      const result = await client.query<OwnershipTransferRow>(`
        INSERT INTO team_ownership_transfers
          (id, team_id, requested_by_member_id, target_member_id, status, created_at, expires_at, resolved_at, acceptance_result)
        VALUES ($1, $2, $3, $4, 'pending', $5, $6, NULL, NULL)
        RETURNING *
      `, [this.id(), team.id, formerOwner.id, target.id, now, now + TEAM_OWNERSHIP_TRANSFER_TTL_MS])
      const transfer = requiredRow(result.rows[0], 'ownership transfer')
      await this.insertOwnershipTransferAudit(client, transfer, 'requested', now, formerOwner.id)
      return summaryOwnershipTransfer(transfer)
    })
  }

  async acceptOwnershipTransfer(
    auth: TeamAuthContext,
    transferId: string,
  ): Promise<TeamOwnershipTransferAcceptanceResult> {
    await this.initialize()
    return this.transaction(async (client) => {
      const team = await this.lockTeam(client, auth.teamId)
      const transfer = await this.lockOwnershipTransfer(client, transferId, team.id)
      let lockedFormerOwner: MemberRow | undefined
      if (transfer !== undefined && transfer.target_member_id === auth.memberId) {
        const formerOwnerResult = await client.query<MemberRow>(`
          SELECT * FROM team_members
          WHERE id = $1 AND team_id = $2 FOR UPDATE
        `, [transfer.requested_by_member_id, team.id])
        lockedFormerOwner = formerOwnerResult.rows[0]
      }
      const { member: target } = await this.requireAuthContext(client, auth, 'update', 'update')
      if (transfer === undefined || target.id !== transfer.target_member_id) throw ownershipTransferUnavailable()
      const now = this.now()
      const currentTransfer = await this.expireLockedOwnershipTransfer(client, transfer, now)
      if (currentTransfer.status === 'accepted') return acceptanceResult(currentTransfer)
      requirePendingOwnershipTransfer(currentTransfer)
      if (target.role !== 'member') throw new Error('ownership target must be an ordinary Team member')

      const formerOwner = lockedFormerOwner
      if (formerOwner === undefined || formerOwner.status !== 'active' || formerOwner.role !== 'owner') {
        throw new Error('ownership transfer requester is no longer the Team owner')
      }

      await client.query(`UPDATE team_anonymous_creations SET recovery_revoked_at = $1 WHERE team_id = $2 AND recovery_revoked_at IS NULL`, [now, team.id])
      const formerOwnerUpdate = await client.query<MemberRow>(`
        UPDATE team_members SET role = 'member'
        WHERE id = $1 AND team_id = $2 AND role = 'owner' AND status = 'active'
        RETURNING *
      `, [formerOwner.id, team.id])
      const ownerUpdate = await client.query<MemberRow>(`
        UPDATE team_members SET role = 'owner'
        WHERE id = $1 AND team_id = $2 AND role = 'member' AND status = 'active'
        RETURNING *
      `, [target.id, team.id])
      await client.query(`
        UPDATE team_invites
        SET status = 'revoked',
            token_hash = 'revoked:ownership-transfer:' || id,
            envelope_version = NULL, envelope_key_ref = NULL, envelope_wrapped_dek = NULL,
            envelope_wrapped_dek_nonce = NULL, envelope_wrapped_dek_tag = NULL,
            envelope_nonce = NULL, envelope_ciphertext = NULL, envelope_tag = NULL
        WHERE team_id = $1 AND status = 'pending'
      `, [team.id])
      const provisionalTransfer: OwnershipTransferRow = {
        ...currentTransfer,
        status: 'accepted',
        resolved_at: now,
      }
      const accepted: TeamOwnershipTransferAcceptanceResult = {
        transfer: summaryOwnershipTransfer(provisionalTransfer),
        formerOwner: summaryMember(requiredRow(formerOwnerUpdate.rows[0], 'former Team owner')),
        owner: summaryMember(requiredRow(ownerUpdate.rows[0], 'new Team owner')),
      }
      const transferResult = await client.query<OwnershipTransferRow>(`
        UPDATE team_ownership_transfers
        SET status = 'accepted', resolved_at = $1, acceptance_result = $2::jsonb
        WHERE id = $3 AND team_id = $4 AND status = 'pending'
        RETURNING *
      `, [now, JSON.stringify(accepted), currentTransfer.id, team.id])
      await this.insertMembershipAudit(client, {
        teamId: team.id,
        actorMemberId: target.id,
        targetMemberId: target.id,
        action: 'ownership_transferred',
        previousRole: target.role,
        nextRole: 'owner',
        createdAt: now,
      })
      const acceptedTransfer = requiredRow(transferResult.rows[0], 'accepted ownership transfer')
      await this.insertOwnershipTransferAudit(client, acceptedTransfer, 'accepted', now, target.id)
      return acceptanceResult(acceptedTransfer)
    })
  }

  async rejectOwnershipTransfer(
    auth: TeamAuthContext,
    transferId: string,
  ): Promise<TeamOwnershipTransferSummary> {
    await this.initialize()
    return this.transaction(async (client) => {
      const team = await this.lockTeam(client, auth.teamId)
      const transfer = await this.lockOwnershipTransfer(client, transferId, team.id)
      const { member: target } = await this.requireAuthContext(client, auth, 'update', 'update')
      if (transfer === undefined || target.id !== transfer.target_member_id) throw ownershipTransferUnavailable()
      const now = this.now()
      const currentTransfer = await this.expireLockedOwnershipTransfer(client, transfer, now)
      if (currentTransfer.status !== 'pending') return summaryOwnershipTransfer(currentTransfer)
      requirePendingOwnershipTransfer(currentTransfer)
      const result = await client.query<OwnershipTransferRow>(`
        UPDATE team_ownership_transfers
        SET status = 'rejected', resolved_at = $1
        WHERE id = $2 AND team_id = $3 AND status = 'pending'
        RETURNING *
      `, [now, currentTransfer.id, team.id])
      const rejected = requiredRow(result.rows[0], 'rejected ownership transfer')
      await this.insertOwnershipTransferAudit(client, rejected, 'rejected', now, target.id)
      return summaryOwnershipTransfer(rejected)
    })
  }

  async revokeOwnershipTransfer(
    auth: TeamAuthContext,
    transferId: string,
  ): Promise<TeamOwnershipTransferSummary> {
    await this.initialize()
    return this.transaction(async (client) => {
      const team = await this.lockTeam(client, auth.teamId)
      const transfer = await this.lockOwnershipTransfer(client, transferId, team.id)
      const { member: owner } = await this.requireAuthContext(client, auth, 'update', 'update')
      if (transfer === undefined || owner.id !== transfer.requested_by_member_id) throw ownershipTransferUnavailable()
      const now = this.now()
      const currentTransfer = await this.expireLockedOwnershipTransfer(client, transfer, now)
      if (currentTransfer.status !== 'pending') return summaryOwnershipTransfer(currentTransfer)
      if (owner.role !== 'owner') throw new Error('only the current Team owner can revoke this ownership transfer')
      requirePendingOwnershipTransfer(currentTransfer)
      const result = await client.query<OwnershipTransferRow>(`
        UPDATE team_ownership_transfers
        SET status = 'revoked', resolved_at = $1
        WHERE id = $2 AND team_id = $3 AND status = 'pending'
        RETURNING *
      `, [now, currentTransfer.id, team.id])
      const revoked = requiredRow(result.rows[0], 'revoked ownership transfer')
      await this.insertOwnershipTransferAudit(client, revoked, 'revoked', now, owner.id)
      return summaryOwnershipTransfer(revoked)
    })
  }

  async removeMember(auth: TeamAuthContext, targetMemberId: string): Promise<TeamMemberDepartureResult> {
    await this.initialize()
    return this.transaction(async (client) => {
      const team = await this.lockTeam(client, auth.teamId)
      if (team.status === 'dissolved') throw new TeamDissolvedError()
      const pendingTransfer = await this.lockPendingOwnershipTransfer(client, team.id)
      const targetResult = await client.query<MemberRow>(
        'SELECT * FROM team_members WHERE id = $1 AND team_id = $2 FOR UPDATE',
        [targetMemberId, team.id],
      )
      const { member: operator } = await this.requireAuthContext(client, auth, 'update', 'update')
      if (operator.role !== 'owner') throw new Error('only the owner can manage Team members')
      if (operator.id === targetMemberId) throw new Error('Team owner cannot remove themselves')
      const target = targetResult.rows[0]
      if (target === undefined) throw new Error('member not found in this Team')
      if (target.status !== 'active') throw new Error('member is not active in this Team')
      if (target.role === 'owner') throw new Error('Team owner cannot be removed')
      return this.departMember(client, target, pendingTransfer, operator.id, 'member_removed')
    })
  }

  async leaveTeam(auth: TeamAuthContext): Promise<TeamMemberDepartureResult> {
    await this.initialize()
    return this.transaction(async (client) => {
      const team = await this.lockTeam(client, auth.teamId)
      if (team.status === 'dissolved') throw new TeamDissolvedError()
      const pendingTransfer = await this.lockPendingOwnershipTransfer(client, team.id)
      const { member } = await this.requireAuthContext(client, auth, 'update', 'update')
      if (member.role === 'owner') throw new Error('Team owner cannot leave before transferring ownership')
      return this.departMember(client, member, pendingTransfer, member.id, 'member_left')
    })
  }

  async listMembershipAuditEvents(
    auth: TeamAuthContext,
    limit: number,
  ): Promise<readonly TeamMembershipAuditEventSummary[]> {
    await this.initialize()
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('membership audit limit must be an integer from 1 to 1000')
    }
    return this.transaction(async (client) => {
      const { member } = await this.requireAuthContext(client, auth)
      if (member.role !== 'owner') throw new Error('only the owner can read Team membership audit events')
      const result = await client.query<MembershipAuditRow>(`
        SELECT * FROM team_membership_audit_events WHERE team_id = $1
        ORDER BY created_at DESC, id DESC LIMIT $2
      `, [member.team_id, limit])
      return result.rows.map(summaryMembershipAudit)
    })
  }

  async listInviteRevealAuditEvents(
    auth: TeamAuthContext,
    limit: number,
  ): Promise<readonly TeamInviteRevealAuditEventSummary[]> {
    await this.initialize()
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('invite reveal audit limit must be an integer from 1 to 1000')
    }
    return this.transaction(async (client) => {
      const { member } = await this.requireAuthContext(client, auth)
      if (member.role !== 'owner') throw new Error('only the owner can read Team invitation reveal audit events')
      const result = await client.query<InviteRevealAuditRow>(`
        SELECT id, team_id, actor_member_id, invite_id, created_at
        FROM team_invite_reveal_audit_events
        WHERE team_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2
      `, [member.team_id, limit])
      return result.rows.map(summaryInviteRevealAudit)
    })
  }

  async createContributionAccount(auth: TeamAuthContext, label: string): Promise<TeamContributionAccountSummary> {
    await this.initialize()
    return this.transaction(async (client) => {
      const team = await this.lockTeam(client, auth.teamId)
      if (team.status === 'dissolved') throw new TeamDissolvedError()
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
      const { member } = await this.requireAuthContext(client, auth)
      const result = await client.query<ContributionRow>(
        'SELECT * FROM team_contributions WHERE team_id = $1 AND owner_member_id = $2 ORDER BY created_at, id',
        [member.team_id, member.id],
      )
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
      const team = await this.lockTeam(client, auth.teamId)
      if (team.status === 'dissolved') throw new TeamDissolvedError()
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
      const team = await this.lockTeam(client, auth.teamId)
      if (team.status === 'dissolved') throw new TeamDissolvedError()
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
        dailyCredits: patch.dailySharedCreditLimit === undefined
          ? nullableNumber(account.daily_shared_credit_limit)
          : patch.dailySharedCreditLimit,
        weeklyCost: patch.weeklySharedEstimatedApiCostLimitMicros === undefined
          ? nullableNumber(account.weekly_shared_estimated_api_cost_limit_micros)
          : patch.weeklySharedEstimatedApiCostLimitMicros,
        concurrency: patch.maxSharedConcurrency ?? account.max_shared_concurrency,
        models: patch.allowedModels === undefined ? parseModels(account.allowed_models) : normalizeModels(patch.allowedModels),
      }
      validateContributionLimits(next.reserve, next.maxRequests, next.dailyCredits, next.concurrency)
      if (next.weeklyCost !== null && (!Number.isSafeInteger(next.weeklyCost) || next.weeklyCost < 10_000 || next.weeklyCost > 10_000_000_000)) {
        throw new Error('weeklySharedEstimatedApiCostLimitMicros must be null or an integer from 10000 to 10000000000')
      }
      const result = await client.query<ContributionRow>(`
        UPDATE team_contributions
        SET label = $1, status = $2, personal_reserve_percent = $3,
            max_shared_requests_per_window = $4, daily_shared_credit_limit = $5,
            weekly_shared_estimated_api_cost_limit_micros = $6,
            max_shared_concurrency = $7, allowed_models = $8::jsonb, updated_at = $9
        WHERE id = $10 AND team_id = $11
        RETURNING *
      `, [
        next.label,
        next.status,
        next.reserve,
        next.maxRequests,
        next.dailyCredits,
        next.weeklyCost,
        next.concurrency,
        JSON.stringify(next.models),
        this.now(),
        account.id,
        account.team_id,
      ])
      return summaryContribution(requiredRow(result.rows[0], 'contribution account'))
    })
  }

  async revokeContributionAccount(auth: TeamAuthContext, accountId: string): Promise<TeamContributionAccountSummary> {
    await this.initialize()
    return this.transaction(async (client) => {
      const team = await this.lockTeam(client, auth.teamId)
      if (team.status === 'dissolved') throw new TeamDissolvedError()
      const { member } = await this.requireAuthContext(client, auth)
      const account = await this.requireContribution(client, accountId, member.team_id, true)
      if (account.owner_member_id !== member.id) throw new Error('only the owner of the contribution account can revoke it')
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
    providerAuthenticatedLabel?: string,
  ): Promise<TeamContributionAccountSummary> {
    await this.initialize()
    return this.transaction(async (client) => {
      const team = await this.lockTeam(client, teamId)
      const account = await this.requireContribution(client, accountId, teamId, true)
      if (team.status === 'dissolved') return summaryContribution(account)
      if (account.status === 'revoked' && status !== 'revoked') return summaryContribution(account)
      if (expectedStatus !== undefined && account.status !== expectedStatus) return summaryContribution(account)
      if (providerAuthenticatedLabel !== undefined && status !== 'active') {
        throw new Error('providerAuthenticatedLabel requires active status')
      }
      const result = await client.query<ContributionRow>(`
        UPDATE team_contributions SET status = $1, last_error = $2, label = $3, updated_at = $4
        WHERE id = $5 AND team_id = $6 RETURNING *
      `, [
        status,
        lastError === undefined ? null : nonEmpty(safeTeamErrorMessage(lastError), 'lastError', 240),
        providerAuthenticatedLabel === undefined
          ? account.label
          : nonEmpty(providerAuthenticatedLabel, 'providerAuthenticatedLabel', MAX_KEY_LABEL_LENGTH),
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
    reservedCredits = 0,
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
      if (!Number.isSafeInteger(reservedCredits) || reservedCredits < 0 || reservedCredits > MAX_DAILY_SHARED_CREDIT_LIMIT) {
        throw new Error(`reservedCredits must be an integer from 0 to ${MAX_DAILY_SHARED_CREDIT_LIMIT}`)
      }
      const shared = account.owner_member_id !== member.id
      const effectiveReservation = shared ? reservedCredits : 0
      const weeklyLimit = nullableNumber(account.weekly_shared_estimated_api_cost_limit_micros)
      const estimatedCostReservation = shared && weeklyLimit !== null ? Math.min(weeklyLimit, 250_000) : 0
      const dailyLimit = nullableNumber(account.daily_shared_credit_limit)
      if (shared && dailyLimit !== null) {
        const now = this.now()
        const dayStart = utcDayStart(now)
        const used = await client.query<{ credits_used: string | number }>(`
          SELECT COALESCE(SUM(
            CASE WHEN status = 'in_progress' THEN reserved_credits ELSE COALESCE(credits, 0) END
          ), 0) AS credits_used
          FROM team_usage_events
          WHERE team_id = $1 AND upstream_account_id = $2
            AND consumer_member_id <> upstream_owner_member_id
            AND started_at >= $3 AND started_at < $4
        `, [member.team_id, account.id, dayStart, dayStart + 86_400_000])
        const usedCredits = numberValue(used.rows[0]?.credits_used ?? 0)
        if (usedCredits + effectiveReservation > dailyLimit) {
          throw new TeamDailyCreditsLimitError()
        }
      }
      if (shared && weeklyLimit !== null) {
        const now = this.now()
        const weekStart = utcIsoWeekStart(now)
        const used = await client.query<{ cost_used: string | number }>(`
          SELECT COALESCE(SUM(
            CASE WHEN status = 'in_progress' THEN reserved_estimated_cost_usd_micros ELSE COALESCE(estimated_cost_usd_micros, 0) END
          ), 0) AS cost_used
          FROM team_usage_events
          WHERE team_id = $1 AND upstream_account_id = $2
            AND consumer_member_id <> upstream_owner_member_id
            AND started_at >= $3 AND started_at < $4
        `, [member.team_id, account.id, weekStart, weekStart + 7 * 86_400_000])
        if (numberValue(used.rows[0]?.cost_used ?? 0) + estimatedCostReservation > weeklyLimit) {
          throw new TeamWeeklyEstimatedCostLimitError()
        }
      }
      const result = await client.query<UsageRow>(`
        INSERT INTO team_usage_events
          (id, team_id, consumer_member_id, upstream_owner_member_id,
           upstream_account_id, model, unit, status, reserved_credits,
           reserved_estimated_cost_usd_micros, started_at, finished_at)
        VALUES ($1, $2, $3, $4, $5, $6, 'request', 'in_progress', $7, $8, $9, NULL)
        RETURNING *
      `, [
        nonEmpty(eventId, 'eventId', 128), member.team_id, member.id, account.owner_member_id,
        account.id, nonEmpty(model, 'model', MAX_MODEL_NAME_LENGTH), effectiveReservation,
        estimatedCostReservation, this.now(),
      ])
      return summaryUsage(requiredRow(result.rows[0], 'usage event'))
    })
  }

  async settleUsageEvent(
    teamId: string,
    eventId: string,
    status: Exclude<TeamUsageEventStatus, 'in_progress'>,
    usage?: TeamProviderTokenUsage,
    costEstimate?: TeamUsageCostEstimate,
  ): Promise<TeamUsageEventSummary> {
    await this.initialize()
    const calculation = usage === undefined ? undefined : calculateTeamCredits(usage)
    if (costEstimate !== undefined && calculation === undefined) {
      throw new Error('a Team cost estimate requires measured provider Token usage')
    }
    let estimatedCostUsdMicros: string | null = null
    let pricingCatalogVersion: string | null = null
    if (costEstimate !== undefined) {
      if (
        typeof costEstimate.estimatedCostUsdMicros !== 'bigint'
        || costEstimate.estimatedCostUsdMicros < 0n
        || costEstimate.estimatedCostUsdMicros > 9_223_372_036_854_775_807n
      ) {
        throw new Error('estimatedCostUsdMicros must be a non-negative signed bigint')
      }
      estimatedCostUsdMicros = costEstimate.estimatedCostUsdMicros.toString()
      pricingCatalogVersion = nonEmpty(costEstimate.pricingCatalogVersion, 'pricingCatalogVersion', 128)
    }
    return this.transaction(async (client) => {
      const current = await client.query<UsageRow>('SELECT * FROM team_usage_events WHERE id = $1 AND team_id = $2 FOR UPDATE', [eventId, teamId])
      const event = current.rows[0]
      if (event === undefined) throw new Error('usage event not found')
      if (event.status !== 'in_progress') {
        if (event.status === status) return summaryUsage(event)
        throw new Error('usage event is already settled')
      }
      if (status !== 'cancelled' && estimatedCostUsdMicros === null && numberValue(event.reserved_estimated_cost_usd_micros) > 0) {
        estimatedCostUsdMicros = String(numberValue(event.reserved_estimated_cost_usd_micros))
        pricingCatalogVersion = 'admission-reservation-v1'
      }
      const result = await client.query<UsageRow>(`
        UPDATE team_usage_events
        SET status = $1, reserved_credits = 0, reserved_estimated_cost_usd_micros = 0,
            credits = $2, credits_formula_version = $3,
            total_tokens = $4, estimated_cost_usd_micros = $5,
            pricing_catalog_version = $6, finished_at = $7
        WHERE id = $8 AND team_id = $9 RETURNING *
      `, [
        status,
        calculation?.credits ?? null,
        calculation?.formulaVersion ?? null,
        usage === undefined ? null : usage.inputTokens + usage.outputTokens,
        estimatedCostUsdMicros,
        pricingCatalogVersion,
        this.now(),
        eventId,
        teamId,
      ])
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

  async listUsageAggregates(auth: TeamAuthContext): Promise<TeamUsageAggregates> {
    await this.initialize()
    return this.transaction(async (client) => {
      const { team } = await this.requireAuthContext(client, auth)
      const generatedAt = this.now()
      const last24HoursStartedAt = generatedAt - 86_400_000
      const last7DaysStartedAt = utcDayStart(generatedAt) - 6 * 86_400_000
      const [accountResult, dailyResult] = await Promise.all([
        client.query<AccountUsageAggregateRow>(`
          SELECT upstream_account_id,
            COUNT(*) AS request_count,
            COUNT(credits) AS measured_request_count,
            COALESCE(SUM(credits), 0) AS credits
          FROM team_usage_events
          WHERE team_id = $1
            AND consumer_member_id <> upstream_owner_member_id
            AND started_at >= $2
          GROUP BY upstream_account_id
          ORDER BY upstream_account_id
        `, [team.id, last24HoursStartedAt]),
        client.query<MemberDailyUsageAggregateRow>(`
          SELECT upstream_account_id, consumer_member_id,
            (started_at / 86400000) * 86400000 AS day_started_at,
            COUNT(*) AS request_count,
            COUNT(credits) AS measured_request_count,
            COALESCE(SUM(credits), 0) AS credits
          FROM team_usage_events
          WHERE team_id = $1
            AND consumer_member_id <> upstream_owner_member_id
            AND started_at >= $2
          GROUP BY upstream_account_id, consumer_member_id, (started_at / 86400000)
          ORDER BY day_started_at, consumer_member_id, upstream_account_id
        `, [team.id, last7DaysStartedAt]),
      ])
      const accountTotals24Hours: TeamAccountUsage24HourSummary[] = accountResult.rows.map(row => ({
        upstreamAccountId: row.upstream_account_id,
        requestCount: numberValue(row.request_count),
        measuredRequestCount: numberValue(row.measured_request_count),
        credits: numberValue(row.credits),
      }))
      const memberDaily7Days: TeamMemberDailyUsageSummary[] = dailyResult.rows.map(row => ({
        upstreamAccountId: row.upstream_account_id,
        consumerMemberId: row.consumer_member_id,
        dayStartedAt: numberValue(row.day_started_at),
        requestCount: numberValue(row.request_count),
        measuredRequestCount: numberValue(row.measured_request_count),
        credits: numberValue(row.credits),
      }))
      return {
        generatedAt,
        last24HoursStartedAt,
        last7DaysStartedAt,
        accountTotals24Hours,
        memberDaily7Days,
      }
    })
  }

  async readUsageProjection(auth: TeamAuthContext): Promise<TeamUsageProjection> {
    await this.initialize()
    return this.transaction(async (client) => {
      const { team, member } = await this.requireAuthContext(client, auth)
      const endedAt = this.now()
      const startedAt = endedAt - 86_400_000
      const readAggregate = async (consumerMemberId?: string): Promise<TeamUsageAggregateSummary> => {
        const result = await client.query<UsageProjectionAggregateRow>(`
          SELECT
            COUNT(*) AS request_count,
            COUNT(total_tokens) AS token_measured_request_count,
            COUNT(estimated_cost_usd_micros) AS priced_request_count,
            SUM(total_tokens) AS total_tokens,
            SUM(estimated_cost_usd_micros) AS estimated_cost_usd_micros
          FROM team_usage_events
          WHERE team_id = $1
            AND consumer_member_id <> upstream_owner_member_id
            AND started_at >= $2 AND started_at <= $3
            ${consumerMemberId === undefined ? '' : 'AND consumer_member_id = $4'}
        `, consumerMemberId === undefined
          ? [team.id, startedAt, endedAt]
          : [team.id, startedAt, endedAt, consumerMemberId])
        return summaryUsageAggregate(requiredRow(result.rows[0], 'usage aggregate'))
      }

      const mine = await readAggregate(member.id)
      const ownedWindowStartedAt = endedAt - 7 * 86_400_000
      const last24HoursStartedAt = endedAt - 86_400_000
      const currentUtcWeekStartedAt = utcIsoWeekStart(endedAt)
      const currentUtcWeekResetAt = currentUtcWeekStartedAt + 7 * 86_400_000
      const ownedRows = await client.query<UsageRow>(`
        SELECT usage.*
        FROM team_usage_events AS usage
        INNER JOIN team_contributions AS contribution
          ON contribution.id = usage.upstream_account_id
        WHERE usage.team_id = $1
          AND contribution.owner_member_id = $2
          AND contribution.status <> 'revoked'
          AND usage.consumer_member_id <> usage.upstream_owner_member_id
          AND usage.started_at >= $3 AND usage.started_at <= $4
        ORDER BY usage.started_at DESC
      `, [team.id, member.id, ownedWindowStartedAt, endedAt])
      const ownedAccountIds = [...new Set(ownedRows.rows.map(row => row.upstream_account_id))]
      const ownedAccounts = ownedAccountIds.map(accountId => {
        const rows = ownedRows.rows.filter(row => row.upstream_account_id === accountId)
        return {
          accountId,
          window: { startedAt: ownedWindowStartedAt, endedAt },
          aggregate: aggregateUsageRows(rows),
          currentUtcWeek: {
            window: { startedAt: currentUtcWeekStartedAt, endedAt },
            resetAt: currentUtcWeekResetAt,
            aggregate: aggregateUsageRows(rows.filter(row => numberValue(row.started_at) >= currentUtcWeekStartedAt)),
          },
          last24Hours: {
            window: { startedAt: last24HoursStartedAt, endedAt },
            aggregate: aggregateUsageRows(rows.filter(row => numberValue(row.started_at) >= last24HoursStartedAt)),
          },
          recentRequests: rows.slice(0, 10).map(row => {
            const event = summaryUsage(row)
            return {
              id: event.id,
              model: event.model,
              status: event.status,
              startedAt: event.startedAt,
              ...(event.finishedAt === undefined ? {} : { finishedAt: event.finishedAt }),
              ...(event.totalTokens === undefined ? {} : { totalTokens: event.totalTokens }),
              ...(event.estimatedCostUsdMicros === undefined ? {} : { estimatedCostUsdMicros: event.estimatedCostUsdMicros }),
            }
          }),
        }
      })
      if (member.role !== 'owner') {
        return { role: 'member', window: { startedAt, endedAt }, currency: 'USD', mine, ownedAccounts }
      }
      return {
        role: 'owner',
        window: { startedAt, endedAt },
        currency: 'USD',
        team: await readAggregate(),
        mine,
        ownedAccounts,
      }
    })
  }

  async setTeamStatus(auth: TeamAuthContext, input: TeamLifecycleTransitionInput): Promise<TeamSummary> {
    await this.initialize()
    const operationId = lifecycleOperationId(input.operationId)
    const expectedLifecycleRevision = lifecycleRevision(input.expectedLifecycleRevision)
    if (input.status !== 'active' && input.status !== 'paused') {
      throw new Error('Team status transition must target active or paused')
    }
    const bindingHash = lifecycleBindingHash([
      'status', auth.teamId, auth.memberId, expectedLifecycleRevision, input.status,
    ])
    return this.transaction(async (client) => {
      const team = await this.lockTeam(client, auth.teamId)
      const previous = await this.readLifecycleOperation(client, operationId, true)
      if (previous !== undefined) return replayStatusOperation(previous, bindingHash)
      if (team.status === 'dissolved') throw new TeamDissolvedError()
      await this.requireOwner(client, auth)
      if (numberValue(team.lifecycle_revision) !== expectedLifecycleRevision) {
        throw new TeamLifecycleConflictError()
      }

      const previousStatus = team.status
      const previousRevision = numberValue(team.lifecycle_revision)
      const changed = previousStatus !== input.status
      const nextRevision = changed ? previousRevision + 1 : previousRevision
      const nextTeam: TeamRow = {
        ...team,
        status: input.status,
        lifecycle_revision: nextRevision,
      }
      const summary = summaryTeam(nextTeam)
      const collided = await this.reserveLifecycleOperation(client, {
        operationId,
        teamId: team.id,
        actorMemberId: auth.memberId,
        kind: 'status',
        bindingHash,
        result: summary,
        createdAt: this.now(),
      })
      if (collided !== undefined) return replayStatusOperation(collided, bindingHash)

      if (changed) {
        await client.query(`
          UPDATE teams
          SET status = $1, lifecycle_revision = $2
          WHERE id = $3
        `, [input.status, nextRevision, team.id])
        await this.insertLifecycleAudit(client, {
          teamId: team.id,
          actorMemberId: auth.memberId,
          operationId,
          kind: 'status',
          previousStatus,
          nextStatus: input.status,
          previousLifecycleRevision: previousRevision,
          nextLifecycleRevision: nextRevision,
          createdAt: this.now(),
        })
      }
      return summary
    })
  }

  async dissolveTeam(auth: TeamAuthContext, input: TeamDissolutionInput): Promise<TeamDissolutionResult> {
    await this.initialize()
    const operationId = lifecycleOperationId(input.operationId)
    const expectedLifecycleRevision = lifecycleRevision(input.expectedLifecycleRevision)
    const storedRecoverySecretHash = recoverySecretHash(input.recoverySecretHash)
    const bindingHash = lifecycleBindingHash([
      'dissolution', auth.teamId, auth.memberId, expectedLifecycleRevision,
      input.confirmationName, storedRecoverySecretHash,
    ])
    return this.transaction(async (client) => {
      const team = await this.lockTeam(client, auth.teamId)
      const pendingTransfer = await this.lockPendingOwnershipTransfer(client, team.id)
      const previous = await this.readLifecycleOperation(client, operationId, true)
      if (previous !== undefined) return replayDissolutionOperation(previous, bindingHash)
      if (team.status === 'dissolved') throw new TeamDissolvedError()
      await this.requireOwner(client, auth, 'update', 'update')
      const previousRevision = numberValue(team.lifecycle_revision)
      if (previousRevision !== expectedLifecycleRevision) throw new TeamLifecycleConflictError()
      if (input.confirmationName !== team.name) throw new Error('Team name confirmation does not match')

      const dissolvedAt = this.now()
      const collided = await this.reserveLifecycleOperation(client, {
        operationId,
        teamId: team.id,
        actorMemberId: auth.memberId,
        kind: 'dissolution',
        bindingHash,
        result: { pending: true },
        recoverySecretHash: storedRecoverySecretHash,
        createdAt: dissolvedAt,
      })
      if (collided !== undefined) return replayDissolutionOperation(collided, bindingHash)

      const nextRevision = previousRevision + 1
      await this.cancelLockedOwnershipTransfer(client, pendingTransfer, dissolvedAt, auth.memberId)
      await client.query(`
        UPDATE teams
        SET status = 'dissolved', lifecycle_revision = $1, dissolved_at = $2
        WHERE id = $3
      `, [nextRevision, dissolvedAt, team.id])
      const members = await client.query(`
        UPDATE team_members
        SET status = 'removed'
        WHERE team_id = $1 AND status = 'active'
      `, [team.id])
      const invites = await client.query(`
        UPDATE team_invites
        SET status = 'revoked', token_hash = 'team-dissolved:' || id,
            envelope_version = NULL, envelope_key_ref = NULL, envelope_wrapped_dek = NULL,
            envelope_wrapped_dek_nonce = NULL, envelope_wrapped_dek_tag = NULL,
            envelope_nonce = NULL, envelope_ciphertext = NULL, envelope_tag = NULL
        WHERE team_id = $1 AND status = 'pending'
      `, [team.id])
      const keys = await client.query(`
        UPDATE team_api_keys
        SET revoked_at = $1, revoked_reason = 'team_dissolved'
        WHERE team_id = $2 AND revoked_at IS NULL
      `, [dissolvedAt, team.id])
      const contributions = await client.query(`
        UPDATE team_contributions
        SET status = 'revoked', updated_at = $1, last_error = NULL
        WHERE team_id = $2 AND status <> 'revoked'
      `, [dissolvedAt, team.id])
      const result: TeamDissolutionResult = {
        operationId,
        teamId: team.id,
        teamName: team.name,
        status: 'dissolved',
        lifecycleRevision: nextRevision,
        dissolvedAt,
        terminatedMemberCount: members.rowCount ?? 0,
        revokedInviteCount: invites.rowCount ?? 0,
        revokedKeyCount: keys.rowCount ?? 0,
        revokedContributionCount: contributions.rowCount ?? 0,
      }
      await client.query(
        'UPDATE team_lifecycle_operations SET result = $1::jsonb WHERE operation_id = $2',
        [JSON.stringify(result), operationId],
      )
      await this.insertLifecycleAudit(client, {
        teamId: team.id,
        actorMemberId: auth.memberId,
        operationId,
        kind: 'dissolution',
        previousStatus: team.status,
        nextStatus: 'dissolved',
        previousLifecycleRevision: previousRevision,
        nextLifecycleRevision: nextRevision,
        createdAt: dissolvedAt,
      })
      return result
    })
  }

  async recoverTeamDissolution(operationId: string, recoverySecret: string): Promise<TeamDissolutionRecoveryResult> {
    await this.initialize()
    const normalizedOperationId = lifecycleOperationId(operationId)
    const operation = await this.readLifecycleOperationFromPool(normalizedOperationId)
    recoverDissolutionOperation(operation, recoverySecret)
    return { operationType: 'team_dissolution', status: 'dissolved' }
  }

  async consumeDissolutionRecoveryAttempt(
    sourceDigest: string,
    action: TeamDissolutionRecoveryAction,
  ): Promise<void> {
    await this.initialize()
    const normalizedSourceDigest = dissolutionRecoverySourceDigest(sourceDigest)
    const normalizedAction = dissolutionRecoveryAction(action)
    const retryAfterSeconds = await this.transaction(async (client) => {
      // Anonymous recovery is shared across Host replicas. Use the database's
      // clock so replica skew cannot move the fixed window backwards and reset
      // the counter on every alternating request.
      const timing = await client.query<{ observed_at: string | number }>(`
        SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS observed_at
      `)
      const timingRow = timing.rows[0]
      if (timingRow === undefined) throw new Error('PostgreSQL clock could not be read')
      const databaseNow = numberValue(timingRow.observed_at)
      const windowStartedAt = Math.floor(databaseNow / TEAM_DISSOLUTION_RECOVERY_RATE_LIMIT_WINDOW_MS)
        * TEAM_DISSOLUTION_RECOVERY_RATE_LIMIT_WINDOW_MS
      await client.query(`
        DELETE FROM team_dissolution_recovery_rate_limits
        WHERE window_started_at < $1
      `, [windowStartedAt - TEAM_DISSOLUTION_RECOVERY_RATE_LIMIT_WINDOW_MS])
      const result = await client.query<DissolutionRecoveryRateLimitRow>(`
        INSERT INTO team_dissolution_recovery_rate_limits
          (source_digest, action, window_started_at, attempt_count)
        VALUES ($1, $2, $3, 1)
        ON CONFLICT (source_digest, action)
        DO UPDATE SET
          attempt_count = CASE
            WHEN EXCLUDED.window_started_at > team_dissolution_recovery_rate_limits.window_started_at THEN 1
            WHEN team_dissolution_recovery_rate_limits.attempt_count < $4
              THEN team_dissolution_recovery_rate_limits.attempt_count + 1
            ELSE team_dissolution_recovery_rate_limits.attempt_count
          END,
          window_started_at = GREATEST(
            team_dissolution_recovery_rate_limits.window_started_at,
            EXCLUDED.window_started_at
          )
        RETURNING window_started_at, attempt_count
      `, [
        normalizedSourceDigest,
        normalizedAction,
        windowStartedAt,
        TEAM_DISSOLUTION_RECOVERY_RATE_LIMIT_MAX_ATTEMPTS + 1,
      ])
      const row = result.rows[0]
      if (row === undefined) throw new Error('Team dissolution recovery rate limit could not be recorded')
      return numberValue(row.attempt_count) > TEAM_DISSOLUTION_RECOVERY_RATE_LIMIT_MAX_ATTEMPTS
        ? rateLimitRetryAfterSeconds(
            numberValue(row.window_started_at),
            databaseNow,
            TEAM_DISSOLUTION_RECOVERY_RATE_LIMIT_WINDOW_MS,
          )
        : undefined
    })
    if (retryAfterSeconds !== undefined) {
      throw new TeamDissolutionRecoveryRateLimitError(retryAfterSeconds)
    }
  }

  async ackTeamDissolution(operationId: string, recoverySecret: string): Promise<void> {
    await this.initialize()
    const normalizedOperationId = lifecycleOperationId(operationId)
    await this.transaction(async (client) => {
      const operation = await this.readLifecycleOperation(client, normalizedOperationId, true)
      recoverDissolutionOperation(operation, recoverySecret)
      await client.query(`
        UPDATE team_lifecycle_operations
        SET acknowledged_at = COALESCE(acknowledged_at, $1)
        WHERE operation_id = $2
      `, [this.now(), normalizedOperationId])
    })
  }

  async diagnoseApiKey(token: string): Promise<TeamConnectionTerminal | undefined> {
    await this.initialize()
    if (token.length < 16) return undefined
    const tokenHash = hashToken(token)
    const result = await this.pool.query<Pick<KeyRow, 'token_hash' | 'revoked_reason'>>(`
      SELECT token_hash, revoked_reason
      FROM team_api_keys
      WHERE token_hash = $1
    `, [tokenHash])
    const key = result.rows[0]
    if (key === undefined || key.revoked_reason === null || !sameHash(key.token_hash, tokenHash)) {
      return undefined
    }
    return { code: key.revoked_reason }
  }

  async sweepExpiredInviteEnvelopes(): Promise<number> {
    await this.initialize()
    const candidates = await this.pool.query<Pick<InviteRow, 'team_id'>>(`
      SELECT DISTINCT team_id
      FROM team_invites
      WHERE expires_at <= $1
        AND (
          envelope_version IS NOT NULL OR envelope_key_ref IS NOT NULL OR
          envelope_wrapped_dek IS NOT NULL OR envelope_wrapped_dek_nonce IS NOT NULL OR
          envelope_wrapped_dek_tag IS NOT NULL OR envelope_nonce IS NOT NULL OR
          envelope_ciphertext IS NOT NULL OR envelope_tag IS NOT NULL
        )
      ORDER BY team_id
    `, [this.now()])
    const orderedTeamIds = [...new Set(candidates.rows.map(candidate => candidate.team_id))]
      .sort((left, right) => left.localeCompare(right))
    let cleared = 0
    for (const teamId of orderedTeamIds) {
      cleared += await this.transaction(async (client) => {
        const team = await client.query<Pick<TeamRow, 'id'>>(
          'SELECT id FROM teams WHERE id = $1 FOR UPDATE',
          [teamId],
        )
        if (team.rows[0] === undefined) return 0
        const locked = await client.query<Pick<InviteRow, 'id'>>(`
          SELECT id
          FROM team_invites
          WHERE team_id = $1 AND expires_at <= $2
            AND (
              envelope_version IS NOT NULL OR envelope_key_ref IS NOT NULL OR
              envelope_wrapped_dek IS NOT NULL OR envelope_wrapped_dek_nonce IS NOT NULL OR
              envelope_wrapped_dek_tag IS NOT NULL OR envelope_nonce IS NOT NULL OR
              envelope_ciphertext IS NOT NULL OR envelope_tag IS NOT NULL
            )
          ORDER BY id
          FOR UPDATE
        `, [teamId, this.now()])
        const inviteIds = locked.rows.map(invite => invite.id)
        if (inviteIds.length === 0) return 0
        const inviteIdPlaceholders = inviteIds.map((_, index) => `$${index + 2}`).join(', ')
        const result = await client.query(`
          UPDATE team_invites
          SET envelope_version = NULL, envelope_key_ref = NULL, envelope_wrapped_dek = NULL,
              envelope_wrapped_dek_nonce = NULL, envelope_wrapped_dek_tag = NULL,
              envelope_nonce = NULL, envelope_ciphertext = NULL, envelope_tag = NULL
          WHERE team_id = $1 AND id IN (${inviteIdPlaceholders})
        `, [teamId, ...inviteIds])
        return result.rowCount ?? 0
      })
    }
    return cleared
  }

  async dispose(): Promise<void> {
    if (this.ownsPool) await this.pool.end()
  }

  private async runDisplayNameMigration(client: PoolClient): Promise<void> {
    await client.query(POSTGRES_TEAM_MIGRATION_20_LOCK_SQL)
    await client.query(POSTGRES_TEAM_MIGRATION_20_PREPARE_SQL)
    const result = await client.query<TeamMemberDisplayNameMigrationRow>(`
      SELECT id, team_id, display_name, role, status, joined_at
      FROM team_members
      ORDER BY team_id, joined_at, id
    `)
    const plans = planTeamMemberDisplayNameMigration(result.rows)
    const createdAt = this.now()
    for (const plan of plans) {
      const updated = await client.query(`
        UPDATE team_members
        SET display_name = $1, display_name_key = $2
        WHERE id = $3 AND team_id = $4
      `, [plan.displayName, plan.displayNameKey, plan.id, plan.teamId])
      if (updated.rowCount !== 1) {
        throw new Error(`Team display-name migration lost member ${JSON.stringify(plan.id)}`)
      }
      if (plan.repairReason === undefined) continue
      await client.query(`
        INSERT INTO team_member_display_name_migration_audit_events
          (id, team_id, member_id, migration_version, previous_display_name,
           next_display_name, repair_reason, created_at, acknowledged_at)
        VALUES ($1, $2, $3, 20, $4, $5, $6, $7, NULL)
      `, [
        `migration-20:display-name:${plan.id}`,
        plan.teamId,
        plan.id,
        plan.previousDisplayName,
        plan.displayName,
        plan.repairReason,
        createdAt,
      ])
    }
    await client.query(POSTGRES_TEAM_MIGRATION_20_FINALIZE_SQL)
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
        if (migration.version === 12) {
          await client.query(POSTGRES_TEAM_MIGRATION_12_LOCK_SQL)
          const affected = await client.query<{ team_id: string }>(POSTGRES_TEAM_MIGRATION_12_AFFECTED_TEAMS_SQL)
          const affectedTeamIds = affected.rows.map(row => row.team_id)
          const eligible = affectedTeamIds.length === 0
            ? { rows: [] as PostgresTeamMigration12OwnerCandidate[] }
            : await client.query<PostgresTeamMigration12OwnerCandidate>(POSTGRES_TEAM_MIGRATION_12_ELIGIBLE_OWNERS_SQL)
          const ownerCandidatesByTeam = new Map<string, PostgresTeamMigration12OwnerCandidate[]>()
          for (const owner of eligible.rows) {
            const owners = ownerCandidatesByTeam.get(owner.team_id) ?? []
            owners.push(owner)
            ownerCandidatesByTeam.set(owner.team_id, owners)
          }
          const conflictTeamId = affectedTeamIds.find(teamId => {
            const owners = ownerCandidatesByTeam.get(teamId) ?? []
            return owners.length !== 1 || owners[0]?.has_active_key !== true
          })
          if (conflictTeamId !== undefined) {
            throw teamMigration12PreflightError(
              conflictTeamId,
              ownerCandidatesByTeam.get(conflictTeamId) ?? [],
            )
          }
          const eligibleOwnerIds = affectedTeamIds.map(teamId => {
            const ownerId = ownerCandidatesByTeam.get(teamId)?.[0]?.owner_member_id
            if (ownerId === undefined) {
              throw teamMigration12PreflightError(teamId, [])
            }
            return ownerId
          })
          await client.query(POSTGRES_TEAM_MIGRATION_12_AUDIT_TABLE_SQL)
          await client.query(POSTGRES_TEAM_MIGRATION_12_AUDIT_ADMINS_SQL, [this.now()])
          await client.query(POSTGRES_TEAM_MIGRATION_12_NORMALIZE_ADMINS_SQL)
          for (const ownerId of eligibleOwnerIds) {
            await client.query(POSTGRES_TEAM_MIGRATION_12_REVOKE_INVITES_SQL, [ownerId])
          }
        } else if (migration.execution === 'runtime-managed') {
          if (migration.version !== 20) {
            throw new Error(`Unsupported runtime-managed Team migration ${migration.version}`)
          }
          await this.runDisplayNameMigration(client)
        } else {
          await client.query(migration.sql)
        }
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
    suppliedToken?: string,
  ): Promise<KeyRow & { token: string }> {
    const token = suppliedToken ?? createSecret('dsh_team', this.token)
    if (!/^dsh_team_[A-Za-z0-9_-]{16,}$/u.test(token)) throw new Error('Team API key is invalid')
    const row: KeyRow & { token: string } = {
      id: this.id(),
      team_id: teamId,
      member_id: memberId,
      label,
      prefix: token.slice(0, 18),
      created_at: now,
      last_used_at: null,
      revoked_at: null,
      revoked_reason: null,
      token_hash: hashToken(token),
      token,
    }
    await client.query(`
      INSERT INTO team_api_keys
        (id, team_id, member_id, label, prefix, created_at, last_used_at, revoked_at, revoked_reason, token_hash)
      VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL, NULL, $7)
    `, [row.id, row.team_id, row.member_id, row.label, row.prefix, row.created_at, row.token_hash])
    return row
  }

  private async readLifecycleOperation(
    client: PoolClient,
    operationId: string,
    lock: boolean,
  ): Promise<LifecycleOperationRow | undefined> {
    const result = await client.query<LifecycleOperationRow>(`
      SELECT * FROM team_lifecycle_operations
      WHERE operation_id = $1${lock ? ' FOR UPDATE' : ''}
    `, [operationId])
    return result.rows[0]
  }

  private async readLifecycleOperationFromPool(operationId: string): Promise<LifecycleOperationRow | undefined> {
    const result = await this.pool.query<LifecycleOperationRow>(
      'SELECT * FROM team_lifecycle_operations WHERE operation_id = $1',
      [operationId],
    )
    return result.rows[0]
  }

  private async reserveLifecycleOperation(
    client: PoolClient,
    operation: {
      readonly operationId: string
      readonly teamId: string
      readonly actorMemberId: string
      readonly kind: LifecycleOperationRow['kind']
      readonly bindingHash: string
      readonly result: unknown
      readonly recoverySecretHash?: string
      readonly createdAt: number
    },
  ): Promise<LifecycleOperationRow | undefined> {
    const inserted = await client.query<LifecycleOperationRow>(`
      INSERT INTO team_lifecycle_operations
        (operation_id, team_id, actor_member_id, kind, binding_hash, result,
         recovery_secret_hash, acknowledged_at, created_at)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, NULL, $8)
      ON CONFLICT (operation_id) DO NOTHING
      RETURNING *
    `, [
      operation.operationId,
      operation.teamId,
      operation.actorMemberId,
      operation.kind,
      operation.bindingHash,
      JSON.stringify(operation.result),
      operation.recoverySecretHash ?? null,
      operation.createdAt,
    ])
    if (inserted.rows[0] !== undefined) return undefined
    const collided = await this.readLifecycleOperation(client, operation.operationId, true)
    if (collided === undefined) throw new TeamLifecycleConflictError()
    return collided
  }

  private async insertLifecycleAudit(
    client: PoolClient,
    event: {
      readonly teamId: string
      readonly actorMemberId: string
      readonly operationId: string
      readonly kind: LifecycleOperationRow['kind']
      readonly previousStatus: 'active' | 'paused'
      readonly nextStatus: TeamStatus
      readonly previousLifecycleRevision: number
      readonly nextLifecycleRevision: number
      readonly createdAt: number
    },
  ): Promise<void> {
    await client.query(`
      INSERT INTO team_lifecycle_audit_events
        (id, team_id, actor_member_id, operation_id, kind, previous_status, next_status,
         previous_lifecycle_revision, next_lifecycle_revision, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `, [
      this.id(),
      event.teamId,
      event.actorMemberId,
      event.operationId,
      event.kind,
      event.previousStatus,
      event.nextStatus,
      event.previousLifecycleRevision,
      event.nextLifecycleRevision,
      event.createdAt,
    ])
  }

  private async insertMembershipAudit(
    client: PoolClient,
    event: {
      readonly teamId: string
      readonly actorMemberId: string
      readonly targetMemberId: string
      readonly action: Extract<
        TeamMembershipAuditAction,
        'ownership_transferred' | 'member_removed' | 'member_left'
      >
      readonly previousRole: TeamRole
      readonly nextRole?: TeamRole
      readonly createdAt: number
    },
  ): Promise<void> {
    await client.query(`
      INSERT INTO team_membership_audit_events
        (id, team_id, actor_member_id, target_member_id, action, previous_role, next_role, result, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'succeeded', $8)
    `, [
      this.id(),
      event.teamId,
      event.actorMemberId,
      event.targetMemberId,
      event.action,
      event.previousRole,
      event.nextRole ?? null,
      event.createdAt,
    ])
  }

  private async insertOwnershipTransferAudit(
    client: PoolClient,
    transfer: OwnershipTransferRow,
    action: OwnershipTransferAuditAction,
    createdAt: number,
    actorMemberId?: string,
  ): Promise<void> {
    await client.query(`
      INSERT INTO team_ownership_transfer_audit_events
        (id, team_id, transfer_id, actor_member_id, action, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (transfer_id, action) DO NOTHING
    `, [this.id(), transfer.team_id, transfer.id, actorMemberId ?? null, action, createdAt])
  }

  private async insertInviteRevealAudit(
    client: PoolClient,
    event: {
      readonly teamId: string
      readonly actorMemberId: string
      readonly inviteId: string
      readonly createdAt: number
    },
  ): Promise<void> {
    await client.query(`
      INSERT INTO team_invite_reveal_audit_events
        (id, team_id, actor_member_id, invite_id, created_at)
      VALUES ($1, $2, $3, $4, $5)
    `, [this.id(), event.teamId, event.actorMemberId, event.inviteId, event.createdAt])
  }

  private async consumeInviteRevealRateLimit(
    client: PoolClient,
    auth: TeamAuthContext,
    inviteId: string,
    now: number,
  ): Promise<number | undefined> {
    const windowStartedAt = Math.floor(now / TEAM_INVITE_REVEAL_RATE_LIMIT_WINDOW_MS)
      * TEAM_INVITE_REVEAL_RATE_LIMIT_WINDOW_MS
    const result = await client.query<InviteRevealRateLimitRow>(`
      INSERT INTO team_invite_reveal_rate_limits
        (team_id, actor_member_id, invite_id, window_started_at, attempt_count)
      VALUES ($1, $2, $3, $4, 1)
      ON CONFLICT (team_id, actor_member_id, invite_id)
      DO UPDATE SET
        attempt_count = CASE
          WHEN team_invite_reveal_rate_limits.window_started_at <> EXCLUDED.window_started_at THEN 1
          WHEN team_invite_reveal_rate_limits.attempt_count < $5
            THEN team_invite_reveal_rate_limits.attempt_count + 1
          ELSE team_invite_reveal_rate_limits.attempt_count
        END,
        window_started_at = EXCLUDED.window_started_at
      RETURNING window_started_at, attempt_count
    `, [
      auth.teamId,
      auth.memberId,
      inviteId,
      windowStartedAt,
      TEAM_INVITE_REVEAL_RATE_LIMIT_MAX_ATTEMPTS + 1,
    ])
    const row = result.rows[0]
    if (row === undefined) throw new Error('Team invitation reveal rate limit could not be recorded')
    return numberValue(row.attempt_count) > TEAM_INVITE_REVEAL_RATE_LIMIT_MAX_ATTEMPTS
      ? revealRateLimitRetryAfterSeconds(windowStartedAt, now)
      : undefined
  }

  private async acceptInviteRecord(
    client: PoolClient,
    token: string,
    displayName: string,
    suppliedApiKey?: string,
  ): Promise<TeamJoinResult | undefined> {
    const tokenHash = hashToken(token)
    const locatorResult = await client.query<Pick<InviteRow, 'id' | 'team_id'>>(
      'SELECT id, team_id FROM team_invites WHERE token_hash = $1',
      [tokenHash],
    )
    const locator = locatorResult.rows[0]
    if (locator === undefined) {
      throw new Error('invite is invalid or expired')
    }
    const team = await this.lockTeam(client, locator.team_id)
    const result = await client.query<InviteRow>(
      'SELECT * FROM team_invites WHERE id = $1 AND team_id = $2 AND token_hash = $3 FOR UPDATE',
      [locator.id, locator.team_id, tokenHash],
    )
    const invite = result.rows[0]
    if (invite === undefined || invite.status !== 'pending') {
      throw new Error('invite is invalid or expired')
    }
    const now = this.now()
    if (numberValue(invite.expires_at) <= now) {
      await this.expireLockedInvite(client, invite)
      return undefined
    }
    if (team.status !== 'active') throw new Error('team is paused')
    const normalizedName = normalizeTeamMemberDisplayName(displayName, 'displayName')
    const duplicate = await client.query<Pick<MemberRow, 'id'>>(`
      SELECT id FROM team_members
      WHERE team_id = $1 AND status = 'active' AND display_name_key = $2
      LIMIT 1
    `, [team.id, normalizedName.displayNameKey])
    if (duplicate.rows[0] !== undefined) {
      throw new Error('Team display name is already in use by an active member')
    }
    const member: MemberRow = {
      id: this.id(),
      team_id: team.id,
      display_name: normalizedName.displayName,
      display_name_key: normalizedName.displayNameKey,
      role: 'member',
      status: 'active',
      joined_at: now,
    }
    try {
      await client.query(
        `INSERT INTO team_members
           (id, team_id, display_name, display_name_key, role, status, joined_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          member.id,
          member.team_id,
          member.display_name,
          member.display_name_key,
          member.role,
          member.status,
          member.joined_at,
        ],
      )
    } catch (error: unknown) {
      if (isActiveDisplayNameUniqueViolation(error)) {
        throw new Error('Team display name is already in use by an active member')
      }
      throw error
    }
    await client.query(`
      UPDATE team_invites
      SET status = 'accepted', accepted_at = $1, token_hash = $2,
          envelope_version = NULL, envelope_key_ref = NULL, envelope_wrapped_dek = NULL,
          envelope_wrapped_dek_nonce = NULL, envelope_wrapped_dek_tag = NULL,
          envelope_nonce = NULL, envelope_ciphertext = NULL, envelope_tag = NULL
      WHERE id = $3
    `, [
      now,
      revokedTokenHash(invite.id),
      invite.id,
    ])
    const key = await this.createKey(client, team.id, member.id, 'member', now, suppliedApiKey)
    return { team: summaryTeam(team), member: summaryMember(member), apiKey: key.token }
  }

  private async expirePendingInvites(client: PoolClient, teamId: string, now: number): Promise<void> {
    await client.query(`
      UPDATE team_invites
      SET status = 'expired', token_hash = 'expired:' || id,
          envelope_version = NULL, envelope_key_ref = NULL, envelope_wrapped_dek = NULL,
          envelope_wrapped_dek_nonce = NULL, envelope_wrapped_dek_tag = NULL,
          envelope_nonce = NULL, envelope_ciphertext = NULL, envelope_tag = NULL
      WHERE team_id = $1 AND status = 'pending' AND expires_at <= $2
    `, [teamId, now])
  }

  private async expireLockedInvite(client: PoolClient, invite: InviteRow): Promise<InviteRow> {
    const result = await client.query<InviteRow>(`
      UPDATE team_invites
      SET status = 'expired', token_hash = $1,
          envelope_version = NULL, envelope_key_ref = NULL, envelope_wrapped_dek = NULL,
          envelope_wrapped_dek_nonce = NULL, envelope_wrapped_dek_tag = NULL,
          envelope_nonce = NULL, envelope_ciphertext = NULL, envelope_tag = NULL
      WHERE id = $2 AND team_id = $3 AND status = 'pending'
      RETURNING *
    `, [expiredTokenHash(invite.id), invite.id, invite.team_id])
    return requiredRow(result.rows[0], 'expired invitation')
  }

  private async lockOwnershipTransfer(
    client: PoolClient,
    transferId: string,
    teamId: string,
  ): Promise<OwnershipTransferRow | undefined> {
    const id = nonEmpty(transferId, 'transferId', 128)
    const result = await client.query<OwnershipTransferRow>(`
      SELECT * FROM team_ownership_transfers
      WHERE id = $1 AND team_id = $2
      FOR UPDATE
    `, [id, teamId])
    return result.rows[0]
  }

  private async lockPendingOwnershipTransfer(
    client: PoolClient,
    teamId: string,
  ): Promise<OwnershipTransferRow | undefined> {
    const result = await client.query<OwnershipTransferRow>(`
      SELECT * FROM team_ownership_transfers
      WHERE team_id = $1 AND status = 'pending'
      FOR UPDATE
    `, [teamId])
    return result.rows[0]
  }

  private async expireLockedOwnershipTransfer(
    client: PoolClient,
    transfer: OwnershipTransferRow,
    now: number,
  ): Promise<OwnershipTransferRow> {
    if (transfer.status !== 'pending' || numberValue(transfer.expires_at) > now) return transfer
    const result = await client.query<OwnershipTransferRow>(`
      UPDATE team_ownership_transfers
      SET status = 'expired', resolved_at = $1
      WHERE id = $2 AND team_id = $3 AND status = 'pending'
      RETURNING *
    `, [now, transfer.id, transfer.team_id])
    const expired = requiredRow(result.rows[0], 'expired ownership transfer')
    await this.insertOwnershipTransferAudit(client, expired, 'expired', now)
    return expired
  }

  private async cancelLockedOwnershipTransfer(
    client: PoolClient,
    transfer: OwnershipTransferRow | undefined,
    now: number,
    actorMemberId: string,
    targetMemberId?: string,
  ): Promise<void> {
    if (transfer === undefined) return
    const currentTransfer = await this.expireLockedOwnershipTransfer(client, transfer, now)
    if (
      currentTransfer.status !== 'pending'
      || (targetMemberId !== undefined && currentTransfer.target_member_id !== targetMemberId)
    ) return
    const result = await client.query<OwnershipTransferRow>(`
      UPDATE team_ownership_transfers
      SET status = 'canceled', resolved_at = $1
      WHERE id = $2 AND team_id = $3 AND status = 'pending'
      RETURNING *
    `, [now, currentTransfer.id, currentTransfer.team_id])
    const canceled = requiredRow(result.rows[0], 'canceled ownership transfer')
    await this.insertOwnershipTransferAudit(client, canceled, 'canceled', now, actorMemberId)
  }

  private async departMember(
    client: PoolClient,
    member: MemberRow,
    pendingTransfer: OwnershipTransferRow | undefined,
    actorMemberId: string,
    action: Extract<TeamMembershipAuditAction, 'member_removed' | 'member_left'>,
  ): Promise<TeamMemberDepartureResult> {
    const now = this.now()
    await this.cancelLockedOwnershipTransfer(client, pendingTransfer, now, actorMemberId, member.id)
    const memberResult = await client.query<MemberRow>(`
      UPDATE team_members SET status = 'removed'
      WHERE id = $1 AND team_id = $2 RETURNING *
    `, [member.id, member.team_id])
    await client.query(`
      UPDATE team_api_keys
      SET revoked_reason = CASE WHEN revoked_at IS NULL THEN $1 ELSE revoked_reason END,
          revoked_at = COALESCE(revoked_at, $2)
      WHERE team_id = $3 AND member_id = $4
    `, [action, now, member.team_id, member.id])
    const contributionResult = await client.query<ContributionRow>(`
      UPDATE team_contributions SET status = 'revoked', updated_at = $1
      WHERE team_id = $2 AND owner_member_id = $3 RETURNING *
    `, [now, member.team_id, member.id])
    const contributions = contributionResult.rows
      .map(summaryContribution)
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    await this.insertMembershipAudit(client, {
      teamId: member.team_id,
      actorMemberId,
      targetMemberId: member.id,
      action,
      previousRole: member.role,
      createdAt: now,
    })
    return {
      member: summaryMember(requiredRow(memberResult.rows[0], 'departing member')),
      contributions,
    }
  }

  private async requireAuthContext(
    client: PoolClient,
    auth: TeamAuthContext,
    memberLock: 'share' | 'update' = 'share',
    credentialLock: 'none' | 'update' = 'none',
  ): Promise<{ team: TeamRow; member: MemberRow }> {
    const memberLockResult = await client.query<MemberRow>(`
      SELECT * FROM team_members WHERE id = $1 AND team_id = $2
      ${memberLock === 'update' ? 'FOR UPDATE' : 'FOR SHARE'}
    `, [auth.memberId, auth.teamId])
    const lockedMember = memberLockResult.rows[0]
    if (lockedMember === undefined || lockedMember.status !== 'active') {
      throw new Error('member is not active in this Team')
    }
    if (credentialLock === 'update') {
      const lockedKey = await client.query<Pick<KeyRow, 'id'>>(`
        SELECT id FROM team_api_keys
        WHERE id = $1 AND team_id = $2 AND member_id = $3 AND revoked_at IS NULL
        FOR UPDATE
      `, [auth.keyId, auth.teamId, auth.memberId])
      if (lockedKey.rows[0] === undefined) throw new Error('Team API key is revoked or invalid')
    }
    const result = await client.query<AuthContextRow>(`
      SELECT
        k.id AS key_id, k.team_id, k.member_id, k.token_hash,
        t.name, t.status AS team_status, t.lifecycle_revision, t.dissolved_at, t.created_at,
        m.display_name, m.display_name_key, m.role, m.status AS member_status, m.joined_at
      FROM team_api_keys k
      JOIN teams t ON t.id = k.team_id
      JOIN team_members m ON m.id = k.member_id AND m.team_id = k.team_id
      WHERE k.id = $1 AND k.team_id = $2 AND k.member_id = $3 AND k.revoked_at IS NULL
    `, [auth.keyId, auth.teamId, auth.memberId])
    const row = result.rows[0]
    if (row === undefined) throw new Error('Team API key is revoked or invalid')
    if (row.member_status !== 'active') throw new Error('member is not active in this Team')
    if (row.role !== auth.role) throw new Error('Team API key role is stale')
    if (row.team_status === 'dissolved') throw new TeamDissolvedError()
    const team: TeamRow = {
      id: row.team_id,
      name: row.name,
      status: row.team_status,
      lifecycle_revision: row.lifecycle_revision,
      dissolved_at: row.dissolved_at,
      created_at: row.created_at,
    }
    const member: MemberRow = {
      id: row.member_id,
      team_id: row.team_id,
      display_name: row.display_name,
      display_name_key: row.display_name_key,
      role: row.role,
      status: row.member_status,
      joined_at: row.joined_at,
    }
    return { team, member }
  }

  private async requireOwner(
    client: PoolClient,
    auth: TeamAuthContext,
    memberLock: 'share' | 'update' = 'share',
    credentialLock: 'none' | 'update' = 'none',
  ): Promise<{ team: TeamRow; member: MemberRow }> {
    const value = await this.requireAuthContext(client, auth, memberLock, credentialLock)
    if (value.member.role !== 'owner') throw new Error('only the owner can manage Team invitations and status')
    return value
  }

  private requireInviteCipher(): TeamInviteCipher {
    if (this.inviteCipher === undefined) {
      throw new Error('Team invitation encryption is not configured')
    }
    return this.inviteCipher
  }

  private async lockTeam(client: PoolClient, teamId: string): Promise<TeamRow> {
    const result = await client.query<TeamRow>('SELECT * FROM teams WHERE id = $1 FOR UPDATE', [teamId])
    const team = result.rows[0]
    if (team === undefined) throw new Error('team not found')
    return team
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

function utcDayStart(timestamp: number): number {
  const value = new Date(timestamp)
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())
}

function utcIsoWeekStart(timestamp: number): number {
  const dayStart = utcDayStart(timestamp)
  return dayStart - ((new Date(dayStart).getUTCDay() + 6) % 7) * 86_400_000
}

function nonEmpty(value: string, field: string, maxLength: number): string {
  const result = value.trim().replace(/\s+/gu, ' ')
  if (result.length === 0) throw new Error(`${field} must be a non-empty string`)
  if (result.length > maxLength) throw new Error(`${field} is too long`)
  return result
}

function isActiveDisplayNameUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const postgresError = error as { readonly code?: unknown; readonly constraint?: unknown }
  return postgresError.code === '23505'
    && postgresError.constraint === 'team_members_active_display_name_key_idx'
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

function validateContributionLimits(
  reserve: number,
  maxRequests: number | null,
  dailyCredits: number | null,
  concurrency: number,
): void {
  if (!Number.isSafeInteger(reserve) || reserve < 0 || reserve > 99) {
    throw new Error('personalReservePercent must be an integer from 0 to 99')
  }
  if (maxRequests !== null && (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 1_000_000)) {
    throw new Error('maxSharedRequestsPerWindow must be null or an integer from 1 to 1000000')
  }
  if (dailyCredits !== null && (!Number.isSafeInteger(dailyCredits) || dailyCredits < 1 || dailyCredits > MAX_DAILY_SHARED_CREDIT_LIMIT)) {
    throw new Error(`dailySharedCreditLimit must be null or an integer from 1 to ${MAX_DAILY_SHARED_CREDIT_LIMIT}`)
  }
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new Error('maxSharedConcurrency must be an integer from 1 to 16')
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function lifecycleBindingHash(parts: readonly unknown[]): string {
  return hashToken(JSON.stringify(parts))
}

function lifecycleOperationId(value: string): string {
  const operationId = nonEmpty(value, 'operationId', 128)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(operationId)) {
    throw new Error('operationId must be a UUID')
  }
  return operationId
}

function lifecycleRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('expectedLifecycleRevision must be a positive safe integer')
  }
  return value
}

function recoverySecretHash(value: string): string {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error('recoverySecretHash must be a SHA-256 hex digest')
  return value
}

function dissolutionRecoverySourceDigest(value: string): string {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error('sourceDigest must be a SHA-256 hex digest')
  return value
}

function dissolutionRecoveryAction(value: TeamDissolutionRecoveryAction): TeamDissolutionRecoveryAction {
  if (value !== 'result' && value !== 'ack') throw new Error('dissolution recovery action is invalid')
  return value
}

function revokedTokenHash(id: string): string {
  return createHash('sha256').update(`accepted:${id}`).digest('hex')
}

function expiredTokenHash(id: string): string {
  return `expired:${id}`
}

function sameHash(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex')
  const b = Buffer.from(right, 'hex')
  return a.byteLength === b.byteLength && timingSafeEqual(a, b)
}

function replayStatusOperation(operation: LifecycleOperationRow, bindingHash: string): TeamSummary {
  if (operation.kind !== 'status' || operation.binding_hash !== bindingHash) {
    throw new TeamLifecycleConflictError()
  }
  return storedTeamSummary(operation.result)
}

function replayDissolutionOperation(
  operation: LifecycleOperationRow,
  bindingHash: string,
): TeamDissolutionResult {
  if (operation.kind !== 'dissolution' || operation.binding_hash !== bindingHash) {
    throw new TeamLifecycleConflictError()
  }
  return storedDissolutionResult(operation.result)
}

function recoverDissolutionOperation(
  operation: LifecycleOperationRow | undefined,
  recoverySecret: string,
): TeamDissolutionResult {
  const expectedHash = operation?.kind === 'dissolution' && operation.recovery_secret_hash !== null
    ? operation.recovery_secret_hash
    : '0'.repeat(64)
  const matches = sameHash(expectedHash, hashToken(recoverySecret))
  if (!matches || operation?.kind !== 'dissolution') {
    throw new TeamDissolutionUnavailableError()
  }
  return storedDissolutionResult(operation.result)
}

function storedJsonRecord(value: unknown): Record<string, unknown> {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('stored Team lifecycle result is invalid')
  }
  return parsed as Record<string, unknown>
}

function storedString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string') throw new Error('stored Team lifecycle result is invalid')
  return value
}

function storedSafeInteger(record: Record<string, unknown>, key: string, minimum: number): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error('stored Team lifecycle result is invalid')
  }
  return value
}

function storedTeamSummary(value: unknown): TeamSummary {
  const record = storedJsonRecord(value)
  const status = storedString(record, 'status')
  if (status !== 'active' && status !== 'paused' && status !== 'dissolved') {
    throw new Error('stored Team lifecycle result is invalid')
  }
  const dissolvedAt = record.dissolvedAt
  if (dissolvedAt !== undefined && (typeof dissolvedAt !== 'number' || !Number.isSafeInteger(dissolvedAt))) {
    throw new Error('stored Team lifecycle result is invalid')
  }
  return {
    id: storedString(record, 'id'),
    name: storedString(record, 'name'),
    status,
    lifecycleRevision: storedSafeInteger(record, 'lifecycleRevision', 1),
    ...(dissolvedAt === undefined ? {} : { dissolvedAt }),
    createdAt: storedSafeInteger(record, 'createdAt', 0),
  }
}

function storedDissolutionResult(value: unknown): TeamDissolutionResult {
  const record = storedJsonRecord(value)
  if (storedString(record, 'status') !== 'dissolved') {
    throw new Error('stored Team lifecycle result is invalid')
  }
  return {
    operationId: storedString(record, 'operationId'),
    teamId: storedString(record, 'teamId'),
    teamName: storedString(record, 'teamName'),
    status: 'dissolved',
    lifecycleRevision: storedSafeInteger(record, 'lifecycleRevision', 1),
    dissolvedAt: storedSafeInteger(record, 'dissolvedAt', 0),
    terminatedMemberCount: storedSafeInteger(record, 'terminatedMemberCount', 0),
    revokedInviteCount: storedSafeInteger(record, 'revokedInviteCount', 0),
    revokedKeyCount: storedSafeInteger(record, 'revokedKeyCount', 0),
    revokedContributionCount: storedSafeInteger(record, 'revokedContributionCount', 0),
  }
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

function nullableNumber(value: string | number | null): number | null {
  return value === null ? null : numberValue(value)
}

function requiredRow<T>(row: T | undefined, label: string): T {
  if (row === undefined) throw new Error(`${label} was not returned by PostgreSQL`)
  return row
}

function summaryTeam(row: TeamRow): TeamSummary {
  const dissolvedAt = optionalNumber(row.dissolved_at)
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    lifecycleRevision: numberValue(row.lifecycle_revision),
    ...(dissolvedAt === undefined ? {} : { dissolvedAt }),
    createdAt: numberValue(row.created_at),
  }
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

function summaryOwnershipTransfer(row: OwnershipTransferRow): TeamOwnershipTransferSummary {
  const resolvedAt = optionalNumber(row.resolved_at)
  return {
    id: row.id,
    teamId: row.team_id,
    requestedByMemberId: row.requested_by_member_id,
    targetMemberId: row.target_member_id,
    status: row.status,
    createdAt: numberValue(row.created_at),
    expiresAt: numberValue(row.expires_at),
    ...(resolvedAt === undefined ? {} : { resolvedAt }),
  }
}

function acceptanceResult(row: OwnershipTransferRow): TeamOwnershipTransferAcceptanceResult {
  if (row.status !== 'accepted' || row.acceptance_result === null) {
    throw new Error('accepted ownership transfer result is unavailable')
  }
  const value = typeof row.acceptance_result === 'string'
    ? JSON.parse(row.acceptance_result) as unknown
    : row.acceptance_result
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('accepted ownership transfer result is invalid')
  }
  return JSON.parse(JSON.stringify(value)) as TeamOwnershipTransferAcceptanceResult
}

function ownershipTransferUnavailable(): Error {
  return new Error('ownership transfer is unavailable to this member')
}

function requirePendingOwnershipTransfer(transfer: OwnershipTransferRow): void {
  if (transfer.status !== 'pending') {
    throw new Error(`ownership transfer is ${transfer.status} and no longer pending`)
  }
}

function summaryMembershipAudit(row: MembershipAuditRow): TeamMembershipAuditEventSummary {
  return {
    id: row.id,
    teamId: row.team_id,
    actorMemberId: row.actor_member_id,
    targetMemberId: row.target_member_id,
    action: row.action,
    previousRole: row.previous_role,
    ...(row.next_role === null ? {} : { nextRole: row.next_role }),
    result: row.result,
    createdAt: numberValue(row.created_at),
  }
}

function summaryInviteRevealAudit(row: InviteRevealAuditRow): TeamInviteRevealAuditEventSummary {
  return {
    id: row.id,
    teamId: row.team_id,
    actorMemberId: row.actor_member_id,
    inviteId: row.invite_id,
    createdAt: numberValue(row.created_at),
  }
}

function summaryInvite(row: InviteRow, now: number): TeamInviteSummary {
  const status = row.status === 'pending' && numberValue(row.expires_at) <= now ? 'expired' : row.status
  const acceptedAt = optionalNumber(row.accepted_at)
  return {
    id: row.id,
    teamId: row.team_id,
    invitedByMemberId: row.invited_by_member_id,
    label: row.label,
    status,
    revealable: status === 'pending' && inviteEnvelope(row) !== undefined,
    expiresAt: numberValue(row.expires_at),
    createdAt: numberValue(row.created_at),
    ...(acceptedAt === undefined ? {} : { acceptedAt }),
  }
}

interface RevealableInviteSnapshot {
  readonly invite: InviteRow
  readonly envelope: TeamInviteTokenEnvelope
}

function storedInviteEnvelope(envelope: TeamInviteTokenEnvelope): Pick<
  InviteRow,
  | 'envelope_version'
  | 'envelope_key_ref'
  | 'envelope_wrapped_dek'
  | 'envelope_wrapped_dek_nonce'
  | 'envelope_wrapped_dek_tag'
  | 'envelope_nonce'
  | 'envelope_ciphertext'
  | 'envelope_tag'
> {
  return {
    envelope_version: envelope.version,
    envelope_key_ref: envelope.keyRef,
    envelope_wrapped_dek: envelope.wrappedDek,
    envelope_wrapped_dek_nonce: envelope.wrappedDekNonce ?? null,
    envelope_wrapped_dek_tag: envelope.wrappedDekTag ?? null,
    envelope_nonce: envelope.nonce,
    envelope_ciphertext: envelope.ciphertext,
    envelope_tag: envelope.tag,
  }
}

function emptyStoredInviteEnvelope(): ReturnType<typeof storedInviteEnvelope> {
  return {
    envelope_version: null,
    envelope_key_ref: null,
    envelope_wrapped_dek: null,
    envelope_wrapped_dek_nonce: null,
    envelope_wrapped_dek_tag: null,
    envelope_nonce: null,
    envelope_ciphertext: null,
    envelope_tag: null,
  }
}

function inviteEnvelope(row: InviteRow): TeamInviteTokenEnvelope | undefined {
  if (
    numberOrNull(row.envelope_version) !== 1
    || row.envelope_key_ref === null
    || row.envelope_wrapped_dek === null
    || row.envelope_nonce === null
    || row.envelope_ciphertext === null
    || row.envelope_tag === null
    || ((row.envelope_wrapped_dek_nonce === null) !== (row.envelope_wrapped_dek_tag === null))
  ) {
    return undefined
  }
  return {
    version: 1,
    keyRef: row.envelope_key_ref,
    wrappedDek: row.envelope_wrapped_dek,
    ...(row.envelope_wrapped_dek_nonce === null ? {} : { wrappedDekNonce: row.envelope_wrapped_dek_nonce }),
    ...(row.envelope_wrapped_dek_tag === null ? {} : { wrappedDekTag: row.envelope_wrapped_dek_tag }),
    nonce: row.envelope_nonce,
    ciphertext: row.envelope_ciphertext,
    tag: row.envelope_tag,
  }
}

function revealableInviteSnapshot(row: InviteRow | undefined, now: number): RevealableInviteSnapshot | undefined {
  if (row === undefined || row.status !== 'pending' || numberValue(row.expires_at) <= now) return undefined
  const envelope = inviteEnvelope(row)
  return envelope === undefined ? undefined : { invite: row, envelope }
}

function sameInviteSnapshot(left: RevealableInviteSnapshot, right: RevealableInviteSnapshot): boolean {
  return left.invite.id === right.invite.id
    && left.invite.team_id === right.invite.team_id
    && left.invite.status === right.invite.status
    && numberValue(left.invite.expires_at) === numberValue(right.invite.expires_at)
    && numberValue(left.invite.created_at) === numberValue(right.invite.created_at)
    && left.invite.token_hash === right.invite.token_hash
    && JSON.stringify(left.envelope) === JSON.stringify(right.envelope)
}

function numberOrNull(value: string | number | null): number | null {
  if (value === null) return null
  const result = typeof value === 'number' ? value : Number(value)
  return Number.isSafeInteger(result) ? result : null
}

function revealRateLimitRetryAfterSeconds(windowStartedAt: number, now: number): number {
  return rateLimitRetryAfterSeconds(windowStartedAt, now, TEAM_INVITE_REVEAL_RATE_LIMIT_WINDOW_MS)
}

function rateLimitRetryAfterSeconds(windowStartedAt: number, now: number, windowMs: number): number {
  return Math.max(1, Math.ceil((windowStartedAt + windowMs - now) / 1_000))
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
    dailySharedCreditLimit: nullableNumber(row.daily_shared_credit_limit),
    weeklySharedEstimatedApiCostLimitMicros: nullableNumber(row.weekly_shared_estimated_api_cost_limit_micros),
    maxSharedConcurrency: row.max_shared_concurrency,
    allowedModels: parseModels(row.allowed_models),
    createdAt: numberValue(row.created_at),
    updatedAt: numberValue(row.updated_at),
    ...(row.last_error === null ? {} : { lastError: safeTeamErrorMessage(row.last_error) }),
  }
}

function summaryUsageAggregate(row: UsageProjectionAggregateRow): TeamUsageAggregateSummary {
  const requestCount = numberValue(row.request_count)
  const tokenMeasuredRequestCount = numberValue(row.token_measured_request_count)
  const pricedRequestCount = numberValue(row.priced_request_count)
  if (
    requestCount < 0
    || tokenMeasuredRequestCount < 0
    || pricedRequestCount < 0
    || tokenMeasuredRequestCount > requestCount
    || pricedRequestCount > requestCount
  ) {
    throw new Error('stored usage aggregate counts are invalid')
  }
  return {
    requestCount,
    tokenMeasuredRequestCount,
    pricedRequestCount,
    totalTokens: requestCount === 0
      ? '0'
      : tokenMeasuredRequestCount === 0
        ? null
        : nonNegativeBigintString(row.total_tokens, 'stored total Token aggregate'),
    estimatedCostUsdMicros: requestCount === 0
      ? '0'
      : pricedRequestCount === 0
        ? null
        : nonNegativeBigintString(row.estimated_cost_usd_micros, 'stored cost aggregate'),
  }
}

function nonNegativeBigintString(value: string | number | bigint | null, label: string): string {
  if (value === null) throw new Error(`${label} is missing`)
  if (typeof value === 'bigint') {
    if (value < 0n) throw new Error(`${label} is invalid`)
    return value.toString()
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`)
    return value.toString()
  }
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) throw new Error(`${label} is invalid`)
  return value
}

function summaryUsage(row: UsageRow): TeamUsageEventSummary {
  const finishedAt = optionalNumber(row.finished_at)
  const credits = optionalNumber(row.credits)
  return {
    id: row.id,
    teamId: row.team_id,
    consumerMemberId: row.consumer_member_id,
    upstreamOwnerMemberId: row.upstream_owner_member_id,
    upstreamAccountId: row.upstream_account_id,
    model: row.model,
    unit: row.unit,
    status: row.status,
    ...(credits === undefined ? {} : { credits }),
    ...(row.credits_formula_version === null ? {} : { creditsFormulaVersion: row.credits_formula_version }),
    ...(row.total_tokens === null ? {} : { totalTokens: numberValue(row.total_tokens) }),
    ...(row.estimated_cost_usd_micros === null ? {} : { estimatedCostUsdMicros: nonNegativeBigintString(row.estimated_cost_usd_micros, 'stored usage cost') }),
    ...(row.pricing_catalog_version === null ? {} : { pricingCatalogVersion: row.pricing_catalog_version }),
    startedAt: numberValue(row.started_at),
    ...(finishedAt === undefined ? {} : { finishedAt }),
  }
}

function aggregateUsageRows(rows: readonly UsageRow[]): TeamUsageAggregateSummary {
  let totalTokens = 0n
  let estimatedCost = 0n
  let tokenMeasuredRequestCount = 0
  let pricedRequestCount = 0
  for (const row of rows) {
    if (row.total_tokens !== null) {
      tokenMeasuredRequestCount += 1
      totalTokens += BigInt(nonNegativeBigintString(row.total_tokens, 'stored usage tokens'))
    }
    if (row.estimated_cost_usd_micros !== null) {
      pricedRequestCount += 1
      estimatedCost += BigInt(nonNegativeBigintString(row.estimated_cost_usd_micros, 'stored usage cost'))
    }
  }
  return {
    requestCount: rows.length,
    tokenMeasuredRequestCount,
    pricedRequestCount,
    totalTokens: rows.length === 0 ? '0' : tokenMeasuredRequestCount === 0 ? null : totalTokens.toString(),
    estimatedCostUsdMicros: rows.length === 0 ? '0' : pricedRequestCount === 0 ? null : estimatedCost.toString(),
  }
}
