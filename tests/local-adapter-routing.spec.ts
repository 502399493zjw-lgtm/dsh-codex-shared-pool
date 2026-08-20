import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { OAuthCredential } from '@earendil-works/pi-ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOpenAICodexAdapter } from '../src/adapter.ts'
import { LocalRoutingEventLedger } from '../src/local-routing-events.ts'
import { OpenAICodexCredentialStore } from '../src/store.ts'
import { OPENAI_CODEX_USAGE_URL } from '../src/usage.ts'

let root: string | undefined

afterEach(async () => {
  vi.unstubAllGlobals()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function credential(accountId: string): OAuthCredential {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return {
    type: 'oauth',
    access: `${encode({ alg: 'none' })}.${encode({
      'https://api.openai.com/auth': { chatgpt_account_id: accountId },
    })}.signature`,
    refresh: `refresh-${accountId}`,
    expires: Date.now() + 3_600_000,
    accountId,
  }
}

function quota(remainingPercent: number): Response {
  return Response.json({
    rate_limit: {
      primary_window: {
        used_percent: 100 - remainingPercent,
        limit_window_seconds: 604_800,
      },
    },
  })
}

describe('local Codex adapter routing receipts', () => {
  it('records the actual fallback profile and settles a provider failure', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-openai-codex-local-adapter-'))
    const store = new OpenAICodexCredentialStore(join(root, 'profiles.json'), () => 'private-session-id')
    const first = await store.addProfile('Private first label', credential('account-1'))
    const second = await store.addProfile('Private second label', credential('account-2'))
    const providerRequests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const headers = input instanceof Request ? new Headers(input.headers) : new Headers(init?.headers)
      const accountId = headers.get('chatgpt-account-id')
      if (url === OPENAI_CODEX_USAGE_URL) {
        return quota(accountId === 'account-1' ? 0 : 75)
      }
      providerRequests.push(url)
      return Response.json({ error: { message: 'controlled stop' } }, { status: 401 })
    }))
    const ledger = new LocalRoutingEventLedger({ id: () => 'event-1', now: () => 1_000 })
    const adapter = createOpenAICodexAdapter(
      store,
      () => undefined,
      () => ({ useFastMode: false, useNativeCompaction: false, useWebSocketContextReuse: false }),
      ledger,
    )

    const chunks = []
    for await (const chunk of adapter.stream({
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'private test prompt' }],
        source: { kind: 'user' },
      })],
      sessionId: 'private-session-id' as never,
    })) chunks.push(chunk)

    expect(providerRequests).toHaveLength(1)
    expect(await store.sessionProfileId('private-session-id')).toBe(second.id)
    expect((await store.listProfiles()).map(profile => profile.id)).toEqual([second.id, first.id])
    expect(ledger.list()).toEqual([{
      id: 'event-1',
      profileAlias: 'A',
      previousProfileAlias: 'B',
      model: 'gpt-5.6-sol',
      reason: 'quota_fallback',
      unit: 'request',
      status: 'failed',
      startedAt: 1_000,
      finishedAt: 1_000,
    }])
    const serialized = JSON.stringify(ledger.list())
    expect(serialized).not.toContain(first.id)
    expect(serialized).not.toContain(second.id)
    expect(serialized).not.toContain('Private')
    expect(serialized).not.toContain('private-session-id')
    expect(serialized).not.toContain('private test prompt')
    expect(serialized).not.toContain('controlled stop')
  })
})
