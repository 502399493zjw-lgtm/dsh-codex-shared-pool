import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CredentialStore, OAuthCredential } from '@earendil-works/pi-ai'
import {
  allocateOpenAICodexSessionProfile,
  openAICodexQuotaBucket,
} from '../src/account-allocation.ts'
import { OpenAICodexCredentialStore, OPENAI_CODEX_PROVIDER } from '../src/store.ts'
import type { OpenAICodexUsage } from '../src/usage.ts'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function credential(accountId: string): OAuthCredential {
  return {
    type: 'oauth',
    access: `access-${accountId}`,
    refresh: `refresh-${accountId}`,
    expires: Date.now() + 60_000,
    accountId,
  }
}

function usage(
  codexRemaining: number | undefined,
  sparkRemaining?: number,
  individualRemaining = 100,
  codexResetsAt?: number,
): OpenAICodexUsage {
  return {
    rateLimits: [
      ...(codexRemaining === undefined ? [] : [{
        id: 'codex',
        windows: [{ remainingPercent: codexRemaining, windowSeconds: 604_800, ...codexResetsAt === undefined ? {} : { resetsAt: codexResetsAt } }],
      }]),
      ...(sparkRemaining === undefined ? [] : [{
        id: 'codex_spark',
        windows: [{ remainingPercent: sparkRemaining, windowSeconds: 604_800 }],
      }]),
    ],
    individualLimit: {
      limit: '100',
      used: String(100 - individualRemaining),
      remaining: String(individualRemaining),
      remainingPercent: individualRemaining,
    },
  }
}

async function setup(): Promise<{
  store: OpenAICodexCredentialStore
  firstId: string
  secondId: string
}> {
  root = await mkdtemp(join(tmpdir(), 'dsh-openai-codex-allocation-'))
  const store = new OpenAICodexCredentialStore(join(root, 'profiles.json'))
  const first = await store.addProfile('First', credential('account-1'))
  const second = await store.addProfile('Second', credential('account-2'))
  return { store, firstId: first.id, secondId: second.id }
}

async function addThird(store: OpenAICodexCredentialStore): Promise<string> {
  return (await store.addProfile('Third', credential('account-3'))).id
}

async function accountId(store: CredentialStore): Promise<string> {
  const value = await store.read(OPENAI_CODEX_PROVIDER)
  if (value?.type !== 'oauth' || typeof value.accountId !== 'string') throw new Error('expected OAuth account')
  return value.accountId
}

