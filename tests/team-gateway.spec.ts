import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { zstdCompressSync } from 'node:zlib'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { DataType, newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import type {
  TeamCredentialBroker,
  TeamCredentialRef,
  TeamResponsesForwardRequest,
} from '../src/team/credentials.ts'
import { TeamCapacityProvider } from '../src/team/capacity.ts'
import { createTeamGatewayHandler, registerTeamGatewayRoute } from '../src/team/gateway.ts'
import { createTeamCodexBearer } from '../src/team/client.ts'
import { TeamService } from '../src/team/service.ts'
import { MemoryTeamStore } from '../src/team/store.ts'
import {
  POSTGRES_TEAM_MIGRATION_12_LOCK_SQL,
  POSTGRES_TEAM_MIGRATION_20_LOCK_SQL,
  PostgresTeamStore,
} from '../src/team/postgres-store.ts'
import { TeamTrafficGuardError } from '../src/team/traffic-guard.ts'
import type { TeamTrafficGuard } from '../src/team/traffic-guard.ts'
import type { OpenAICodexUsage } from '../src/usage.ts'
import { TEAM_CODEX_RESPONSES_PATH, TEAM_RESPONSES_PATH } from '../src/team/types.ts'

class GatewayBroker implements TeamCredentialBroker {
  readonly forwarded: TeamResponsesForwardRequest[] = []
  usageReads = 0

  startOAuth(_ref: TeamCredentialRef): Promise<{ method: 'device_code'; verificationUrl: string; userCode: string; expiresAt: number }> {
    return Promise.resolve({ method: 'device_code', verificationUrl: 'https://auth.example.test/codex/device', userCode: 'ABCD-EFGH', expiresAt: 1_800_000 })
  }
  restartOAuth(ref: TeamCredentialRef): ReturnType<TeamCredentialBroker['startOAuth']> { return this.startOAuth(ref) }
  cancelOAuth(): Promise<void> { return Promise.resolve() }
  inspectAuthorization(): Promise<{ status: 'active' }> { return Promise.resolve({ status: 'active' }) }
  revoke(): Promise<void> { return Promise.resolve() }
  dispose(): Promise<void> { return Promise.resolve() }

  readUsage(): Promise<OpenAICodexUsage> {
    this.usageReads += 1
    return Promise.resolve({
      rateLimits: [{
        id: 'codex',
        windows: [{ remainingPercent: 80, windowSeconds: 18_000, resetsAt: 50_000 }],
      }],
    })
  }

  forwardResponses(_ref: TeamCredentialRef, request: TeamResponsesForwardRequest): Promise<Response> {
    this.forwarded.push(request)
    return Promise.resolve(new Response('data: {"type":"response.completed"}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'x-request-id': 'upstream-request' },
    }))
  }
}

function request(method: string, body: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const payload = body === undefined ? '' : JSON.stringify(body)
  return rawRequest(method, payload === '' ? undefined : Buffer.from(payload), headers)
}

function rawRequest(method: string, body: Buffer | undefined, headers: Record<string, string> = {}): IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [body]) as unknown as IncomingMessage
  Object.assign(stream, {
    method,
    headers: { host: 'team.example.test', ...headers },
    socket: { remoteAddress: '10.0.0.2' },
  })
  return stream
}

function chunkedResponse(chunks: readonly string[], contentType: string): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }), { status: 200, headers: { 'content-type': contentType } })
}

async function response(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  req: IncomingMessage,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  let status = 0
  let headers: Record<string, string> = {}
  let body = ''
  let ended = false
  const res = Object.assign(new EventEmitter(), {
    writeHead(code: number, values: Record<string, string>) { status = code; headers = values },
    write(value: Uint8Array | string) { body += Buffer.from(value).toString('utf8'); return true },
    end(value?: Uint8Array | string) {
      if (value !== undefined) body += Buffer.from(value).toString('utf8')
      ended = true
    },
  })
  Object.defineProperty(res, 'writableEnded', { get: () => ended })
  await handler(req, res as unknown as ServerResponse)
  return { status, headers, body }
}

