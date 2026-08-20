import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  TeamCredentialAuthorizationState,
  TeamCredentialBroker,
  TeamCredentialRef,
} from '../src/team/credentials.ts'
import {
  createTeamCredentialBrokerHttpHandler,
  RemoteTeamCredentialBroker,
  resolveTeamCredentialBrokerBaseUrl,
  TEAM_CREDENTIAL_BROKER_PATH_PREFIX,
} from '../src/team/remote-credentials.ts'

const INTERNAL_KEY = 'broker-secret-that-is-long-enough'
const ref: TeamCredentialRef = { teamId: 'team_123', accountId: 'account_456' }

const servers: Array<ReturnType<typeof createServer>> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => { if (error === undefined) resolve(); else reject(error) })
  })))
})

describe('remote Team credential broker boundary', () => {
  it('accepts only a fixed HTTPS broker path, with loopback HTTP reserved for development', () => {
    expect(resolveTeamCredentialBrokerBaseUrl('https://broker.example.test/v1/dsh-team-credential-broker'))
      .toBe('https://broker.example.test/v1/dsh-team-credential-broker')
    expect(resolveTeamCredentialBrokerBaseUrl('http://127.0.0.1:8788/v1/dsh-team-credential-broker/'))
      .toBe('http://127.0.0.1:8788/v1/dsh-team-credential-broker')
    expect(() => resolveTeamCredentialBrokerBaseUrl('http://broker.example.test/v1/dsh-team-credential-broker'))
      .toThrow(/HTTPS.*loopback/iu)
    expect(() => resolveTeamCredentialBrokerBaseUrl('https://user:secret@broker.example.test/v1/dsh-team-credential-broker'))
      .toThrow(/credentials/iu)
    expect(() => resolveTeamCredentialBrokerBaseUrl('https://broker.example.test/proxy?target=openai'))
      .toThrow(/query|fixed.*path/iu)
  })

  it('authenticates fixed operations, synchronizes OAuth completion, and streams Responses without forwarding its key', async () => {
    const challenge = {
      method: 'device_code' as const,
      verificationUrl: 'https://auth.openai.com/device',
      userCode: 'ABCD-EFGH',
      expiresAt: Date.now() + 60_000,
    }
    const authorizationStates: TeamCredentialAuthorizationState[] = [
      { status: 'authorizing' },
      { status: 'active' },
    ]
    const forwarded = vi.fn(async (_ref: TeamCredentialRef, request: Parameters<TeamCredentialBroker['forwardResponses']>[1]) => {
      expect(request.headers).toEqual({
        accept: 'text/event-stream',
        'openai-beta': 'responses=experimental',
        'user-agent': 'stock-dsh',
      })
      return new Response('data: {"ok":true}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'x-request-id': 'provider-request' },
      })
    })
    const fake = fakeBroker({
      startOAuth: vi.fn(async () => challenge),
      inspectAuthorization: vi.fn(async () => authorizationStates.shift() ?? { status: 'active' }),
      forwardResponses: forwarded,
    })
    const baseUrl = await listen(fake)
    const onStatusChange = vi.fn(async () => undefined)
    const remote = new RemoteTeamCredentialBroker({
      baseUrl,
      resolveApiKey: async () => INTERNAL_KEY,
      pollIntervalMs: 10,
      onStatusChange,
    })

    await expect(remote.startOAuth(ref)).resolves.toEqual(challenge)
    await waitFor(() => onStatusChange.mock.calls.length === 1)
    expect(onStatusChange).toHaveBeenCalledWith(ref.teamId, ref.accountId, 'active', undefined, 'authorizing')
    await expect(remote.readUsage(ref)).resolves.toEqual({
      rateLimits: [{ id: 'codex', windows: [{ remainingPercent: 75, windowSeconds: 18_000 }] }],
    })

    const response = await remote.forwardResponses(ref, {
      model: 'gpt-5.3-codex',
      sessionId: 'session_789',
      body: '{"model":"gpt-5.3-codex"}',
      headers: {
        accept: 'text/event-stream',
        authorization: `Bearer ${INTERNAL_KEY}`,
        'openai-beta': 'responses=experimental',
        'user-agent': 'stock-dsh',
        cookie: 'secret=cookie',
      },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('x-request-id')).toBe('provider-request')
    expect(response.headers.has('x-dsh-team-broker-upstream')).toBe(false)
    await expect(response.text()).resolves.toBe('data: {"ok":true}\n\n')
    expect(forwarded).toHaveBeenCalledWith(ref, expect.objectContaining({
      model: 'gpt-5.3-codex',
      sessionId: 'session_789',
      body: '{"model":"gpt-5.3-codex"}',
    }))
    await remote.revoke(ref)
    expect(fake.revoke).toHaveBeenCalledWith(ref)
    await remote.dispose()
  })

  it('rejects an invalid internal key before reading or invoking a credential operation', async () => {
    const fake = fakeBroker()
    const baseUrl = await listen(fake)
    const remote = new RemoteTeamCredentialBroker({
      baseUrl,
      resolveApiKey: async () => 'wrong-secret-that-is-long-enough',
    })

    await expect(remote.readUsage(ref)).rejects.toThrow(/authentication|HTTP 401/iu)
    expect(fake.readUsage).not.toHaveBeenCalled()
    await remote.dispose()
  })

  it('bounds raw Responses bodies before invoking the provider-facing broker', async () => {
    const fake = fakeBroker()
    const handler = createTeamCredentialBrokerHttpHandler({
      broker: fake,
      resolveApiKey: async () => INTERNAL_KEY,
      maxForwardBodyBytes: 4,
    })
    const baseUrl = await listenHandler(handler)
    const remote = new RemoteTeamCredentialBroker({
      baseUrl,
      resolveApiKey: async () => INTERNAL_KEY,
    })

    await expect(remote.forwardResponses(ref, {
      model: 'gpt-5.3-codex',
      sessionId: 'session_789',
      body: '12345',
      headers: {},
    })).rejects.toThrow(/too large|HTTP 413/iu)
    expect(fake.forwardResponses).not.toHaveBeenCalled()
    await remote.dispose()
  })

  it('cancels provider forwarding when the remote client disconnects during streaming', async () => {
    let providerSignal: AbortSignal | undefined
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
    const fake = fakeBroker({
      forwardResponses: vi.fn(async (_ref, request) => {
        providerSignal = request.signal
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller
            controller.enqueue(new TextEncoder().encode('data: {"started":true}\n\n'))
          },
        }), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }),
    })
    let firstHandlerFinished = false
    const brokerHandler = createTeamCredentialBrokerHttpHandler({
      broker: fake,
      resolveApiKey: async () => INTERNAL_KEY,
      maxConcurrency: 1,
    })
    const baseUrl = await listenHandler(async (req, res) => {
      try { await brokerHandler(req, res) } finally { firstHandlerFinished = true }
    })
    const remote = new RemoteTeamCredentialBroker({
      baseUrl,
      resolveApiKey: async () => INTERNAL_KEY,
    })
    const cancellation = new AbortController()

    try {
      const response = await remote.forwardResponses(ref, {
        model: 'gpt-5.3-codex',
        sessionId: 'session_789',
        body: '{"model":"gpt-5.3-codex"}',
        headers: { accept: 'text/event-stream' },
        signal: cancellation.signal,
      })
      const reader = response.body!.getReader()
      await expect(reader.read()).resolves.toMatchObject({ done: false })

      cancellation.abort(new Error('Team gateway client disconnected'))

      await waitFor(() => providerSignal?.aborted === true)
      expect(providerSignal?.reason).toMatchObject({ message: 'credential broker client disconnected' })
      await waitFor(() => firstHandlerFinished)
      await expect(remote.readUsage(ref)).resolves.toMatchObject({ rateLimits: expect.any(Array) })
      await reader.cancel().catch(() => undefined)
    } finally {
      try { streamController?.close() } catch { /* stream already cancelled */ }
      await remote.dispose()
    }
  })

  it('cancels a provider usage read when the remote client times out', async () => {
    let providerSignal: AbortSignal | undefined
    let releaseUsage: ((usage: { rateLimits: readonly [] }) => void) | undefined
    const fake = fakeBroker({
      readUsage: vi.fn(async (_ref, signal) => {
        providerSignal = signal
        return new Promise(resolve => { releaseUsage = resolve })
      }),
    })
    const baseUrl = await listen(fake)
    const remote = new RemoteTeamCredentialBroker({
      baseUrl,
      resolveApiKey: async () => INTERNAL_KEY,
      jsonTimeoutMs: 100,
    })

    try {
      await expect(remote.readUsage(ref)).rejects.toThrow()
      await waitFor(() => providerSignal?.aborted === true)
      expect(providerSignal?.reason).toMatchObject({ message: 'credential broker client disconnected' })
    } finally {
      releaseUsage?.({ rateLimits: [] })
      await remote.dispose()
    }
  })

  it('applies a fixed internal request-rate guard before invoking broker capabilities', async () => {
    const fake = fakeBroker()
    const handler = createTeamCredentialBrokerHttpHandler({
      broker: fake,
      resolveApiKey: async () => INTERNAL_KEY,
      requestsPerMinute: 1,
    })
    const baseUrl = await listenHandler(handler)
    const remote = new RemoteTeamCredentialBroker({
      baseUrl,
      resolveApiKey: async () => INTERNAL_KEY,
    })

    await expect(remote.readUsage(ref)).resolves.toMatchObject({ rateLimits: expect.any(Array) })
    await expect(remote.readUsage(ref)).rejects.toThrow(/rate limit|HTTP 429/iu)
    expect(fake.readUsage).toHaveBeenCalledTimes(1)
    await remote.dispose()
  })
})

