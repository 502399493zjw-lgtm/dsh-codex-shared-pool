import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AuthInteraction, OAuthCredential } from '@earendil-works/pi-ai'
import { LocalTeamCredentialBroker } from '../src/team/credentials.ts'
import { OpenAICodexCredentialStore } from '../src/store.ts'
import { OPENAI_CODEX_RESPONSES_URL } from '../src/responses.ts'
import { TEAM_AUTHORIZATION_FAILED_CODE } from '../src/shared/team-management.ts'
import { sealTeamCredentialHandoff } from '../src/team/oauth-handoff.ts'

const usage = vi.hoisted(() => ({
  readOpenAICodexRateLimits: vi.fn(),
}))

vi.mock('../src/usage.ts', () => usage)

describe('Local Team credential broker', () => {
  it('accepts a one-time encrypted browser OAuth handoff without exposing the credential', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'dsh-team-browser-auth-'))
    const ref = { teamId: 'team-1', accountId: 'account-1' }
    try {
      const broker = new LocalTeamCredentialBroker({ rootDir })
      const challenge = await broker.startOAuth(ref, 'browser')
      expect(challenge.method).toBe('browser_handoff')
      if (challenge.method !== 'browser_handoff') throw new Error('expected browser handoff')
      const envelope = sealTeamCredentialHandoff(challenge.handoff, ref, {
        label: 'Owner Codex',
        credential: {
          type: 'oauth',
          access: 'host-only-access-token',
          refresh: 'host-only-refresh-token',
          expires: Date.now() + 60_000,
          accountId: 'chatgpt-account-1',
        },
      })

      await expect(broker.completeOAuthHandoff(ref, envelope)).resolves.toEqual({
        status: 'active',
        accountLabel: 'Owner Codex',
      })
      await expect(broker.completeOAuthHandoff(ref, envelope)).resolves.toEqual({
        status: 'active',
        accountLabel: 'Owner Codex',
      })
      expect(JSON.stringify(challenge)).not.toMatch(/host-only|chatgpt-account/iu)
      await broker.dispose()
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('inspects isolated credential state without returning OAuth material', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'dsh-team-inspect-auth-'))
    try {
      const ref = { teamId: 'team-1', accountId: 'account-1' }
      const broker = new LocalTeamCredentialBroker({ rootDir })

      const interrupted = await broker.inspectAuthorization(ref)
      expect(interrupted).toEqual({
        status: 'reauth_required',
        lastError: 'authorization was interrupted; authorize this account again',
      })

      const store = new OpenAICodexCredentialStore(join(rootDir, ref.teamId, `${ref.accountId}.json`))
      await store.addProfile('Owner Codex', {
        type: 'oauth',
        access: 'host-only-access-token',
        refresh: 'host-only-refresh-token',
        expires: Date.now() + 60_000,
        accountId: 'chatgpt-account-1',
      })
      const active = await broker.inspectAuthorization(ref)
      expect(active).toEqual({ status: 'active', accountLabel: 'Owner Codex' })
      expect(JSON.stringify(active)).not.toMatch(/access|refresh|chatgpt-account/iu)
      await broker.dispose()
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('uses provider device code login so a central broker does not depend on the contributor localhost', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'dsh-team-device-auth-'))
    try {
      let finishLogin: (() => void) | undefined
      const loginProfile = vi.fn(async (
        interaction: AuthInteraction,
        store: OpenAICodexCredentialStore,
      ) => {
        expect(await interaction.prompt({
          type: 'select',
          message: 'method',
          options: [{ id: 'browser', label: 'Browser' }, { id: 'device_code', label: 'Device code' }],
        })).toBe('device_code')
        interaction.notify({
          type: 'device_code',
          verificationUri: 'https://auth.openai.com/codex/device',
          userCode: 'ABCD-EFGH',
          expiresInSeconds: 900,
        })
        await new Promise<void>(resolve => { finishLogin = resolve })
        return store.addProfile('Owner Codex', {
          type: 'oauth',
          access: 'host-only-access-token',
          refresh: 'host-only-refresh-token',
          expires: Date.now() + 60_000,
          accountId: 'chatgpt-account-1',
        })
      })
      const broker = new LocalTeamCredentialBroker({ rootDir, loginProfile })

      const startedAt = Date.now()
      await expect(broker.startOAuth({ teamId: 'team-1', accountId: 'account-1' })).resolves.toMatchObject({
        method: 'device_code',
        verificationUrl: 'https://auth.openai.com/codex/device',
        userCode: 'ABCD-EFGH',
      })
      const challenge = await broker.startOAuth({ teamId: 'team-1', accountId: 'account-1' })
      expect(challenge.expiresAt).toBeGreaterThanOrEqual(startedAt + 899_000)
      expect(loginProfile).toHaveBeenCalledTimes(1)
      await expect(broker.inspectAuthorization({ teamId: 'team-1', accountId: 'account-1' }))
        .resolves.toEqual({ status: 'authorizing' })

      finishLogin?.()
      await broker.dispose()
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('replaces one stale isolated credential when restarting OAuth', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'dsh-team-reauth-'))
    const ref = { teamId: 'team-1', accountId: 'account-1' }
    try {
      const stale = new OpenAICodexCredentialStore(join(rootDir, ref.teamId, `${ref.accountId}.json`))
      await stale.addProfile('Stale Codex', {
        type: 'oauth', access: 'stale-access', refresh: 'stale-refresh', expires: 1, accountId: 'stale-account',
      })
      const broker = new LocalTeamCredentialBroker({
        rootDir,
        loginProfile: async (interaction, store) => {
          interaction.notify({
            type: 'device_code', verificationUri: 'https://auth.openai.com/codex/device', userCode: 'NEW-CODE', expiresInSeconds: 900,
          })
          return store.addProfile('Fresh Codex', {
            type: 'oauth', access: 'fresh-access', refresh: 'fresh-refresh', expires: Date.now() + 60_000, accountId: 'fresh-account',
          })
        },
      })

      const challenge = await broker.restartOAuth(ref)
      expect(challenge).toMatchObject({ method: 'device_code', userCode: 'NEW-CODE' })
      await broker.dispose()
      const profiles = await stale.listProfiles()
      expect(profiles).toHaveLength(1)
      expect(profiles[0]?.label).toBe('Fresh Codex')
      expect(JSON.stringify(challenge)).not.toMatch(/fresh-access|fresh-refresh|fresh-account/u)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('contains sanitized status-persistence failures from background OAuth completion', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'dsh-team-background-auth-'))
    try {
      const onBackgroundError = vi.fn()
      const broker = new LocalTeamCredentialBroker({
        rootDir,
        onStatusChange: async () => {
          throw new Error([
            'database unavailable',
            'Authorization: Bearer opaque-provider-token',
            'api_key=provider-api-secret',
            'client_secret=provider-client-secret',
            'id_token=provider-id-secret',
            'dsh_team_team-secret-1234567890',
            'dsh_invite_invite-secret-1234567890',
          ].join(' '))
        },
        onBackgroundError,
        loginProfile: async (interaction, store) => {
          interaction.notify({
            type: 'device_code',
            verificationUri: 'https://auth.openai.com/codex/device',
            userCode: 'ABCD-EFGH',
            expiresInSeconds: 900,
          })
          return store.addProfile('Owner Codex', {
            type: 'oauth',
            access: 'host-only-access-token',
            refresh: 'host-only-refresh-token',
            expires: Date.now() + 60_000,
            accountId: 'chatgpt-account-1',
          })
        },
      })

      await expect(broker.startOAuth({ teamId: 'team-1', accountId: 'account-1' }))
        .resolves.toMatchObject({ userCode: 'ABCD-EFGH' })
      await vi.waitFor(() => {
        expect(onBackgroundError).toHaveBeenCalledTimes(1)
      })
      const diagnostic = String(onBackgroundError.mock.calls[0]?.[0])
      expect(diagnostic).toContain('[redacted')
      expect(diagnostic).not.toMatch(/opaque-provider-token|provider-api-secret|provider-client-secret|provider-id-secret|dsh_team_|dsh_invite_/u)
      await expect(broker.dispose()).resolves.toBeUndefined()
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('projects provider failures to a closed stable code before status persistence', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'dsh-team-provider-error-auth-'))
    try {
      const onStatusChange = vi.fn()
      const broker = new LocalTeamCredentialBroker({
        rootDir,
        onStatusChange,
        loginProfile: async (interaction) => {
          interaction.notify({
            type: 'device_code',
            verificationUri: 'https://auth.openai.com/codex/device',
            userCode: 'ABCD-EFGH',
            expiresInSeconds: 900,
          })
          throw new Error('OAuth failed Authorization: Bearer opaque-provider-token client_secret=provider-client-secret')
        },
      })

      await expect(broker.startOAuth({ teamId: 'team-1', accountId: 'account-1' }))
        .resolves.toMatchObject({ userCode: 'ABCD-EFGH' })
      await vi.waitFor(() => {
        expect(onStatusChange).toHaveBeenCalledWith(
          'team-1',
          'account-1',
          'reauth_required',
          TEAM_AUTHORIZATION_FAILED_CODE,
          'authorizing',
        )
      })
      const diagnostic = String(onStatusChange.mock.calls[0]?.[3])
      expect(diagnostic).not.toMatch(/OAuth failed|opaque-provider-token|provider-client-secret/u)
      await broker.dispose()
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('persists a closed OAuth code when a usage refresh discovers stale authentication', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'dsh-team-usage-auth-'))
    const ref = { teamId: 'team-1', accountId: 'account-1' }
    const providerError = new Error(
      'OpenAI Codex OAuth credential expired Authorization: Bearer opaque-provider-token',
    )
    try {
      const onStatusChange = vi.fn()
      usage.readOpenAICodexRateLimits.mockRejectedValueOnce(providerError)
      const broker = new LocalTeamCredentialBroker({ rootDir, onStatusChange })

      await expect(broker.readUsage(ref)).rejects.toBe(providerError)
      expect(onStatusChange).toHaveBeenCalledWith(
        'team-1',
        'account-1',
        'reauth_required',
        TEAM_AUTHORIZATION_FAILED_CODE,
        'active',
      )
      expect(JSON.stringify(onStatusChange.mock.calls))
        .not.toMatch(/opaque-provider-token|Authorization: Bearer/iu)
      await broker.dispose()
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('keeps non-authentication usage failures transient and does not rewrite durable status', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'dsh-team-usage-transient-'))
    const ref = { teamId: 'team-1', accountId: 'account-1' }
    const providerError = new Error('OpenAI Codex usage request failed with HTTP 429')
    try {
      const onStatusChange = vi.fn()
      usage.readOpenAICodexRateLimits.mockRejectedValueOnce(providerError)
      const broker = new LocalTeamCredentialBroker({ rootDir, onStatusChange })

      await expect(broker.readUsage(ref)).rejects.toBe(providerError)
      expect(onStatusChange).not.toHaveBeenCalled()
      await broker.dispose()
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('labels OAuth completion as an authorizing-only state transition', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'dsh-team-transition-auth-'))
    try {
      const onStatusChange = vi.fn()
      const broker = new LocalTeamCredentialBroker({
        rootDir,
        onStatusChange,
        loginProfile: async (interaction, store) => {
          interaction.notify({
            type: 'device_code',
            verificationUri: 'https://auth.openai.com/codex/device',
            userCode: 'ABCD-EFGH',
            expiresInSeconds: 900,
          })
          return store.addProfile('Owner Codex', {
            type: 'oauth',
            access: 'host-only-access-token',
            refresh: 'host-only-refresh-token',
            expires: Date.now() + 60_000,
            accountId: 'chatgpt-account-1',
          })
        },
      })

      await broker.startOAuth({ teamId: 'team-1', accountId: 'account-1' })
      await vi.waitFor(() => {
        expect(onStatusChange).toHaveBeenCalledWith(
          'team-1',
          'account-1',
          'active',
          undefined,
          'authorizing',
          'Owner Codex',
        )
      })
      await broker.dispose()
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('injects OAuth only inside the fixed upstream request and discards caller authorization', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'dsh-team-broker-'))
    try {
      const ref = { teamId: 'team-1', accountId: 'account-1' }
      const store = new OpenAICodexCredentialStore(join(rootDir, ref.teamId, `${ref.accountId}.json`))
      const credential: OAuthCredential = {
        type: 'oauth',
        access: 'host-only-access-token',
        refresh: 'host-only-refresh-token',
        expires: Date.now() + 60_000,
        accountId: 'chatgpt-account-1',
      }
      await store.addProfile('Owner Codex', credential)
      const fetchMock = vi.fn<typeof fetch>(async () => new Response('ok', { status: 200 }))
      const broker = new LocalTeamCredentialBroker({ rootDir, fetch: fetchMock })

      await expect(broker.forwardResponses(ref, {
        model: 'gpt-5-codex',
        sessionId: 'session-1',
        body: '{"model":"gpt-5-codex","input":"private"}',
        headers: { authorization: 'Bearer team-secret', accept: 'text/event-stream' },
      })).resolves.toMatchObject({ status: 200 })

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0]!
      expect(url).toBe(OPENAI_CODEX_RESPONSES_URL)
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe('Bearer host-only-access-token')
      expect(headers.get('chatgpt-account-id')).toBe('chatgpt-account-1')
      expect(headers.get('session-id')).toBe('session-1')
      expect(init?.body).not.toContain('team-secret')
      await broker.dispose()
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})
