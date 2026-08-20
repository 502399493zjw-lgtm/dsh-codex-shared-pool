-- Apply after POSTGRES_TEAM_MIGRATIONS with the schema owner/migration role.
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

GRANT USAGE ON SCHEMA public TO dsh_team_host, dsh_team_broker;

REVOKE ALL ON TABLE
  public.teams,
  public.team_members,
  public.team_invites,
  public.team_api_keys,
  public.team_contributions,
  public.team_usage_events,
  public.team_route_leases,
  public.team_session_bindings,
  public.team_api_key_traffic_state,
  public.team_api_key_traffic_leases,
  public.team_schema_migrations,
  public.team_contribution_credentials
FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.teams,
  public.team_members,
  public.team_invites,
  public.team_api_keys,
  public.team_contributions,
  public.team_usage_events,
  public.team_route_leases,
  public.team_session_bindings,
  public.team_api_key_traffic_state,
  public.team_api_key_traffic_leases
TO dsh_team_host;
GRANT SELECT ON TABLE public.team_schema_migrations TO dsh_team_host;
REVOKE ALL ON TABLE public.team_contribution_credentials FROM dsh_team_host;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.team_contribution_credentials
  TO dsh_team_broker;
REVOKE ALL ON TABLE
  public.teams,
  public.team_members,
  public.team_invites,
  public.team_api_keys,
  public.team_contributions,
  public.team_usage_events,
  public.team_route_leases,
  public.team_session_bindings,
  public.team_api_key_traffic_state,
  public.team_api_key_traffic_leases,
  public.team_schema_migrations
FROM dsh_team_broker;

-- Example (replace these workload roles with your own LOGIN/workload identities):
-- GRANT dsh_team_host TO my_team_host_login;
-- GRANT dsh_team_broker TO my_team_broker_login;
-- GRANT CONNECT ON DATABASE my_database TO my_team_host_login, my_team_broker_login;
