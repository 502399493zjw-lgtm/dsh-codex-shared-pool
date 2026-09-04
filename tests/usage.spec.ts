import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OAuthCredential } from '@earendil-works/pi-ai'
import { OpenAICodexWebAuth } from '../src/auth-routes.ts'
import {
  OPENAI_CODEX_USAGE_URL,
  parseOpenAICodexUsage,
  readOpenAICodexRateLimits,
} from '../src/usage.ts'
import { OpenAICodexCredentialStore, OPENAI_CODEX_PROVIDER } from '../src/store.ts'
import { OpenAICodexAuthenticationError } from '../src/openai-codex-authentication-error.ts'

let root: string | undefined

afterEach(async () => {
  vi.unstubAllGlobals()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function payload(): unknown {
  return {
    plan_type: 'business',
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: 13, limit_window_seconds: 604_800 },
      secondary_window: { used_percent: 40.5, limit_window_seconds: 18_000 },
    },
    credits: { has_credits: true, unlimited: false, balance: '42.5' },
    spend_control: {
      reached: false,
      individual_limit: {
        limit: '100',
        used: '25',
        remaining: '75',
        remaining_percent: 75,
      },
    },
    additional_rate_limits: [{
      metered_feature: 'codex_spark',
      limit_name: 'Codex Spark',
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 0, limit_window_seconds: 604_800 },
      },
    }],
  }
}

async function authenticatedStore(expires = Date.now() + 3_600_000): Promise<OpenAICodexCredentialStore> {
  root = await mkdtemp(join(tmpdir(), 'dsh-openai-codex-usage-'))
  const store = new OpenAICodexCredentialStore(join(root, 'auth.json'))
  const credential: OAuthCredential = {
    type: 'oauth',
    access: 'access-secret',
    refresh: 'refresh-secret',
    expires,
    accountId: 'account-1',
  }
  await store.modify(OPENAI_CODEX_PROVIDER, () => Promise.resolve(credential))
  return store
}

describe('OpenAI Codex usage', () => {
  it('projects rolling percentages and exact provider-supported balances', () => {
    expect(parseOpenAICodexUsage(payload())).toEqual({
      planType: 'business',
      rateLimits: [
        {
          id: 'codex',
          name: 'Codex',
          windows: [
            { remainingPercent: 87, windowSeconds: 604_800 },
            { remainingPercent: 59.5, windowSeconds: 18_000 },
          ],
        },
        {
          id: 'codex_spark',
          name: 'Codex Spark',
          windows: [{ remainingPercent: 100, windowSeconds: 604_800 }],
        },
      ],
      credits: { unlimited: false, balance: '42.5' },
      individualLimit: {
        limit: '100',
        used: '25',
        remaining: '75',
        remainingPercent: 75,
      },
    })
  })

  it('rejects percentages that would make a quota bar misleading', () => {
    expect(() => parseOpenAICodexUsage({
      rate_limit: {
        primary_window: { used_percent: 101, limit_window_seconds: 18_000 },
      },
    })).toThrow(/invalid used percentage/)
  })

  it('reads the fixed usage endpoint with refreshed plugin credentials', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => response(payload()))
    vi.stubGlobal('fetch', fetchMock)
    const usage = await readOpenAICodexRateLimits(await authenticatedStore())

    expect(usage.rateLimits[0]?.windows[0]?.remainingPercent).toBe(87)
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe(OPENAI_CODEX_USAGE_URL)
    expect(init).toMatchObject({
      method: 'GET',
      redirect: 'error',
      headers: {
        authorization: 'Bearer access-secret',
        'chatgpt-account-id': 'account-1',
        'cache-control': 'no-store',
      },
    })
  })

  it('keeps a signed-in account usable when quota metadata is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: 'unavailable' }, 503)))
    const status = await new OpenAICodexWebAuth(await authenticatedStore()).status()

    expect(status).toEqual({
      status: 'signed-in',
      usage: { rateLimits: [] },
      quotaError: 'OpenAI Codex usage request failed with HTTP 503',
    })
    expect(status).not.toHaveProperty('expiresAt')
  })

  it.each([401, 403])('types HTTP %i as a reauthorization failure', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: 'unauthorized' }, status)))

    await expect(readOpenAICodexRateLimits(await authenticatedStore()))
      .rejects.toBeInstanceOf(OpenAICodexAuthenticationError)
  })

  it('types a rejected refresh for an expired credential as a reauthorization failure', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe('https://auth.openai.com/oauth/token')
      return response({ error: 'invalid_grant', error_description: 'refresh token expired' }, 400)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(readOpenAICodexRateLimits(await authenticatedStore(Date.now() - 1)))
      .rejects.toBeInstanceOf(OpenAICodexAuthenticationError)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('types a missing stored credential as a reauthorization failure', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-openai-codex-signed-out-'))
    const store = new OpenAICodexCredentialStore(join(root, 'auth.json'))

    await expect(readOpenAICodexRateLimits(store))
      .rejects.toBeInstanceOf(OpenAICodexAuthenticationError)
  })
})
