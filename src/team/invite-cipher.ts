/** Host-only envelope encryption for revealable Team invitation tokens. */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes as secureRandomBytes,
  timingSafeEqual,
} from 'node:crypto'

const ENVELOPE_VERSION = 1 as const
const AES_KEY_BYTES = 32
const GCM_NONCE_BYTES = 12
const GCM_TAG_BYTES = 16
const MAX_TOKEN_BYTES = 4_096
const MAX_WRAPPED_DEK_BYTES = 196_608
const MAX_WRAPPED_METADATA_BYTES = 49_152
const MAX_KEY_REF_LENGTH = 256
const MAX_ID_LENGTH = 128

/** Domain separation for both document AAD and the injected KEK provider. */
export const TEAM_INVITE_CIPHER_DOMAIN = 'dsh-team-invite-token/v1' as const

/** Existing SHA-256 token digest and immutable invitation identity. */
export interface TeamInviteCipherContext {
  readonly teamId: string
  readonly inviteId: string
  readonly createdAt: number
  /** Lowercase hexadecimal SHA-256 digest of the complete invitation token. */
  readonly tokenDigest: string
}

/** Domain-separated context supplied only to the Host KEK provider. */
export interface TeamInviteKeyWrapContext extends TeamInviteCipherContext {
  readonly domain: typeof TEAM_INVITE_CIPHER_DOMAIN
}

/** Provider-owned wrapped DEK; the cipher never receives or stores a KEK. */
export interface TeamInviteWrappedKey {
  /** Stable provider key reference used to select historical KEKs after rotation. */
  readonly keyRef: string
  readonly ciphertext: Uint8Array
  readonly nonce?: Uint8Array
  readonly tag?: Uint8Array
}

/**
 * Dedicated invitation KEK boundary. It is intentionally separate from the
 * OAuth credential broker and its encryption-provider types.
 */
export interface TeamInviteKeyEncryptionProvider {
  wrapKey(context: TeamInviteKeyWrapContext, plaintextKey: Uint8Array): Promise<TeamInviteWrappedKey>
  /** Must return a fresh, writable 32-byte DEK. The cipher clears it after use. */
  unwrapKey(context: TeamInviteKeyWrapContext, wrappedKey: TeamInviteWrappedKey): Promise<Uint8Array>
  dispose?(): Promise<void> | void
}

/** JSON-safe durable representation; every byte string uses unpadded base64url. */
export interface TeamInviteTokenEnvelope {
  readonly version: typeof ENVELOPE_VERSION
  readonly keyRef: string
  readonly wrappedDek: string
  readonly wrappedDekNonce?: string
  readonly wrappedDekTag?: string
  readonly nonce: string
  readonly ciphertext: string
  readonly tag: string
}

export interface TeamInviteCipherOptions {
  readonly keyEncryptionProvider: TeamInviteKeyEncryptionProvider
  /** Test seam only. Production callers should use the cryptographic default. */
  readonly randomBytes?: (size: number) => Uint8Array
}

/** One public failure shape for malformed, mismatched, or unauthenticated envelopes. */
export class TeamInviteDecryptionError extends Error {
  readonly code = 'team_invite_decryption_failed' as const

  constructor() {
    super('Team invitation could not be decrypted')
    this.name = 'TeamInviteDecryptionError'
  }
}

/** One public failure shape for malformed envelopes or unavailable KEKs during rotation. */
export class TeamInviteRewrapError extends Error {
  readonly code = 'team_invite_rewrap_failed' as const

  constructor() {
    super('Team invitation key could not be rewrapped')
    this.name = 'TeamInviteRewrapError'
  }
}

export class TeamInviteCipher {
  private readonly randomBytes: (size: number) => Uint8Array

  constructor(private readonly options: TeamInviteCipherOptions) {
    this.randomBytes = options.randomBytes ?? secureRandomBytes
  }

  async encrypt(context: TeamInviteCipherContext, inviteToken: string): Promise<TeamInviteTokenEnvelope> {
    const keyContext = validatedContext(context)
    const plaintext = encodedToken(inviteToken)
    let dek: Buffer | undefined

    try {
      if (!matchesDigest(plaintext, keyContext.tokenDigest)) {
        throw new Error('Team invite token does not match tokenDigest')
      }
      dek = exactRandomBytes(this.randomBytes, AES_KEY_BYTES)
      const nonce = exactRandomBytes(this.randomBytes, GCM_NONCE_BYTES)
      const cipher = createCipheriv('aes-256-gcm', dek, nonce, { authTagLength: GCM_TAG_BYTES })
      cipher.setAAD(inviteAad(keyContext))
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
      const tag = cipher.getAuthTag()
      const wrapped = validatedWrappedKey(await this.options.keyEncryptionProvider.wrapKey(keyContext, dek))

      return {
        version: ENVELOPE_VERSION,
        keyRef: wrapped.keyRef,
        wrappedDek: encodeBytes(wrapped.ciphertext),
        ...(wrapped.nonce === undefined ? {} : { wrappedDekNonce: encodeBytes(wrapped.nonce) }),
        ...(wrapped.tag === undefined ? {} : { wrappedDekTag: encodeBytes(wrapped.tag) }),
        nonce: encodeBytes(nonce),
        ciphertext: encodeBytes(ciphertext),
        tag: encodeBytes(tag),
      }
    } finally {
      plaintext.fill(0)
      dek?.fill(0)
    }
  }

