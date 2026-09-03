/** Host-only, one-time encrypted transfer for a locally captured Team OAuth credential. */

import {
  createCipheriv,
  createPublicKey,
  createDecipheriv,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
} from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import type { OAuthCredential } from '@earendil-works/pi-ai'
import type { TeamCredentialRef } from './credentials.ts'

export const TEAM_CREDENTIAL_HANDOFF_TTL_MS = 10 * 60 * 1_000
const MAX_TTL_MS = 30 * 60 * 1_000
const MAX_CIPHERTEXT_BYTES = 128 * 1024
const HANDOFF_VERSION = 1

export interface TeamCredentialHandoffOffer {
  readonly version: typeof HANDOFF_VERSION
  readonly sessionId: string
  readonly serverPublicKey: string
  readonly expiresAt: number
}

export interface TeamCredentialHandoffEnvelope {
  readonly version: typeof HANDOFF_VERSION
  readonly sessionId: string
  readonly clientPublicKey: string
  readonly iv: string
  readonly ciphertext: string
  readonly tag: string
}

export interface TeamCredentialHandoffPayload {
  readonly label: string
  readonly credential: OAuthCredential & { readonly accountId: string }
}

interface PendingHandoff {
  readonly ref: TeamCredentialRef
  readonly privateKey: KeyObject
  readonly expiresAt: number
}

interface CompletedHandoff {
  readonly ref: TeamCredentialRef
  readonly envelope: TeamCredentialHandoffEnvelope
  readonly expiresAt: number
}

export type TeamCredentialHandoffCompletion =
  | { readonly replayed: false; readonly payload: TeamCredentialHandoffPayload }
  | { readonly replayed: true }

export interface TeamCredentialHandoffRegistryOptions {
  readonly now?: () => number
  readonly ttlMs?: number
}

/** Decrypts each offer once and keeps only an exact-envelope replay receipt until expiry. */
export class TeamCredentialHandoffRegistry {
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly pending = new Map<string, PendingHandoff>()
  private readonly completed = new Map<string, CompletedHandoff>()

  constructor(options: TeamCredentialHandoffRegistryOptions = {}) {
    this.now = options.now ?? Date.now
    this.ttlMs = boundedInteger(options.ttlMs ?? TEAM_CREDENTIAL_HANDOFF_TTL_MS, 'handoff ttl', 1_000, MAX_TTL_MS)
  }

  create(refInput: TeamCredentialRef): TeamCredentialHandoffOffer {
    const ref = parseRef(refInput)
    this.prune()
    const sessionId = randomUUID()
    const { publicKey, privateKey } = generateKeyPairSync('x25519')
    const expiresAt = this.now() + this.ttlMs
    this.pending.set(sessionId, { ref, privateKey, expiresAt })
    return {
      version: HANDOFF_VERSION,
      sessionId,
      serverPublicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
      expiresAt,
    }
  }

  complete(refInput: TeamCredentialRef, envelopeInput: TeamCredentialHandoffEnvelope): TeamCredentialHandoffPayload {
    const completion = this.completeReplaySafe(refInput, envelopeInput)
    if (completion.replayed) throw new Error('OAuth handoff session is already used')
    return completion.payload
  }

