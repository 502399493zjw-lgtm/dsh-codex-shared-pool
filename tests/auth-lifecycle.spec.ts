import type { AuthInteraction } from '@earendil-works/pi-ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenAICodexCredentialStore } from '../src/store.ts'
import { LocalRoutingEventLedger } from '../src/local-routing-events.ts'

interface LoginAttemptOptions {
  beforeCommit(): void
}

const auth = vi.hoisted(() => ({
  loginOpenAICodex: vi.fn(),
  loginOpenAICodexProfile: vi.fn(),
  logoutOpenAICodex: vi.fn(),
  openAICodexAuthStatus: vi.fn(),
}))

const usage = vi.hoisted(() => ({
  readOpenAICodexRateLimits: vi.fn(),
}))

vi.mock('../src/auth.ts', () => auth)
vi.mock('../src/usage.ts', () => usage)

describe('OpenAI Codex Web auth lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    auth.openAICodexAuthStatus.mockResolvedValue({ authenticated: false })
    usage.readOpenAICodexRateLimits.mockResolvedValue({ rateLimits: [] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('cancels a browser login whose provider prompt remains pending', async () => {
    auth.loginOpenAICodexProfile.mockImplementation(async (interaction: AuthInteraction) => {
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.test/authorize' })
      await interaction.prompt({
        type: 'manual_code',
        message: 'Paste the authorization code',
        signal: new AbortController().signal,
      })
      throw new Error('manual code prompt unexpectedly resolved')
    })
    const { OpenAICodexWebAuth } = await import('../src/auth-routes.ts')
    const store = {
      listProfiles: () => Promise.resolve([]),
    } as unknown as OpenAICodexCredentialStore
    const webAuth = new OpenAICodexWebAuth(store)

    await expect(webAuth.signInProfile()).resolves.toEqual({
      url: 'https://auth.openai.test/authorize',
    })
    await expect(webAuth.profilesStatus()).resolves.toEqual({ status: 'signing-in' })

    await expect(webAuth.cancelSignIn()).resolves.toBe(true)
    await expect(webAuth.profilesStatus()).resolves.toEqual({ status: 'ready', profiles: [] })
    await expect(webAuth.cancelSignIn()).resolves.toBe(false)
  }, 5_000)

  it('invalidates a cancelled attempt before a late callback can add a profile', async () => {
    let finishProvider: (() => void) | undefined
    const providerFinished = new Promise<void>((resolve) => { finishProvider = resolve })
    const addProfile = vi.fn(async () => ({
      id: 'late-profile',
      label: 'Late profile',
      createdAt: 1,
      updatedAt: 1,
    }))
    auth.loginOpenAICodexProfile.mockImplementation(async (
      interaction: AuthInteraction,
      _store: OpenAICodexCredentialStore,
      options: LoginAttemptOptions,
    ) => {
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.test/authorize' })
      await providerFinished
      options.beforeCommit()
      await addProfile()
    })
    const { OpenAICodexWebAuth } = await import('../src/auth-routes.ts')
    const store = {
      listProfiles: () => Promise.resolve([]),
      addProfile,
    } as unknown as OpenAICodexCredentialStore
    const webAuth = new OpenAICodexWebAuth(store)

    await expect(webAuth.signInProfile()).resolves.toEqual({
      url: 'https://auth.openai.test/authorize',
    })
    const cancellation = webAuth.cancelSignIn()
    finishProvider?.()

    await expect(cancellation).resolves.toBe(true)
    await webAuth.waitForCompletion()
    expect(addProfile).not.toHaveBeenCalled()
    await expect(webAuth.profilesStatus()).resolves.toEqual({ status: 'ready', profiles: [] })
    await expect(webAuth.cancelSignIn()).resolves.toBe(false)
  })

  it('lets an OAuth commit that won the race finish and reports cancellation as a no-op', async () => {
    let finishCommit: (() => void) | undefined
    const commitFinished = new Promise<void>((resolve) => { finishCommit = resolve })
    const addProfile = vi.fn(async () => {
      await commitFinished
      return { id: 'profile-1', label: 'Profile 1', createdAt: 1, updatedAt: 1 }
    })
    auth.loginOpenAICodexProfile.mockImplementation(async (
      interaction: AuthInteraction,
      _store: OpenAICodexCredentialStore,
      options: LoginAttemptOptions,
    ) => {
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.test/authorize' })
      options.beforeCommit()
      await addProfile()
    })
    const { OpenAICodexWebAuth } = await import('../src/auth-routes.ts')
    const store = {
      listProfiles: () => Promise.resolve([
        { id: 'profile-1', label: 'Profile 1', createdAt: 1, updatedAt: 1 },
      ]),
      addProfile,
      forProfile: vi.fn(),
    } as unknown as OpenAICodexCredentialStore
    const webAuth = new OpenAICodexWebAuth(store)

    await expect(webAuth.signInProfile()).resolves.toEqual({
      url: 'https://auth.openai.test/authorize',
    })
    await expect(webAuth.cancelSignIn()).resolves.toBe(false)
    finishCommit?.()
    await webAuth.waitForCompletion()

    expect(addProfile).toHaveBeenCalledOnce()
  })

  it('expires a pending attempt, aborts the provider, and exposes only a typed failure reason', async () => {
    vi.useFakeTimers()
    let providerSignal: AbortSignal | undefined
    auth.loginOpenAICodexProfile.mockImplementation(async (interaction: AuthInteraction) => {
      providerSignal = interaction.signal
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.test/authorize?code=secret-code' })
      await new Promise<void>((_resolve, reject) => {
        interaction.signal?.addEventListener('abort', () => reject(interaction.signal?.reason), { once: true })
      })
    })
    const { OpenAICodexWebAuth } = await import('../src/auth-routes.ts')
    const store = {
      listProfiles: () => Promise.resolve([]),
    } as unknown as OpenAICodexCredentialStore
    const AuthWithTimeout = OpenAICodexWebAuth as unknown as new (
      store: OpenAICodexCredentialStore,
      options: { timeoutMs: number },
    ) => InstanceType<typeof OpenAICodexWebAuth>
    const webAuth = new AuthWithTimeout(store, { timeoutMs: 25 })

    await webAuth.signInProfile()
    await vi.advanceTimersByTimeAsync(25)

    expect(providerSignal?.aborted).toBe(true)
    await expect(webAuth.profilesStatus()).resolves.toEqual({
      status: 'error',
      reason: 'authorization-timed-out',
    })
    expect(JSON.stringify(await webAuth.profilesStatus())).not.toContain('secret-code')
    await expect(webAuth.cancelSignIn()).resolves.toBe(false)
  })

  it('recovers as idle after Host restart without reviving an interrupted attempt', async () => {
    const { OpenAICodexWebAuth } = await import('../src/auth-routes.ts')
    const store = {
      listProfiles: () => Promise.resolve([]),
    } as unknown as OpenAICodexCredentialStore

    const restarted = new OpenAICodexWebAuth(store)

    await expect(restarted.profilesStatus()).resolves.toEqual({ status: 'ready', profiles: [] })
    await expect(restarted.cancelSignIn()).resolves.toBe(false)
  })

  it('does not project a raw Host error into browser status', async () => {
    auth.loginOpenAICodexProfile.mockImplementation(async (interaction: AuthInteraction) => {
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.test/authorize' })
      throw new Error('callback failed code=secret-code at /private/host/auth.json')
    })
    const { OpenAICodexWebAuth } = await import('../src/auth-routes.ts')
    const store = {
      listProfiles: () => Promise.resolve([]),
    } as unknown as OpenAICodexCredentialStore
    const webAuth = new OpenAICodexWebAuth(store)

    await webAuth.signInProfile()
    await webAuth.waitForCompletion()
    const status = await webAuth.profilesStatus()

    expect(status).toEqual({ status: 'error', reason: 'authorization-failed' })
    expect(JSON.stringify(status)).not.toMatch(/secret-code|\/private\/host|auth\.json/u)
  })

  it('marks only the latest routed profile as in use without exposing it in receipts', async () => {
    const { OpenAICodexWebAuth } = await import('../src/auth-routes.ts')
    const profiles = [
      { id: 'profile-b', label: 'Second', createdAt: 1, updatedAt: 2 },
      { id: 'profile-a', label: 'First', createdAt: 1, updatedAt: 1 },
    ]
    const store = {
      listProfiles: () => Promise.resolve(profiles),
      forProfile: () => ({}),
    } as unknown as OpenAICodexCredentialStore
    const ledger = new LocalRoutingEventLedger({ id: () => 'event-1', now: () => 1 })
    ledger.begin({
      allocation: { profileId: 'profile-b', previousProfileId: 'profile-a', reason: 'quota_fallback' },
      profileOrder: profiles.map(profile => profile.id),
      model: 'gpt-5.6-sol',
    })

    const status = await new OpenAICodexWebAuth(store, {}, ledger).profilesStatus()

    expect(status).toEqual({
      status: 'ready',
      profiles: [
        { ...profiles[0], usage: { rateLimits: [] }, inUse: true },
        { ...profiles[1], usage: { rateLimits: [] }, inUse: false },
      ],
    })
    expect(JSON.stringify(ledger.list())).not.toContain('profile-b')
  })
})