  async decrypt(context: TeamInviteCipherContext, envelope: TeamInviteTokenEnvelope): Promise<string> {
    let providerDek: Uint8Array | undefined
    let dek: Buffer | undefined
    let plaintext: Buffer | undefined

    try {
      const keyContext = validatedContext(context)
      const parsed = decodedEnvelope(envelope)
      providerDek = await this.options.keyEncryptionProvider.unwrapKey(keyContext, parsed.wrappedKey)
      if (!(providerDek instanceof Uint8Array) || providerDek.byteLength !== AES_KEY_BYTES) {
        throw new Error('invalid DEK')
      }
      dek = Buffer.from(providerDek)
      const decipher = createDecipheriv('aes-256-gcm', dek, parsed.nonce, { authTagLength: GCM_TAG_BYTES })
      decipher.setAAD(inviteAad(keyContext))
      decipher.setAuthTag(parsed.tag)
      plaintext = Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()])
      if (plaintext.byteLength === 0 || plaintext.byteLength > MAX_TOKEN_BYTES) throw new Error('invalid plaintext')
      if (!matchesDigest(plaintext, keyContext.tokenDigest)) throw new Error('digest mismatch')
      return new TextDecoder('utf-8', { fatal: true }).decode(plaintext)
    } catch {
      throw new TeamInviteDecryptionError()
    } finally {
      wipe(providerDek)
      dek?.fill(0)
      plaintext?.fill(0)
    }
  }

  /**
   * Moves an existing envelope to the provider's active KEK without decrypting
   * or re-encrypting the invitation token itself.
   */
  async rewrap(
    context: TeamInviteCipherContext,
    envelope: TeamInviteTokenEnvelope,
  ): Promise<TeamInviteTokenEnvelope> {
    let providerDek: Uint8Array | undefined
    let dek: Buffer | undefined

    try {
      const keyContext = validatedContext(context)
      const parsed = decodedEnvelope(envelope)
      providerDek = await this.options.keyEncryptionProvider.unwrapKey(keyContext, parsed.wrappedKey)
      if (!(providerDek instanceof Uint8Array) || providerDek.byteLength !== AES_KEY_BYTES) {
        throw new Error('invalid DEK')
      }
      dek = Buffer.from(providerDek)
      const wrapped = validatedWrappedKey(await this.options.keyEncryptionProvider.wrapKey(keyContext, dek))

      return {
        version: ENVELOPE_VERSION,
        keyRef: wrapped.keyRef,
        wrappedDek: encodeBytes(wrapped.ciphertext),
        ...(wrapped.nonce === undefined ? {} : { wrappedDekNonce: encodeBytes(wrapped.nonce) }),
        ...(wrapped.tag === undefined ? {} : { wrappedDekTag: encodeBytes(wrapped.tag) }),
        nonce: encodeBytes(parsed.nonce),
        ciphertext: encodeBytes(parsed.ciphertext),
        tag: encodeBytes(parsed.tag),
      }
    } catch {
      throw new TeamInviteRewrapError()
    } finally {
      wipe(providerDek)
      dek?.fill(0)
    }
  }
}

interface DecodedEnvelope {
  readonly wrappedKey: TeamInviteWrappedKey
  readonly nonce: Buffer
  readonly ciphertext: Buffer
  readonly tag: Buffer
}

function validatedContext(context: TeamInviteCipherContext): TeamInviteKeyWrapContext {
  if (context === null || typeof context !== 'object') throw new Error('Team invite encryption context is invalid')
  return {
    domain: TEAM_INVITE_CIPHER_DOMAIN,
    teamId: boundedIdentity(context.teamId),
    inviteId: boundedIdentity(context.inviteId),
    createdAt: validTimestamp(context.createdAt),
    tokenDigest: validDigest(context.tokenDigest),
  }
}

