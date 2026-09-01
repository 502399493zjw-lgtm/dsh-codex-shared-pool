/** Shared, envelope-encrypted Host credential storage for PostgreSQL Team runtimes. */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto'
import type { Credential, CredentialInfo, OAuthCredential } from '@earendil-works/pi-ai'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import {
  OPENAI_CODEX_PROVIDER,
  openAICodexAccountName,
} from '../store.ts'
import type { CodexProfileSummary, OpenAICodexProfileStore } from '../store.ts'
import type { TeamCredentialRef, TeamCredentialStoreBackend } from './credentials.ts'

const ENVELOPE_VERSION = 1
const DOCUMENT_VERSION = 1
const AES_KEY_BYTES = 32
const GCM_NONCE_BYTES = 12
const GCM_TAG_BYTES = 16
const MAX_WRAPPED_KEY_BYTES = 196_608
const MAX_WRAPPED_KEY_METADATA_BYTES = 49_152

/** Public so tests can assert SQL shape without overstating pg-mem lock semantics. */
export const POSTGRES_CREDENTIAL_SCOPE_MUTATION_LOCK_SQL = `
  SELECT team_lock_credential_scope($1, $2) AS allowed
`

const POSTGRES_CREDENTIAL_TEAM_MUTATION_LOCK_SQL = `
  SELECT status FROM teams
  WHERE id = $1
  FOR UPDATE
`

const POSTGRES_CREDENTIAL_CONTRIBUTION_MUTATION_LOCK_SQL = `
  SELECT status FROM team_contributions
  WHERE team_id = $1 AND id = $2
  FOR UPDATE
`

export const POSTGRES_CREDENTIAL_MUTATION_LOCK_SQL = `
  SELECT * FROM team_contribution_credentials
  WHERE team_id = $1 AND account_id = $2
  FOR UPDATE
`

export interface TeamWrappedKey {
  readonly keyId: string
  readonly ciphertext: Uint8Array
  /** Optional provider-owned metadata. Managed KMS ciphertexts are commonly opaque. */
  readonly nonce?: Uint8Array
  readonly tag?: Uint8Array
}

/**
 * KMS/KEK boundary. A managed KMS adapter can implement this interface without
 * gaining access to the encrypted OAuth document or changing the broker API.
 */
export interface TeamKeyEncryptionProvider {
  wrapKey(ref: TeamCredentialRef, plaintextKey: Uint8Array): Promise<TeamWrappedKey>
  unwrapKey(ref: TeamCredentialRef, wrappedKey: TeamWrappedKey): Promise<Uint8Array>
  /** Best-effort lifecycle hook for providers holding local key bytes. */
  dispose?(): Promise<void> | void
}

/**
 * Rotation helper that writes with the primary provider and can still read
 * legacy envelopes. Keep every live Host on the same readable keyring until
 * an online rewrap has completed and been verified.
 */
export class TeamKeyEncryptionKeyring implements TeamKeyEncryptionProvider {
  private readonly readers: readonly TeamKeyEncryptionProvider[]
  private disposed = false
  private disposal: Promise<void> | undefined

  constructor(
    private readonly primary: TeamKeyEncryptionProvider,
    fallbackReaders: readonly TeamKeyEncryptionProvider[] = [],
  ) {
    this.readers = [primary, ...fallbackReaders]
  }

  wrapKey(ref: TeamCredentialRef, plaintextKey: Uint8Array): Promise<TeamWrappedKey> {
    if (this.disposed) return Promise.reject(new Error('Team credential encryption keyring is disposed'))
    return this.primary.wrapKey(ref, plaintextKey)
  }

  async unwrapKey(ref: TeamCredentialRef, wrappedKey: TeamWrappedKey): Promise<Uint8Array> {
    if (this.disposed) throw credentialDecryptionError()
    for (const provider of this.readers) {
      try {
        return await provider.unwrapKey(ref, wrappedKey)
      } catch {
        // A legacy reader may own this key id. Never expose provider errors.
      }
    }
    throw credentialDecryptionError()
  }