  completeReplaySafe(
    refInput: TeamCredentialRef,
    envelopeInput: TeamCredentialHandoffEnvelope,
  ): TeamCredentialHandoffCompletion {
    const ref = parseRef(refInput)
    const envelope = parseEnvelope(envelopeInput)
    const pending = this.pending.get(envelope.sessionId)
    if (pending === undefined) {
      const completed = this.completed.get(envelope.sessionId)
      if (
        completed !== undefined
        && completed.expiresAt >= this.now()
        && sameRef(completed.ref, ref)
        && sameEnvelope(completed.envelope, envelope)
      ) return { replayed: true }
      throw new Error('OAuth handoff session is unknown, expired, already used, or replay differs')
    }
    if (!sameRef(pending.ref, ref)) throw new Error('OAuth handoff session belongs to another Team account')
    if (pending.expiresAt < this.now()) {
      this.pending.delete(envelope.sessionId)
      throw new Error('OAuth handoff session expired')
    }

    // Consume before decrypting so ciphertext replay and repeated tampering cannot be retried.
    this.pending.delete(envelope.sessionId)
    try {
      const clientPublicKey = importPublicKey(envelope.clientPublicKey)
      const key = deriveKey(
        diffieHellman({ privateKey: pending.privateKey, publicKey: clientPublicKey }),
        envelope.sessionId,
        ref,
      )
      const decipher = createDecipheriv('aes-256-gcm', key, decodeBase64Url(envelope.iv, 'iv', 12, 12))
      decipher.setAAD(aad(envelope.sessionId, ref))
      decipher.setAuthTag(decodeBase64Url(envelope.tag, 'tag', 16, 16))
      const plaintext = Buffer.concat([
        decipher.update(decodeBase64Url(envelope.ciphertext, 'ciphertext', 1, MAX_CIPHERTEXT_BYTES)),
        decipher.final(),
      ])
      const payload = parsePayload(JSON.parse(plaintext.toString('utf8')) as unknown)
      this.completed.set(envelope.sessionId, { ref, envelope, expiresAt: pending.expiresAt })
      return { replayed: false, payload }
    } catch (error: unknown) {
      if (error instanceof SyntaxError) throw new Error('OAuth handoff payload is invalid')
      if (error instanceof Error && error.message.startsWith('OAuth handoff')) throw error
      throw new Error('OAuth handoff could not be decrypted or authenticated')
    }
  }

  cancel(refInput: TeamCredentialRef): void {
    const ref = parseRef(refInput)
    for (const [sessionId, pending] of this.pending) {
      if (sameRef(pending.ref, ref)) this.pending.delete(sessionId)
    }
    for (const [sessionId, completed] of this.completed) {
      if (sameRef(completed.ref, ref)) this.completed.delete(sessionId)
    }
  }

  dispose(): void {
    this.pending.clear()
    this.completed.clear()
  }

  private prune(): void {
    const now = this.now()
    for (const [sessionId, pending] of this.pending) {
      if (pending.expiresAt < now) this.pending.delete(sessionId)
    }
    for (const [sessionId, completed] of this.completed) {
      if (completed.expiresAt < now) this.completed.delete(sessionId)
    }
  }
}

function sameEnvelope(left: TeamCredentialHandoffEnvelope, right: TeamCredentialHandoffEnvelope): boolean {
  return left.version === right.version
    && left.sessionId === right.sessionId
    && left.clientPublicKey === right.clientPublicKey
    && left.iv === right.iv
    && left.ciphertext === right.ciphertext
    && left.tag === right.tag
}

/** Encrypt a captured OAuth credential using only the public handoff offer. */
export function sealTeamCredentialHandoff(
  offerInput: TeamCredentialHandoffOffer,
  refInput: TeamCredentialRef,
  payloadInput: TeamCredentialHandoffPayload,
): TeamCredentialHandoffEnvelope {
  const offer = parseOffer(offerInput)
  const ref = parseRef(refInput)
  const payload = parsePayload(payloadInput)
  const serverPublicKey = importPublicKey(offer.serverPublicKey)
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  const key = deriveKey(
    diffieHellman({ privateKey, publicKey: serverPublicKey }),
    offer.sessionId,
    ref,
  )
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad(offer.sessionId, ref))
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8')
  if (plaintext.length > MAX_CIPHERTEXT_BYTES) throw new Error('OAuth handoff payload is too large')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return {
    version: HANDOFF_VERSION,
    sessionId: offer.sessionId,
    clientPublicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    iv: iv.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
  }
}