function boundedIdentity(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_LENGTH) {
    throw new Error('Team invite encryption context is invalid')
  }
  if (value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('Team invite encryption context is invalid')
  }
  return value
}

function validTimestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Team invite encryption context is invalid')
  }
  return value
}

function validDigest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error('Team invite encryption context is invalid')
  }
  return value
}

function encodedToken(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Team invite token is invalid')
  const encoded = Buffer.from(value, 'utf8')
  if (encoded.byteLength === 0 || encoded.byteLength > MAX_TOKEN_BYTES) {
    encoded.fill(0)
    throw new Error('Team invite token is invalid')
  }
  return encoded
}

function matchesDigest(value: Uint8Array, expectedHex: string): boolean {
  const actual = createHash('sha256').update(value).digest()
  const expected = Buffer.from(expectedHex, 'hex')
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected)
}

function inviteAad(context: TeamInviteKeyWrapContext): Buffer {
  return Buffer.from(JSON.stringify([
    context.domain,
    context.teamId,
    context.inviteId,
    context.createdAt,
    context.tokenDigest,
  ]), 'utf8')
}

function exactRandomBytes(factory: (size: number) => Uint8Array, size: number): Buffer {
  const value = factory(size)
  if (!(value instanceof Uint8Array) || value.byteLength !== size) {
    wipe(value)
    throw new Error('Secure random-byte source returned an invalid value')
  }
  // Share the factory-owned storage so clearing the DEK does not leave an
  // otherwise-unreachable copy returned by `randomBytes()` behind.
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
}

function validatedWrappedKey(value: TeamInviteWrappedKey): TeamInviteWrappedKey {
  if (value === null || typeof value !== 'object') throw new Error('Invitation KEK provider returned an invalid value')
  return {
    keyRef: validKeyRef(value.keyRef),
    ciphertext: boundedProviderBytes(value.ciphertext, 1, MAX_WRAPPED_DEK_BYTES),
    ...(value.nonce === undefined
      ? {}
      : { nonce: boundedProviderBytes(value.nonce, 1, MAX_WRAPPED_METADATA_BYTES) }),
    ...(value.tag === undefined
      ? {}
      : { tag: boundedProviderBytes(value.tag, 1, MAX_WRAPPED_METADATA_BYTES) }),
  }
}

function decodedEnvelope(value: TeamInviteTokenEnvelope): DecodedEnvelope {
  if (value === null || typeof value !== 'object' || value.version !== ENVELOPE_VERSION) {
    throw new Error('invalid envelope')
  }
  return {
    wrappedKey: {
      keyRef: validKeyRef(value.keyRef),
      ciphertext: decodedBytes(value.wrappedDek, 1, MAX_WRAPPED_DEK_BYTES),
      ...(value.wrappedDekNonce === undefined
        ? {}
        : { nonce: decodedBytes(value.wrappedDekNonce, 1, MAX_WRAPPED_METADATA_BYTES) }),
      ...(value.wrappedDekTag === undefined
        ? {}
        : { tag: decodedBytes(value.wrappedDekTag, 1, MAX_WRAPPED_METADATA_BYTES) }),
    },
    nonce: decodedBytes(value.nonce, GCM_NONCE_BYTES, GCM_NONCE_BYTES),
    ciphertext: decodedBytes(value.ciphertext, 1, MAX_TOKEN_BYTES),
    tag: decodedBytes(value.tag, GCM_TAG_BYTES, GCM_TAG_BYTES),
  }
}

function validKeyRef(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_KEY_REF_LENGTH) {
    throw new Error('invalid key reference')
  }
  if (value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('invalid key reference')
  return value
}

function boundedProviderBytes(value: unknown, minimum: number, maximum: number): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength < minimum || value.byteLength > maximum) {
    throw new Error('invalid provider bytes')
  }
  return Buffer.from(value)
}

function decodedBytes(value: unknown, minimum: number, maximum: number): Buffer {
  if (
    typeof value !== 'string'
    || value.length > base64UrlEncodedLength(maximum)
    || !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new Error('invalid encoded bytes')
  }
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.byteLength < minimum || decoded.byteLength > maximum || decoded.toString('base64url') !== value) {
    decoded.fill(0)
    throw new Error('invalid encoded bytes')
  }
  return decoded
}

function base64UrlEncodedLength(byteLength: number): number {
  const remainder = byteLength % 3
  return Math.floor(byteLength / 3) * 4 + (remainder === 0 ? 0 : remainder + 1)
}

function encodeBytes(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url')
}

function wipe(value: unknown): void {
  if (!(value instanceof Uint8Array)) return
  try {
    value.fill(0)
  } catch {
    // Best effort only; decryption still fails closed.
  }
}