  dispose(): Promise<void> {
    this.disposed = true
    this.disposal ??= disposeKeyEncryptionProviders(this.readers)
    return this.disposal
  }
}

async function disposeKeyEncryptionProviders(providers: readonly TeamKeyEncryptionProvider[]): Promise<void> {
  const unique = [...new Set(providers)]
  const results = await Promise.allSettled(unique.map(provider => Promise.resolve(provider.dispose?.())))
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map(result => result.reason)
  if (failures.length > 0) throw new AggregateError(failures, 'Team credential encryption key cleanup failed')
}

/** Decode a base64/base64url 256-bit KEK without accepting ambiguous text. */
export function decodeTeamCredentialMasterKey(encoded: string): Buffer {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/u.test(encoded)) {
    throw new Error('Team credential master key must be valid base64 or base64url')
  }
  const decoded = Buffer.from(encoded, 'base64url')
  if (decoded.length !== AES_KEY_BYTES) throw new Error('Team credential master key must decode to exactly 32 bytes')
  return decoded
}

/** Portable development/self-hosted KEK adapter; production may inject managed KMS instead. */
export class Aes256GcmTeamKeyEncryptionProvider implements TeamKeyEncryptionProvider {
  private readonly key: Buffer
  private readonly keyId: string
  private disposed = false

  constructor(key: Uint8Array) {
    if (key.byteLength !== AES_KEY_BYTES) throw new Error('Team credential encryption key must be exactly 32 bytes')
    this.key = Buffer.from(key)
    this.keyId = `aes256gcm:${createHash('sha256').update(this.key).digest('base64url').slice(0, 22)}`
  }

  async wrapKey(ref: TeamCredentialRef, plaintextKey: Uint8Array): Promise<TeamWrappedKey> {
    if (this.disposed) throw new Error('Team credential encryption provider is disposed')
    if (plaintextKey.byteLength !== AES_KEY_BYTES) throw new Error('Team credential DEK must be exactly 32 bytes')
    const nonce = randomBytes(GCM_NONCE_BYTES)
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce, { authTagLength: GCM_TAG_BYTES })
    cipher.setAAD(envelopeAad('wrapped-dek', ref))
    const ciphertext = Buffer.concat([cipher.update(plaintextKey), cipher.final()])
    return { keyId: this.keyId, ciphertext, nonce, tag: cipher.getAuthTag() }
  }

  async unwrapKey(ref: TeamCredentialRef, wrappedKey: TeamWrappedKey): Promise<Uint8Array> {
    try {
      if (this.disposed) throw new Error('provider disposed')
      if (wrappedKey.keyId !== this.keyId) throw new Error('key id mismatch')
      const nonce = sizedBytes(wrappedKey.nonce, GCM_NONCE_BYTES)
      const tag = sizedBytes(wrappedKey.tag, GCM_TAG_BYTES)
      const decipher = createDecipheriv('aes-256-gcm', this.key, nonce, { authTagLength: GCM_TAG_BYTES })
      decipher.setAAD(envelopeAad('wrapped-dek', ref))
      decipher.setAuthTag(tag)
      const plaintext = Buffer.concat([decipher.update(wrappedKey.ciphertext), decipher.final()])
      if (plaintext.length !== AES_KEY_BYTES) {
        plaintext.fill(0)
        throw new Error('invalid DEK length')
      }
      return plaintext
    } catch {
      throw credentialDecryptionError()
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.key.fill(0)
  }
}

export interface PostgresTeamEnvelopeCredentialBackendOptions {
  readonly pool: Pool
  readonly keyEncryptionProvider: TeamKeyEncryptionProvider
  /** Standalone Broker roles lock lifecycle rows through the restricted database capability. */
  readonly credentialScopeLock?: 'control-tables' | 'restricted-function'
  readonly now?: () => number
  readonly id?: () => string
}