function fakeBroker(overrides: Partial<TeamCredentialBroker> = {}): TeamCredentialBroker & {
  readUsage: ReturnType<typeof vi.fn>
  forwardResponses: ReturnType<typeof vi.fn>
  revoke: ReturnType<typeof vi.fn>
} {
  return {
    startOAuth: vi.fn(async () => { throw new Error('not used') }),
    restartOAuth: vi.fn(async () => { throw new Error('not used') }),
    cancelOAuth: vi.fn(async () => undefined),
    inspectAuthorization: vi.fn(async () => ({ status: 'active' as const })),
    readUsage: vi.fn(async () => ({
      rateLimits: [{ id: 'codex', windows: [{ remainingPercent: 75, windowSeconds: 18_000 }] }],
    })),
    forwardResponses: vi.fn(async () => new Response(null, { status: 204 })),
    revoke: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    ...overrides,
  } as TeamCredentialBroker & {
    readUsage: ReturnType<typeof vi.fn>
    forwardResponses: ReturnType<typeof vi.fn>
    revoke: ReturnType<typeof vi.fn>
  }
}

async function listen(broker: TeamCredentialBroker): Promise<string> {
  return listenHandler(createTeamCredentialBrokerHttpHandler({
    broker,
    resolveApiKey: async () => INTERNAL_KEY,
  }))
}

async function listenHandler(
  handler: ReturnType<typeof createTeamCredentialBrokerHttpHandler>,
): Promise<string> {
  const server = createServer((req, res) => { void handler(req, res) })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}${TEAM_CREDENTIAL_BROKER_PATH_PREFIX}`
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for broker status callback')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
