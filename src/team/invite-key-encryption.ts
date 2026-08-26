/** Dedicated Host-only KEK implementations for revealable Team invitations. */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto'
import {
  TEAM_INVITE_CIPHER_DOMAIN,
} from './invite-cipher.ts'
import type {
  TeamInviteKeyEncryptionProvider,
  TeamInviteKeyWrapContext,
  TeamInviteWrappedKey,
} from './invite-cipher.ts'

const AES_KEY_BYTES = 32
const GCM_NONCE_BYTES = 12
const GCM_TAG_BYTES = 16
const MAX_CONTEXT_ID_LENGTH = 128
const MAX_KEY_REF_LENGTH = 256
const WRAP_AAD_DOMAIN = 'dsh-codex-shared-pool/team-invite-kek-wrap/v1' as const

/** Providers in a rotation keyring expose a stable, non-secret dispatch key. */
export interface ReferencedTeamInviteKeyEncryptionProvider extends TeamInviteKeyEncryptionProvider {
  readonly keyRef: string
}

/** One public failure shape for every failed invitation-DEK unwrap. */
export class TeamInviteKeyDecryptionError extends Error {
  readonly code = 'team_invite_key_decryption_failed' as const

  constructor() {
    super('Team invitation key could not be decrypted')
    this.name = 'TeamInviteKeyDecryptionError'
  }
}

/** Decode canonical base64/base64url text into an exact 256-bit invitation KEK. */
export function decodeTeamInviteMasterKey(encoded: string): Buffer {
  if (typeof encoded !== 'string' || encoded.length === 0) throw invalidBase64Key()

  let decoded: Buffer
  if (isCanonicalBase64(encoded)) {
    decoded = Buffer.from(encoded, 'base64')
    if (decoded.toString('base64') !== encoded) {
      decoded.fill(0)
      throw invalidBase64Key()
    }
  } else if (isCanonicalBase64Url(encoded)) {
    const unpadded = encoded.replace(/=+$/u, '')
    decoded = Buffer.from(unpadded, 'base64url')
    if (decoded.toString('base64url') !== unpadded) {
      decoded.fill(0)
      throw invalidBase64Key()
    }
  } else {
    throw invalidBase64Key()
  }

  if (decoded.byteLength !== AES_KEY_BYTES) {
    decoded.fill(0)
    throw new Error('Team invitation master key must decode to exactly 32 bytes')
  }
  return decoded
}

/** Portable self-hosted AES-256-GCM KEK; managed KMS adapters use the same boundary. */
export class Aes256GcmTeamInviteKeyEncryptionProvider implements ReferencedTeamInviteKeyEncryptionProvider {
  private readonly key: Buffer
  readonly keyRef: string
  private disposed = false

  constructor(key: Uint8Array) {
    if (!(key instanceof Uint8Array) || key.byteLength !== AES_KEY_BYTES) {
      throw new Error('Team invitation encryption key must be exactly 32 bytes')
    }
    this.key = Buffer.from(key)
    this.keyRef = `invite-aes256gcm:${createHash('sha256')
      .update(`${WRAP_AAD_DOMAIN}\0`, 'utf8')
      .update(this.key)
      .digest('base64url')}`
  }

  async wrapKey(
    context: TeamInviteKeyWrapContext,
    plaintextKey: Uint8Array,
  ): Promise<TeamInviteWrappedKey> {
    if (this.disposed) throw new Error('Team invitation encryption provider is disposed')
    const safeContext = validatedContext(context)
    if (!(plaintextKey instanceof Uint8Array) || plaintextKey.byteLength !== AES_KEY_BYTES) {
      throw new Error('Team invitation DEK must be exactly 32 bytes')
    }

    const nonce = randomBytes(GCM_NONCE_BYTES)
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce, { authTagLength: GCM_TAG_BYTES })
    cipher.setAAD(wrapAad(safeContext, this.keyRef))
    const ciphertext = Buffer.concat([cipher.update(plaintextKey), cipher.final()])
    return {
      keyRef: this.keyRef,
      ciphertext,
      nonce,
      tag: cipher.getAuthTag(),
    }
  }

  async unwrapKey(
    context: TeamInviteKeyWrapContext,
    wrappedKey: TeamInviteWrappedKey,
  ): Promise<Uint8Array> {
    let plaintext: Buffer | undefined
    try {
      if (this.disposed) throw new Error('provider disposed')
      const safeContext = validatedContext(context)
      if (wrappedKey === null || typeof wrappedKey !== 'object' || wrappedKey.keyRef !== this.keyRef) {
        throw new Error('key reference mismatch')
      }
      const ciphertext = exactBytes(wrappedKey.ciphertext, AES_KEY_BYTES)
      const nonce = exactBytes(wrappedKey.nonce, GCM_NONCE_BYTES)
      const tag = exactBytes(wrappedKey.tag, GCM_TAG_BYTES)
      const decipher = createDecipheriv('aes-256-gcm', this.key, nonce, { authTagLength: GCM_TAG_BYTES })
      decipher.setAAD(wrapAad(safeContext, this.keyRef))
      decipher.setAuthTag(tag)
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
      if (plaintext.byteLength !== AES_KEY_BYTES) throw new Error('invalid plaintext length')
      const result = plaintext
      plaintext = undefined
      return result
    } catch {
      throw keyDecryptionError()
    } finally {
      plaintext?.fill(0)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.key.fill(0)
  }
}

