import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  TEAM_INVITE_CIPHER_DOMAIN,
  TeamInviteCipher,
  TeamInviteDecryptionError,
  TeamInviteRewrapError,
} from '../src/team/invite-cipher.ts'
import type {
  TeamInviteCipherContext,
  TeamInviteKeyEncryptionProvider,
  TeamInviteKeyWrapContext,
  TeamInviteTokenEnvelope,
  TeamInviteWrappedKey,
} from '../src/team/invite-cipher.ts'

const TOKEN = 'dsh_invite_test-token-that-remains-host-only'

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function context(overrides: Partial<TeamInviteCipherContext> = {}): TeamInviteCipherContext {
  return {
    teamId: 'team-1',
    inviteId: 'invite-1',
    createdAt: 1_777_000_000_000,
    tokenDigest: sha256(TOKEN),
    ...overrides,
  }
}

function wrapAad(ref: TeamInviteKeyWrapContext, keyRef: string): Buffer {
  return Buffer.from(JSON.stringify([
    ref.domain,
    'wrapped-dek',
    ref.teamId,
    ref.inviteId,
    ref.createdAt,
    ref.tokenDigest,
    keyRef,
  ]), 'utf8')
}

class RotatingInviteKekProvider implements TeamInviteKeyEncryptionProvider {
  readonly wrapInputs: Uint8Array[] = []
  readonly unwrapOutputs: Uint8Array[] = []
  readonly contexts: TeamInviteKeyWrapContext[] = []
  private readonly keys = new Map<string, Buffer>()
  private activeKeyRef: string
  private rejectNextWrap = false

  constructor(keyRef = 'invite-kek:2026-08') {
    this.activeKeyRef = keyRef
    this.keys.set(keyRef, randomBytes(32))
  }

  rotate(keyRef: string): void {
    this.activeKeyRef = keyRef
    this.keys.set(keyRef, randomBytes(32))
  }

  forget(keyRef: string): void {
    this.keys.delete(keyRef)
  }

  failNextWrap(): void {
    this.rejectNextWrap = true
  }

  async wrapKey(ref: TeamInviteKeyWrapContext, plaintextKey: Uint8Array): Promise<TeamInviteWrappedKey> {
    this.contexts.push({ ...ref })
    this.wrapInputs.push(plaintextKey)
    if (this.rejectNextWrap) {
      this.rejectNextWrap = false
      throw new Error('fixture active KEK unavailable')
    }
    const keyRef = this.activeKeyRef
    const key = this.keys.get(keyRef)
    if (key === undefined) throw new Error('fixture KEK missing')
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(wrapAad(ref, keyRef))
    const ciphertext = Buffer.concat([cipher.update(plaintextKey), cipher.final()])
    return { keyRef, ciphertext, nonce, tag: cipher.getAuthTag() }
  }

  async unwrapKey(ref: TeamInviteKeyWrapContext, wrappedKey: TeamInviteWrappedKey): Promise<Uint8Array> {
    const key = this.keys.get(wrappedKey.keyRef)
    if (key === undefined) throw new Error(`unknown fixture key ${wrappedKey.keyRef}`)
    if (wrappedKey.nonce === undefined || wrappedKey.tag === undefined) throw new Error('fixture metadata missing')
    const decipher = createDecipheriv('aes-256-gcm', key, wrappedKey.nonce)
    decipher.setAAD(wrapAad(ref, wrappedKey.keyRef))
    decipher.setAuthTag(wrappedKey.tag)
    const plaintext = Buffer.concat([decipher.update(wrappedKey.ciphertext), decipher.final()])
    this.unwrapOutputs.push(plaintext)
    return plaintext
  }
}

/**
 * Deliberately ignores the invitation identity so tests can prove that the
 * document AEAD itself authenticates every business-context field.
 */
class ContextBlindInviteKekProvider implements TeamInviteKeyEncryptionProvider {
  private readonly key = randomBytes(32)
  private readonly keyRef = 'invite-kek:context-blind'

  async wrapKey(
    _context: TeamInviteKeyWrapContext,
    plaintextKey: Uint8Array,
  ): Promise<TeamInviteWrappedKey> {
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce)
    const ciphertext = Buffer.concat([cipher.update(plaintextKey), cipher.final()])
    return { keyRef: this.keyRef, ciphertext, nonce, tag: cipher.getAuthTag() }
  }

  async unwrapKey(
    _context: TeamInviteKeyWrapContext,
    wrappedKey: TeamInviteWrappedKey,
  ): Promise<Uint8Array> {
    if (wrappedKey.keyRef !== this.keyRef) throw new Error('unknown context-blind fixture key')
    if (wrappedKey.nonce === undefined || wrappedKey.tag === undefined) {
      throw new Error('context-blind fixture metadata missing')
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, wrappedKey.nonce)
    decipher.setAuthTag(wrappedKey.tag)
    return Buffer.concat([decipher.update(wrappedKey.ciphertext), decipher.final()])
  }
}

