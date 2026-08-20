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

function usage(codexRemaining: number | undefined, sparkRemaining?: number, individualRemaining = 100): OpenAICodexUsage {
  return {
    rateLimits: [
      ...(codexRemaining === undefined ? [] : [{
        id: 'codex',
        windows: [{ remainingPercent: codexRemaining, windowSeconds: 604_800 }],
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

async function accountId(store: CredentialStore): Promise<string> {
  const value = await store.read(OPENAI_CODEX_PROVIDER)
  if (value?.type !== 'oauth' || typeof value.accountId !== 'string') throw new Error('expected OAuth account')
  return value.accountId
}

describe('OpenAI Codex account allocation', () => {
  it('selects the first eligible profile and stops the scan', async () => {
    const { store, firstId } = await setup()
    const readUsage = vi.fn(async () => usage(25))

    await allocateOpenAICodexSessionProfile(store, 'session-1', 'gpt-5.6-sol', undefined, readUsage)

    expect(await store.sessionProfileId('session-1')).toBe(firstId)
    expect(readUsage).toHaveBeenCalledOnce()
  })

  it('fails over on the model-specific Codex bucket and keeps Spark separate', async () => {
    const { store, firstId, secondId } = await setup()
    const readUsage = vi.fn(async (profile: CredentialStore) => (
      usage(await accountId(profile) === 'account-1' ? 0 : 50, 100)
    ))

    await allocateOpenAICodexSessionProfile(store, 'codex-session', 'gpt-5.6-sol', undefined, readUsage)
    await allocateOpenAICodexSessionProfile(store, 'spark-session', 'gpt-5.3-codex-spark', undefined, readUsage)

    expect(openAICodexQuotaBucket('gpt-5.6-sol')).toBe('codex')
    expect(openAICodexQuotaBucket('gpt-5.3-codex-spark')).toBe('codex_spark')
    expect(await store.sessionProfileId('codex-session')).toBe(secondId)
    expect(await store.sessionProfileId('spark-session')).toBe(firstId)
  })

  it('moves an existing Session to the next profile after exhaustion and reports the switch', async () => {
    const { store, firstId, secondId } = await setup()
    await store.bindSessionProfile('session-1', firstId)
    const onProfileSwitch = vi.fn()
    const readUsage = vi.fn(async (profile: CredentialStore) => (
      usage(await accountId(profile) === 'account-1' ? 0 : 60)
    ))

    await allocateOpenAICodexSessionProfile(store, 'session-1', 'gpt-5.6-sol', undefined, readUsage, onProfileSwitch)

    expect(await store.sessionProfileId('session-1')).toBe(secondId)
    expect(onProfileSwitch).toHaveBeenCalledWith('session-1', firstId, secondId)
  })

  it('uses the global priority for the next request and treats unreadable quota as eligible', async () => {
    const { store, firstId, secondId } = await setup()
    await store.bindSessionProfile('session-1', firstId)
    await store.prioritizeProfile(secondId)
    const readUsage = vi.fn(async (): Promise<OpenAICodexUsage> => {
      throw new Error('quota unavailable')
    })

    await allocateOpenAICodexSessionProfile(store, 'session-1', 'gpt-5.6-sol', undefined, readUsage)

    expect(await store.sessionProfileId('session-1')).toBe(secondId)
    expect(readUsage).toHaveBeenCalledOnce()
  })

  it('retains an existing binding when every profile is proven exhausted', async () => {
    const { store, secondId } = await setup()
    await store.bindSessionProfile('session-1', secondId)

    await allocateOpenAICodexSessionProfile(store, 'session-1', 'gpt-5.6-sol', undefined, () => Promise.resolve(usage(0)))

    expect(await store.sessionProfileId('session-1')).toBe(secondId)
  })
})
