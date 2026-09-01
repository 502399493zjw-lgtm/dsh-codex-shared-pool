import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  Aes256GcmTeamInviteKeyEncryptionProvider,
  decodeTeamInviteMasterKey,
  TeamInviteKeyDecryptionError,
  TeamInviteKeyEncryptionKeyring,
} from '../src/team/invite-key-encryption.ts'
import {
  TEAM_INVITE_CIPHER_DOMAIN,
} from '../src/team/invite-cipher.ts'
import type {
  TeamInviteKeyWrapContext,
  TeamInviteWrappedKey,
} from '../src/team/invite-cipher.ts'

const PRIMARY_KEY = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1))
const PREVIOUS_KEY = Buffer.from(Array.from({ length: 32 }, (_, index) => 255 - index))
const DEK = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 101))

function context(overrides: Partial<TeamInviteKeyWrapContext> = {}): TeamInviteKeyWrapContext {
  return {
    domain: TEAM_INVITE_CIPHER_DOMAIN,
    teamId: 'team-1',
    inviteId: 'invite-1',
    createdAt: 1_777_000_000_000,
    tokenDigest: 'a'.repeat(64),
    ...overrides,
  }
}

function provider(key = PRIMARY_KEY): Aes256GcmTeamInviteKeyEncryptionProvider {
  return new Aes256GcmTeamInviteKeyEncryptionProvider(key)
}

async function expectSafeFailure(operation: Promise<unknown>): Promise<void> {
  const error = await operation.catch(reason => reason)
  expect(error).toBeInstanceOf(TeamInviteKeyDecryptionError)
  expect(error).toMatchObject({
    code: 'team_invite_key_decryption_failed',
    message: 'Team invitation key could not be decrypted',
  })
  expect(String(error)).not.toMatch(/authenticate|cipher|nonce|tag|keyRef mismatch/iu)
}

describe('decodeTeamInviteMasterKey', () => {
  it('accepts canonical base64 and padded or unpadded base64url only when they decode to 32 bytes', () => {
    const standard = randomBytes(32).toString('base64')
    const url = randomBytes(32).toString('base64url')

    expect(decodeTeamInviteMasterKey(standard)).toEqual(Buffer.from(standard, 'base64'))
    expect(decodeTeamInviteMasterKey(url)).toEqual(Buffer.from(url, 'base64url'))
    expect(decodeTeamInviteMasterKey(`${url}=`)).toEqual(Buffer.from(url, 'base64url'))
  })

  it.each([
    ['not-base64!'],
    [' Zm9v'],
    ['Zm9v\n'],
    [Buffer.alloc(31).toString('base64')],
    [Buffer.alloc(33).toString('base64url')],
    [`${Buffer.alloc(32).toString('base64url')}==`],
    [`${Buffer.alloc(32).toString('base64')}extra`],
  ])('rejects malformed or non-256-bit material: %s', encoded => {
    expect(() => decodeTeamInviteMasterKey(encoded)).toThrow(/base64|32 bytes/u)
  })
})

