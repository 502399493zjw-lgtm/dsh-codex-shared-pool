import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { createHash } from 'node:crypto'
import { DataType, newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { MemoryTeamStore } from '../src/team/store.ts'
import {
  POSTGRES_TEAM_MIGRATION_12_LOCK_SQL,
  POSTGRES_TEAM_MIGRATION_20_LOCK_SQL,
  PostgresTeamStore,
} from '../src/team/postgres-store.ts'
import type { TeamCredentialBroker, TeamCredentialRef } from '../src/team/credentials.ts'
import {
  createTeamServiceFromConfig,
  DEFAULT_TEAM_CREDENTIAL_BROKER_API_KEY_REF,
  DEFAULT_TEAM_CREDENTIAL_MASTER_KEY_REF,
  DEFAULT_TEAM_DATABASE_URL_REF,
  DEFAULT_TEAM_INVITE_TOKEN_MASTER_KEY_REF,
} from '../src/team/runtime.ts'
import { TeamConfigSchema } from '../src/team/config.ts'
import { RemoteTeamCredentialBroker } from '../src/team/remote-credentials.ts'
import {
  Aes256GcmTeamKeyEncryptionProvider,
  PostgresTeamEnvelopeCredentialBackend,
} from '../src/team/envelope-credentials.ts'
import { TeamInviteCipher } from '../src/team/invite-cipher.ts'
import {
  Aes256GcmTeamInviteKeyEncryptionProvider,
} from '../src/team/invite-key-encryption.ts'

function testPool(): PgPool {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true })
  memory.public.interceptQueries((query) => {
    const normalized = query.trim()
    return normalized === POSTGRES_TEAM_MIGRATION_12_LOCK_SQL
      || normalized === POSTGRES_TEAM_MIGRATION_20_LOCK_SQL
      ? []
      : null
  })
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
  it('defaults durable invitations to an independent Host-only key reference', () => {
    expect(TeamConfigSchema({})).toMatchObject({
      inviteTokenMasterKeyRef: 'DSH_CODEX_SHARED_POOL_INVITE_MASTER_KEY',
      inviteTokenPreviousMasterKeyRef: '',
      inviteEnvelopeSweepIntervalMs: 6 * 60 * 60 * 1_000,
    })
  })

  it('starts the configured invitation-envelope sweep and stops it on disposal', async () => {
    vi.useFakeTimers()
    const sweep = vi.spyOn(MemoryTeamStore.prototype, 'sweepExpiredInviteEnvelopes').mockResolvedValue(0)
    try {
      const service = await createTeamServiceFromConfig({
        storage: 'memory',
        inviteEnvelopeSweepIntervalMs: 100,
      })
      await Promise.resolve()
      expect(sweep).toHaveBeenCalledOnce()

      await vi.advanceTimersByTimeAsync(100)
      expect(sweep).toHaveBeenCalledTimes(2)

      await service.dispose()
      await vi.advanceTimersByTimeAsync(100)
      expect(sweep).toHaveBeenCalledTimes(2)
    } finally {
      sweep.mockRestore()
      vi.useRealTimers()
    }
  })

  it('keeps memory storage available for local development without resolving a database secret', async () => {
    const resolve = vi.fn()
    const service = await createTeamServiceFromConfig({ storage: 'memory' }, { credentials: { resolve } })
    expect(service.store).toBeInstanceOf(MemoryTeamStore)
    expect(resolve).not.toHaveBeenCalled()
    await service.dispose()
  })

  it('resolves a PostgreSQL connection from the DSH credential seam and initializes it', async () => {
    const pool = testPool()
    let store: PostgresTeamStore | undefined
    const createPostgresStore = vi.fn((_connectionString: string, inviteCipher: TeamInviteCipher) => {
      store = new PostgresTeamStore({ pool, inviteCipher })
      return store
    })
    const resolve = vi.fn(async (ref: CredentialRef) => ({
      value: ref === DEFAULT_TEAM_DATABASE_URL_REF
        ? 'postgres://team-db'
        : Buffer.alloc(32, ref === DEFAULT_TEAM_INVITE_TOKEN_MASTER_KEY_REF ? 8 : 7).toString('base64url'),
      source: `test:${ref}`,
    }))

    const service = await createTeamServiceFromConfig({ storage: 'postgres' }, {
      credentials: { resolve },
      createPostgresStore,
    })

    expect(resolve).toHaveBeenCalledWith(DEFAULT_TEAM_DATABASE_URL_REF)
    expect(resolve).toHaveBeenCalledWith(DEFAULT_TEAM_INVITE_TOKEN_MASTER_KEY_REF)
    expect(resolve).toHaveBeenCalledWith(DEFAULT_TEAM_CREDENTIAL_MASTER_KEY_REF)
    expect(createPostgresStore).toHaveBeenCalledWith('postgres://team-db', expect.any(TeamInviteCipher))
    expect(store).toBeDefined()
    await service.dispose()
    await pool.end()
  })

  it('keeps invitation encryption in the Host when using a remote credential broker', async () => {
    const pool = testPool()
    let store: PostgresTeamStore | undefined
    const brokerKey = 'remote-broker-secret-that-is-long-enough'
    const resolve = vi.fn(async (ref: CredentialRef) => {
      if (ref === DEFAULT_TEAM_DATABASE_URL_REF) return { value: 'postgres://team-db', source: 'test' }
      if (ref === DEFAULT_TEAM_INVITE_TOKEN_MASTER_KEY_REF) {
        return { value: Buffer.alloc(32, 9).toString('base64url'), source: 'test' }
      }
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
      createPostgresStore: (_connectionString, inviteCipher) => {
        store = new PostgresTeamStore({ pool, inviteCipher })
        return store
      },
      fetch: brokerFetch,
    })

    expect(service.broker).toBeInstanceOf(RemoteTeamCredentialBroker)
    await expect(service.broker.readUsage({ teamId: 'team_123', accountId: 'account_456' }))
      .resolves.toEqual({ rateLimits: [] })
    expect(resolve).toHaveBeenCalledWith(DEFAULT_TEAM_INVITE_TOKEN_MASTER_KEY_REF)
    expect(resolve).not.toHaveBeenCalledWith(DEFAULT_TEAM_CREDENTIAL_MASTER_KEY_REF)
    await service.dispose()
    await pool.end()
  })

  it('loads a previous invitation KEK only as a reader', async () => {
    const pool = testPool()
    const store = new PostgresTeamStore({ pool })
    const previousKey = Buffer.alloc(32, 0x41)
    const currentKey = Buffer.alloc(32, 0x42)
    const token = 'dsh_invite_previous-runtime-key'
    const context = {
      teamId: 'team-rotation',
      inviteId: 'invite-rotation',
      createdAt: 123,
      tokenDigest: createHash('sha256').update(token).digest('hex'),
    }
    const previousCipher = new TeamInviteCipher({
      keyEncryptionProvider: new Aes256GcmTeamInviteKeyEncryptionProvider(previousKey),
    })
    const legacyEnvelope = await previousCipher.encrypt(context, token)
    let runtimeCipher: TeamInviteCipher | undefined
    const broker: TeamCredentialBroker = {
      startOAuth: async () => { throw new Error('not used') },
      restartOAuth: async () => { throw new Error('not used') },
      cancelOAuth: async () => undefined,
      inspectAuthorization: async () => ({ status: 'missing' }),
      readUsage: async () => ({ rateLimits: [] }),
      forwardResponses: async () => new Response(null, { status: 204 }),
      revoke: async () => undefined,
      dispose: async () => undefined,
    }
    const resolve = vi.fn(async (ref: CredentialRef) => {
      const name = String(ref)
      if (ref === DEFAULT_TEAM_DATABASE_URL_REF) return { value: 'postgres://team-db', source: 'test' }
      if (name === 'CURRENT_INVITE_KEK') return { value: currentKey.toString('base64url'), source: 'test' }
      if (name === 'PREVIOUS_INVITE_KEK') return { value: previousKey.toString('base64url'), source: 'test' }
      return undefined
    })

    const service = await createTeamServiceFromConfig({
      storage: 'postgres',
      inviteTokenMasterKeyRef: 'CURRENT_INVITE_KEK',
      inviteTokenPreviousMasterKeyRef: 'PREVIOUS_INVITE_KEK',
    }, {
      credentials: { resolve },
      createPostgresStore: (_connectionString, inviteCipher) => {
        runtimeCipher = inviteCipher
        return store
      },
      broker,
    })

    await expect(runtimeCipher?.decrypt(context, legacyEnvelope)).resolves.toBe(token)
    expect(resolve.mock.calls.map(([ref]) => String(ref))).toContain('PREVIOUS_INVITE_KEK')
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
      if (ref === DEFAULT_TEAM_INVITE_TOKEN_MASTER_KEY_REF) {
        return { value: Buffer.alloc(32, 0x33).toString('base64url'), source: 'test' }
      }
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
      credentials: {
        resolve: async ref => ({
          value: ref === DEFAULT_TEAM_DATABASE_URL_REF
            ? 'postgres://team-db'
            : Buffer.alloc(32, 0x51).toString('base64url'),
          source: 'test',
        }),
      },
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
      credentials: {
        resolve: async ref => ({
          value: ref === DEFAULT_TEAM_DATABASE_URL_REF
            ? 'postgres://team-db'
            : Buffer.alloc(32, 0x52).toString('base64url'),
          source: 'test',
        }),
      },
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
    const resolve = vi.fn(async (ref: CredentialRef) => {
      if (ref === DEFAULT_TEAM_DATABASE_URL_REF) return { value: 'postgres://team-db', source: 'test' }
      if (ref === DEFAULT_TEAM_INVITE_TOKEN_MASTER_KEY_REF) {
        return { value: Buffer.alloc(32, 0x61).toString('base64url'), source: 'test' }
      }
      return undefined
    })

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
        resolve: async ref => {
          if (ref === DEFAULT_TEAM_DATABASE_URL_REF) return { value: 'postgres://team-db', source: 'test' }
          if (ref === DEFAULT_TEAM_INVITE_TOKEN_MASTER_KEY_REF) {
            return { value: Buffer.alloc(32, 0x62).toString('base64url'), source: 'test' }
          }
          return { value: malformed, source: 'test' }
        },
      },
      createPostgresStore: () => store,
    }).catch(error => String(error))
    expect(failure).toMatch(/base64/u)
    expect(failure).not.toContain(malformed)
    await pool.end()
  })

  it('fails closed when the Host invitation master key is absent', async () => {
    const resolve = vi.fn(async (ref: CredentialRef) => ref === DEFAULT_TEAM_DATABASE_URL_REF
      ? { value: 'postgres://team-db', source: 'test' }
      : undefined)

    await expect(createTeamServiceFromConfig({ storage: 'postgres' }, {
      credentials: { resolve },
    })).rejects.toThrow(/invitation encryption key.*not configured/u)
  })

  it('rejects malformed invitation key material without echoing it', async () => {
    const malformed = 'invite-secret-that-must-not-appear!'
    const failure = await createTeamServiceFromConfig({ storage: 'postgres' }, {
      credentials: {
        resolve: async ref => ({
          value: ref === DEFAULT_TEAM_DATABASE_URL_REF ? 'postgres://team-db' : malformed,
          source: 'test',
        }),
      },
    }).catch(error => String(error))

    expect(failure).toMatch(/invitation master key.*base64/u)
    expect(failure).not.toContain(malformed)
  })

  it('rejects invitation key references that reuse credential secrets', async () => {
    const resolve = vi.fn()
    await expect(createTeamServiceFromConfig({
      storage: 'postgres',
      inviteTokenMasterKeyRef: 'SHARED_KEY_REF',
      credentialMasterKeyRef: 'SHARED_KEY_REF',
    }, {
      credentials: { resolve },
    })).rejects.toThrow(/invitation.*reference.*must differ/u)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('disposes the loaded invitation provider with the Team service', async () => {
    const pool = testPool()
    const provider = new Aes256GcmTeamInviteKeyEncryptionProvider(Buffer.alloc(32, 0x71))
    const dispose = vi.spyOn(provider, 'dispose')
    const broker: TeamCredentialBroker = {
      startOAuth: async () => { throw new Error('not used') },
      restartOAuth: async () => { throw new Error('not used') },
      cancelOAuth: async () => undefined,
      inspectAuthorization: async () => ({ status: 'missing' }),
      readUsage: async () => ({ rateLimits: [] }),
      forwardResponses: async () => new Response(null, { status: 204 }),
      revoke: async () => undefined,
      dispose: async () => undefined,
    }
    const service = await createTeamServiceFromConfig({ storage: 'postgres' }, {
      credentials: {
        resolve: async ref => ref === DEFAULT_TEAM_DATABASE_URL_REF
          ? { value: 'postgres://team-db', source: 'test' }
          : undefined,
      },
      inviteKeyEncryptionProvider: provider,
      createPostgresStore: (_connectionString, inviteCipher) => new PostgresTeamStore({ pool, inviteCipher }),
      broker,
    })

    await service.dispose()
    await service.dispose()
    expect(dispose).toHaveBeenCalledOnce()
    await pool.end()
  })

  it('disposes the invitation provider when store initialization fails', async () => {
    const provider = new Aes256GcmTeamInviteKeyEncryptionProvider(Buffer.alloc(32, 0x72))
    const dispose = vi.spyOn(provider, 'dispose')
    const store = new MemoryTeamStore() as MemoryTeamStore & { initialize: () => Promise<void> }
    store.initialize = vi.fn(async () => { throw new Error('database initialization failed') })

    await expect(createTeamServiceFromConfig({ storage: 'postgres' }, {
      credentials: {
        resolve: async ref => ref === DEFAULT_TEAM_DATABASE_URL_REF
          ? { value: 'postgres://team-db', source: 'test' }
          : undefined,
      },
      inviteKeyEncryptionProvider: provider,
      createPostgresStore: () => store,
      broker: {
        startOAuth: async () => { throw new Error('not used') },
        restartOAuth: async () => { throw new Error('not used') },
        cancelOAuth: async () => undefined,
        inspectAuthorization: async () => ({ status: 'missing' }),
        readUsage: async () => ({ rateLimits: [] }),
        forwardResponses: async () => new Response(null, { status: 204 }),
        revoke: async () => undefined,
        dispose: async () => undefined,
      },
    })).rejects.toThrow('database initialization failed')
    expect(dispose).toHaveBeenCalledOnce()
  })
})
