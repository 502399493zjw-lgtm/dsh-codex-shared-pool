/** PostgreSQL workload-role policy for the split Team Host/Credential Broker deployment. */

export const POSTGRES_TEAM_RUNTIME_ROLES_SQL = `-- Apply after POSTGRES_TEAM_MIGRATIONS with the schema owner/migration role.
-- These are NOLOGIN group roles. Grant them to separate workload login roles;
-- do not grant both groups to the same workload.

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dsh_team_host') THEN
    CREATE ROLE dsh_team_host NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dsh_team_broker') THEN
    CREATE ROLE dsh_team_broker NOLOGIN;
  END IF;
END
$roles$;

-- Acquire lifecycle row locks without granting the credential-only workload
-- UPDATE access to Team control tables. PostgreSQL row-locking SELECTs require
-- UPDATE privilege, so expose only a fixed allow/deny capability.
CREATE OR REPLACE FUNCTION public.team_lock_credential_scope(
  target_team_id text,
  target_account_id text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $credential_scope$
DECLARE
  team_status text;
  contribution_status text;
BEGIN
  SELECT status INTO team_status
  FROM public.teams
  WHERE id = target_team_id
  FOR UPDATE;
  IF team_status IS NULL OR team_status NOT IN ('active', 'paused') THEN
    RETURN false;
  END IF;
  SELECT status INTO contribution_status
  FROM public.team_contributions
  WHERE team_id = target_team_id AND id = target_account_id
  FOR UPDATE;
  RETURN contribution_status IS NOT NULL AND contribution_status <> 'revoked';
END
$credential_scope$;

REVOKE ALL ON FUNCTION public.team_lock_credential_scope(text, text) FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO dsh_team_host, dsh_team_broker;

REVOKE ALL ON TABLE
  public.teams,
  public.team_members,
  public.team_membership_audit_events,
  public.team_role_migration_audit_events,
  public.team_member_display_name_migration_audit_events,
  public.team_invites,
  public.team_invite_reveal_audit_events,
  public.team_invite_reveal_rate_limits,
  public.team_api_keys,
  public.team_contributions,
  public.team_usage_events,
  public.team_route_leases,
  public.team_session_bindings,
  public.team_api_key_traffic_state,
  public.team_api_key_traffic_leases,
  public.team_lifecycle_operations,
  public.team_lifecycle_audit_events,
  public.team_dissolution_recovery_rate_limits,
  public.team_ownership_transfers,
  public.team_ownership_transfer_audit_events,
  public.team_schema_migrations,
  public.team_contribution_credentials
FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.teams,
  public.team_members,
  public.team_membership_audit_events,
  public.team_invites,
  public.team_invite_reveal_audit_events,
  public.team_invite_reveal_rate_limits,
  public.team_api_keys,
  public.team_contributions,
  public.team_usage_events,
  public.team_route_leases,
  public.team_session_bindings,
  public.team_api_key_traffic_state,
  public.team_api_key_traffic_leases,
  public.team_lifecycle_operations,
  public.team_lifecycle_audit_events,
  public.team_dissolution_recovery_rate_limits,
  public.team_ownership_transfers,
  public.team_ownership_transfer_audit_events
TO dsh_team_host;
GRANT SELECT ON TABLE public.team_role_migration_audit_events TO dsh_team_host;
REVOKE ALL ON TABLE public.team_member_display_name_migration_audit_events
FROM dsh_team_host, dsh_team_broker;
REVOKE ALL PRIVILEGES (
  id,
  team_id,
  member_id,
  migration_version,
  previous_display_name,
  next_display_name,
  repair_reason,
  created_at,
  acknowledged_at
) ON TABLE public.team_member_display_name_migration_audit_events
FROM PUBLIC, dsh_team_host, dsh_team_broker;
GRANT SELECT ON TABLE public.team_member_display_name_migration_audit_events TO dsh_team_host;
GRANT UPDATE (acknowledged_at) ON TABLE public.team_member_display_name_migration_audit_events TO dsh_team_host;
GRANT SELECT ON TABLE public.team_schema_migrations TO dsh_team_host;
REVOKE ALL ON TABLE public.team_contribution_credentials FROM dsh_team_host;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.team_contribution_credentials
  TO dsh_team_broker;
REVOKE ALL ON TABLE
  public.teams,
  public.team_members,
  public.team_membership_audit_events,
  public.team_role_migration_audit_events,
  public.team_member_display_name_migration_audit_events,
  public.team_invites,
  public.team_invite_reveal_audit_events,
  public.team_invite_reveal_rate_limits,
  public.team_api_keys,
  public.team_contributions,
  public.team_usage_events,
  public.team_route_leases,
  public.team_session_bindings,
  public.team_api_key_traffic_state,
  public.team_api_key_traffic_leases,
  public.team_lifecycle_operations,
  public.team_lifecycle_audit_events,
  public.team_dissolution_recovery_rate_limits,
  public.team_ownership_transfers,
  public.team_ownership_transfer_audit_events,
  public.team_schema_migrations
FROM dsh_team_broker;

GRANT SELECT (id, status) ON TABLE public.teams TO dsh_team_broker;
GRANT SELECT (id, team_id, status) ON TABLE public.team_contributions TO dsh_team_broker;
GRANT EXECUTE ON FUNCTION public.team_lock_credential_scope(text, text) TO dsh_team_broker;

-- Example (replace these workload roles with your own LOGIN/workload identities):
-- GRANT dsh_team_host TO my_team_host_login;
-- GRANT dsh_team_broker TO my_team_broker_login;
-- GRANT CONNECT ON DATABASE my_database TO my_team_host_login, my_team_broker_login;
`

