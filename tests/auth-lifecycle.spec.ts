import type { AuthInteraction } from '@earendil-works/pi-ai'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenAICodexCredentialStore } from '../src/store.ts'

const auth = vi.hoisted(() => ({
  loginOpenAICodex: vi.fn(),
  loginOpenAICodexProfile: vi.fn(),
  logoutOpenAICodex: vi.fn(),
  openAICodexAuthStatus: vi.fn(),
}))

vi.mock('../src/auth.ts', () => auth)

describe('OpenAI Codex Web auth lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    auth.openAICodexAuthStatus.mockResolvedValue({ authenticated: false })
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
})
