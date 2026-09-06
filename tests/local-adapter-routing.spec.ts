import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { OAuthCredential } from '@earendil-works/pi-ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOpenAICodexAdapter } from '../src/adapter.ts'
import { LocalRoutingEventLedger } from '../src/local-routing-events.ts'
import { OpenAICodexCredentialStore } from '../src/store.ts'
import { OPENAI_CODEX_USAGE_URL } from '../src/usage.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  vi.unstubAllGlobals()
  await context?.fiber.dispose()
  context = undefined
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

function successfulResponse(): Response {
  const events = [
    { type: 'response.created', response: { id: 'response-1' } },
    {
      type: 'response.output_item.added', output_index: 0,
      item: { type: 'message', id: 'message-1', role: 'assistant', content: [] },
    },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'hello' },
    {
      type: 'response.output_item.done', output_index: 0,
      item: { type: 'message', id: 'message-1', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'hello', annotations: [] }] },
    },
    { type: 'response.done', response: { id: 'response-1', status: 'completed', output: [],
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } },
  ]
  return new Response(`${events.map(event => `data: ${JSON.stringify(event)}`).join('\n\n')}\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  })
}

describe('local Codex adapter routing receipts', () => {
  it.each(['complete', 'abort', 'consumer-return'] as const)('settles a prepared request when its stream ends via %s', async (ending) => {
    root = await mkdtemp(join(tmpdir(), 'dsh-openai-codex-prepared-lifecycle-'))
    const store = new OpenAICodexCredentialStore(join(root, 'profiles.json'), () => 'session-1')
    await store.addProfile('Test account', credential('account-1'))
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url === OPENAI_CODEX_USAGE_URL) return quota(75)
      if (ending === 'abort') {
        controller.abort()
        throw new DOMException('request cancelled', 'AbortError')
      }
      return successfulResponse()
    }))
    const ledger = new LocalRoutingEventLedger()
    const adapter = createOpenAICodexAdapter(store, () => undefined, () => ({
      useFastMode: false, useNativeCompaction: false, useWebSocketContextReuse: false,
    }), ledger)
    context = new Context()
    await context.plugin(LlmRuntime)
    context.llm.registerAdapter(['openai-codex'], adapter)
    const prepared = await context.llm.prepareCall({ provider: 'openai-codex', model: 'gpt-5.6-sol' })
    const chunks = []
    for await (const chunk of prepared.stream({
      ...prepared.config,
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })],
      sessionId: 'session-1' as never,
      signal: controller.signal,
    })) {
      chunks.push(chunk)
      if (ending === 'consumer-return') break
    }

    expect(ledger.list()).toHaveLength(1)
    expect(ledger.list()[0]?.status).toBe(ending === 'complete' ? 'succeeded' : 'cancelled')
    if (ending === 'complete') expect(chunks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'finish', reason: expect.objectContaining({ kind: 'stop' }) }),
    ]))
  })

  it.each(['direct', 'prepared', 'runtime'] as const)('records fallback and settles a provider failure through %s dispatch', async (entry) => {
    root = await mkdtemp(join(tmpdir(), 'dsh-openai-codex-local-adapter-'))
    const store = new OpenAICodexCredentialStore(join(root, 'profiles.json'), () => 'private-session-id')
    const first = await store.addProfile('Private first label', credential('account-1'))
    const second = await store.addProfile('Private second label', credential('account-2'))
    const providerRequests: string[] = []
    const providerAccounts: Array<string | null> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const headers = input instanceof Request ? new Headers(input.headers) : new Headers(init?.headers)
      const accountId = headers.get('chatgpt-account-id')
      if (url === OPENAI_CODEX_USAGE_URL) {
        return quota(accountId === 'account-1' ? 0 : 75)
      }
      providerRequests.push(url)
      providerAccounts.push(accountId)
      return Response.json({ error: { message: 'controlled stop' } }, { status: 401 })
    }))
    const ledger = new LocalRoutingEventLedger({ id: () => 'event-1', now: () => 1_000 })
    const adapter = createOpenAICodexAdapter(
      store,
      () => undefined,
      () => ({ useFastMode: false, useNativeCompaction: false, useWebSocketContextReuse: false }),
      ledger,
    )

    const options: GenerateOptions = {
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'private test prompt' }],
        source: { kind: 'user' },
      })],
      sessionId: 'private-session-id' as never,
    }
    context = new Context()
    await context.plugin(LlmRuntime)
    context.llm.registerAdapter(['openai-codex'], adapter)
    const prepared = entry === 'prepared'
      ? await context.llm.prepareCall({ provider: options.provider, model: options.model })
      : undefined
    const chunks = []
    const stream = prepared !== undefined
      ? prepared.stream({ ...options, ...prepared.config })
      : entry === 'runtime' ? context.llm.stream(options) : adapter.stream(options)
    for await (const chunk of stream) chunks.push(chunk)

    expect(providerRequests).toHaveLength(1)
    expect(providerAccounts).toEqual(['account-2'])
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