export interface TeamCredentialKeyRewrapOptions {
  /** Defaults to the backend's active provider, such as a primary-first keyring. */
  readonly targetKeyEncryptionProvider?: TeamKeyEncryptionProvider
  /** Metadata identities loaded per page; each credential row commits separately. */
  readonly batchSize?: number
  /** Rewrap even when the target returns the same key id. */
  readonly force?: boolean
}

export interface TeamCredentialKeyRewrapResult {
  readonly scanned: number
  readonly rewrapped: number
  readonly unchanged: number
  readonly missing: number
}

type CredentialKeyRewrapOutcome = 'rewrapped' | 'unchanged' | 'missing'

/** One shared encrypted row per contribution, usable by every Host replica. */
export class PostgresTeamEnvelopeCredentialBackend implements TeamCredentialStoreBackend {
  private readonly now: () => number
  private readonly id: () => string

  constructor(private readonly options: PostgresTeamEnvelopeCredentialBackendOptions) {
    this.now = options.now ?? Date.now
    this.id = options.id ?? randomUUID
  }

  open(ref: TeamCredentialRef): OpenAICodexProfileStore {
    return new PostgresTeamEnvelopeProfileStore(this, validatedRef(ref))
  }

  async delete(ref: TeamCredentialRef): Promise<void> {
    const safeRef = validatedRef(ref)
    await this.options.pool.query(
      'DELETE FROM team_contribution_credentials WHERE team_id = $1 AND account_id = $2',
      [safeRef.teamId, safeRef.accountId],
    )
  }

  async dispose(): Promise<void> {
    await this.options.keyEncryptionProvider.dispose?.()
  }

  /**
   * Rewrap every currently-enumerated account DEK without decrypting or
   * rewriting its OAuth document. The active provider must be able to read
   * both old and replacement envelopes so live replicas fail closed during a
   * coordinated online rotation.
   */
  async rewrapCredentialKeys(
    options: TeamCredentialKeyRewrapOptions = {},
  ): Promise<TeamCredentialKeyRewrapResult> {
    const batchSize = rewrapBatchSize(options.batchSize)
    const target = options.targetKeyEncryptionProvider ?? this.options.keyEncryptionProvider
    const totals = { scanned: 0, rewrapped: 0, unchanged: 0, missing: 0 }
    let cursor: CredentialEnvelopeIdentity | undefined

    while (true) {
      const page = cursor === undefined
        ? await this.options.pool.query<CredentialEnvelopeIdentity>(`
            SELECT credential.team_id, credential.account_id
            FROM team_contribution_credentials AS credential
            INNER JOIN teams AS team ON team.id = credential.team_id
            INNER JOIN team_contributions AS contribution
              ON contribution.team_id = credential.team_id AND contribution.id = credential.account_id
            WHERE team.status IN ('active', 'paused') AND contribution.status <> 'revoked'
            ORDER BY credential.team_id, credential.account_id LIMIT $1
          `, [batchSize])
        : await this.options.pool.query<CredentialEnvelopeIdentity>(`
            SELECT credential.team_id, credential.account_id
            FROM team_contribution_credentials AS credential
            INNER JOIN teams AS team ON team.id = credential.team_id
            INNER JOIN team_contributions AS contribution
              ON contribution.team_id = credential.team_id AND contribution.id = credential.account_id
            WHERE team.status IN ('active', 'paused') AND contribution.status <> 'revoked'
              AND (credential.team_id > $1 OR (credential.team_id = $1 AND credential.account_id > $2))
            ORDER BY credential.team_id, credential.account_id LIMIT $3
          `, [cursor.team_id, cursor.account_id, batchSize])
      if (page.rows.length === 0) break

      for (const identity of page.rows) {
        const ref = validatedRef({ teamId: identity.team_id, accountId: identity.account_id })
        const outcome = await this.rewrapCredentialKey(ref, target, options.force === true)
        totals.scanned += 1
        totals[outcome] += 1
      }
      cursor = page.rows.at(-1)
    }

    return totals
  }

