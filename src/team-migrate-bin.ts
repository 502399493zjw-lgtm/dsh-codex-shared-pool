#!/usr/bin/env node
/** One-shot PostgreSQL schema and least-privilege role migration command. */

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { safeExternalErrorMessage } from './safe-message.ts'
import { PostgresTeamStore } from './team/postgres-store.ts'
import {
  POSTGRES_TEAM_RUNTIME_ROLES_SQL,
  verifyTeamDatabaseRoleBoundary,
} from './team/postgres-roles.ts'

interface TextWriter {
  write(value: string): unknown
}

export interface TeamDatabaseMigrationCommandOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly stdout?: TextWriter
  readonly stderr?: TextWriter
  readonly migrate?: (databaseUrl: string) => Promise<void>
}

const HELP = [
  'Usage: dsh-codex-team-migrate',
  '',
  'Applies Team schema migrations and the split Host/Broker runtime-role policy.',
  'Run it with a schema-owner connection before either workload starts.',
  '',
  'Required:',
  '  DSH_CODEX_SHARED_POOL_DATABASE_URL',
  '',
].join('\n')

export async function runTeamDatabaseMigration(
  argv: readonly string[],
  options: TeamDatabaseMigrationCommandOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    stdout.write(HELP)
    return 0
  }
  if (argv.length > 0) {
    stderr.write('dsh-codex-team-migrate: does not accept command arguments; use --help for configuration\n')
    return 1
  }

  try {
    const databaseUrl = requiredDatabaseUrl(options.environment ?? process.env)
    await (options.migrate ?? migrateTeamDatabase)(databaseUrl)
    stdout.write('dsh-codex-team-migrate: migration and role verification complete\n')
    return 0
  } catch (error: unknown) {
    stderr.write(`dsh-codex-team-migrate: migration failed: ${safeExternalErrorMessage(error, 500)}\n`)
    return 1
  }
}

export async function migrateTeamDatabase(databaseUrl: string): Promise<void> {
  const pool = new Pool({
    connectionString: databaseUrl,
    application_name: 'dsh-codex-team-migrate',
  })
  try {
    await new PostgresTeamStore({ pool }).initialize()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(POSTGRES_TEAM_RUNTIME_ROLES_SQL)
      await verifyTeamDatabaseRoleBoundary(client)
      await client.query('COMMIT')
    } catch (error: unknown) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  } finally {
    await pool.end()
  }
}

function requiredDatabaseUrl(environment: Readonly<Record<string, string | undefined>>): string {
  const value = environment['DSH_CODEX_SHARED_POOL_DATABASE_URL']?.trim()
  if (value === undefined || value.length === 0) {
    throw new Error('DSH_CODEX_SHARED_POOL_DATABASE_URL is required')
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('DSH_CODEX_SHARED_POOL_DATABASE_URL must be a valid PostgreSQL URL')
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.hostname.length === 0) {
    throw new Error('DSH_CODEX_SHARED_POOL_DATABASE_URL must be a valid PostgreSQL URL')
  }
  return value
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await runTeamDatabaseMigration(process.argv.slice(2))
}