function parseOffer(value: TeamCredentialHandoffOffer): TeamCredentialHandoffOffer {
  if (value.version !== HANDOFF_VERSION) throw new Error('OAuth handoff offer version is unsupported')
  const sessionId = boundedString(value.sessionId, 'handoff session id', 80)
  const serverPublicKey = boundedString(value.serverPublicKey, 'handoff server public key', 256)
  const expiresAt = positiveNumber(value.expiresAt, 'handoff expiry')
  return { version: HANDOFF_VERSION, sessionId, serverPublicKey, expiresAt }
}

function parseEnvelope(value: TeamCredentialHandoffEnvelope): TeamCredentialHandoffEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('OAuth handoff envelope is invalid')
  if (value.version !== HANDOFF_VERSION) throw new Error('OAuth handoff envelope version is unsupported')
  return {
    version: HANDOFF_VERSION,
    sessionId: boundedString(value.sessionId, 'handoff session id', 80),
    clientPublicKey: boundedString(value.clientPublicKey, 'handoff client public key', 256),
    iv: boundedString(value.iv, 'handoff iv', 64),
    ciphertext: boundedString(value.ciphertext, 'handoff ciphertext', Math.ceil(MAX_CIPHERTEXT_BYTES * 4 / 3) + 8),
    tag: boundedString(value.tag, 'handoff tag', 64),
  }
}

function parsePayload(value: unknown): TeamCredentialHandoffPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('OAuth handoff payload is invalid')
  const item = value as Record<string, unknown>
  if (Object.keys(item).some(key => key !== 'label' && key !== 'credential')) {
    throw new Error('OAuth handoff payload contains an unknown field')
  }
  const label = boundedString(item.label, 'OAuth account label', 80)
  const raw = item.credential
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('OAuth handoff credential is invalid')
  const credential = raw as Record<string, unknown>
  if (Object.keys(credential).some(key => !['type', 'access', 'refresh', 'expires', 'accountId'].includes(key))) {
    throw new Error('OAuth handoff credential contains an unknown field')
  }
  if (credential.type !== 'oauth') throw new Error('OAuth handoff credential type is invalid')
  return {
    label,
    credential: {
      type: 'oauth',
      access: boundedString(credential.access, 'OAuth access token', 64 * 1024),
      refresh: boundedString(credential.refresh, 'OAuth refresh token', 64 * 1024),
      expires: positiveNumber(credential.expires, 'OAuth expiry'),
      accountId: boundedString(credential.accountId, 'OAuth account id', 512),
    },
  }
}

function parseRef(value: TeamCredentialRef): TeamCredentialRef {
  return {
    teamId: boundedString(value.teamId, 'team id', 160),
    accountId: boundedString(value.accountId, 'account id', 160),
  }
}

function sameRef(left: TeamCredentialRef, right: TeamCredentialRef): boolean {
  return left.teamId === right.teamId && left.accountId === right.accountId
}

function aad(sessionId: string, ref: TeamCredentialRef): Buffer {
  return Buffer.from(JSON.stringify({ version: HANDOFF_VERSION, sessionId, teamId: ref.teamId, accountId: ref.accountId }), 'utf8')
}

function deriveKey(sharedSecret: Buffer, sessionId: string, ref: TeamCredentialRef): Buffer {
  return Buffer.from(hkdfSync('sha256', sharedSecret, Buffer.from(sessionId, 'utf8'), aad(sessionId, ref), 32))
}

function importPublicKey(value: string): KeyObject {
  try {
    const der = decodeBase64Url(value, 'public key', 44, 44)
    return createPublicKey({ key: der, format: 'der', type: 'spki' })
  } catch {
    throw new Error('OAuth handoff public key is invalid')
  }
}

function decodeBase64Url(value: string, name: string, min: number, max: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error(`OAuth handoff ${name} is invalid`)
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.length < min || decoded.length > max || decoded.toString('base64url') !== value) {
    throw new Error(`OAuth handoff ${name} is invalid`)
  }
  return decoded
}

function boundedString(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > max) throw new Error(`${name} is invalid`)
  return normalized
}

function positiveNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`${name} is invalid`)
  return value
}

function boundedInteger(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${name} is invalid`)
  }
  return value as number
}