  async readDocument(ref: TeamCredentialRef): Promise<CredentialDocument> {
    const safeRef = validatedRef(ref)
    const result = await this.options.pool.query<CredentialEnvelopeRow>(`
      SELECT credential.*
      FROM team_contribution_credentials AS credential
      INNER JOIN teams AS team ON team.id = credential.team_id
      INNER JOIN team_contributions AS contribution
        ON contribution.team_id = credential.team_id AND contribution.id = credential.account_id
      WHERE credential.team_id = $1 AND credential.account_id = $2
        AND team.status IN ('active', 'paused')
        AND contribution.status <> 'revoked'
    `, [safeRef.teamId, safeRef.accountId])
    const row = result.rows[0]
    if (row === undefined) return emptyDocument()
    const opened = await this.decryptRow(safeRef, row)
    try {
      return opened.document
    } finally {
      opened.dek.fill(0)
    }
  }

  async mutate<T>(
    ref: TeamCredentialRef,
    transform: (document: CredentialDocument) => Promise<MutationResult<T>> | MutationResult<T>,
  ): Promise<T> {
    const safeRef = validatedRef(ref)
    const client = await this.options.pool.connect()
    let dek: Buffer | undefined
    try {
      await client.query('BEGIN')
      await this.lockWritableCredentialScope(client, safeRef)
      const selected = await client.query<CredentialEnvelopeRow>(POSTGRES_CREDENTIAL_MUTATION_LOCK_SQL, [safeRef.teamId, safeRef.accountId])
      const row = selected.rows[0]
      const opened: { document: CredentialDocument; dek?: Buffer } = row === undefined
        ? { document: emptyDocument() }
        : await this.decryptRow(safeRef, row)
      dek = opened.dek
      const mutation = await transform(opened.document)
      if (mutation.changed) {
        const validated = parseDocument(opened.document)
        if (dek === undefined) dek = randomBytes(AES_KEY_BYTES)
        await this.writeEnvelope(client, safeRef, row, validated, dek)
      }
      await client.query('COMMIT')
      return mutation.value
    } catch (error: unknown) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      dek?.fill(0)
      client.release()
    }
  }

  private async decryptRow(
    ref: TeamCredentialRef,
    row: CredentialEnvelopeRow,
  ): Promise<{ document: CredentialDocument; dek: Buffer }> {
    let dek: Buffer | undefined
    let plaintext: Buffer | undefined
    try {
      if (Number(row.envelope_version) !== ENVELOPE_VERSION) throw new Error('unsupported envelope version')
      dek = await unwrapOwnedKey(this.options.keyEncryptionProvider, ref, wrappedKeyFromRow(row))
      if (dek.length !== AES_KEY_BYTES) throw new Error('invalid DEK length')
      const decipher = createDecipheriv('aes-256-gcm', dek, sizedEncodedBytes(row.document_nonce, GCM_NONCE_BYTES), {
        authTagLength: GCM_TAG_BYTES,
      })
      decipher.setAAD(envelopeAad('document', ref))
      decipher.setAuthTag(sizedEncodedBytes(row.document_tag, GCM_TAG_BYTES))
      plaintext = Buffer.concat([decipher.update(encodedBytes(row.encrypted_document)), decipher.final()])
      const document = parseDocument(JSON.parse(plaintext.toString('utf8')))
      return { document, dek }
    } catch {
      dek?.fill(0)
      throw credentialDecryptionError()
    } finally {
      plaintext?.fill(0)
    }
  }

  private async rewrapCredentialKey(
    ref: TeamCredentialRef,
    target: TeamKeyEncryptionProvider,
    force: boolean,
  ): Promise<CredentialKeyRewrapOutcome> {
    const client = await this.options.pool.connect()
    let dek: Buffer | undefined
    let verification: Buffer | undefined
    try {
      await client.query('BEGIN')
      await this.lockWritableCredentialScope(client, ref)
      const selected = await client.query<CredentialEnvelopeRow>(
        POSTGRES_CREDENTIAL_MUTATION_LOCK_SQL,
        [ref.teamId, ref.accountId],
      )
      const row = selected.rows[0]
      if (row === undefined) {
        await client.query('COMMIT')
        return 'missing'
      }

      const existing = wrappedKeyFromRow(row)
      dek = await unwrapOwnedKey(this.options.keyEncryptionProvider, ref, existing)
      if (dek.length !== AES_KEY_BYTES) throw credentialDecryptionError()
      const replacement = validatedWrappedKey(await target.wrapKey(ref, dek))
      if (!force && replacement.keyId === existing.keyId) {
        await client.query('COMMIT')
        return 'unchanged'
      }

      try {
        verification = await unwrapOwnedKey(this.options.keyEncryptionProvider, ref, replacement)
      } catch {
        throw replacementKeyError()
      }
      if (verification.length !== AES_KEY_BYTES || !timingSafeEqual(dek, verification)) {
        throw replacementKeyError()
      }

      const updated = await client.query(`
        UPDATE team_contribution_credentials SET
          key_id = $3, wrapped_dek = $4, wrapped_dek_nonce = $5,
          wrapped_dek_tag = $6, updated_at = $7
        WHERE team_id = $1 AND account_id = $2
      `, [ref.teamId, ref.accountId, replacement.keyId, encodeBytes(replacement.ciphertext),
        encodeOptionalBytes(replacement.nonce), encodeOptionalBytes(replacement.tag), this.now()])
      if (updated.rowCount !== 1) throw new Error('Team credential envelope identity conflict')
      await client.query('COMMIT')
      return 'rewrapped'
    } catch (error: unknown) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      dek?.fill(0)
      verification?.fill(0)
      client.release()
    }
  }

  private async writeEnvelope(
    client: PoolClient,
    ref: TeamCredentialRef,
    existing: CredentialEnvelopeRow | undefined,
    document: CredentialDocument,
    dek: Buffer,
  ): Promise<void> {
    const nonce = randomBytes(GCM_NONCE_BYTES)
    const plaintext = Buffer.from(JSON.stringify(document), 'utf8')
    try {
      const cipher = createCipheriv('aes-256-gcm', dek, nonce, { authTagLength: GCM_TAG_BYTES })
      cipher.setAAD(envelopeAad('document', ref))
      const encryptedDocument = Buffer.concat([cipher.update(plaintext), cipher.final()])
      const documentTag = cipher.getAuthTag()
      const wrapped = existing === undefined
        ? validatedWrappedKey(await this.options.keyEncryptionProvider.wrapKey(ref, dek))
        : wrappedKeyFromRow(existing)
      const values = [ref.accountId, ref.teamId, ENVELOPE_VERSION, wrapped.keyId, encodeBytes(wrapped.ciphertext),
        encodeOptionalBytes(wrapped.nonce), encodeOptionalBytes(wrapped.tag), encodeBytes(encryptedDocument),
        encodeBytes(nonce), encodeBytes(documentTag), this.now()]
      const written = existing === undefined
        ? await client.query(`
            INSERT INTO team_contribution_credentials
              (account_id, team_id, envelope_version, key_id, wrapped_dek, wrapped_dek_nonce,
               wrapped_dek_tag, encrypted_document, document_nonce, document_tag, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          `, values)
        : await client.query(`
            UPDATE team_contribution_credentials SET
              envelope_version = $3, key_id = $4, wrapped_dek = $5, wrapped_dek_nonce = $6,
              wrapped_dek_tag = $7, encrypted_document = $8, document_nonce = $9,
              document_tag = $10, updated_at = $11
            WHERE account_id = $1 AND team_id = $2
          `, values)
      if (written.rowCount !== 1) throw new Error('Team credential envelope identity conflict')
    } finally {
      plaintext.fill(0)
    }
  }

  private async lockWritableCredentialScope(client: PoolClient, ref: TeamCredentialRef): Promise<void> {
    if (this.options.credentialScopeLock === 'restricted-function') {
      const scope = await client.query<CredentialScopeLockRow>(
        POSTGRES_CREDENTIAL_SCOPE_MUTATION_LOCK_SQL,
        [ref.teamId, ref.accountId],
      )
      if (scope.rows[0]?.allowed !== true) throw credentialUnavailableError()
      return
    }
    const team = await client.query<LifecycleStatusRow>(POSTGRES_CREDENTIAL_TEAM_MUTATION_LOCK_SQL, [ref.teamId])
    if (team.rows[0]?.status !== 'active' && team.rows[0]?.status !== 'paused') throw credentialUnavailableError()
    const contribution = await client.query<LifecycleStatusRow>(
      POSTGRES_CREDENTIAL_CONTRIBUTION_MUTATION_LOCK_SQL,
      [ref.teamId, ref.accountId],
    )
    if (contribution.rows[0] === undefined || contribution.rows[0].status === 'revoked') {
      throw credentialUnavailableError()
    }
  }

  createProfileId(): string {
    return this.id()
  }

  currentTime(): number {
    return this.now()
  }
}

