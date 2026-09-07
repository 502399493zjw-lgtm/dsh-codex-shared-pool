import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { OAuthCredential } from '@earendil-works/pi-ai'
import * as codexProvider from '@earendil-works/pi-ai/providers/openai-codex'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOpenAICodexAdapter } from '../src/adapter.ts'
import { LocalRoutingEventLedger } from '../src/local-routing-events.ts'
import { OpenAICodexCredentialStore } from '../src/store.ts'
import { createTeamCodexBearer } from '../src/team/client.ts'
import { TEAM_PATH_PREFIX } from '../src/team/types.ts'
import { OPENAI_CODEX_USAGE_URL } from '../src/usage.ts'

vi.mock('@earendil-works/pi-ai/providers/openai-codex', async importOriginal => {
  const source = await importOriginal<typeof import('@earendil-works/pi-ai/providers/openai-codex')>()
  return { ...source, openaiCodexProvider: vi.fn(source.openaiCodexProvider) }
})

const baseUrl = `https://pool.example.test${TEAM_PATH_PREFIX}`
const teamBearer = createTeamCodexBearer('dsh_team_auto-member-1234567890')
const roots: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.mocked(codexProvider.openaiCodexProvider).mockReset()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function localCredential(): OAuthCredential {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return {
    type: 'oauth',
    access: `${encode({ alg: 'none' })}.${encode({
      'https://api.openai.com/auth': { chatgpt_account_id: 'local-account' },
    })}.signature`,
    refresh: 'local-refresh', expires: Date.now() + 3_600_000, accountId: 'local-account',
  }
}

async function setup(resolveApiKey: () => Promise<string | undefined>, config: {
  useNativeCompaction?: boolean
  useWebSocketContextReuse?: boolean
  attachments?: AttachmentStore
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-auto-team-adapter-'))
  roots.push(root)
  const store = new OpenAICodexCredentialStore(join(root, 'profiles.json'), () => 'auto-session')
  await store.addProfile('Local account', localCredential())
  const listProfiles = vi.spyOn(store, 'listProfiles')
  const ledger = new LocalRoutingEventLedger()
  const requests: Array<{ url: string; bearer: string | null; body: string }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url === OPENAI_CODEX_USAGE_URL) return Response.json({ rate_limit: { primary_window: {
      used_percent: 20, limit_window_seconds: 604_800,
    } } })
    requests.push({
      url, bearer: new Headers(init?.headers).get('authorization'),
      body: init?.body instanceof Uint8Array ? zstdDecompressSync(init.body).toString() : String(init?.body),
    })
    return Response.json({ error: { message: 'controlled stop' } }, { status: 401 })
  }))
  const adapter = createOpenAICodexAdapter(store, () => config.attachments, () => ({
    useFastMode: false,
    useNativeCompaction: config.useNativeCompaction ?? false,
    useWebSocketContextReuse: config.useWebSocketContextReuse ?? false,
  }), { baseUrl, resolveApiKey, useLocalWhenUnconfigured: true }, ledger)
  return { adapter, ledger, requests, listProfiles }
}

function options(text = 'hello'): GenerateOptions {
  return {
    provider: 'openai-codex', model: 'gpt-5.6-sol', sessionId: 'auto-session' as never,
    messages: [createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })],
  }
}

