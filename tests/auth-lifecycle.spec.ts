import type { AuthInteraction } from '@earendil-works/pi-ai'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenAICodexCredentialStore } from '../src/store.ts'
import { LocalRoutingEventLedger } from '../src/local-routing-events.ts'

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

    const status = await new OpenAICodexWebAuth(store, ledger).profilesStatus()

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