class PostgresTeamEnvelopeProfileStore implements OpenAICodexProfileStore {
  constructor(
    private readonly backend: PostgresTeamEnvelopeCredentialBackend,
    private readonly ref: TeamCredentialRef,
  ) {}

  async listProfiles(): Promise<readonly CodexProfileSummary[]> {
    const profile = (await this.backend.readDocument(this.ref)).profile
    return profile === undefined ? [] : [summary(profile)]
  }

  async addProfile(labelInput: string, credentialInput: OAuthCredential): Promise<CodexProfileSummary> {
    const label = normalizeLabel(labelInput)
    const credential = parseCredential(credentialInput)
    return this.backend.mutate(this.ref, document => {
      if (document.profile !== undefined) throw new Error('openai-codex: account already exists in another profile')
      const now = this.backend.currentTime()
      const profile: StoredCredentialProfile = {
        id: this.backend.createProfileId(),
        label,
        credential,
        createdAt: now,
        updatedAt: now,
      }
      document.profile = profile
      return { changed: true, value: summary(profile) }
    })
  }

  async removeProfile(profileId: string): Promise<void> {
    await this.backend.mutate(this.ref, document => {
      if (document.profile?.id !== profileId) throw new Error(`openai-codex: profile does not exist: ${profileId}`)
      delete document.profile
      return { changed: true, value: undefined }
    })
  }