async function consume(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('automatic cloud Team adapter', () => {
  it.each(['direct', 'prepared'] as const)('selects local, joined Team, then local again per %s stream', async (entry) => {
    let bearer: string | undefined
    const resolveApiKey = vi.fn(async () => bearer)
    const { adapter, ledger, requests, listProfiles } = await setup(resolveApiKey)
    const prepared = entry === 'prepared' ? await adapter.prepareCall('openai-codex', 'gpt-5.6-sol') : undefined
    const stream = () => prepared?.stream(options()) ?? adapter.stream(options())
    expect(resolveApiKey).not.toHaveBeenCalled()

    await consume(stream())
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(requests[0]?.bearer).toBe(`Bearer ${localCredential().access}`)
    expect(ledger.list()).toHaveLength(1)
    expect(ledger.list()[0]?.status).toBe('failed')

    listProfiles.mockClear()
    bearer = teamBearer
    await consume(stream())
    expect(requests[1]?.url).toBe(`${baseUrl}/codex/responses`)
    expect(requests[1]?.bearer).toBe(`Bearer ${teamBearer}`)
    expect(listProfiles).not.toHaveBeenCalled()
    expect(ledger.list()).toHaveLength(1)

    bearer = undefined
    await consume(stream())
    expect(requests[2]?.url).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(ledger.list()).toHaveLength(2)
    expect(resolveApiKey).toHaveBeenCalledTimes(3)
  })

  it('freezes concurrent prepared streams to their own route and resolved bearer', async () => {
    const resolvers: Array<(value: string | undefined) => void> = []
    const resolveApiKey = vi.fn(() => new Promise<string | undefined>(resolve => resolvers.push(resolve)))
    const { adapter, requests, ledger } = await setup(resolveApiKey)
    const prepared = await adapter.prepareCall('openai-codex', 'gpt-5.6-sol')
    const first = consume(prepared.stream(options('first local')))
    const second = consume(prepared.stream(options('second Team')))
    await vi.waitFor(() => expect(resolvers).toHaveLength(2))
    resolvers[1]!(teamBearer)
    await second
    resolvers[0]!(undefined)
    await first
    expect(requests.map(request => request.url)).toEqual([
      `${baseUrl}/codex/responses`, 'https://chatgpt.com/backend-api/codex/responses',
    ])
    expect(requests[0]).toMatchObject({ bearer: `Bearer ${teamBearer}`, body: expect.stringContaining('second Team') })
    expect(requests[1]).toMatchObject({ bearer: `Bearer ${localCredential().access}`, body: expect.stringContaining('first local') })
    expect(ledger.list()).toHaveLength(1)
    expect(resolveApiKey).toHaveBeenCalledTimes(2)
  })

  it('isolates different Team bearers across overlapping prepared streams', async () => {
    const secondBearer = createTeamCodexBearer('dsh_team_second-member-1234567890')
    const resolveApiKey = vi.fn().mockResolvedValueOnce(teamBearer).mockResolvedValueOnce(secondBearer)
    const { adapter, requests, listProfiles } = await setup(resolveApiKey)
    const prepared = await adapter.prepareCall('openai-codex', 'gpt-5.6-sol')
    await Promise.all([
      consume(prepared.stream(options('first Team key'))),
      consume(prepared.stream(options('second Team key'))),
    ])
    expect(requests).toHaveLength(2)
    expect(requests.find(request => request.body.includes('first Team key'))?.bearer).toBe(`Bearer ${teamBearer}`)
    expect(requests.find(request => request.body.includes('second Team key'))?.bearer).toBe(`Bearer ${secondBearer}`)
    expect(requests.every(request => request.url === `${baseUrl}/codex/responses`)).toBe(true)
    expect(resolveApiKey).toHaveBeenCalledTimes(2)
    expect(listProfiles).not.toHaveBeenCalled()
  })

  it.each(['local', 'Team'] as const)('retains the prepared %s model snapshot after catalog changes', async (route) => {
    const source = codexProvider.openaiCodexProvider()
    vi.mocked(codexProvider.openaiCodexProvider).mockReturnValue(source)
    const { adapter, requests } = await setup(async () => route === 'local' ? undefined : teamBearer)
    const prepared = await adapter.prepareCall('openai-codex', 'gpt-5.6-sol')
    vi.mocked(codexProvider.openaiCodexProvider).mockReturnValue({ ...source, getModels: () => [] })
    await consume(prepared.stream(options()))
    expect(requests).toHaveLength(1)
    expect(JSON.parse(requests[0]!.body).model).toBe(prepared.model.id)
    expect(requests[0]?.url).toBe(route === 'local'
      ? 'https://chatgpt.com/backend-api/codex/responses' : `${baseUrl}/codex/responses`)
  })

  it.each(['local', 'Team'] as const)('preserves the stock prepared image policy for automatic %s requests', async (route) => {
    const ref: ImageAttachmentRef = {
      attachmentId: 'image-1' as never, mediaType: 'image/png', bytes: 4_000_000, width: 4000, height: 4000,
    }
    const readImageRequest = vi.fn(async () => ({
      variantId: 'variant-1', attachment: ref, data: new Uint8Array([1, 2, 3]),
      mediaType: 'image/jpeg', bytes: 3, width: 2048, height: 2048,
      depth: 'uchar', space: 'srgb', hasAlpha: false,
    }))
    const { adapter, requests } = await setup(async () => route === 'local' ? undefined : teamBearer, {
      attachments: { readImageRequest } as unknown as AttachmentStore,
    })
    const prepared = await adapter.prepareCall('openai-codex', 'gpt-5.6-sol')
    await consume(prepared.stream({
      ...options(), messages: [createUserMessage({ content: [{ type: 'image', attachment: ref }], source: { kind: 'user' } })],
    }))
    expect(readImageRequest).toHaveBeenCalledExactlyOnceWith(ref, {
      maxPixels: 2048 * 2048, maxBytes: 1024 * 1024,
    }, expect.any(AbortSignal))
    expect(requests).toHaveLength(1)
    expect(requests[0]?.body).toContain('data:image/jpeg;base64,AQID')
  })

  it.each(['local', 'Team'] as const)('keeps native compaction and its cleanup on the selected %s runtime', async (route) => {
    const resolveApiKey = vi.fn(async () => route === 'local' ? undefined : teamBearer)
    const { adapter, requests } = await setup(resolveApiKey, { useNativeCompaction: true })
    const prepared = await adapter.prepareCall('openai-codex', 'gpt-5.6-sol')
    await consume(prepared.stream({ ...options(), purpose: 'compaction' }))
    expect(requests).toHaveLength(2)
    expect(requests[0]?.body).toContain('compaction_trigger')
    expect(requests[1]?.body).not.toContain('compaction_trigger')
    await consume(prepared.stream(options()))
    expect(requests).toHaveLength(3)
    expect(requests[2]?.body).not.toContain('compaction_trigger')
    expect(requests.every(request => request.url === (route === 'local'
      ? 'https://chatgpt.com/backend-api/codex/responses' : `${baseUrl}/codex/responses`))).toBe(true)
    expect(resolveApiKey).toHaveBeenCalledTimes(2)
  })

  it('preserves local WebSocket preferences while forcing Team SSE across route changes', async () => {
    const source = codexProvider.openaiCodexProvider()
    const streamSimple = vi.fn((...args: Parameters<typeof source.streamSimple>) => source.streamSimple(
      args[0], args[1], { ...args[2], transport: 'sse' },
    ))
    vi.mocked(codexProvider.openaiCodexProvider).mockReturnValue({ ...source, streamSimple })
    let bearer: string | undefined
    const { adapter } = await setup(async () => bearer, { useWebSocketContextReuse: true })
    const prepared = await adapter.prepareCall('openai-codex', 'gpt-5.6-sol')
    await consume(prepared.stream(options()))
    bearer = teamBearer
    await consume(prepared.stream(options()))
    bearer = undefined
    await consume(prepared.stream(options()))
    expect(streamSimple.mock.calls.map(call => call[2]?.transport)).toEqual(['websocket-cached', 'sse', 'websocket-cached'])
  })

  it.each(['429', 'transport'] as const)('does not allocate local OAuth after a Team %s failure', async (failure) => {
    const resolveApiKey = vi.fn(async () => teamBearer)
    const { adapter, listProfiles, ledger } = await setup(resolveApiKey)
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      if (failure === 'transport') throw new TypeError('controlled connection refused')
      return Response.json({ error: 'rate limited' }, { status: 429, headers: { 'retry-after': '120' } })
    })
    vi.stubGlobal('fetch', fetch)
    await consume(adapter.stream(options()))
    expect(fetch).toHaveBeenCalled()
    expect(fetch.mock.calls.every(call => String(call[0]) === `${baseUrl}/codex/responses`)).toBe(true)
    expect(listProfiles).not.toHaveBeenCalled()
    expect(ledger.list()).toEqual([])
    expect(resolveApiKey).toHaveBeenCalledOnce()
  })

  it.each(['empty', 'read-failure'] as const)('does not select local after %s from the Team resolver', async (failure) => {
    const resolveApiKey = vi.fn(async () => {
      if (failure === 'read-failure') throw new Error('controlled credential read failure')
      return ''
    })
    const { adapter, requests, listProfiles, ledger } = await setup(resolveApiKey)
    try { await consume(adapter.stream(options())) } catch { /* a resolver error may reject the stream */ }
    expect(resolveApiKey).toHaveBeenCalledOnce()
    expect(requests).toEqual([])
    expect(listProfiles).not.toHaveBeenCalled()
    expect(ledger.list()).toEqual([])
  })
})
