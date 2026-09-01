#!/usr/bin/env node
/** Standalone process for the Host-only Team credential broker capability boundary. */

import { timingSafeEqual } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { OutboundNetwork } from './network.ts'
import { safeExternalErrorMessage } from './safe-message.ts'
import {
  loadTeamCredentialBrokerEnvironment,
  startTeamCredentialBrokerDaemon,
  verifyTeamCredentialBrokerDatabase,
} from './team/broker-daemon.ts'
import type { RunningTeamCredentialBrokerDaemon } from './team/broker-daemon.ts'
import { LocalTeamCredentialBroker } from './team/credentials.ts'
import {
  Aes256GcmTeamKeyEncryptionProvider,
  PostgresTeamEnvelopeCredentialBackend,
  TeamKeyEncryptionKeyring,
} from './team/envelope-credentials.ts'
import type { TeamKeyEncryptionProvider } from './team/envelope-credentials.ts'

interface TextWriter {
  write(value: string): unknown
}

export interface TeamCredentialBrokerCommandOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly stdout?: TextWriter
  readonly stderr?: TextWriter
}

const HELP = [
  'Usage: dsh-codex-team-broker',
  '',
  'Runs the credential-only service at /v1/dsh-team-credential-broker.',
  'It listens on 127.0.0.1:8788 by default; put TLS/authenticated network policy in front of non-loopback deployments.',
  '',
  'Required secrets (set exactly one direct value or _FILE path):',
  '  DSH_CODEX_SHARED_POOL_DATABASE_URL[_FILE]',
  '  DSH_CODEX_SHARED_POOL_CREDENTIAL_MASTER_KEY[_FILE]',
  '  DSH_CODEX_SHARED_POOL_CREDENTIAL_BROKER_API_KEY[_FILE]',
  '',
  'Optional:',
  '  DSH_CODEX_SHARED_POOL_CREDENTIAL_PREVIOUS_MASTER_KEY[_FILE]',
  '  DSH_CODEX_TEAM_BROKER_HOST (default 127.0.0.1)',
  '  DSH_CODEX_TEAM_BROKER_PORT (default 8788)',
  '  DSH_CODEX_TEAM_BROKER_SHUTDOWN_GRACE_MS (default 10000)',
  '',
  'Examples of file variables:',
  '  DSH_CODEX_SHARED_POOL_DATABASE_URL_FILE=/run/secrets/database-url',
  '  DSH_CODEX_SHARED_POOL_CREDENTIAL_MASTER_KEY_FILE=/run/secrets/credential-master-key',
  '  DSH_CODEX_SHARED_POOL_CREDENTIAL_BROKER_API_KEY_FILE=/run/secrets/broker-api-key',
  '',
].join('\n')

/** Run the daemon command until SIGINT or SIGTERM. */
export async function runTeamCredentialBroker(
  argv: readonly string[],
  options: TeamCredentialBrokerCommandOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    stdout.write(HELP)
    return 0
  }
  if (argv.length > 0) {
    stderr.write('dsh-codex-team-broker: does not accept command arguments; use --help for environment configuration\n')
    return 1
  }

  let daemon: RunningTeamCredentialBrokerDaemon | undefined
  let disposeNetwork: (() => Promise<void>) | undefined
  let exitCode = 1
  try {
    const environment = options.environment ?? process.env
    disposeNetwork = new OutboundNetwork(environment).install()
    const config = await loadTeamCredentialBrokerEnvironment(environment)
    let providers: TeamKeyEncryptionProvider
    try {
      providers = createKeyEncryptionProvider(config.masterKey, config.previousMasterKey)
    } finally {
      config.masterKey.fill(0)
      config.previousMasterKey?.fill(0)
    }
    let pool: Pool
    try {
      pool = new Pool({
        connectionString: config.databaseUrl,
        application_name: 'dsh-codex-team-broker',
      })
    } catch (error: unknown) {
      await providers.dispose?.()
      throw error
    }
    pool.on('error', (error) => {
      stderr.write(`dsh-codex-team-broker: idle PostgreSQL connection error: ${safeExternalErrorMessage(error, 500)}\n`)
    })
    const broker = new LocalTeamCredentialBroker({
      storage: new PostgresTeamEnvelopeCredentialBackend({
        pool,
        keyEncryptionProvider: providers,
      }),
      onBackgroundError: (message) => {
        stderr.write(`dsh-codex-team-broker: background OAuth state error: ${safeExternalErrorMessage(message, 500)}\n`)
      },
    })
    daemon = await startTeamCredentialBrokerDaemon({
      broker,
      resolveApiKey: async () => config.apiKey,
      host: config.host,
      port: config.port,
      shutdownGraceMs: config.shutdownGraceMs,
      verifyReady: async () => verifyTeamCredentialBrokerDatabase(pool),
      onClose: async () => pool.end(),
    })
    stdout.write(`dsh-codex-team-broker: listening on ${daemon.address.host}:${daemon.address.port}\n`)
    await terminationSignal()
    await daemon.dispose()
    daemon = undefined
    exitCode = 0
  } catch (error: unknown) {
    await daemon?.dispose().catch(() => undefined)
    stderr.write(`dsh-codex-team-broker: startup or shutdown failed: ${safeExternalErrorMessage(error, 500)}\n`)
  } finally {
    try {
      await disposeNetwork?.()
    } catch (error: unknown) {
      exitCode = 1
      stderr.write(`dsh-codex-team-broker: outbound network cleanup failed: ${safeExternalErrorMessage(error, 500)}\n`)
    }
  }
  return exitCode
}

function createKeyEncryptionProvider(
  masterKey: Buffer,
  previousMasterKey: Buffer | undefined,
): TeamKeyEncryptionProvider {
  if (previousMasterKey !== undefined && timingSafeEqual(masterKey, previousMasterKey)) {
    throw new Error('Team current and previous credential encryption keys must differ')
  }
  const primary = new Aes256GcmTeamKeyEncryptionProvider(masterKey)
  if (previousMasterKey === undefined) return primary
  try {
    return new TeamKeyEncryptionKeyring(primary, [new Aes256GcmTeamKeyEncryptionProvider(previousMasterKey)])
  } catch (error: unknown) {
    primary.dispose()
    throw error
  }
}

function terminationSignal(): Promise<void> {
  return new Promise(resolve => {
    const done = () => {
      process.removeListener('SIGINT', done)
      process.removeListener('SIGTERM', done)
      resolve()
    }
    process.once('SIGINT', done)
    process.once('SIGTERM', done)
  })
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await runTeamCredentialBroker(process.argv.slice(2))
}