export interface TeamDatabaseRoleInspection {
  query(text: string): Promise<{ rows: readonly Record<string, unknown>[] }>
}

/** Fail closed unless the two workload logins have exactly the intended table boundary. */
export async function verifyTeamDatabaseRoleBoundary(database: TeamDatabaseRoleInspection): Promise<void> {
  const result = await database.query(`
    WITH control_tables(table_name) AS (VALUES
      ('teams'),
      ('team_members'),
      ('team_membership_audit_events'),
      ('team_invites'),
      ('team_invite_reveal_audit_events'),
      ('team_invite_reveal_rate_limits'),
      ('team_api_keys'),
      ('team_contributions'),
      ('team_usage_events'),
      ('team_route_leases'),
      ('team_session_bindings'),
      ('team_api_key_traffic_state'),
      ('team_api_key_traffic_leases'),
      ('team_lifecycle_operations'),
      ('team_lifecycle_audit_events'),
      ('team_dissolution_recovery_rate_limits'),
      ('team_ownership_transfers'),
      ('team_ownership_transfer_audit_events')
    ), runtime_privileges(privilege) AS (VALUES
      ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')
    )
    SELECT
      (SELECT bool_and(has_table_privilege(
        'dsh_team_host_login',
        'public.' || control_tables.table_name,
        runtime_privileges.privilege
      )) FROM control_tables CROSS JOIN runtime_privileges)
        AND has_table_privilege('dsh_team_host_login', 'public.team_schema_migrations', 'SELECT')
        AND NOT has_table_privilege('dsh_team_host_login', 'public.team_schema_migrations', 'INSERT')
        AND NOT has_table_privilege('dsh_team_host_login', 'public.team_schema_migrations', 'UPDATE')
        AND NOT has_table_privilege('dsh_team_host_login', 'public.team_schema_migrations', 'DELETE')
        AS host_control,
      has_table_privilege('dsh_team_host_login', 'public.team_contribution_credentials', 'SELECT')
        OR has_table_privilege('dsh_team_host_login', 'public.team_contribution_credentials', 'INSERT')
        OR has_table_privilege('dsh_team_host_login', 'public.team_contribution_credentials', 'UPDATE')
        OR has_table_privilege('dsh_team_host_login', 'public.team_contribution_credentials', 'DELETE')
        AS host_credentials,
      has_table_privilege('dsh_team_host_login', 'public.team_role_migration_audit_events', 'SELECT')
        AND NOT has_table_privilege('dsh_team_host_login', 'public.team_role_migration_audit_events', 'INSERT')
        AND NOT has_table_privilege('dsh_team_host_login', 'public.team_role_migration_audit_events', 'UPDATE')
        AND NOT has_table_privilege('dsh_team_host_login', 'public.team_role_migration_audit_events', 'DELETE')
        AS host_role_migration_audit,
      has_table_privilege('dsh_team_host_login', 'public.team_member_display_name_migration_audit_events', 'SELECT')
        AND NOT has_table_privilege('dsh_team_host_login', 'public.team_member_display_name_migration_audit_events', 'INSERT')
        AND NOT has_table_privilege('dsh_team_host_login', 'public.team_member_display_name_migration_audit_events', 'UPDATE')
        AND NOT has_table_privilege('dsh_team_host_login', 'public.team_member_display_name_migration_audit_events', 'DELETE')
        AS host_display_name_migration_audit,
      has_column_privilege(
        'dsh_team_host_login',
        'public.team_member_display_name_migration_audit_events',
        'acknowledged_at',
        'UPDATE'
      ) AND NOT has_any_column_privilege(
        'dsh_team_host_login',
        'public.team_member_display_name_migration_audit_events',
        'INSERT'
      ) AND NOT has_any_column_privilege(
        'dsh_team_host_login',
        'public.team_member_display_name_migration_audit_events',
        'REFERENCES'
      ) AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'team_member_display_name_migration_audit_events'
          AND column_name <> 'acknowledged_at'
          AND has_column_privilege(
            'dsh_team_host_login',
            'public.team_member_display_name_migration_audit_events',
            column_name,
            'UPDATE'
          )
      ) AS host_display_name_migration_ack,
      (SELECT bool_or(has_table_privilege(
        'dsh_team_broker_login',
        'public.' || control_tables.table_name,
        runtime_privileges.privilege
      )) FROM control_tables CROSS JOIN runtime_privileges)
        OR has_table_privilege('dsh_team_broker_login', 'public.team_schema_migrations', 'SELECT')
        OR has_table_privilege('dsh_team_broker_login', 'public.team_schema_migrations', 'INSERT')
        OR has_table_privilege('dsh_team_broker_login', 'public.team_schema_migrations', 'UPDATE')
        OR has_table_privilege('dsh_team_broker_login', 'public.team_schema_migrations', 'DELETE')
        AS broker_control,
      has_table_privilege('dsh_team_broker_login', 'public.team_role_migration_audit_events', 'SELECT')
        OR has_table_privilege('dsh_team_broker_login', 'public.team_role_migration_audit_events', 'INSERT')
        OR has_table_privilege('dsh_team_broker_login', 'public.team_role_migration_audit_events', 'UPDATE')
        OR has_table_privilege('dsh_team_broker_login', 'public.team_role_migration_audit_events', 'DELETE')
        AS broker_role_migration_audit,
      has_table_privilege('dsh_team_broker_login', 'public.team_member_display_name_migration_audit_events', 'SELECT')
        OR has_table_privilege('dsh_team_broker_login', 'public.team_member_display_name_migration_audit_events', 'INSERT')
        OR has_table_privilege('dsh_team_broker_login', 'public.team_member_display_name_migration_audit_events', 'UPDATE')
        OR has_table_privilege('dsh_team_broker_login', 'public.team_member_display_name_migration_audit_events', 'DELETE')
        AS broker_display_name_migration_audit,
      has_any_column_privilege(
        'dsh_team_broker_login',
        'public.team_member_display_name_migration_audit_events',
        'SELECT'
      ) OR has_any_column_privilege(
        'dsh_team_broker_login',
        'public.team_member_display_name_migration_audit_events',
        'INSERT'
      ) OR has_any_column_privilege(
        'dsh_team_broker_login',
        'public.team_member_display_name_migration_audit_events',
        'UPDATE'
      ) OR has_any_column_privilege(
        'dsh_team_broker_login',
        'public.team_member_display_name_migration_audit_events',
        'REFERENCES'
      ) AS broker_display_name_migration_ack,
      has_column_privilege('dsh_team_broker_login', 'public.teams', 'id', 'SELECT')
        AND has_column_privilege('dsh_team_broker_login', 'public.teams', 'status', 'SELECT')
        AND NOT has_column_privilege('dsh_team_broker_login', 'public.teams', 'name', 'SELECT')
        AND has_column_privilege('dsh_team_broker_login', 'public.team_contributions', 'id', 'SELECT')
        AND has_column_privilege('dsh_team_broker_login', 'public.team_contributions', 'team_id', 'SELECT')
        AND has_column_privilege('dsh_team_broker_login', 'public.team_contributions', 'status', 'SELECT')
        AND NOT has_column_privilege('dsh_team_broker_login', 'public.team_contributions', 'label', 'SELECT')
        AND has_function_privilege(
          'dsh_team_broker_login',
          'public.team_lock_credential_scope(text,text)',
          'EXECUTE'
        ) AS broker_credential_scope,
      has_table_privilege('dsh_team_broker_login', 'public.team_contribution_credentials', 'SELECT')
        AND has_table_privilege('dsh_team_broker_login', 'public.team_contribution_credentials', 'INSERT')
        AND has_table_privilege('dsh_team_broker_login', 'public.team_contribution_credentials', 'UPDATE')
        AND has_table_privilege('dsh_team_broker_login', 'public.team_contribution_credentials', 'DELETE')
        AS broker_credentials
  `)
  const row = result.rows[0]
  if (row?.['host_control'] !== true
    || row['host_credentials'] !== false
    || row['host_role_migration_audit'] !== true
    || row['host_display_name_migration_audit'] !== true
    || row['host_display_name_migration_ack'] !== true
    || row['broker_control'] !== false
    || row['broker_role_migration_audit'] !== false
    || row['broker_display_name_migration_audit'] !== false
    || row['broker_display_name_migration_ack'] !== false
    || row['broker_credential_scope'] !== true
    || row['broker_credentials'] !== true) {
    throw new Error('Team database role boundary verification failed')
  }
}
