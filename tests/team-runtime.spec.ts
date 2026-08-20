import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { DataType, newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { MemoryTeamStore } from '../src/team/store.ts'
import { PostgresTeamStore } from '../src/team/postgres-store.ts'
import type { TeamCredentialBroker, TeamCredentialRef } from '../src/team/credentials.ts'
import {
  createTeamServiceFromConfig,
  DEFAULT_TEAM_CREDENTIAL_BROKER_API_KEY_REF,
  DEFAULT_TEAM_CREDENTIAL_MASTER_KEY_REF,
  DEFAULT_TEAM_DATABASE_URL_REF,
} from '../src/team/runtime.ts'
import { RemoteTeamCredentialBroker } from '../src/team/remote-credentials.ts'
import {
  Aes256GcmTeamKeyEncryptionProvider,
  PostgresTeamEnvelopeCredentialBackend,
} from '../src/team/envelope-credentials.ts'

function testPool(): PgPool {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true })
  memory.public.registerFunction({
    name: 'pg_advisory_xact_lock',
    args: [DataType.integer, DataType.integer],
    returns: DataType.integer,
    implementation: () => 1,
  })
  memory.public.registerFunction({
    name: 'char_length',
    args: [DataType.text],
    returns: DataType.integer,
    implementation: (value: string) => value.length,
  })
  const adapter = memory.adapters.createPg()
  return new adapter.Pool() as unknown as PgPool
}

