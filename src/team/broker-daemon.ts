/** Runnable HTTP boundary and environment loading for the isolated credential broker. */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { open } from 'node:fs/promises'
import type { TeamCredentialBroker } from './credentials.ts'
import {
  createTeamCredentialBrokerHttpHandler,
  TEAM_CREDENTIAL_BROKER_PATH_PREFIX,
} from './remote-credentials.ts'
import { decodeTeamCredentialMasterKey } from './envelope-credentials.ts'

export const TEAM_CREDENTIAL_BROKER_HEALTH_PATH = '/healthz'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 8788
const DEFAULT_SHUTDOWN_GRACE_MS = 10_000
const MAX_SECRET_FILE_BYTES = 64 * 1024
const MAX_INTERNAL_KEY_LENGTH = 4_096

export interface TeamCredentialBrokerEnvironment {
  readonly databaseUrl: string
  /** Caller owns these buffers and must wipe them after provider construction. */
  readonly masterKey: Buffer
  readonly previousMasterKey?: Buffer
  readonly apiKey: string
  readonly host: string
  readonly port: number
  readonly shutdownGraceMs: number
}

export interface TeamCredentialBrokerDatabase {
  query(text: string): Promise<{ rows: readonly Record<string, unknown>[] }>
}

export interface TeamCredentialBrokerDaemonOptions {
  readonly broker: TeamCredentialBroker
  readonly resolveApiKey: () => Promise<string | undefined>
  readonly host?: string
  readonly port?: number
  readonly shutdownGraceMs?: number
  /** Runs before the socket starts accepting traffic. */
  readonly verifyReady?: () => Promise<void>
  /** Releases resources not owned by the broker, such as its PostgreSQL pool and KEK. */
  readonly onClose?: () => Promise<void> | void
}

export interface RunningTeamCredentialBrokerDaemon {
  readonly origin: string
  readonly brokerBaseUrl: string
  readonly address: Readonly<{ host: string; port: number }>
  dispose(): Promise<void>
}

/**
 * Load Host-only daemon configuration. Every secret supports a `_FILE`
 * alternative suitable for container secret mounts; direct and file sources
 * are intentionally mutually exclusive.
 */
export async function loadTeamCredentialBrokerEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<TeamCredentialBrokerEnvironment> {
  const databaseUrl = await requiredSecret(environment, 'DSH_CODEX_SHARED_POOL_DATABASE_URL')
  validateDatabaseUrl(databaseUrl)
  const encodedMasterKey = await requiredSecret(environment, 'DSH_CODEX_SHARED_POOL_CREDENTIAL_MASTER_KEY')
  const encodedPreviousMasterKey = await optionalSecret(
    environment,
    'DSH_CODEX_SHARED_POOL_CREDENTIAL_PREVIOUS_MASTER_KEY',
  )
  const apiKey = await requiredSecret(environment, 'DSH_CODEX_SHARED_POOL_CREDENTIAL_BROKER_API_KEY')
  validateInternalApiKey(apiKey)
  const masterKey = decodeTeamCredentialMasterKey(encodedMasterKey)
  let previousMasterKey: Buffer | undefined
  try {
    previousMasterKey = encodedPreviousMasterKey === undefined
      ? undefined
      : decodeTeamCredentialMasterKey(encodedPreviousMasterKey)
    return {
      databaseUrl,
      masterKey,
      ...(previousMasterKey === undefined ? {} : { previousMasterKey }),
      apiKey,
      host: daemonHost(environment['DSH_CODEX_TEAM_BROKER_HOST']),
      port: daemonInteger(environment['DSH_CODEX_TEAM_BROKER_PORT'], DEFAULT_PORT, 'broker port', 0, 65_535),
      shutdownGraceMs: daemonInteger(
        environment['DSH_CODEX_TEAM_BROKER_SHUTDOWN_GRACE_MS'],
        DEFAULT_SHUTDOWN_GRACE_MS,
        'shutdown grace',
        100,
        120_000,
      ),
    }
  } catch (error: unknown) {
    masterKey.fill(0)
    previousMasterKey?.fill(0)
    throw error
  }
}

/** Fail closed unless the credential-only runtime role sees the migrated shape and CRUD privileges. */
export async function verifyTeamCredentialBrokerDatabase(database: TeamCredentialBrokerDatabase): Promise<void> {
  const privilege = await database.query(`
    SELECT c.oid::text AS table_oid,
      has_table_privilege(current_user, c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS allowed
    FROM pg_class AS c
    WHERE c.oid = to_regclass('team_contribution_credentials')
      AND c.relkind IN ('r', 'p')
  `)
  const row = privilege.rows[0]
  if (row === undefined) {
    throw new Error('Team credential broker database migration is missing the credential table')
  }
  if (row['allowed'] !== true) {
    throw new Error('Team credential broker database role lacks required credential-table privileges')
  }
  await database.query(`
    SELECT team_id, account_id, envelope_version, key_id,
      wrapped_dek, wrapped_dek_nonce, wrapped_dek_tag,
      encrypted_document, document_nonce, document_tag, updated_at
    FROM team_contribution_credentials
    LIMIT 0
  `)
}