describe('OpenAI Codex account allocation', () => {
  it('selects the first eligible profile and stops the scan', async () => {
    const { store, firstId } = await setup()
    const readUsage = vi.fn(async () => usage(25))

    const allocation = await allocateOpenAICodexSessionProfile(store, 'session-1', 'gpt-5.6-sol', undefined, readUsage)

    expect(await store.sessionProfileId('session-1')).toBe(firstId)
    expect(allocation).toEqual({ profileId: firstId, reason: 'priority' })
    expect(readUsage).toHaveBeenCalledOnce()
  })

  it('promotes a model-specific fallback to global priority for the next model', async () => {
    const { store, firstId, secondId } = await setup()
    const readUsage = vi.fn(async (profile: CredentialStore) => (
      usage(await accountId(profile) === 'account-1' ? 0 : 50, 100)
    ))

    const codexAllocation = await allocateOpenAICodexSessionProfile(store, 'codex-session', 'gpt-5.6-sol', undefined, readUsage)
    const sparkAllocation = await allocateOpenAICodexSessionProfile(store, 'spark-session', 'gpt-5.3-codex-spark', undefined, readUsage)

    expect(openAICodexQuotaBucket('gpt-5.6-sol')).toBe('codex')
    expect(openAICodexQuotaBucket('gpt-5.3-codex-spark')).toBe('codex_spark')
    expect(await store.sessionProfileId('codex-session')).toBe(secondId)
    expect(await store.sessionProfileId('spark-session')).toBe(secondId)
    expect(codexAllocation).toEqual({
      profileId: secondId,
      previousProfileId: firstId,
      reason: 'quota_fallback',
    })
    expect(sparkAllocation).toEqual({ profileId: secondId, reason: 'priority' })
  })

  it('moves an existing Session to the next profile after exhaustion and reports the switch', async () => {
    const { store, firstId, secondId } = await setup()
    await store.bindSessionProfile('session-1', firstId)
    const onProfileSwitch = vi.fn()
    const readUsage = vi.fn(async (profile: CredentialStore) => (
      usage(await accountId(profile) === 'account-1' ? 0 : 60)
    ))

    const allocation = await allocateOpenAICodexSessionProfile(store, 'session-1', 'gpt-5.6-sol', undefined, readUsage, onProfileSwitch)

    expect(await store.sessionProfileId('session-1')).toBe(secondId)
    expect(onProfileSwitch).toHaveBeenCalledWith('session-1', firstId, secondId)
    expect(allocation).toEqual({
      profileId: secondId,
      previousProfileId: firstId,
      reason: 'quota_fallback',
    })
    expect((await store.listProfiles()).map(profile => profile.id)).toEqual([secondId, firstId])
  })

  it('promotes the usable fallback whose provider reset time is earliest', async () => {
    const { store, firstId, secondId } = await setup()
    const thirdId = await addThird(store)
    const readUsage = vi.fn(async (profile: CredentialStore) => {
      switch (await accountId(profile)) {
        case 'account-1': return usage(0, undefined, 100, 9_000)
        case 'account-2': return usage(65, undefined, 100, 7_000)
        case 'account-3': return usage(40, undefined, 100, 5_000)
        default: throw new Error('unexpected account')
      }
    })

    const allocation = await allocateOpenAICodexSessionProfile(
      store,
      'session-earliest-reset',
      'gpt-5.6-sol',
      undefined,
      readUsage,
    )

    expect(allocation).toEqual({
      profileId: thirdId,
      previousProfileId: firstId,
      reason: 'quota_fallback',
    })
    expect((await store.listProfiles()).map(profile => profile.id)).toEqual([thirdId, firstId, secondId])
    expect(readUsage).toHaveBeenCalledTimes(3)
  })

  it('does not promote unreadable quota ahead of a proven usable fallback', async () => {
    const { store, firstId, secondId } = await setup()
    const thirdId = await addThird(store)
    const readUsage = vi.fn(async (profile: CredentialStore) => {
      switch (await accountId(profile)) {
        case 'account-1': return usage(0, undefined, 100, 9_000)
        case 'account-2': throw new Error('quota unavailable')
        case 'account-3': return usage(30, undefined, 100, 5_000)
        default: throw new Error('unexpected account')
      }
    })

    const allocation = await allocateOpenAICodexSessionProfile(
      store,
      'session-known-capacity',
      'gpt-5.6-sol',
      undefined,
      readUsage,
    )

    expect(allocation?.profileId).toBe(thirdId)
    expect((await store.listProfiles()).map(profile => profile.id)).toEqual([thirdId, firstId, secondId])
  })

  it('uses the global priority for the next request and treats unreadable quota as eligible', async () => {
    const { store, firstId, secondId } = await setup()
    await store.bindSessionProfile('session-1', firstId)
    await store.prioritizeProfile(secondId)
    const readUsage = vi.fn(async (): Promise<OpenAICodexUsage> => {
      throw new Error('quota unavailable')
    })

    const allocation = await allocateOpenAICodexSessionProfile(store, 'session-1', 'gpt-5.6-sol', undefined, readUsage)

    expect(await store.sessionProfileId('session-1')).toBe(secondId)
    expect(readUsage).toHaveBeenCalledOnce()
    expect(allocation).toEqual({
      profileId: secondId,
      previousProfileId: firstId,
      reason: 'quota_unknown',
    })
  })

  it('retains an existing binding when every profile is proven exhausted', async () => {
    const { store, secondId } = await setup()
    await store.bindSessionProfile('session-1', secondId)

    const allocation = await allocateOpenAICodexSessionProfile(store, 'session-1', 'gpt-5.6-sol', undefined, () => Promise.resolve(usage(0)))

    expect(await store.sessionProfileId('session-1')).toBe(secondId)
    expect(allocation).toEqual({ profileId: secondId, reason: 'all_exhausted' })
  })
})