  async read(providerId: string): Promise<Credential | undefined> {
    if (providerId !== OPENAI_CODEX_PROVIDER) return undefined
    const credential = (await this.backend.readDocument(this.ref)).profile?.credential
    return credential === undefined ? undefined : structuredClone(credential)
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return await this.read(OPENAI_CODEX_PROVIDER) === undefined
      ? []
      : [{ providerId: OPENAI_CODEX_PROVIDER, type: 'oauth' }]
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    if (providerId !== OPENAI_CODEX_PROVIDER) {
      throw new Error(`openai-codex: credential store does not own provider "${providerId}"`)
    }
    return this.backend.mutate(this.ref, async document => {
      const current = document.profile?.credential
      const candidate = await fn(current === undefined ? undefined : structuredClone(current))
      if (candidate === undefined) {
        return { changed: false, value: current === undefined ? undefined : structuredClone(current) }
      }
      const credential = parseCredential(candidate)
      const now = this.backend.currentTime()
      if (document.profile === undefined) {
        document.profile = {
          id: this.backend.createProfileId(),
          label: 'Default',
          credential,
          createdAt: now,
          updatedAt: now,
        }
      } else {
        document.profile.credential = credential
        document.profile.updatedAt = now
      }
      return { changed: true, value: structuredClone(credential) }
    })
  }

  async delete(providerId: string): Promise<void> {
    if (providerId === OPENAI_CODEX_PROVIDER) await this.backend.delete(this.ref)
  }
}

interface StoredOAuthCredential extends OAuthCredential {
  accountId: string
}

interface StoredCredentialProfile {
  id: string
  label: string
  credential: StoredOAuthCredential
  createdAt: number
  updatedAt: number
}

