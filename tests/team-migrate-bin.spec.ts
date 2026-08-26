import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { runTeamDatabaseMigration } from '../src/team-migrate-bin.ts'
import {
  POSTGRES_TEAM_RUNTIME_ROLES_SQL,
  verifyTeamDatabaseRoleBoundary,
} from '../src/team/postgres-roles.ts'

describe('Team database migration command', () => {
  it('keeps the shipped role policy identical to the policy executed by the migrator', async () => {
    const shipped = await readFile(new URL('../deploy/postgres/runtime-roles.sql', import.meta.url), 'utf8')
    const logins = await readFile(new URL('../deploy/postgres/init-runtime-logins.sh', import.meta.url), 'utf8')

    expect(shipped.trim()).toBe(POSTGRES_TEAM_RUNTIME_ROLES_SQL.trim())
    expect(shipped).toMatch(/REVOKE ALL ON TABLE public\.team_contribution_credentials FROM dsh_team_host/u)
    expect(shipped).toMatch(/GRANT SELECT ON TABLE public\.team_role_migration_audit_events TO dsh_team_host/u)
    expect(shipped).toMatch(/GRANT SELECT ON TABLE public\.team_member_display_name_migration_audit_events TO dsh_team_host/u)
    expect(shipped).toMatch(/GRANT UPDATE \(acknowledged_at\) ON TABLE public\.team_member_display_name_migration_audit_events TO dsh_team_host/u)
    expect(shipped).toMatch(/REVOKE ALL ON TABLE[\s\S]*public\.team_role_migration_audit_events[\s\S]*FROM dsh_team_broker/u)
    expect(shipped).toMatch(/REVOKE ALL ON TABLE[\s\S]*public\.team_member_display_name_migration_audit_events[\s\S]*FROM dsh_team_broker/u)
    expect(shipped).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE[\s\S]*public\.team_dissolution_recovery_rate_limits[\s\S]*TO dsh_team_host/u)
    expect(shipped).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE[\s\S]*public\.team_ownership_transfers[\s\S]*public\.team_ownership_transfer_audit_events[\s\S]*TO dsh_team_host/u)
    expect(shipped).toMatch(/REVOKE ALL ON TABLE[\s\S]*public\.team_ownership_transfers[\s\S]*public\.team_ownership_transfer_audit_events[\s\S]*FROM PUBLIC/u)
    expect(shipped).toMatch(/REVOKE ALL ON TABLE[\s\S]*public\.team_lifecycle_operations[\s\S]*public\.team_dissolution_recovery_rate_limits[\s\S]*FROM dsh_team_broker/u)
    expect(shipped).toMatch(/REVOKE ALL ON TABLE[\s\S]*public\.team_ownership_transfers[\s\S]*public\.team_ownership_transfer_audit_events[\s\S]*FROM dsh_team_broker/u)
    expect(shipped).toMatch(/REVOKE ALL ON TABLE[\s\S]*public\.teams[\s\S]*FROM dsh_team_broker/u)
    expect(logins).toMatch(/CREATE ROLE dsh_team_host_login LOGIN PASSWORD '\$POSTGRES_TEAM_HOST_PASSWORD'/u)
    expect(logins).toMatch(/CREATE ROLE dsh_team_broker_login LOGIN PASSWORD '\$POSTGRES_TEAM_BROKER_PASSWORD'/u)
    expect(logins).toMatch(/validate_hex_secret "\$POSTGRES_TEAM_HOST_PASSWORD"/u)
    expect(logins).toMatch(/validate_hex_secret "\$POSTGRES_TEAM_BROKER_PASSWORD"/u)
    expect(logins).toMatch(/GRANT dsh_team_host TO dsh_team_host_login/u)
    expect(logins).toMatch(/GRANT dsh_team_broker TO dsh_team_broker_login/u)
    expect(logins).not.toMatch(/set -x/u)
  })

  it('fails closed unless the workload logins have inverse table privileges', async () => {
    const query = vi.fn(async () => ({ rows: [{
      host_control: true,
      host_credentials: false,
      host_role_migration_audit: true,
      host_display_name_migration_audit: true,
      host_display_name_migration_ack: true,
      broker_control: false,
      broker_role_migration_audit: false,
      broker_display_name_migration_audit: false,
      broker_display_name_migration_ack: false,
      broker_credentials: true,
    }] }))

    await expect(verifyTeamDatabaseRoleBoundary({ query })).resolves.toBeUndefined()
    expect(String(query.mock.calls[0]?.[0])).toMatch(/has_table_privilege/iu)
    expect(String(query.mock.calls[0]?.[0])).toMatch(/has_column_privilege/iu)
    expect(String(query.mock.calls[0]?.[0])).toMatch(/has_any_column_privilege/iu)
    expect(String(query.mock.calls[0]?.[0])).toMatch(/dsh_team_host_login/iu)
    expect(String(query.mock.calls[0]?.[0])).toMatch(/dsh_team_broker_login/iu)
    expect(String(query.mock.calls[0]?.[0])).toMatch(/team_dissolution_recovery_rate_limits/iu)
    expect(String(query.mock.calls[0]?.[0])).toMatch(/team_ownership_transfers/iu)
    expect(String(query.mock.calls[0]?.[0])).toMatch(/team_ownership_transfer_audit_events/iu)
    expect(String(query.mock.calls[0]?.[0])).toMatch(/team_role_migration_audit_events/iu)
    expect(String(query.mock.calls[0]?.[0])).toMatch(/team_member_display_name_migration_audit_events/iu)

    await expect(verifyTeamDatabaseRoleBoundary({
      query: vi.fn(async () => ({ rows: [{
        host_control: true,
        host_credentials: true,
        host_role_migration_audit: true,
        host_display_name_migration_audit: true,
        broker_control: false,
        broker_role_migration_audit: false,
        broker_display_name_migration_audit: false,
        broker_credentials: true,
      }] })),
    })).rejects.toThrow(/role boundary/iu)

    await expect(verifyTeamDatabaseRoleBoundary({
      query: vi.fn(async () => ({ rows: [{
        host_control: true,
        host_credentials: false,
        host_role_migration_audit: false,
        host_display_name_migration_audit: true,
        broker_control: false,
        broker_role_migration_audit: false,
        broker_display_name_migration_audit: false,
        broker_credentials: true,
      }] })),
    })).rejects.toThrow(/role boundary/iu)

    await expect(verifyTeamDatabaseRoleBoundary({
      query: vi.fn(async () => ({ rows: [{
        host_control: true,
        host_credentials: false,
        host_role_migration_audit: true,
        host_display_name_migration_audit: false,
        broker_control: false,
        broker_role_migration_audit: false,
        broker_display_name_migration_audit: false,
        broker_credentials: true,
      }] })),
    })).rejects.toThrow(/role boundary/iu)

    await expect(verifyTeamDatabaseRoleBoundary({
      query: vi.fn(async () => ({ rows: [{
        host_control: true,
        host_credentials: false,
        host_role_migration_audit: true,
        host_display_name_migration_audit: true,
        host_display_name_migration_ack: false,
        broker_control: false,
        broker_role_migration_audit: false,
        broker_display_name_migration_audit: false,
        broker_display_name_migration_ack: false,
        broker_credentials: true,
      }] })),
    })).rejects.toThrow(/role boundary/iu)

    await expect(verifyTeamDatabaseRoleBoundary({
      query: vi.fn(async () => ({ rows: [{
        host_control: true,
        host_credentials: false,
        host_role_migration_audit: true,
        host_display_name_migration_audit: true,
        host_display_name_migration_ack: true,
        broker_control: false,
        broker_role_migration_audit: false,
        broker_display_name_migration_audit: false,
        broker_display_name_migration_ack: true,
        broker_credentials: true,
      }] })),
    })).rejects.toThrow(/role boundary/iu)
  })

  it('runs only with an explicit migration URL and never prints it', async () => {
    const stdout = vi.fn(() => true)
    const stderr = vi.fn(() => true)
    const migrate = vi.fn(async () => undefined)
    const databaseUrl = 'postgres://migrator:private-password@postgres/team_pool'

    await expect(runTeamDatabaseMigration([], {
      environment: { DSH_CODEX_SHARED_POOL_DATABASE_URL: databaseUrl },
      stdout: { write: stdout },
      stderr: { write: stderr },
      migrate,
    })).resolves.toBe(0)
    expect(migrate).toHaveBeenCalledWith(databaseUrl)
    expect(stdout.mock.calls.flat().join('')).toMatch(/migration.*complete/iu)
    expect(stdout.mock.calls.flat().join('')).not.toContain(databaseUrl)
    expect(stderr).not.toHaveBeenCalled()

    migrate.mockRejectedValueOnce(new Error(`connection refused for ${databaseUrl}`))
    await expect(runTeamDatabaseMigration([], {
      environment: { DSH_CODEX_SHARED_POOL_DATABASE_URL: databaseUrl },
      stdout: { write: stdout },
      stderr: { write: stderr },
      migrate,
    })).resolves.toBe(1)
    const failure = stderr.mock.calls.flat().join('')
    expect(failure).toMatch(/migration failed/iu)
    expect(failure).not.toContain('private-password')
    expect(failure).not.toContain(databaseUrl)
  })
})
