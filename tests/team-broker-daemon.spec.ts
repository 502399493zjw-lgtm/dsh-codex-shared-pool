import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { TeamCredentialBroker } from '../src/team/credentials.ts'
import {
  loadTeamCredentialBrokerEnvironment,
  startTeamCredentialBrokerDaemon,
  TEAM_CREDENTIAL_BROKER_HEALTH_PATH,
  verifyTeamCredentialBrokerDatabase,
} from '../src/team/broker-daemon.ts'
import { RemoteTeamCredentialBroker } from '../src/team/remote-credentials.ts'

const INTERNAL_KEY = 'broker-secret-that-is-long-enough'

describe('Team credential broker daemon', () => {
  it('loads bounded secrets from files without putting them in command arguments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-team-broker-config-'))
    const databaseUrl = 'postgresql://broker:database-password@db.internal/team_pool'
    const masterKey = Buffer.alloc(32, 0x41).toString('base64url')
    try {
      await Promise.all([
        writeFile(join(root, 'database-url'), `${databaseUrl}\n`, { mode: 0o600 }),
        writeFile(join(root, 'master-key'), `${masterKey}\n`, { mode: 0o600 }),
        writeFile(join(root, 'api-key'), `${INTERNAL_KEY}\n`, { mode: 0o600 }),
      ])

      const config = await loadTeamCredentialBrokerEnvironment({
        DSH_CODEX_SHARED_POOL_DATABASE_URL_FILE: join(root, 'database-url'),
        DSH_CODEX_SHARED_POOL_CREDENTIAL_MASTER_KEY_FILE: join(root, 'master-key'),
        DSH_CODEX_SHARED_POOL_CREDENTIAL_BROKER_API_KEY_FILE: join(root, 'api-key'),
        DSH_CODEX_TEAM_BROKER_HOST: '127.0.0.1',
        DSH_CODEX_TEAM_BROKER_PORT: '0',
        DSH_CODEX_TEAM_BROKER_SHUTDOWN_GRACE_MS: '2500',
      })

      expect(config).toMatchObject({
        databaseUrl,
        apiKey: INTERNAL_KEY,
        host: '127.0.0.1',
        port: 0,
        shutdownGraceMs: 2500,
      })
      expect(config.masterKey).toEqual(Buffer.alloc(32, 0x41))
      expect(config.previousMasterKey).toBeUndefined()
      config.masterKey.fill(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects ambiguous or invalid secret configuration without echoing values', async () => {
    const directSecret = 'broker-direct-secret-that-must-not-leak'
    const error = await loadTeamCredentialBrokerEnvironment({
      DSH_CODEX_SHARED_POOL_DATABASE_URL: 'postgresql://broker@localhost/team_pool',
      DSH_CODEX_SHARED_POOL_CREDENTIAL_MASTER_KEY: Buffer.alloc(32).toString('base64url'),
      DSH_CODEX_SHARED_POOL_CREDENTIAL_BROKER_API_KEY: directSecret,
      DSH_CODEX_SHARED_POOL_CREDENTIAL_BROKER_API_KEY_FILE: '/run/secrets/broker-api-key',
    }).catch(reason => String(reason))

    expect(error).toMatch(/API_KEY.*API_KEY_FILE|both/iu)
    expect(error).not.toContain(directSecret)
  })

  it('checks the migrated credential table shape and runtime role privileges', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ table_oid: 1234, allowed: true }] })
      .mockResolvedValueOnce({ rows: [] })

    await expect(verifyTeamCredentialBrokerDatabase({ query })).resolves.toBeUndefined()
    expect(query).toHaveBeenCalledTimes(2)
    expect(String(query.mock.calls[0]?.[0])).toMatch(/has_table_privilege|team_contribution_credentials/iu)
    expect(String(query.mock.calls[1]?.[0])).toMatch(/SELECT\s+team_id.*account_id.*envelope_version/is)

    await expect(verifyTeamCredentialBrokerDatabase({
      query: vi.fn(async () => ({ rows: [{ table_oid: 1234, allowed: false }] })),
    })).rejects.toThrow(/database role.*privilege/iu)
    await expect(verifyTeamCredentialBrokerDatabase({
      query: vi.fn(async () => ({ rows: [] })),
    })).rejects.toThrow(/migration|credential table/iu)
  })

  it('serves health and fixed authenticated capabilities, then shuts down once', async () => {
    const broker = fakeBroker()
    const verifyReady = vi.fn(async () => undefined)
    const onClose = vi.fn(async () => undefined)
    const daemon = await startTeamCredentialBrokerDaemon({
      broker,
      resolveApiKey: async () => INTERNAL_KEY,
      host: '127.0.0.1',
      port: 0,
      shutdownGraceMs: 1_000,
      verifyReady,
      onClose,
    })

    expect(verifyReady).toHaveBeenCalledTimes(1)
    const health = await fetch(`${daemon.origin}${TEAM_CREDENTIAL_BROKER_HEALTH_PATH}`)
    expect(health.status).toBe(200)
    expect(health.headers.get('cache-control')).toBe('no-store')
    await expect(health.json()).resolves.toEqual({ status: 'ok' })

    const remote = new RemoteTeamCredentialBroker({
      baseUrl: daemon.brokerBaseUrl,
      resolveApiKey: async () => INTERNAL_KEY,
    })
    await expect(remote.readUsage({ teamId: 'team_1', accountId: 'account_1' })).resolves.toEqual({
      rateLimits: [{ id: 'codex', windows: [{ remainingPercent: 75, windowSeconds: 18_000 }] }],
    })
    await remote.dispose()

    await expect(Promise.all([daemon.dispose(), daemon.dispose()])).resolves.toEqual([undefined, undefined])
    expect(broker.dispose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
    await expect(fetch(`${daemon.origin}${TEAM_CREDENTIAL_BROKER_HEALTH_PATH}`)).rejects.toThrow()
  })
})

function fakeBroker(): TeamCredentialBroker & { dispose: ReturnType<typeof vi.fn> } {
  return {
    startOAuth: vi.fn(async () => { throw new Error('not used') }),
    restartOAuth: vi.fn(async () => { throw new Error('not used') }),
    cancelOAuth: vi.fn(async () => undefined),
    inspectAuthorization: vi.fn(async () => ({ status: 'active' as const })),
    readUsage: vi.fn(async () => ({
      rateLimits: [{ id: 'codex', windows: [{ remainingPercent: 75, windowSeconds: 18_000 }] }],
    })),
    forwardResponses: vi.fn(async () => new Response(null, { status: 204 })),
    revoke: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  }
}