interface CredentialDocument {
  version: typeof DOCUMENT_VERSION
  profile?: StoredCredentialProfile
}

interface MutationResult<T> {
  readonly changed: boolean
  readonly value: T
}

interface CredentialEnvelopeRow extends QueryResultRow {
  account_id: string
  team_id: string
  envelope_version: number | string
  key_id: string
  wrapped_dek: string
  wrapped_dek_nonce: string | null
  wrapped_dek_tag: string | null
  encrypted_document: string
  document_nonce: string
  document_tag: string
  updated_at: number | string
}

interface CredentialEnvelopeIdentity extends QueryResultRow {
  account_id: string
  team_id: string
}

interface CredentialScopeLockRow extends QueryResultRow {
  allowed: boolean
}

interface LifecycleStatusRow extends QueryResultRow {
  status: string
}

function emptyDocument(): CredentialDocument {
  return { version: DOCUMENT_VERSION }
}

function parseDocument(raw: unknown): CredentialDocument {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw credentialDecryptionError()
  const value = raw as Record<string, unknown>
  if (value['version'] !== DOCUMENT_VERSION || Object.keys(value).some(key => !['version', 'profile'].includes(key))) {
    throw credentialDecryptionError()
  }
  if (value['profile'] === undefined) return emptyDocument()
  const profile = value['profile']
  if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) throw credentialDecryptionError()
  const fields = profile as Record<string, unknown>
  if (Object.keys(fields).some(key => !['id', 'label', 'credential', 'createdAt', 'updatedAt'].includes(key))) {
    throw credentialDecryptionError()
  }
  const id = nonEmptyString(fields['id'], 'profile id', 128)
  const label = normalizeLabel(fields['label'])
  const createdAt = positiveFiniteNumber(fields['createdAt'])
  const updatedAt = positiveFiniteNumber(fields['updatedAt'])
  return {
    version: DOCUMENT_VERSION,
    profile: { id, label, credential: parseCredential(fields['credential']), createdAt, updatedAt },
  }
}

function parseCredential(raw: unknown): StoredOAuthCredential {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw credentialDecryptionError()
  const value = raw as Record<string, unknown>
  if (value['type'] !== 'oauth' || Object.keys(value).some(key => !['type', 'access', 'refresh', 'expires', 'accountId'].includes(key))) {
    throw credentialDecryptionError()
  }
  return {
    type: 'oauth',
    access: nonEmptyString(value['access'], 'access token', 64 * 1024),
    refresh: nonEmptyString(value['refresh'], 'refresh token', 64 * 1024),
    expires: positiveFiniteNumber(value['expires']),
    accountId: nonEmptyString(value['accountId'], 'provider account id', 1024),
  }
}

function summary(profile: StoredCredentialProfile): CodexProfileSummary {
  return {
    id: profile.id,
    label: openAICodexAccountName(profile.credential) ?? profile.label,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  }
}

function normalizeLabel(raw: unknown): string {
  if (typeof raw !== 'string') throw credentialDecryptionError()
  return nonEmptyString(raw.trim(), 'profile label', 80)
}

function nonEmptyString(raw: unknown, label: string, maxLength: number): string {
  if (typeof raw !== 'string') throw credentialDecryptionError()
  if (raw.length === 0 || raw.length > maxLength) throw new Error(`openai-codex: invalid ${label}`)
  return raw
}

function positiveFiniteNumber(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) throw credentialDecryptionError()
  return raw
}

function validatedRef(ref: TeamCredentialRef): TeamCredentialRef {
  for (const value of [ref.teamId, ref.accountId]) {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) throw new Error('Team credential reference is invalid')
  }
  return { teamId: ref.teamId, accountId: ref.accountId }
}

function envelopeAad(purpose: 'wrapped-dek' | 'document', ref: TeamCredentialRef): Buffer {
  return Buffer.from(JSON.stringify(['dsh-team-credential', ENVELOPE_VERSION, purpose, ref.teamId, ref.accountId]), 'utf8')
}

function encodeBytes(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url')
}