describe('Team Host runtime', () => {
  it('keeps memory storage available for local development without resolving a database secret', async () => {
    const resolve = vi.fn()
    const service = await createTeamServiceFromConfig({ storage: 'memory' }, { credentials: { resolve } })
    expect(service.store).toBeInstanceOf(MemoryTeamStore)
    expect(resolve).not.toHaveBeenCalled()
    await service.dispose()
  })

  it('resolves a PostgreSQL connection from the DSH credential seam and initializes it', async () => {
    const pool = testPool()
    const store = new PostgresTeamStore({ pool })
    const initialize = vi.spyOn(store, 'initialize')
    const createPostgresStore = vi.fn(() => store)
    const resolve = vi.fn(async (ref: CredentialRef) => ({
      value: ref === DEFAULT_TEAM_DATABASE_URL_REF
        ? 'postgres://team-db'
        : Buffer.alloc(32, 7).toString('base64url'),
      source: `test:${ref}`,
    }))

    const service = await createTeamServiceFromConfig({ storage: 'postgres' }, {
      credentials: { resolve },
      createPostgresStore,
    })

    expect(resolve).toHaveBeenCalledWith(DEFAULT_TEAM_DATABASE_URL_REF)
    expect(resolve).toHaveBeenCalledWith(DEFAULT_TEAM_CREDENTIAL_MASTER_KEY_REF)
    expect(createPostgresStore).toHaveBeenCalledWith('postgres://team-db')
    expect(initialize).toHaveBeenCalled()
    await service.dispose()
    await pool.end()
  })

  it('uses a remote credential broker without resolving the credential encryption master key', async () => {
    const pool = testPool()
    const store = new PostgresTeamStore({ pool })
    const brokerKey = 'remote-broker-secret-that-is-long-enough'
    const resolve = vi.fn(async (ref: CredentialRef) => {
      if (ref === DEFAULT_TEAM_DATABASE_URL_REF) return { value: 'postgres://team-db', source: 'test' }
      if (ref === DEFAULT_TEAM_CREDENTIAL_BROKER_API_KEY_REF) return { value: brokerKey, source: 'test' }
      throw new Error(`unexpected credential lookup: ${String(ref)}`)
    })
    const brokerFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://broker.example.test/v1/dsh-team-credential-broker/usage')
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${brokerKey}`)
      return Response.json({ rateLimits: [] })
    }) as unknown as typeof fetch

    const service = await createTeamServiceFromConfig({
      storage: 'postgres',
      credentialBroker: 'remote',
      credentialBrokerBaseUrl: 'https://broker.example.test/v1/dsh-team-credential-broker',
    }, {
      credentials: { resolve },
      createPostgresStore: () => store,
      fetch: brokerFetch,
    })

    expect(service.broker).toBeInstanceOf(RemoteTeamCredentialBroker)
    await expect(service.broker.readUsage({ teamId: 'team_123', accountId: 'account_456' }))
      .resolves.toEqual({ rateLimits: [] })
    expect(resolve).not.toHaveBeenCalledWith(DEFAULT_TEAM_CREDENTIAL_MASTER_KEY_REF)
    await service.dispose()
    await pool.end()
  })

  it('keeps legacy envelopes readable through a configured previous master-key reference', async () => {
    const pool = testPool()
    const store = new PostgresTeamStore({ pool })
    await store.initialize()
    const boot = await store.bootstrap('Rotation Team', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner should authenticate')
    const account = await store.createContributionAccount(owner, 'Owner Codex')
    const previousKey = Buffer.alloc(32, 0x31)
    const currentKey = Buffer.alloc(32, 0x32)
    const legacyBackend = new PostgresTeamEnvelopeCredentialBackend({
      pool,
      keyEncryptionProvider: new Aes256GcmTeamKeyEncryptionProvider(previousKey),
    })
    await legacyBackend.open({ teamId: account.teamId, accountId: account.id }).addProfile('Owner Codex', {
      type: 'oauth', access: 'legacy-access', refresh: 'legacy-refresh', expires: Date.now() + 60_000, accountId: 'provider-account',
    })

    const resolve = vi.fn(async (ref: CredentialRef) => {
      const name = String(ref)
      if (ref === DEFAULT_TEAM_DATABASE_URL_REF) return { value: 'postgres://team-db', source: 'test' }
      if (name === 'CURRENT_TEAM_KEK') return { value: currentKey.toString('base64url'), source: 'test' }
      if (name === 'PREVIOUS_TEAM_KEK') return { value: previousKey.toString('base64url'), source: 'test' }
      return undefined
    })
    const service = await createTeamServiceFromConfig({
      storage: 'postgres',
      credentialMasterKeyRef: 'CURRENT_TEAM_KEK',
      credentialPreviousMasterKeyRef: 'PREVIOUS_TEAM_KEK',
    }, {
      credentials: { resolve },
      createPostgresStore: () => store,
    })

    await expect(service.broker.inspectAuthorization({ teamId: account.teamId, accountId: account.id }))
      .resolves.toEqual({ status: 'active' })
    await expect(store.listContributionAccounts(owner)).resolves.toMatchObject([{ id: account.id, status: 'active' }])
    expect(resolve.mock.calls.map(([ref]) => String(ref))).toContain('PREVIOUS_TEAM_KEK')
    await service.dispose()
    await pool.end()
  })

  it('reconciles interrupted OAuth before returning a durable Team runtime', async () => {
    const store = new MemoryTeamStore() as MemoryTeamStore & { initialize: () => Promise<void> }
    store.initialize = vi.fn(async () => undefined)
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const contribution = await store.createContributionAccount(owner, 'Owner Codex')
    const inspectAuthorization = vi.fn(async (_ref: TeamCredentialRef) => ({ status: 'active' as const }))
    const broker: TeamCredentialBroker = {
      startOAuth: async () => { throw new Error('not used') },
      restartOAuth: async () => { throw new Error('not used') },
      cancelOAuth: async () => undefined,
      inspectAuthorization,
      readUsage: async () => ({ rateLimits: [] }),
      forwardResponses: async () => new Response(null, { status: 204 }),
      revoke: async () => undefined,
      dispose: async () => undefined,
    }

    const service = await createTeamServiceFromConfig({ storage: 'postgres' }, {
      credentials: { resolve: async () => ({ value: 'postgres://team-db', source: 'test' }) },
      createPostgresStore: () => store,
      broker,
    })

    expect(inspectAuthorization).toHaveBeenCalledWith({ teamId: owner.teamId, accountId: contribution.id })
    await expect(store.listContributionAccounts(owner))
      .resolves.toMatchObject([{ id: contribution.id, status: 'active' }])
    await service.dispose()
  })

  it('retries persisted revoked-credential cleanup before returning a Team runtime', async () => {
    const store = new MemoryTeamStore() as MemoryTeamStore & { initialize: () => Promise<void> }
    store.initialize = vi.fn(async () => undefined)
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner should authenticate')
    const contribution = await store.createContributionAccount(owner, 'Owner Codex')
    await store.revokeContributionAccount(owner, contribution.id)
    const revoke = vi.fn(async (_ref: TeamCredentialRef) => undefined)
    const broker: TeamCredentialBroker = {
      startOAuth: async () => { throw new Error('not used') },
      restartOAuth: async () => { throw new Error('not used') },
      cancelOAuth: async () => undefined,
      inspectAuthorization: async () => { throw new Error('revoked credentials must not be inspected') },
      readUsage: async () => ({ rateLimits: [] }),
      forwardResponses: async () => new Response(null, { status: 204 }),
      revoke,
      dispose: async () => undefined,
    }

    const service = await createTeamServiceFromConfig({ storage: 'postgres' }, {
      credentials: { resolve: async () => ({ value: 'postgres://team-db', source: 'test' }) },
      createPostgresStore: () => store,
      broker,
    })

    expect(revoke).toHaveBeenCalledWith({ teamId: owner.teamId, accountId: contribution.id })
    await service.dispose()
  })

  it('fails closed when PostgreSQL is selected without a configured credential', async () => {
    await expect(createTeamServiceFromConfig({
      storage: 'postgres',
      databaseUrlRef: 'CUSTOM_TEAM_DATABASE_URL',
    }, {
      credentials: { resolve: async () => undefined },
    })).rejects.toThrow(/CUSTOM_TEAM_DATABASE_URL.*not configured/u)
  })

  it('fails closed when PostgreSQL credential encryption has no valid master key', async () => {
    const pool = testPool()
    const store = new PostgresTeamStore({ pool })
    const dispose = vi.spyOn(store, 'dispose')
    const resolve = vi.fn(async (ref: CredentialRef) => ref === DEFAULT_TEAM_DATABASE_URL_REF
      ? { value: 'postgres://team-db', source: 'test' }
      : undefined)

    await expect(createTeamServiceFromConfig({ storage: 'postgres' }, {
      credentials: { resolve },
      createPostgresStore: () => store,
    })).rejects.toThrow(/encryption key.*not configured/u)
    expect(dispose).toHaveBeenCalledOnce()
    await pool.end()
  })

  it('rejects a malformed PostgreSQL credential encryption key without echoing it', async () => {
    const pool = testPool()
    const store = new PostgresTeamStore({ pool })
    const malformed = 'not-a-valid-secret!'

    const failure = await createTeamServiceFromConfig({ storage: 'postgres' }, {
      credentials: {
        resolve: async ref => ({
          value: ref === DEFAULT_TEAM_DATABASE_URL_REF ? 'postgres://team-db' : malformed,
          source: 'test',
        }),
      },
      createPostgresStore: () => store,
    }).catch(error => String(error))
    expect(failure).toMatch(/base64/u)
    expect(failure).not.toContain(malformed)
    await pool.end()
  })
})