/**
 * Rotation keyring: new envelopes use `active`, while historical envelopes
 * are dispatched directly to the current or previous provider by keyRef.
 */
export class TeamInviteKeyEncryptionKeyring implements ReferencedTeamInviteKeyEncryptionProvider {
  readonly keyRef: string
  private readonly providers: ReadonlyMap<string, ReferencedTeamInviteKeyEncryptionProvider>
  private readonly orderedProviders: readonly ReferencedTeamInviteKeyEncryptionProvider[]
  private disposed = false
  private disposal: Promise<void> | undefined

  constructor(
    private readonly active: ReferencedTeamInviteKeyEncryptionProvider,
    previous: readonly ReferencedTeamInviteKeyEncryptionProvider[] = [],
  ) {
    this.orderedProviders = [active, ...previous]
    const providers = new Map<string, ReferencedTeamInviteKeyEncryptionProvider>()
    for (const provider of this.orderedProviders) {
      const keyRef = validKeyRef(provider.keyRef)
      if (providers.has(keyRef)) throw new Error(`Duplicate Team invitation keyRef: ${keyRef}`)
      providers.set(keyRef, provider)
    }
    this.providers = providers
    this.keyRef = validKeyRef(active.keyRef)
  }

  async wrapKey(
    context: TeamInviteKeyWrapContext,
    plaintextKey: Uint8Array,
  ): Promise<TeamInviteWrappedKey> {
    if (this.disposed) throw new Error('Team invitation encryption keyring is disposed')
    const wrapped = await this.active.wrapKey(context, plaintextKey)
    if (wrapped.keyRef !== this.keyRef) {
      throw new Error('Active Team invitation encryption provider returned an unexpected keyRef')
    }
    return wrapped
  }

  async unwrapKey(
    context: TeamInviteKeyWrapContext,
    wrappedKey: TeamInviteWrappedKey,
  ): Promise<Uint8Array> {
    try {
      if (this.disposed || wrappedKey === null || typeof wrappedKey !== 'object') {
        throw new Error('keyring unavailable')
      }
      const provider = this.providers.get(wrappedKey.keyRef)
      if (provider === undefined) throw new Error('unknown key reference')
      return await provider.unwrapKey(context, wrappedKey)
    } catch {
      throw keyDecryptionError()
    }
  }

  dispose(): Promise<void> {
    this.disposed = true
    this.disposal ??= disposeProviders(this.orderedProviders)
    return this.disposal
  }
}

function isCanonicalBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
}

function isCanonicalBase64Url(value: string): boolean {
  const match = /^([A-Za-z0-9_-]+)(=*)$/u.exec(value)
  if (match === null) return false
  const unpadded = match[1]!
  const padding = match[2]!
  if (unpadded.length % 4 === 1) return false
  const expectedPadding = (4 - (unpadded.length % 4)) % 4
  return padding.length === 0 || (padding.length === expectedPadding && value.length % 4 === 0)
}

function invalidBase64Key(): Error {
  return new Error('Team invitation master key must be canonical base64 or base64url')
}

function validatedContext(context: TeamInviteKeyWrapContext): TeamInviteKeyWrapContext {
  if (context === null || typeof context !== 'object' || context.domain !== TEAM_INVITE_CIPHER_DOMAIN) {
    throw new Error('Team invitation key context is invalid')
  }
  return {
    domain: TEAM_INVITE_CIPHER_DOMAIN,
    teamId: validContextId(context.teamId),
    inviteId: validContextId(context.inviteId),
    createdAt: validTimestamp(context.createdAt),
    tokenDigest: validDigest(context.tokenDigest),
  }
}

function validContextId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CONTEXT_ID_LENGTH) {
    throw new Error('Team invitation key context is invalid')
  }
  if (value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('Team invitation key context is invalid')
  }
  return value
}

function validTimestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Team invitation key context is invalid')
  }
  return value
}

function validDigest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error('Team invitation key context is invalid')
  }
  return value
}

function validKeyRef(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_KEY_REF_LENGTH) {
    throw new Error('Team invitation keyRef is invalid')
  }
  if (value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('Team invitation keyRef is invalid')
  }
  return value
}

function exactBytes(value: unknown, size: number): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== size) throw new Error('invalid wrapped-key bytes')
  return Buffer.from(value)
}

function wrapAad(context: TeamInviteKeyWrapContext, keyRef: string): Buffer {
  return Buffer.from(JSON.stringify([
    WRAP_AAD_DOMAIN,
    context.domain,
    context.teamId,
    context.inviteId,
    context.createdAt,
    context.tokenDigest,
    keyRef,
  ]), 'utf8')
}

function keyDecryptionError(): TeamInviteKeyDecryptionError {
  return new TeamInviteKeyDecryptionError()
}

async function disposeProviders(
  providers: readonly ReferencedTeamInviteKeyEncryptionProvider[],
): Promise<void> {
  const results = await Promise.allSettled(providers.map(provider => Promise.resolve(provider.dispose?.())))
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map(result => result.reason)
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Team invitation encryption key cleanup failed')
  }
}
