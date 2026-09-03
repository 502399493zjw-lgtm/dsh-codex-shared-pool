import type { AuthInteraction } from '@earendil-works/pi-ai'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenAICodexCredentialStore } from '../src/store.ts'
import type { OpenAICodexProfileStore } from '../src/store.ts'

const model = vi.hoisted(() => ({
  createModels: vi.fn(({ credentials }: { credentials: {
    modify(providerId: string, fn: (current: undefined) => Promise<unknown>): Promise<unknown>
  } }) => ({
    setProvider: vi.fn(),
    login: vi.fn(async () => credentials.modify('openai-codex', async () => ({
      type: 'oauth',
      access: 'captured-access-token',
      refresh: 'captured-refresh-token',
      expires: 4_102_444_800_000,
      accountId: 'account-1',
    }))),
  })),
}))

vi.mock('@earendil-works/pi-ai', () => ({
  createModels: model.createModels,
}))

vi.mock('@earendil-works/pi-ai/providers/openai-codex', () => ({
  openaiCodexProvider: vi.fn(() => ({ id: 'openai-codex' })),
}))

import { loginOpenAICodexLocalProfile, loginOpenAICodexProfile } from '../src/auth.ts'

const interaction = {
  notify: vi.fn(),
  prompt: vi.fn(),
} as unknown as AuthInteraction

describe('OpenAI Codex OAuth commit gate', () => {
  const temporaryRoots: string[] = []

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  })

  it('does not persist a captured credential when Host invalidates the attempt before commit', async () => {
    const cancellation = new Error('authorization attempt cancelled')
    const addProfile = vi.fn()
    const store = { addProfile } as unknown as OpenAICodexProfileStore

    await expect(loginOpenAICodexProfile(interaction, store, {
      beforeCommit: () => { throw cancellation },
    })).rejects.toBe(cancellation)

    expect(addProfile).not.toHaveBeenCalled()
  })

  it('reauthorizes an already-stored local account in place after OAuth completes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-codex-local-reauthorize-'))
    temporaryRoots.push(root)
    const store = new OpenAICodexCredentialStore(join(root, 'profiles.json'))
    const existing = await store.addProfile('Existing label', {
      type: 'oauth',
      access: 'old-access-token',
      refresh: 'old-refresh-token',
      expires: 1,
      accountId: 'account-1',
    })
    const other = await store.addProfile('Other account', {
      type: 'oauth',
      access: 'other-access-token',
      refresh: 'other-refresh-token',
      expires: 2,
      accountId: 'account-2',
    })
    await store.bindSessionProfile('session-1', existing.id)

    await expect(loginOpenAICodexLocalProfile(interaction, store)).resolves.toMatchObject({
      id: existing.id,
      label: 'Existing label',
      createdAt: existing.createdAt,
    })

    expect(await store.listProfiles()).toEqual([
      expect.objectContaining({ id: existing.id, label: 'Existing label', createdAt: existing.createdAt }),
      other,
    ])
    await expect(store.forProfile(existing.id).read('openai-codex')).resolves.toMatchObject({
      access: 'captured-access-token',
      refresh: 'captured-refresh-token',
      accountId: 'account-1',
    })
    await expect(store.forProfile(other.id).read('openai-codex')).resolves.toMatchObject({
      access: 'other-access-token',
      accountId: 'account-2',
    })
    await expect(store.sessionProfileId('session-1')).resolves.toBe(existing.id)
  })
})