function disconnectableResponse(): { readonly res: ServerResponse; close: () => void } {
  const events = new EventEmitter()
  let ended = false
  Object.assign(events, {
    writeHead() { return events },
    write() { return true },
    end() { ended = true },
  })
  Object.defineProperty(events, 'writableEnded', { get: () => ended })
  return {
    res: events as unknown as ServerResponse,
    close: () => events.emit('close'),
  }
}

function postgresTestPool(): PgPool {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true })
  memory.public.interceptQueries((query) => {
    const normalized = query.trim()
    return normalized === POSTGRES_TEAM_MIGRATION_12_LOCK_SQL
      || normalized === POSTGRES_TEAM_MIGRATION_20_LOCK_SQL
      ? []
      : null
  })
  memory.public.registerFunction({
    name: 'pg_advisory_xact_lock',
    args: [DataType.integer, DataType.integer],
    returns: DataType.integer,
    implementation: () => 1,
  })
  memory.public.registerFunction({
    name: 'char_length',
    args: [DataType.text],
    returns: DataType.integer,
    implementation: (value: string) => value.length,
  })
  const adapter = memory.adapters.createPg()
  return new adapter.Pool() as unknown as PgPool
}

describe('Team Responses gateway', () => {
  it('registers both generic and Codex-native data-plane aliases with one handler', () => {
    const registered: Array<{ path: string; handler: unknown }> = []
    const context = {
      webServer: {
        register: vi.fn((route: { path: string; handler: unknown }) => {
          registered.push(route)
          return () => undefined
        }),
      },
      effect: (setup: () => unknown) => setup(),
    } as unknown as Context
    const service = new TeamService({ store: new MemoryTeamStore(), broker: new GatewayBroker() })

    registerTeamGatewayRoute(context, service)

    expect(registered.map(route => route.path)).toEqual([TEAM_RESPONSES_PATH, TEAM_CODEX_RESPONSES_PATH])
    expect(registered[0]?.handler).toBe(registered[1]?.handler)
  })

  it('authenticates a member, admits live quota, proxies without the Team key, and records metadata only', async () => {
    const broker = new GatewayBroker()
    const store = new MemoryTeamStore({ now: () => 1_000 })
    const service = new TeamService({
      store,
      broker,
      capacity: new TeamCapacityProvider(broker, { now: () => 1_000 }),
    })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const account = await store.createContributionAccount(owner, 'Owner Codex')
    await store.setContributionAccountStatus(owner.teamId, account.id, 'active')
    const handler = createTeamGatewayHandler(service)

    const result = await response(handler, request('POST', {
      model: 'gpt-5-codex',
      input: 'private prompt',
      stream: true,
      prompt_cache_key: 'session-1',
    }, {
      authorization: `Bearer ${boot.apiKey}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    }))

    expect(result).toMatchObject({ status: 200, headers: { 'content-type': 'text/event-stream' } })
    expect(result.body).toContain('response.completed')
    expect(broker.forwarded).toHaveLength(1)
    expect(broker.forwarded[0]).toMatchObject({ model: 'gpt-5-codex', sessionId: 'session-1' })
    expect(broker.forwarded[0]?.headers).not.toHaveProperty('authorization')
    expect(Buffer.from(broker.forwarded[0]!.body).toString('utf8')).toContain('private prompt')
    const events = await store.listUsageEvents(owner, 10)
    expect(events).toMatchObject([{ model: 'gpt-5-codex', status: 'succeeded', unit: 'request' }])
    expect(JSON.stringify(events)).not.toContain('private prompt')
  })

  it('returns an explicit capacity response when a contributor daily Credits limit blocks admission', async () => {
    const broker = new GatewayBroker()
    const store = new MemoryTeamStore()
    const service = new TeamService({ store, broker, capacity: new TeamCapacityProvider(broker) })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invite = await store.createInvite(owner, 60_000)
    const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
    const account = await store.createContributionAccount(owner, 'Owner Codex')
    await store.updateContributionAccount(owner, account.id, { dailySharedCreditLimit: 49_999 })
    await store.setContributionAccountStatus(owner.teamId, account.id, 'active')

    const result = await response(createTeamGatewayHandler(service), request('POST', {
      model: 'gpt-5-codex', input: [], stream: true,
    }, { authorization: `Bearer ${joined.apiKey}`, 'content-type': 'application/json' }))

    expect(result.status).toBe(429)
    expect(JSON.parse(result.body)).toMatchObject({
      code: 'TEAM_CAPACITY_UNAVAILABLE',
      reasons: ['daily_shared_credits_reached'],
    })
    expect(broker.forwarded).toHaveLength(0)
  })

  it('captures chunk-split streamed Responses usage while forwarding bytes unchanged', async () => {
    const payload = 'data: {"type":"response.completed","response":{"usage":{"input_tokens":120,"input_tokens_details":{"cached_tokens":40},"output_tokens":10}}}\n\n'
    const broker = new GatewayBroker()
    vi.spyOn(broker, 'forwardResponses').mockResolvedValueOnce(chunkedResponse([
      payload.slice(0, 17),
      payload.slice(17, 71),
      payload.slice(71),
    ], 'text/event-stream'))
    const store = new MemoryTeamStore()
    const service = new TeamService({ store, broker, capacity: new TeamCapacityProvider(broker) })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const account = await store.createContributionAccount(owner, 'Owner Codex')
    await store.setContributionAccountStatus(owner.teamId, account.id, 'active')

    const result = await response(createTeamGatewayHandler(service), request('POST', {
      model: 'gpt-5-codex', input: [], stream: true,
    }, { authorization: `Bearer ${boot.apiKey}`, 'content-type': 'application/json' }))

    expect(result.body).toBe(payload)
    expect(await store.listUsageEvents(owner, 10)).toMatchObject([{
      status: 'succeeded',
      credits: 130,
      creditsFormulaVersion: 'credits-v1',
    }])
  })

  it('captures non-stream Responses usage and ignores malformed numeric metadata', async () => {
    const broker = new GatewayBroker()
    vi.spyOn(broker, 'forwardResponses')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'response-1',
        usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 20 }, output_tokens: 5 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'response-2',
        usage: { input_tokens: -1, output_tokens: 'secret-not-a-number' },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const store = new MemoryTeamStore()
    const service = new TeamService({ store, broker, capacity: new TeamCapacityProvider(broker) })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const account = await store.createContributionAccount(owner, 'Owner Codex')
    await store.setContributionAccountStatus(owner.teamId, account.id, 'active')
    const handler = createTeamGatewayHandler(service)
    const headers = { authorization: `Bearer ${boot.apiKey}`, 'content-type': 'application/json' }

    await response(handler, request('POST', { model: 'gpt-5-codex', input: [], stream: false }, headers))
    await response(handler, request('POST', { model: 'gpt-5-codex', input: [], stream: false }, headers))

    const events = await store.listUsageEvents(owner, 10)
    expect(events[1]).toMatchObject({ credits: 105, creditsFormulaVersion: 'credits-v1' })
    expect(events[0]).not.toHaveProperty('credits')
    expect(JSON.stringify(events)).not.toContain('secret-not-a-number')
  })

  it('accepts the Host-only Codex bearer wrapper used by the Team client adapter', async () => {
    const broker = new GatewayBroker()
    const store = new MemoryTeamStore()
    const service = new TeamService({ store, broker, capacity: new TeamCapacityProvider(broker) })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const account = await store.createContributionAccount(owner, 'Owner Codex')
    await store.setContributionAccountStatus(owner.teamId, account.id, 'active')

    const result = await response(createTeamGatewayHandler(service), request('POST', {
      model: 'gpt-5.4', input: [], stream: true,
    }, {
      authorization: `Bearer ${createTeamCodexBearer(boot.apiKey)}`,
      'content-type': 'application/json',
    }))

    expect(result.status).toBe(200)
    expect(broker.forwarded).toHaveLength(1)
  })

  it('decompresses Codex zstd request bodies before validation and upstream forwarding', async () => {
    const broker = new GatewayBroker()
    const store = new MemoryTeamStore()
    const service = new TeamService({ store, broker, capacity: new TeamCapacityProvider(broker) })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const account = await store.createContributionAccount(owner, 'Owner Codex')
    await store.setContributionAccountStatus(owner.teamId, account.id, 'active')
    const payload = JSON.stringify({ model: 'gpt-5.4', input: 'private prompt', stream: true })

    const result = await response(createTeamGatewayHandler(service), rawRequest('POST', zstdCompressSync(payload), {
      authorization: `Bearer ${boot.apiKey}`,
      'content-type': 'application/json',
      'content-encoding': 'zstd',
    }))

    expect(result.status).toBe(200)
    expect(broker.forwarded[0]?.body).toBe(payload)
  })

  it('rejects missing Team authentication before reading provider quota', async () => {
    const broker = new GatewayBroker()
    const service = new TeamService({
      store: new MemoryTeamStore(),
      broker,
      capacity: new TeamCapacityProvider(broker),
    })
    const result = await response(createTeamGatewayHandler(service), request('POST', {
      model: 'gpt-5-codex', input: [], stream: true,
    }, { 'content-type': 'application/json' }))
    expect(result.status).toBe(401)
    expect(broker.usageReads).toBe(0)
    expect(broker.forwarded).toHaveLength(0)
  })

  it('coalesces live usage reads during the short provider cache window', async () => {
    const broker = new GatewayBroker()
    const provider = new TeamCapacityProvider(broker, { now: () => 1_000, ttlMs: 15_000 })
    const ref = { teamId: 'team-1', accountId: 'account-1' }
    const [first, second] = await Promise.all([
      provider.read(ref, 'gpt-5-codex'),
      provider.read(ref, 'gpt-5-codex'),
    ])
    expect(first).toEqual(second)
    expect(first).toMatchObject({ healthy: true, remainingPercent: 80, resetAt: 50_000 })
    expect(broker.usageReads).toBe(1)
  })

  it('waits for an in-flight forced refresh instead of admitting from stale cached usage', async () => {
    const broker = new GatewayBroker()
    const provider = new TeamCapacityProvider(broker, { now: () => 1_000, ttlMs: 15_000 })
    const ref = { teamId: 'team-1', accountId: 'account-1' }
    await expect(provider.read(ref, 'gpt-5-codex')).resolves.toMatchObject({
      healthy: true,
      remainingPercent: 80,
    })

    let finishRefresh: ((usage: OpenAICodexUsage) => void) | undefined
    const readUsage = vi.spyOn(broker, 'readUsage').mockImplementationOnce(() => new Promise(resolve => {
      finishRefresh = resolve
    }))
    const refreshing = provider.refresh(ref, 'gpt-5-codex')
    await Promise.resolve()

    let admissionReadSettled = false
    const admissionRead = provider.read(ref, 'gpt-5-codex').then(result => {
      admissionReadSettled = true
      return result
    })
    await Promise.resolve()
    expect(admissionReadSettled).toBe(false)

    finishRefresh?.({
      rateLimits: [{
        id: 'codex',
        windows: [{ remainingPercent: 0, windowSeconds: 18_000, resetsAt: 60_000 }],
      }],
    })
    await expect(refreshing).resolves.toMatchObject({ healthy: true, remainingPercent: 0 })
    await expect(admissionRead).resolves.toMatchObject({ healthy: true, remainingPercent: 0 })
    expect(readUsage).toHaveBeenCalledTimes(1)
  })

  it('settles an admitted request as failed when the broker cannot reach upstream', async () => {
    const broker = new GatewayBroker()
    vi.spyOn(broker, 'forwardResponses').mockRejectedValueOnce(new Error('upstream offline'))
    const store = new MemoryTeamStore()
    const service = new TeamService({ store, broker, capacity: new TeamCapacityProvider(broker) })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const account = await store.createContributionAccount(owner, 'Owner Codex')
    await store.setContributionAccountStatus(owner.teamId, account.id, 'active')

    const result = await response(createTeamGatewayHandler(service), request('POST', {
      model: 'gpt-5-codex', input: [], stream: true,
    }, { authorization: `Bearer ${boot.apiKey}`, 'content-type': 'application/json' }))
    expect(result.status).toBe(502)
    expect((await store.listUsageEvents(owner, 10))[0]?.status).toBe('failed')
    expect(result.body).not.toContain('upstream offline')
  })

  it('fails over within one request when an upstream account reaches a hard limit', async () => {
    const broker = new GatewayBroker()
    const forwardedAccounts: string[] = []
    vi.spyOn(broker, 'forwardResponses').mockImplementation(async (ref, request) => {
      broker.forwarded.push(request)
      forwardedAccounts.push(ref.accountId)
      return forwardedAccounts.length === 1
        ? new Response('provider-account-details-must-not-escape', { status: 429 })
        : new Response('data: {"type":"response.completed"}\n\n', {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          })
    })
    const store = new MemoryTeamStore()
    const service = new TeamService({ store, broker, capacity: new TeamCapacityProvider(broker) })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invite = await store.createInvite(owner, 60_000)
    const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
    const friend = await store.authenticateApiKey(joined.apiKey)
    if (friend === undefined) throw new Error('friend key should authenticate')
    const own = await store.createContributionAccount(owner, 'Owner Codex')
    const shared = await store.createContributionAccount(friend, 'Friend Codex')
    await store.setContributionAccountStatus(owner.teamId, own.id, 'active')
    await store.setContributionAccountStatus(owner.teamId, shared.id, 'active')
    const handler = createTeamGatewayHandler(service)
    const headers = { authorization: `Bearer ${boot.apiKey}`, 'content-type': 'application/json' }
    const body = { model: 'gpt-5-codex', input: [], stream: true, prompt_cache_key: 'failover-session' }

    const first = await response(handler, request('POST', body, headers))
    const sticky = await response(handler, request('POST', body, headers))

    expect(first).toMatchObject({ status: 200 })
    expect(first.body).toContain('response.completed')
    expect(first.body).not.toContain('provider-account-details')
    expect(sticky).toMatchObject({ status: 200 })
    expect(forwardedAccounts).toEqual([own.id, shared.id, shared.id])
    const events = await store.listUsageEvents(owner, 10)
    expect(events.filter(event => event.upstreamAccountId === own.id).map(event => event.status)).toEqual(['failed'])
    expect(events.filter(event => event.upstreamAccountId === shared.id).map(event => event.status)).toEqual(['succeeded', 'succeeded'])
  })

  it('returns canonical capacity exhaustion after a hard-limit response has no fallback', async () => {
    const broker = new GatewayBroker()
    vi.spyOn(broker, 'forwardResponses').mockResolvedValueOnce(
      new Response('private-provider-account-details', { status: 429 }),
    )
    const store = new MemoryTeamStore()
    const service = new TeamService({ store, broker, capacity: new TeamCapacityProvider(broker) })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const account = await store.createContributionAccount(owner, 'Owner Codex')
    await store.setContributionAccountStatus(owner.teamId, account.id, 'active')

    const result = await response(createTeamGatewayHandler(service), request('POST', {
      model: 'gpt-5-codex', input: [], stream: true,
    }, { authorization: `Bearer ${boot.apiKey}`, 'content-type': 'application/json' }))

    expect(result).toMatchObject({ status: 429 })
    expect(result.body).toContain('TEAM_CAPACITY_UNAVAILABLE')
    expect(result.body).not.toContain('private-provider-account-details')
    expect((await store.listUsageEvents(owner, 10))).toMatchObject([{ status: 'failed' }])
  })

  it('bounds hard-limit failover attempts inside one external request', async () => {
    const broker = new GatewayBroker()
    vi.spyOn(broker, 'forwardResponses').mockResolvedValue(
      new Response('provider-capacity-details', { status: 429 }),
    )
    const store = new MemoryTeamStore()
    const service = new TeamService({ store, broker, capacity: new TeamCapacityProvider(broker) })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    for (const label of ['First Codex', 'Second Codex', 'Third Codex']) {
      const account = await store.createContributionAccount(owner, label)
      await store.setContributionAccountStatus(owner.teamId, account.id, 'active')
    }

    const result = await response(createTeamGatewayHandler(service, {
      maxUpstreamAttemptsPerRequest: 2,
    }), request('POST', {
      model: 'gpt-5-codex', input: [], stream: true,
    }, { authorization: `Bearer ${boot.apiKey}`, 'content-type': 'application/json' }))

    expect(result).toMatchObject({ status: 429 })
    expect(result.body).toContain('TEAM_CAPACITY_UNAVAILABLE')
    expect(broker.forwardResponses).toHaveBeenCalledTimes(2)
    expect(await store.listUsageEvents(owner, 10)).toHaveLength(2)
  })

  it('enforces fixed per-key concurrency before a second request reaches the provider', async () => {
    let release: ((response: Response) => void) | undefined
    const blocked = new Promise<Response>(resolve => { release = resolve })
    const broker = new GatewayBroker()
    vi.spyOn(broker, 'forwardResponses').mockReturnValueOnce(blocked)
    const store = new MemoryTeamStore()
    const service = new TeamService({ store, broker, capacity: new TeamCapacityProvider(broker) })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const account = await store.createContributionAccount(owner, 'Owner Codex')
    await store.setContributionAccountStatus(owner.teamId, account.id, 'active')
    const handler = createTeamGatewayHandler(service, { maxConcurrencyPerKey: 1 })
    const headers = { authorization: `Bearer ${boot.apiKey}`, 'content-type': 'application/json' }
    const first = response(handler, request('POST', { model: 'gpt-5-codex', input: [], stream: true }, headers))
    await vi.waitFor(() => { expect(broker.forwarded).toHaveLength(0); expect(broker.usageReads).toBe(1) })

    const second = await response(handler, request('POST', { model: 'gpt-5-codex', input: [], stream: true }, headers))
    expect(second.status).toBe(429)
    expect(second.headers['retry-after']).toBeDefined()
    release?.(new Response('ok', { status: 200 }))
    await expect(first).resolves.toMatchObject({ status: 200 })
  })

  it('enforces a fixed per-key RPM guard independently of contribution limits', async () => {
    const broker = new GatewayBroker()
    const store = new MemoryTeamStore()
    const service = new TeamService({ store, broker, capacity: new TeamCapacityProvider(broker) })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const account = await store.createContributionAccount(owner, 'Owner Codex')
    await store.setContributionAccountStatus(owner.teamId, account.id, 'active')
    const handler = createTeamGatewayHandler(service, { requestsPerMinutePerKey: 1 })
    const headers = { authorization: `Bearer ${boot.apiKey}`, 'content-type': 'application/json' }
    await expect(response(handler, request('POST', { model: 'gpt-5-codex', input: [], stream: true }, headers)))
      .resolves.toMatchObject({ status: 200 })
    await expect(response(handler, request('POST', { model: 'gpt-5-codex', input: [], stream: true }, headers)))
      .resolves.toMatchObject({ status: 429 })
    expect(broker.forwarded).toHaveLength(1)
  })

  it('renews the traffic lease while an upstream request is still running', async () => {
    vi.useFakeTimers()
    try {
      let release: ((response: Response) => void) | undefined
      let markStarted: (() => void) | undefined
      const blocked = new Promise<Response>(resolve => { release = resolve })
      const started = new Promise<void>(resolve => { markStarted = resolve })
      const broker = new GatewayBroker()
      vi.spyOn(broker, 'forwardResponses').mockImplementation(() => {
        markStarted?.()
        return blocked
      })
      const store = new MemoryTeamStore()
      const boot = await store.bootstrap('Friends', 'Owner')
      const owner = await store.authenticateApiKey(boot.apiKey)
      if (owner === undefined) throw new Error('owner key should authenticate')
      const account = await store.createContributionAccount(owner, 'Owner Codex')
      await store.setContributionAccountStatus(owner.teamId, account.id, 'active')
      const renew = vi.fn().mockResolvedValue(undefined)
      const finish = vi.fn().mockResolvedValue(undefined)
      const guard: TeamTrafficGuard = {
        acquire: vi.fn().mockResolvedValue({ renew, finish }),
      }
      const handler = createTeamGatewayHandler(new TeamService({
        store,
        broker,
        capacity: new TeamCapacityProvider(broker),
      }), { heartbeatMs: 1_000, trafficGuard: guard })
      const pending = response(handler, request('POST', {
        model: 'gpt-5-codex', input: [], stream: true,
      }, { authorization: `Bearer ${boot.apiKey}`, 'content-type': 'application/json' }))

      await started
      await vi.advanceTimersByTimeAsync(1_000)
      expect(renew).toHaveBeenCalledTimes(1)
      release?.(new Response('ok', { status: 200 }))
      await expect(pending).resolves.toMatchObject({ status: 200 })
      expect(finish).toHaveBeenCalledWith('success')
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels upstream and settles metadata when the client disconnects during streaming', async () => {
    let rejectForward: ((error: Error) => void) | undefined
    let started: (() => void) | undefined
    let forwardedSignal: AbortSignal | undefined
    const forwarding = new Promise<Response>((_resolve, reject) => { rejectForward = reject })
    const forwardingStarted = new Promise<void>(resolve => { started = resolve })
    const broker = new GatewayBroker()
    vi.spyOn(broker, 'forwardResponses').mockImplementation((_ref, request) => {
      forwardedSignal = request.signal
      request.signal.addEventListener('abort', () => rejectForward?.(new Error('upstream aborted')), { once: true })
      started?.()
      return forwarding
    })
    const store = new MemoryTeamStore()
    const service = new TeamService({ store, broker, capacity: new TeamCapacityProvider(broker) })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const account = await store.createContributionAccount(owner, 'Owner Codex')
    await store.setContributionAccountStatus(owner.teamId, account.id, 'active')
    const outgoing = disconnectableResponse()
    const pending = createTeamGatewayHandler(service)(request('POST', {
      model: 'gpt-5-codex', input: [], stream: true,
    }, { authorization: `Bearer ${boot.apiKey}`, 'content-type': 'application/json' }), outgoing.res)

    await forwardingStarted
    outgoing.close()
    try {
      await vi.waitFor(() => { expect(forwardedSignal?.aborted).toBe(true) }, { timeout: 100 })
    } finally {
      rejectForward?.(new Error('test cleanup'))
      await pending
    }

    expect(await store.listUsageEvents(owner, 10)).toMatchObject([{ status: 'cancelled' }])
  })

  it('uses durable traffic state automatically for a PostgreSQL Team store', async () => {
    const pool = postgresTestPool()
    try {
      const broker = new GatewayBroker()
      const store = new PostgresTeamStore({ pool })
      const service = new TeamService({ store, broker, capacity: new TeamCapacityProvider(broker) })
      const boot = await store.bootstrap('Friends', 'Owner')
      const owner = await store.authenticateApiKey(boot.apiKey)
      if (owner === undefined) throw new Error('owner key should authenticate')
      const account = await store.createContributionAccount(owner, 'Owner Codex')
      await store.setContributionAccountStatus(owner.teamId, account.id, 'active')

      const result = await response(createTeamGatewayHandler(service), request('POST', {
        model: 'gpt-5-codex', input: [], stream: true,
      }, { authorization: `Bearer ${boot.apiKey}`, 'content-type': 'application/json' }))
      const durable = await pool.query<{ result: string }>(
        'SELECT result FROM team_api_key_traffic_leases WHERE key_id = $1',
        [owner.keyId],
      )

      expect(result.status).toBe(200)
      expect(durable.rows).toEqual([{ result: 'success' }])
    } finally {
      await pool.end()
    }
  })

  it('maps expected traffic-guard rejection without exposing storage diagnostics', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const guard: TeamTrafficGuard = {
      acquire: vi.fn().mockRejectedValue(new TeamTrafficGuardError(
        'Team API key is revoked',
        'revoked',
        401,
      )),
    }
    const handler = createTeamGatewayHandler(new TeamService({ store, broker: new GatewayBroker() }), {
      trafficGuard: guard,
    })
    const result = await response(handler, request('POST', {
      model: 'gpt-5-codex', input: [], stream: true,
    }, { authorization: `Bearer ${boot.apiKey}`, 'content-type': 'application/json' }))

    expect(result).toMatchObject({ status: 401 })
    expect(result.headers).not.toHaveProperty('retry-after')
    expect(result.body).toContain('TEAM_TRAFFIC_GUARD')
  })

  it('returns a stable 503 when the distributed traffic guard is unavailable', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const guard: TeamTrafficGuard = {
      acquire: vi.fn().mockRejectedValue(new Error('postgres://secret-host/internal diagnostics')),
    }
    const handler = createTeamGatewayHandler(new TeamService({ store, broker: new GatewayBroker() }), {
      trafficGuard: guard,
    })
    const result = await response(handler, request('POST', {
      model: 'gpt-5-codex', input: [], stream: true,
    }, { authorization: `Bearer ${boot.apiKey}`, 'content-type': 'application/json' }))

    expect(result).toMatchObject({ status: 503 })
    expect(result.body).toContain('Team traffic guard is unavailable')
    expect(result.body).not.toContain('secret-host')
  })
})