function changed(encoded: string): string {
  const first = encoded[0]
  if (first === undefined) throw new Error('fixture requires a non-empty encoded value')
  return `${first === 'A' ? 'B' : 'A'}${encoded.slice(1)}`
}

async function expectSafeFailure(operation: Promise<unknown>): Promise<void> {
  const error = await operation.catch(reason => reason)
  expect(error).toBeInstanceOf(TeamInviteDecryptionError)
  expect(error).toMatchObject({
    code: 'team_invite_decryption_failed',
    message: 'Team invitation could not be decrypted',
  })
  expect(String(error)).not.toContain(TOKEN)
}

async function expectSafeRewrapFailure(operation: Promise<unknown>): Promise<void> {
  const error = await operation.catch(reason => reason)
  expect(error).toBeInstanceOf(TeamInviteRewrapError)
  expect(error).toMatchObject({
    code: 'team_invite_rewrap_failed',
    message: 'Team invitation key could not be rewrapped',
  })
  expect(String(error)).not.toContain(TOKEN)
  expect(String(error)).not.toContain('fixture')
}

describe('TeamInviteCipher', () => {
  it('uses the product-spec domain separator before any envelope is persisted', () => {
    expect(TEAM_INVITE_CIPHER_DOMAIN).toBe('dsh-team-invite-token/v1')
  })

  it('creates a versioned JSON-safe envelope and decrypts it only on the Host provider boundary', async () => {
    const provider = new RotatingInviteKekProvider()
    const cipher = new TeamInviteCipher({ keyEncryptionProvider: provider })

    const envelope = await cipher.encrypt(context(), TOKEN)

    expect(envelope).toMatchObject({ version: 1, keyRef: 'invite-kek:2026-08' })
    expect(Buffer.from(envelope.nonce, 'base64url')).toHaveLength(12)
    expect(Buffer.from(envelope.tag, 'base64url')).toHaveLength(16)
    expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope)
    expect(JSON.stringify(envelope)).not.toContain(TOKEN)
    expect(provider.contexts).toEqual([{ domain: TEAM_INVITE_CIPHER_DOMAIN, ...context() }])

    await expect(cipher.decrypt(context(), envelope)).resolves.toBe(TOKEN)
  })

  it('uses a fresh 32-byte DEK and 12-byte document nonce for every envelope, then clears raw DEKs', async () => {
    const provider = new RotatingInviteKekProvider()
    const cipher = new TeamInviteCipher({ keyEncryptionProvider: provider })

    const first = await cipher.encrypt(context(), TOKEN)
    const second = await cipher.encrypt(context(), TOKEN)

    expect(first.nonce).not.toBe(second.nonce)
    expect(first.wrappedDek).not.toBe(second.wrappedDek)
    expect(provider.wrapInputs).toHaveLength(2)
    for (const rawDek of provider.wrapInputs) {
      expect(rawDek).toHaveLength(32)
      expect([...rawDek]).toEqual(new Array<number>(32).fill(0))
    }

    await cipher.decrypt(context(), first)
    expect(provider.unwrapOutputs).toHaveLength(1)
    expect([...provider.unwrapOutputs[0]!]).toEqual(new Array<number>(32).fill(0))
  })

  it.each([
    ['teamId', { teamId: 'team-2' }],
    ['inviteId', { inviteId: 'invite-2' }],
    ['createdAt', { createdAt: 1_777_000_000_001 }],
    ['tokenDigest', { tokenDigest: sha256('another-token') }],
  ] satisfies ReadonlyArray<readonly [string, Partial<TeamInviteCipherContext>]>) (
    'binds %s into the document AEAD authenticated context',
    async (_field, overrides) => {
      const provider = new ContextBlindInviteKekProvider()
      const cipher = new TeamInviteCipher({ keyEncryptionProvider: provider })
      const envelope = await cipher.encrypt(context(), TOKEN)

      await expectSafeFailure(cipher.decrypt(context(overrides), envelope))
    },
  )

  it('returns one safe error for ciphertext, tag, nonce, wrapped-DEK, key-ref, and shape failures', async () => {
    const provider = new RotatingInviteKekProvider()
    const cipher = new TeamInviteCipher({ keyEncryptionProvider: provider })
    const envelope = await cipher.encrypt(context(), TOKEN)
    const malformed = { version: 7 } as unknown as TeamInviteTokenEnvelope
    const mutations: TeamInviteTokenEnvelope[] = [
      { ...envelope, ciphertext: changed(envelope.ciphertext) },
      { ...envelope, tag: changed(envelope.tag) },
      { ...envelope, nonce: changed(envelope.nonce) },
      { ...envelope, wrappedDek: changed(envelope.wrappedDek) },
      { ...envelope, keyRef: 'invite-kek:missing' },
      malformed,
    ]

    for (const mutation of mutations) await expectSafeFailure(cipher.decrypt(context(), mutation))
  })

  it('rejects oversized encoded fields before attempting base64url decoding', async () => {
    const provider = new RotatingInviteKekProvider()
    const cipher = new TeamInviteCipher({ keyEncryptionProvider: provider })
    const envelope = await cipher.encrypt(context(), TOKEN)
    const oversizedCiphertext = 'A'.repeat(10_000)
    const bufferFrom = vi.spyOn(Buffer, 'from')

    try {
      await expectSafeFailure(cipher.decrypt(context(), { ...envelope, ciphertext: oversizedCiphertext }))
      expect(bufferFrom.mock.calls.some(([value]) => value === oversizedCiphertext)).toBe(false)
    } finally {
      bufferFrom.mockRestore()
    }
  })

  it('keeps keyRef in the envelope so a provider keyring can read old and new invitations', async () => {
    const provider = new RotatingInviteKekProvider('invite-kek:v1')
    const cipher = new TeamInviteCipher({ keyEncryptionProvider: provider })
    const oldEnvelope = await cipher.encrypt(context({ inviteId: 'invite-old' }), TOKEN)
    provider.rotate('invite-kek:v2')
    const newEnvelope = await cipher.encrypt(context({ inviteId: 'invite-new' }), TOKEN)

    expect(oldEnvelope.keyRef).toBe('invite-kek:v1')
    expect(newEnvelope.keyRef).toBe('invite-kek:v2')
    await expect(cipher.decrypt(context({ inviteId: 'invite-old' }), oldEnvelope)).resolves.toBe(TOKEN)
    await expect(cipher.decrypt(context({ inviteId: 'invite-new' }), newEnvelope)).resolves.toBe(TOKEN)

    provider.forget('invite-kek:v1')
    await expectSafeFailure(cipher.decrypt(context({ inviteId: 'invite-old' }), oldEnvelope))
  })

  it('rewraps only the DEK under the active KEK and preserves document ciphertext bytes verbatim', async () => {
    const provider = new RotatingInviteKekProvider('invite-kek:v1')
    const cipher = new TeamInviteCipher({ keyEncryptionProvider: provider })
    const oldEnvelope = await cipher.encrypt(context(), TOKEN)
    provider.rotate('invite-kek:v2')

    const rewrapped = await cipher.rewrap(context(), oldEnvelope)

    expect(rewrapped).toMatchObject({ version: 1, keyRef: 'invite-kek:v2' })
    expect(rewrapped.wrappedDek).not.toBe(oldEnvelope.wrappedDek)
    expect(rewrapped.nonce).toBe(oldEnvelope.nonce)
    expect(rewrapped.ciphertext).toBe(oldEnvelope.ciphertext)
    expect(rewrapped.tag).toBe(oldEnvelope.tag)
    expect([...provider.unwrapOutputs[0]!]).toEqual(new Array<number>(32).fill(0))
    expect([...provider.wrapInputs.at(-1)!]).toEqual(new Array<number>(32).fill(0))

    provider.forget('invite-kek:v1')
    await expect(cipher.decrypt(context(), rewrapped)).resolves.toBe(TOKEN)
  })

  it('normalizes malformed envelope and unavailable unwrap/wrap KEK rewrap failures', async () => {
    const provider = new RotatingInviteKekProvider('invite-kek:v1')
    const cipher = new TeamInviteCipher({ keyEncryptionProvider: provider })
    const envelope = await cipher.encrypt(context(), TOKEN)
    provider.rotate('invite-kek:v2')

    await expectSafeRewrapFailure(cipher.rewrap(
      context(),
      { version: 7 } as unknown as TeamInviteTokenEnvelope,
    ))
    provider.failNextWrap()
    await expectSafeRewrapFailure(cipher.rewrap(context(), envelope))
    provider.forget('invite-kek:v1')
    await expectSafeRewrapFailure(cipher.rewrap(context(), envelope))
  })

  it('rejects a token whose SHA-256 digest does not match the bound digest', async () => {
    const provider = new RotatingInviteKekProvider()
    const cipher = new TeamInviteCipher({ keyEncryptionProvider: provider })

    await expect(cipher.encrypt(context({ tokenDigest: sha256('wrong-token') }), TOKEN))
      .rejects.toThrow('Team invite token does not match tokenDigest')
  })
})