/** Start one loopback-by-default broker server after its dependencies pass readiness checks. */
export async function startTeamCredentialBrokerDaemon(
  options: TeamCredentialBrokerDaemonOptions,
): Promise<RunningTeamCredentialBrokerDaemon> {
  const host = daemonHost(options.host)
  const port = boundedInteger(options.port ?? DEFAULT_PORT, 'broker port', 0, 65_535)
  const shutdownGraceMs = boundedInteger(
    options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS,
    'shutdown grace',
    100,
    120_000,
  )
  const handler = createTeamCredentialBrokerHttpHandler({
    broker: options.broker,
    resolveApiKey: options.resolveApiKey,
  })
  const server = createServer((req, res) => {
    void dispatch(req, res, handler).catch(() => {
      if (!res.headersSent) writeHealthError(res)
      else if (!res.writableEnded) res.end()
    })
  })
  server.headersTimeout = 15_000
  server.keepAliveTimeout = 5_000

  try {
    await options.verifyReady?.()
    await listen(server, host, port)
  } catch (error: unknown) {
    await cleanup(options).catch(() => undefined)
    throw error
  }

  const listening = server.address()
  if (listening === null || typeof listening === 'string') {
    await closeServer(server, shutdownGraceMs)
    await cleanup(options).catch(() => undefined)
    throw new Error('Team credential broker did not bind a TCP address')
  }
  const address = tcpAddress(listening, host)
  const origin = `http://${urlHost(address.host)}:${address.port}`
  let disposing: Promise<void> | undefined
  return {
    origin,
    brokerBaseUrl: `${origin}${TEAM_CREDENTIAL_BROKER_PATH_PREFIX}`,
    address,
    dispose() {
      disposing ??= Promise.allSettled([
        closeServer(server, shutdownGraceMs),
        cleanup(options),
      ]).then(results => {
        const failures = results
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map(result => result.reason)
        if (failures.length > 0) throw new AggregateError(failures, 'Team credential broker shutdown failed')
      })
      return disposing
    },
  }
}

type BrokerHandler = ReturnType<typeof createTeamCredentialBrokerHttpHandler>

async function dispatch(req: IncomingMessage, res: ServerResponse, handler: BrokerHandler): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://credential-broker.invalid')
  if (url.pathname === TEAM_CREDENTIAL_BROKER_HEALTH_PATH && url.search.length === 0) {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' })
      res.end('{"error":"method not allowed"}')
      return
    }
    res.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' })
    res.end('{"status":"ok"}')
    return
  }
  await handler(req, res)
}

function writeHealthError(res: ServerResponse): void {
  res.writeHead(500, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' })
  res.end('{"error":"internal broker error"}')
}

async function requiredSecret(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): Promise<string> {
  const value = await optionalSecret(environment, name)
  if (value === undefined || value.length === 0) throw new Error(`${name} or ${name}_FILE is required`)
  return value
}

async function optionalSecret(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): Promise<string | undefined> {
  const direct = environment[name]
  const file = environment[`${name}_FILE`]
  if (direct !== undefined && file !== undefined) {
    throw new Error(`${name} and ${name}_FILE cannot both be configured`)
  }
  if (direct !== undefined) return stripOneFinalLineBreak(direct)
  if (file === undefined) return undefined
  if (file.length === 0 || file !== file.trim()) throw new Error(`${name}_FILE must be a non-empty path`)
  const handle = await open(file, 'r')
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_SECRET_FILE_BYTES) {
      throw new Error(`${name}_FILE must reference a non-empty regular file no larger than ${MAX_SECRET_FILE_BYTES} bytes`)
    }
    return stripOneFinalLineBreak(await handle.readFile('utf8'))
  } finally {
    await handle.close()
  }
}

function stripOneFinalLineBreak(value: string): string {
  return value.replace(/\r?\n$/u, '')
}

function validateDatabaseUrl(value: string): void {
  if (value !== value.trim() || /[\r\n]/u.test(value)) {
    throw new Error('DSH_CODEX_SHARED_POOL_DATABASE_URL must not contain surrounding whitespace')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('DSH_CODEX_SHARED_POOL_DATABASE_URL must be a PostgreSQL URL')
  }
  if ((url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') || url.hostname.length === 0) {
    throw new Error('DSH_CODEX_SHARED_POOL_DATABASE_URL must be a PostgreSQL URL')
  }
}

function validateInternalApiKey(value: string): void {
  if (value.length < 16 || value.length > MAX_INTERNAL_KEY_LENGTH || /\s/u.test(value)) {
    throw new Error('DSH_CODEX_SHARED_POOL_CREDENTIAL_BROKER_API_KEY must be 16-4096 non-whitespace characters')
  }
}

function daemonHost(value: string | undefined): string {
  const host = value ?? DEFAULT_HOST
  if (host.length === 0 || host.length > 255 || host !== host.trim() || /[\s/?#@\[\]]/u.test(host)) {
    throw new Error('Team credential broker host is invalid')
  }
  return host
}

function daemonInteger(
  value: string | undefined,
  fallback: number,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback
  if (!/^\d+$/u.test(value)) throw new Error(`Team credential broker ${label} must be an integer`)
  return boundedInteger(Number(value), label, minimum, maximum)
}

function boundedInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Team credential broker ${label} must be between ${minimum} and ${maximum}`)
  }
  return value
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => { server.removeListener('listening', onListening); reject(error) }
    const onListening = () => { server.removeListener('error', onError); resolve() }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

function closeServer(server: Server, graceMs: number): Promise<void> {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => server.closeAllConnections(), graceMs)
    timer.unref()
    server.close(error => {
      clearTimeout(timer)
      if (error === undefined) resolve()
      else reject(error)
    })
    server.closeIdleConnections()
  })
}

async function cleanup(options: TeamCredentialBrokerDaemonOptions): Promise<void> {
  const results = await Promise.allSettled([
    options.broker.dispose(),
    Promise.resolve(options.onClose?.()),
  ])
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map(result => result.reason)
  if (failures.length > 0) throw new AggregateError(failures, 'Team credential broker resource cleanup failed')
}

function tcpAddress(address: AddressInfo, requestedHost: string): Readonly<{ host: string; port: number }> {
  const host = requestedHost === '0.0.0.0' || requestedHost === '::'
    ? address.address
    : requestedHost
  return { host, port: address.port }
}

function urlHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host
}
