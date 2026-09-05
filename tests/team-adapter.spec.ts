import { zstdDecompressSync } from 'node:zlib'
import {
  createAssistantMessageEventStream,
} from '@earendil-works/pi-ai'
import type { Provider } from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOpenAICodexAdapter, createTeamClientProvider } from '../src/adapter.ts'
import { OpenAICodexResponseRuntime } from '../src/responses.ts'
import { createTeamCodexBearer } from '../src/team/client.ts'
import { TEAM_PATH_PREFIX } from '../src/team/types.ts'
import type { OpenAICodexCredentialStore } from '../src/store.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Team client Codex adapter', () => {
  it('rewrites both provider and model base URLs to the Team gateway', () => {
    const base = `https://pool.example.test${TEAM_PATH_PREFIX}`
    const provider = createTeamClientProvider(openaiCodexProvider(), base)
    expect(provider.baseUrl).toBe(base)
    expect(provider.getModels().length).toBeGreaterThan(0)
    expect(provider.getModels().every(model => model.baseUrl === base)).toBe(true)
  })

  it.each([
    [undefined, 'Team 请求受限'],
    ['shared_concurrency_reached', '共享并发'],
    ['weekly_shared_cost_reached', '每周共享预算'],
    ['untrusted-provider-secret', 'Team 请求受限'],
  ])('keeps Team 429 diagnostics distinct from ChatGPT quota (%s)', async (reason, expected) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'no Team capacity is available' }), {
      status: 429,
      headers: reason ? { 'x-dsh-team-limit-reasons': reason } : {},
    })))
    const provider = createTeamClientProvider(openaiCodexProvider(), `https://pool.example.test${TEAM_PATH_PREFIX}`)
    const onResponse = vi.fn()
    const stream = provider.streamSimple(provider.getModels()[0]!, { messages: [] }, {
      apiKey: createTeamCodexBearer('dsh_team_member-secret-1234567890'),
      transport: 'sse', maxRetries: 0, onResponse,
    })
    const result = await stream.result()
    expect(result.stopReason).toBe('error')
    expect(result.errorMessage).toContain(expected)
    expect(result.errorMessage).not.toMatch(/ChatGPT usage limit|untrusted-provider-secret/i)
    expect(onResponse).toHaveBeenCalledOnce()
  })

  it('drains a Team rejection body and preserves provider Retry-After policy', async () => {
    const rejection = new Response(JSON.stringify({ error: 'Team limit' }), {
      status: 429, headers: { 'retry-after': '120', 'x-dsh-team-limit-reasons': 'rate_limit' },
    })
    const fetch = vi.fn(async () => rejection)
    vi.stubGlobal('fetch', fetch)
    const provider = createTeamClientProvider(openaiCodexProvider(), `https://pool.example.test${TEAM_PATH_PREFIX}`)
    const result = await provider.streamSimple(provider.getModels()[0]!, { messages: [] }, {
      apiKey: createTeamCodexBearer('dsh_team_member-secret-1234567890'),
      transport: 'sse', maxRetries: 1, maxRetryDelayMs: 1,
    }).result()
    expect(rejection.bodyUsed).toBe(true)
    expect(fetch).toHaveBeenCalledOnce()
    expect(result.errorMessage).toContain('retry delay')
  })

  it('forces SSE when Team mode is active even if live preferences enable WebSocket reuse', () => {
    const source = openaiCodexProvider()
    const streamSimple = vi.fn(() => {
      const stream = createAssistantMessageEventStream()
      stream.end()
      return stream
    })
    const provider = { ...source, streamSimple } as Provider
    const runtime = new OpenAICodexResponseRuntime(() => ({
      useFastMode: false,
      useNativeCompaction: false,
      useWebSocketContextReuse: true,
    }), () => undefined, { forceSse: true })
    const model = provider.getModels()[0]
    if (model === undefined) throw new Error('Codex model catalog is empty')

    runtime.wrap(provider).streamSimple(model, { messages: [] }, { sessionId: 'session-1' })

    expect(streamSimple).toHaveBeenCalledWith(model, { messages: [] }, expect.objectContaining({ transport: 'sse' }))
  })

  it('sends native compaction to the configured Team endpoint instead of chatgpt.com', async () => {
    const responsesUrl = `https://pool.example.test${TEAM_PATH_PREFIX}/codex/responses`
    const fetch = vi.fn(async () => new Response('not available', { status: 400 }))
    vi.stubGlobal('fetch', fetch)
    const source = openaiCodexProvider()
    const fallback = vi.fn(() => {
      const stream = createAssistantMessageEventStream()
      stream.end()
      return stream
    })
    const provider = { ...source, streamSimple: fallback } as Provider
    const runtime = new OpenAICodexResponseRuntime(() => ({
      useFastMode: false,
      useNativeCompaction: true,
      useWebSocketContextReuse: false,
    }), () => undefined, { forceSse: true, responsesUrl })
    const model = provider.getModels()[0]
    if (model === undefined) throw new Error('Codex model catalog is empty')
    const release = runtime.enterCompaction('session-1')

    runtime.wrap(provider).streamSimple(model, { messages: [] }, {
      apiKey: createTeamCodexBearer('dsh_team_member-secret-1234567890'),
      sessionId: 'session-1',
      maxRetries: 0,
    })
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledOnce()
      expect(fallback).toHaveBeenCalled()
    })
    release()

    expect(fetch.mock.calls[0]?.[0]).toBe(responsesUrl)
  })

  it.each(['gpt-5.4', 'gpt-6-astra'])('streams %s with the Team credential and never allocates a local OAuth profile', async (model) => {
    const baseUrl = `https://pool.example.test${TEAM_PATH_PREFIX}`
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'test stop' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetch)
    const listProfiles = vi.fn(async () => [])
    const localCredentials = { listProfiles } as unknown as OpenAICodexCredentialStore
    const resolveApiKey = vi.fn(async () => createTeamCodexBearer('dsh_team_member-secret-1234567890'))
    const adapter = createOpenAICodexAdapter(
      localCredentials,
      () => undefined,
      () => ({ useFastMode: false, useNativeCompaction: false, useWebSocketContextReuse: true }),
      { baseUrl, resolveApiKey },
    )

    const consume = async () => {
      const chunks = []
      for await (const chunk of adapter.stream({
        provider: 'openai-codex',
        model,
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })],
        sessionId: 'session-1' as never,
      })) chunks.push(chunk)
      return chunks
    }
    const chunks = await consume()

    expect(resolveApiKey).toHaveBeenCalledOnce()
    expect(listProfiles).not.toHaveBeenCalled()
    expect(chunks).toEqual(expect.arrayContaining([expect.objectContaining({
      type: 'finish',
      reason: expect.objectContaining({ kind: 'error' }),
    })]))
    expect(fetch.mock.calls[0]?.[0]).toBe(`${baseUrl}/codex/responses`)
    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers)
    expect(headers.get('authorization')).toMatch(/^Bearer\s+[^\s]+\.[^\s]+\.[^\s]+$/u)
    expect(headers.get('content-encoding')).toBe('zstd')
    const body = JSON.parse(zstdDecompressSync(fetch.mock.calls[0]![1]!.body as Uint8Array).toString())
    expect(body.model).toBe(model)
  })
})