function encodeOptionalBytes(value: Uint8Array | undefined): string | null {
  return value === undefined ? null : encodeBytes(value)
}

function encodedBytes(value: unknown): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) throw credentialDecryptionError()
  const buffer = Buffer.from(value, 'base64url')
  if (buffer.length === 0) throw credentialDecryptionError()
  return buffer
}

function sizedEncodedBytes(value: unknown, length: number): Buffer {
  const buffer = encodedBytes(value)
  if (buffer.length !== length) throw credentialDecryptionError()
  return buffer
}

function sizedBytes(value: Uint8Array | undefined, length: number): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) throw credentialDecryptionError()
  return Buffer.from(value)
}

function optionalEncodedBytes(value: unknown, maximumLength: number): Buffer | undefined {
  if (value === null) return undefined
  const buffer = encodedBytes(value)
  if (buffer.length > maximumLength) throw credentialDecryptionError()
  return buffer
}

function wrappedKeyFromRow(row: CredentialEnvelopeRow): TeamWrappedKey {
  const nonce = optionalEncodedBytes(row.wrapped_dek_nonce, MAX_WRAPPED_KEY_METADATA_BYTES)
  const tag = optionalEncodedBytes(row.wrapped_dek_tag, MAX_WRAPPED_KEY_METADATA_BYTES)
  return {
    keyId: row.key_id,
    ciphertext: boundedBytes(encodedBytes(row.wrapped_dek), MAX_WRAPPED_KEY_BYTES),
    ...(nonce === undefined ? {} : { nonce }),
    ...(tag === undefined ? {} : { tag }),
  }
}

function validatedWrappedKey(value: TeamWrappedKey): TeamWrappedKey {
  if (typeof value.keyId !== 'string' || value.keyId.length === 0 || value.keyId.length > 255) {
    throw replacementKeyError()
  }
  const ciphertext = providerBytes(value.ciphertext, MAX_WRAPPED_KEY_BYTES)
  const nonce = optionalBoundedBytes(value.nonce, MAX_WRAPPED_KEY_METADATA_BYTES)
  const tag = optionalBoundedBytes(value.tag, MAX_WRAPPED_KEY_METADATA_BYTES)
  return {
    keyId: value.keyId,
    ciphertext,
    ...(nonce === undefined ? {} : { nonce }),
    ...(tag === undefined ? {} : { tag }),
  }
}

function optionalBoundedBytes(value: unknown, maximumLength: number): Buffer | undefined {
  if (value === undefined) return undefined
  return providerBytes(value, maximumLength)
}

function providerBytes(value: unknown, maximumLength: number): Buffer {
  if (!(value instanceof Uint8Array)) throw replacementKeyError()
  return boundedBytes(Buffer.from(value), maximumLength, replacementKeyError)
}

function boundedBytes(
  value: Buffer,
  maximumLength: number,
  errorFactory: () => Error = credentialDecryptionError,
): Buffer {
  if (value.length === 0 || value.length > maximumLength) {
    value.fill(0)
    throw errorFactory()
  }
  return value
}

async function unwrapOwnedKey(
  provider: TeamKeyEncryptionProvider,
  ref: TeamCredentialRef,
  wrappedKey: TeamWrappedKey,
): Promise<Buffer> {
  const plaintext = await provider.unwrapKey(ref, wrappedKey)
  try {
    return Buffer.from(plaintext)
  } finally {
    plaintext.fill(0)
  }
}

function rewrapBatchSize(value: number | undefined): number {
  const result = value ?? 100
  if (!Number.isSafeInteger(result) || result < 1 || result > 1_000) {
    throw new Error('Team credential rewrap batch size must be an integer between 1 and 1000')
  }
  return result
}

function replacementKeyError(): Error {
  return new Error('Team credential replacement wrapping key is not readable by the active Host provider')
}

function credentialDecryptionError(): Error {
  return new Error('Team credential cannot be decrypted')
}

function credentialUnavailableError(): Error {
  return new Error('Team credential is unavailable')
}
