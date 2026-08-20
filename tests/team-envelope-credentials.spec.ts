import { DataType, newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import {
  Aes256GcmTeamKeyEncryptionProvider,
  decodeTeamCredentialMasterKey,
  POSTGRES_CREDENTIAL_MUTATION_LOCK_SQL,
  PostgresTeamEnvelopeCredentialBackend,
  TeamKeyEncryptionKeyring,
} from '../src/team/envelope-credentials.ts'
import type {
  TeamKeyEncryptionProvider,
  TeamWrappedKey,
} from '../src/team/envelope-credentials.ts'
import { OPENAI_CODEX_PROVIDER } from '../src/store.ts'
import { PostgresTeamStore } from '../src/team/postgres-store.ts'
import { LocalTeamCredentialBroker } from '../src/team/credentials.ts'

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

const primaryKey = Buffer.alloc(32, 0x31).toString('base64url')
const secondaryKey = Buffer.alloc(32, 0x32).toString('base64url')

function provider(encodedKey = primaryKey): Aes256GcmTeamKeyEncryptionProvider {
  return new Aes256GcmTeamKeyEncryptionProvider(decodeTeamCredentialMasterKey(encodedKey))
}

function opaqueProvider(encodedKey = secondaryKey): TeamKeyEncryptionProvider {
  const delegated = provider(encodedKey)
  const keyId = 'opaque-kms:test'
  return {
    async wrapKey(ref, plaintextKey) {
      const wrapped = await delegated.wrapKey(ref, plaintextKey)
      if (wrapped.nonce === undefined || wrapped.tag === undefined) throw new Error('AES wrapping metadata expected')
      const ciphertext = Buffer.from(JSON.stringify({
        keyId: wrapped.keyId,
        ciphertext: Buffer.from(wrapped.ciphertext).toString('base64url'),
        nonce: Buffer.from(wrapped.nonce).toString('base64url'),
        tag: Buffer.from(wrapped.tag).toString('base64url'),
      }), 'utf8')
      return { keyId, ciphertext }
    },
    async unwrapKey(ref, wrappedKey) {
      if (wrappedKey.keyId !== keyId) throw new Error('key id mismatch')
      const decoded = JSON.parse(Buffer.from(wrappedKey.ciphertext).toString('utf8')) as Record<string, unknown>
      const delegatedKey: TeamWrappedKey = {
        keyId: String(decoded['keyId']),
        ciphertext: Buffer.from(String(decoded['ciphertext']), 'base64url'),
        nonce: Buffer.from(String(decoded['nonce']), 'base64url'),
        tag: Buffer.from(String(decoded['tag']), 'base64url'),
      }
      return delegated.unwrapKey(ref, delegatedKey)
    },
  }
}

async function fixture() {
  const pool = testPool()
  const teamStore = new PostgresTeamStore({ pool })
  await teamStore.initialize()
  const boot = await teamStore.bootstrap('Friends', 'Owner')
  const owner = await teamStore.authenticateApiKey(boot.apiKey)
  if (owner === undefined) throw new Error('owner should authenticate')
  const account = await teamStore.createContributionAccount(owner, 'Owner Codex')
  const backend = new PostgresTeamEnvelopeCredentialBackend({ pool, keyEncryptionProvider: provider() })
  return { pool, teamStore, owner, account, backend }
}

function oauth(accountId: string) {
  return {
    type: 'oauth' as const,
    access: `access-secret-${accountId}`,
    refresh: `refresh-secret-${accountId}`,
    expires: 2_000_000_000_000,
    accountId: `provider-${accountId}`,
  }
}

describe('PostgreSQL Team envelope credential backend', () => {
  it('uses a PostgreSQL row lock for every credential mutation', () => {
    expect(POSTGRES_CREDENTIAL_MUTATION_LOCK_SQL).toMatch(/FOR UPDATE/iu)
  })

  it('stores only ciphertext and returns one secret-free profile summary', async () => {
    const { pool, account, backend } = await fixture()
    const store = backend.open({ teamId: account.teamId, accountId: account.id })
    const credential = oauth('one')

    const summary = await store.addProfile('Owner Codex', credential)
    expect(summary).not.toHaveProperty('credential')
    expect(await store.listProfiles()).toEqual([summary])
    await expect(store.read(OPENAI_CODEX_PROVIDER)).resolves.toEqual(credential)

    const persisted = await pool.query('SELECT * FROM team_contribution_credentials WHERE account_id = $1', [account.id])
    expect(persisted.rows).toHaveLength(1)
    const serialized = JSON.stringify(persisted.rows)
    expect(serialized).not.toMatch(/access-secret|refresh-secret|provider-one|Owner Codex/u)
    expect(persisted.rows[0]).toMatchObject({ envelope_version: 1, team_id: account.teamId, account_id: account.id })
    for (const column of ['wrapped_dek', 'wrapped_dek_nonce', 'wrapped_dek_tag', 'encrypted_document', 'document_nonce', 'document_tag']) {
      expect(persisted.rows[0]?.[column]).toMatch(/^[A-Za-z0-9_-]+$/u)
    }
    await pool.end()
  })

  it('rejects malformed envelope metadata at the database boundary', async () => {
    const { pool, account, backend } = await fixture()
    await backend.open({ teamId: account.teamId, accountId: account.id }).addProfile('Owner', oauth('shape'))

    await expect(pool.query(
      'UPDATE team_contribution_credentials SET document_nonce = $1 WHERE account_id = $2',
      ['short', account.id],
    )).rejects.toThrow()
    await expect(pool.query(
      'UPDATE team_contribution_credentials SET wrapped_dek = $1 WHERE account_id = $2',
      ['', account.id],
    )).rejects.toThrow()
    await pool.end()
  })

  it('uses independent account DEKs and deletes only the selected contribution credential', async () => {
    const { pool, teamStore, owner, account, backend } = await fixture()
    const second = await teamStore.createContributionAccount(owner, 'Second Codex')
    await backend.open({ teamId: account.teamId, accountId: account.id }).addProfile('First', oauth('first'))
    await backend.open({ teamId: second.teamId, accountId: second.id }).addProfile('Second', oauth('second'))

    const rows = await pool.query<{ account_id: string; wrapped_dek: string }>(
      'SELECT account_id, wrapped_dek FROM team_contribution_credentials ORDER BY account_id',
    )
    expect(rows.rows).toHaveLength(2)
    expect(rows.rows[0]?.wrapped_dek).not.toBe(rows.rows[1]?.wrapped_dek)

    await backend.delete({ teamId: account.teamId, accountId: account.id })
    await expect(backend.open({ teamId: account.teamId, accountId: account.id }).listProfiles()).resolves.toEqual([])
    await expect(backend.open({ teamId: second.teamId, accountId: second.id }).read(OPENAI_CODEX_PROVIDER))
      .resolves.toEqual(oauth('second'))
    await pool.end()
  })

  it('atomically persists provider refresh mutations', async () => {
    const { pool, account, backend } = await fixture()
    const store = backend.open({ teamId: account.teamId, accountId: account.id })
    await store.addProfile('Owner', oauth('before'))
    await store.modify(OPENAI_CODEX_PROVIDER, async current => {
      if (current?.type !== 'oauth') throw new Error('OAuth credential expected')
      return { ...current, access: 'rotated-access', refresh: 'rotated-refresh', expires: current.expires + 1 }
    })

    await expect(store.read(OPENAI_CODEX_PROVIDER)).resolves.toMatchObject({
      access: 'rotated-access',
      refresh: 'rotated-refresh',
      expires: 2_000_000_000_001,
    })
    expect(JSON.stringify((await pool.query('SELECT * FROM team_contribution_credentials')).rows))
      .not.toMatch(/rotated-access|rotated-refresh/u)
    await pool.end()
  })

  it('rewraps account DEKs without rewriting encrypted OAuth documents and resumes idempotently', async () => {
    const { pool, teamStore, owner, account, backend } = await fixture()
    const second = await teamStore.createContributionAccount(owner, 'Second Codex')
    await backend.open({ teamId: account.teamId, accountId: account.id }).addProfile('First', oauth('first'))
    await backend.open({ teamId: second.teamId, accountId: second.id }).addProfile('Second', oauth('second'))
    const before = await pool.query(`
      SELECT account_id, key_id, wrapped_dek, wrapped_dek_nonce, wrapped_dek_tag,
             encrypted_document, document_nonce, document_tag
      FROM team_contribution_credentials ORDER BY team_id, account_id
    `)

    const next = provider(secondaryKey)
    const rotating = new PostgresTeamEnvelopeCredentialBackend({
      pool,
      keyEncryptionProvider: new TeamKeyEncryptionKeyring(next, [provider()]),
    })
    await expect(rotating.rewrapCredentialKeys({ batchSize: 1 })).resolves.toEqual({
      scanned: 2,
      rewrapped: 2,
      unchanged: 0,
      missing: 0,
    })

    const after = await pool.query(`
      SELECT account_id, key_id, wrapped_dek, wrapped_dek_nonce, wrapped_dek_tag,
             encrypted_document, document_nonce, document_tag
      FROM team_contribution_credentials ORDER BY team_id, account_id
    `)
    expect(after.rows.map(row => row.key_id)).not.toEqual(before.rows.map(row => row.key_id))
    expect(after.rows.map(row => ({
      account_id: row.account_id,
      encrypted_document: row.encrypted_document,
      document_nonce: row.document_nonce,
      document_tag: row.document_tag,
    }))).toEqual(before.rows.map(row => ({
      account_id: row.account_id,
      encrypted_document: row.encrypted_document,
      document_nonce: row.document_nonce,
      document_tag: row.document_tag,
    })))

    const currentOnly = new PostgresTeamEnvelopeCredentialBackend({ pool, keyEncryptionProvider: next })
    await expect(currentOnly.open({ teamId: account.teamId, accountId: account.id }).read(OPENAI_CODEX_PROVIDER))
      .resolves.toEqual(oauth('first'))
    await expect(currentOnly.open({ teamId: second.teamId, accountId: second.id }).read(OPENAI_CODEX_PROVIDER))
      .resolves.toEqual(oauth('second'))
    await expect(rotating.rewrapCredentialKeys({ batchSize: 1 })).resolves.toEqual({
      scanned: 2,
      rewrapped: 0,
      unchanged: 2,
      missing: 0,
    })
    await pool.end()
  })

  it('supports opaque managed-KMS ciphertext without AES-specific wrapping metadata', async () => {
    const { pool, account, backend } = await fixture()
    await backend.open({ teamId: account.teamId, accountId: account.id }).addProfile('Owner', oauth('opaque'))
    const target = opaqueProvider()
    const rotating = new PostgresTeamEnvelopeCredentialBackend({
      pool,
      keyEncryptionProvider: new TeamKeyEncryptionKeyring(target, [provider()]),
    })

    await expect(rotating.rewrapCredentialKeys()).resolves.toMatchObject({ rewrapped: 1 })
    const persisted = await pool.query<{
      key_id: string
      wrapped_dek: string
      wrapped_dek_nonce: string | null
      wrapped_dek_tag: string | null
    }>('SELECT key_id, wrapped_dek, wrapped_dek_nonce, wrapped_dek_tag FROM team_contribution_credentials')
    expect(persisted.rows[0]).toMatchObject({
      key_id: 'opaque-kms:test',
      wrapped_dek_nonce: null,
      wrapped_dek_tag: null,
    })
    expect(persisted.rows[0]?.wrapped_dek.length).toBeGreaterThan(43)

    const currentOnly = new PostgresTeamEnvelopeCredentialBackend({ pool, keyEncryptionProvider: target })
    await expect(currentOnly.open({ teamId: account.teamId, accountId: account.id }).read(OPENAI_CODEX_PROVIDER))
      .resolves.toEqual(oauth('opaque'))
    await pool.end()
  })

  it('fails closed when the active provider cannot read the replacement wrapping key', async () => {
    const { pool, account, backend } = await fixture()
    await backend.open({ teamId: account.teamId, accountId: account.id }).addProfile('Owner', oauth('before'))
    const before = await pool.query(`
      SELECT key_id, wrapped_dek, wrapped_dek_nonce, wrapped_dek_tag
      FROM team_contribution_credentials WHERE account_id = $1
    `, [account.id])

    await expect(backend.rewrapCredentialKeys({ targetKeyEncryptionProvider: provider(secondaryKey) }))
      .rejects.toThrow(/replacement wrapping key/iu)
    const after = await pool.query(`
      SELECT key_id, wrapped_dek, wrapped_dek_nonce, wrapped_dek_tag
      FROM team_contribution_credentials WHERE account_id = $1
    `, [account.id])
    expect(after.rows).toEqual(before.rows)
    await expect(backend.open({ teamId: account.teamId, accountId: account.id }).read(OPENAI_CODEX_PROVIDER))
      .resolves.toEqual(oauth('before'))
    await pool.end()
  })

  it('runs the OAuth broker and fixed-endpoint forwarding through the encrypted backend', async () => {
    const { pool, account, backend } = await fixture()
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('ok', { status: 200 }))
    const broker = new LocalTeamCredentialBroker({
      storage: backend,
      fetch: fetchMock,
      loginProfile: async (interaction, store) => {
        interaction.notify({
          type: 'device_code',
          verificationUri: 'https://auth.openai.com/codex/device',
          userCode: 'ABCD-EFGH',
          expiresInSeconds: 900,
        })
        return store.addProfile('Owner Codex', oauth('broker'))
      },
    })
    const ref = { teamId: account.teamId, accountId: account.id }

    await expect(broker.startOAuth(ref)).resolves.toMatchObject({ userCode: 'ABCD-EFGH' })
    await vi.waitFor(async () => {
      await expect(broker.inspectAuthorization(ref)).resolves.toEqual({ status: 'active' })
    })
    await expect(broker.forwardResponses(ref, {
      model: 'gpt-5-codex',
      sessionId: 'session-1',
      body: '{"input":"private"}',
      headers: { authorization: 'Bearer member-key' },
    })).resolves.toMatchObject({ status: 200 })
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers)
    expect(headers.get('authorization')).toBe('Bearer access-secret-broker')
    expect(headers.get('chatgpt-account-id')).toBe('provider-broker')
    expect(JSON.stringify((await pool.query('SELECT * FROM team_contribution_credentials')).rows))
      .not.toMatch(/access-secret-broker|refresh-secret-broker|provider-broker/u)
    await broker.revoke(ref)
    await expect(broker.inspectAuthorization(ref)).resolves.toMatchObject({ status: 'reauth_required' })
    await broker.dispose()
    await pool.end()
  })

  it('fails closed for a wrong KEK, swapped tenant context, or tampered ciphertext', async () => {
    const { pool, teamStore, owner, account, backend } = await fixture()
    const second = await teamStore.createContributionAccount(owner, 'Second Codex')
    await backend.open({ teamId: account.teamId, accountId: account.id }).addProfile('First', oauth('first'))
    await backend.open({ teamId: second.teamId, accountId: second.id }).addProfile('Second', oauth('second'))

    const wrongKeyBackend = new PostgresTeamEnvelopeCredentialBackend({ pool, keyEncryptionProvider: provider(secondaryKey) })
    await expect(wrongKeyBackend.open({ teamId: account.teamId, accountId: account.id }).read(OPENAI_CODEX_PROVIDER))
      .rejects.toThrow(/cannot be decrypted/u)

    const firstEnvelope = await pool.query('SELECT * FROM team_contribution_credentials WHERE account_id = $1', [account.id])
    const row = firstEnvelope.rows[0]
    await pool.query(`
      UPDATE team_contribution_credentials
      SET key_id = $1, wrapped_dek = $2, wrapped_dek_nonce = $3, wrapped_dek_tag = $4,
          encrypted_document = $5, document_nonce = $6, document_tag = $7
      WHERE account_id = $8
    `, [row.key_id, row.wrapped_dek, row.wrapped_dek_nonce, row.wrapped_dek_tag,
      row.encrypted_document, row.document_nonce, row.document_tag, second.id])
    await expect(backend.open({ teamId: second.teamId, accountId: second.id }).read(OPENAI_CODEX_PROVIDER))
      .rejects.toThrow(/cannot be decrypted/u)

    const corrupted = Buffer.from(row.encrypted_document, 'base64url')
    corrupted[0] = (corrupted[0] ?? 0) ^ 0xff
    await pool.query('UPDATE team_contribution_credentials SET encrypted_document = $1 WHERE account_id = $2', [corrupted.toString('base64url'), account.id])
    const failure = await backend.open({ teamId: account.teamId, accountId: account.id })
      .read(OPENAI_CODEX_PROVIDER).catch(error => String(error))
    expect(failure).toMatch(/cannot be decrypted/u)
    expect(failure).not.toMatch(/access-secret|refresh-secret|provider-first/u)
    await pool.end()
  })

  it('accepts only an encoded 32-byte master key', () => {
    expect(decodeTeamCredentialMasterKey(primaryKey)).toHaveLength(32)
    expect(() => decodeTeamCredentialMasterKey('not-base64!')).toThrow(/base64/u)
    expect(() => decodeTeamCredentialMasterKey(Buffer.alloc(31).toString('base64url'))).toThrow(/32 bytes/u)
    expect(() => decodeTeamCredentialMasterKey(Buffer.alloc(33).toString('base64'))).toThrow(/32 bytes/u)
  })

  it('wipes local KEKs on disposal and makes the keyring fail closed', async () => {
    const primary = provider(primaryKey)
    const previous = provider(secondaryKey)
    const ring = new TeamKeyEncryptionKeyring(primary, [previous])
    const ref = { teamId: 'team-1', accountId: 'account-1' }
    const plaintext = Buffer.alloc(32, 0x51)
    const wrapped = await ring.wrapKey(ref, plaintext)

    await expect(ring.unwrapKey(ref, wrapped)).resolves.toEqual(plaintext)
    await expect(ring.dispose()).resolves.toBeUndefined()
    await expect(ring.wrapKey(ref, plaintext)).rejects.toThrow(/disposed/iu)
    await expect(ring.unwrapKey(ref, wrapped)).rejects.toThrow(/cannot be decrypted/iu)
    await expect(ring.dispose()).resolves.toBeUndefined()
  })
})