describe('Aes256GcmTeamInviteKeyEncryptionProvider', () => {
  it('derives a stable, non-secret keyRef and wraps each DEK with a fresh 12-byte nonce and 16-byte tag', async () => {
    const firstProvider = provider()
    const sameKeyProvider = provider()
    const differentProvider = provider(PREVIOUS_KEY)

    expect(firstProvider.keyRef).toBe(sameKeyProvider.keyRef)
    expect(firstProvider.keyRef).not.toBe(differentProvider.keyRef)
    expect(firstProvider.keyRef).not.toContain(PRIMARY_KEY.toString('base64url'))

    const first = await firstProvider.wrapKey(context(), DEK)
    const second = await firstProvider.wrapKey(context(), DEK)

    expect(first).toMatchObject({ keyRef: firstProvider.keyRef })
    expect(first.ciphertext).toHaveLength(32)
    expect(first.nonce).toHaveLength(12)
    expect(first.tag).toHaveLength(16)
    expect(second.nonce).not.toEqual(first.nonce)
    await expect(firstProvider.unwrapKey(context(), first)).resolves.toEqual(DEK)
  })

  it.each([
    ['domain', { domain: 'other-domain' }],
    ['teamId', { teamId: 'team-2' }],
    ['inviteId', { inviteId: 'invite-2' }],
    ['createdAt', { createdAt: 1_777_000_000_001 }],
    ['tokenDigest', { tokenDigest: 'b'.repeat(64) }],
  ])('authenticates %s as wrapping AAD', async (_field, overrides) => {
    const encryption = provider()
    const wrapped = await encryption.wrapKey(context(), DEK)

    await expectSafeFailure(encryption.unwrapKey(context(overrides as Partial<TeamInviteKeyWrapContext>), wrapped))
  })

  it('accepts only its own keyRef and returns one safe failure for all unwrap errors', async () => {
    const encryption = provider()
    const wrapped = await encryption.wrapKey(context(), DEK)
    const mutations: TeamInviteWrappedKey[] = [
      { ...wrapped, keyRef: 'invite-kek:foreign' },
      { ...wrapped, ciphertext: Buffer.alloc(0) },
      { ...wrapped, ciphertext: Buffer.from(wrapped.ciphertext).fill(0) },
      { ...wrapped, nonce: Buffer.alloc(11) },
      { ...wrapped, tag: Buffer.alloc(15) },
      { keyRef: encryption.keyRef, ciphertext: wrapped.ciphertext },
    ]

    for (const mutation of mutations) await expectSafeFailure(encryption.unwrapKey(context(), mutation))
  })

  it('clears its in-memory KEK on idempotent disposal and fails closed afterwards', async () => {
    const encryption = provider()
    const internalKey = (encryption as unknown as { key: Buffer }).key
    const wrapped = await encryption.wrapKey(context(), DEK)

    expect([...internalKey]).not.toEqual(new Array<number>(32).fill(0))
    encryption.dispose()
    encryption.dispose()

    expect([...internalKey]).toEqual(new Array<number>(32).fill(0))
    await expect(encryption.wrapKey(context(), DEK)).rejects.toThrow(/disposed/u)
    await expectSafeFailure(encryption.unwrapKey(context(), wrapped))
  })
})

describe('TeamInviteKeyEncryptionKeyring', () => {
  it('writes with the active key and reads envelopes by exact keyRef across rotation', async () => {
    const previous = provider(PREVIOUS_KEY)
    const oldWrapped = await previous.wrapKey(context({ inviteId: 'invite-old' }), DEK)
    const active = provider(PRIMARY_KEY)
    const keyring = new TeamInviteKeyEncryptionKeyring(active, [previous])

    const newWrapped = await keyring.wrapKey(context({ inviteId: 'invite-new' }), DEK)

    expect(newWrapped.keyRef).toBe(active.keyRef)
    await expect(keyring.unwrapKey(context({ inviteId: 'invite-old' }), oldWrapped)).resolves.toEqual(DEK)
    await expect(keyring.unwrapKey(context({ inviteId: 'invite-new' }), newWrapped)).resolves.toEqual(DEK)
    await expectSafeFailure(keyring.unwrapKey(context(), { ...newWrapped, keyRef: 'invite-kek:unknown' }))
  })

  it('rejects duplicate keyRefs instead of making historical reads ambiguous', () => {
    expect(() => new TeamInviteKeyEncryptionKeyring(provider(), [provider()]))
      .toThrow(/duplicate.*keyRef/iu)
    expect(() => new TeamInviteKeyEncryptionKeyring(provider(PREVIOUS_KEY), [
      provider(PRIMARY_KEY),
      provider(PRIMARY_KEY),
    ])).toThrow(/duplicate.*keyRef/iu)
  })

  it('disposes and clears every provider once, then fails closed', async () => {
    const active = provider(PRIMARY_KEY)
    const previous = provider(PREVIOUS_KEY)
    const activeBytes = (active as unknown as { key: Buffer }).key
    const previousBytes = (previous as unknown as { key: Buffer }).key
    const keyring = new TeamInviteKeyEncryptionKeyring(active, [previous])
    const wrapped = await keyring.wrapKey(context(), DEK)

    await keyring.dispose()
    await keyring.dispose()

    expect([...activeBytes]).toEqual(new Array<number>(32).fill(0))
    expect([...previousBytes]).toEqual(new Array<number>(32).fill(0))
    await expect(keyring.wrapKey(context(), DEK)).rejects.toThrow(/disposed/u)
    await expectSafeFailure(keyring.unwrapKey(context(), wrapped))
  })
})
