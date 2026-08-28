import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AuthInteraction } from '@earendil-works/pi-ai'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { describe, expect, it, vi } from 'vitest'
import {
  OPENAI_CODEX_NETWORK_STATUS_PATH,
  OPENAI_CODEX_PROFILE_DIRECTORY_PATH,
  OPENAI_CODEX_PROFILE_LOGIN_CANCEL_PATH,
  OPENAI_CODEX_PROFILE_LOGIN_PATH,
  OPENAI_CODEX_PROFILES_PATH,
  OPENAI_CODEX_ROUTING_EVENTS_PATH,
  OpenAICodexWebAuth,
  registerOpenAICodexAuthRoutes,
} from '../src/auth-routes.ts'
import { LocalRoutingEventLedger } from '../src/local-routing-events.ts'
import { OutboundNetwork } from '../src/network.ts'
import type { OpenAICodexCredentialStore } from '../src/store.ts'
import type { ImageToolPolicy } from '../src/tool-policy.ts'

const auth = vi.hoisted(() => ({
  loginOpenAICodex: vi.fn(),
  loginOpenAICodexProfile: vi.fn(),
  logoutOpenAICodex: vi.fn(),
  openAICodexAuthStatus: vi.fn(),
}))

vi.mock('../src/auth.ts', () => auth)

function setupRoutes(
  network: OutboundNetwork,
  store = {} as OpenAICodexCredentialStore,
): {
  routes: Map<string, WebRoute>
  routingEvents: LocalRoutingEventLedger
  dispose: () => Promise<void>
} {
  const routes = new Map<string, WebRoute>()
  const routingEvents = new LocalRoutingEventLedger({ id: () => 'event-1', now: () => 1_000 })
  let cleanup: (() => void | Promise<void>) | undefined
  const context = {
    webServer: {
      register(route: WebRoute) {
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      },
    },
    effect(effect: () => () => void | Promise<void>) {
      cleanup = effect()
      return () => cleanup?.()
    },
  } as unknown as Context
  registerOpenAICodexAuthRoutes(
    context,
    store,
    {} as ImageToolPolicy,
    network,
    routingEvents,
  )
  return {
    routes,
    routingEvents,
    dispose: async () => { await cleanup?.() },
  }
}

async function request(route: WebRoute | undefined, method: string): Promise<{
  status: number
  body: string
}> {
  let status = 0
  let body = ''
  const req = {
    method,
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080' },
  } as IncomingMessage
  const response = {
    writeHead(nextStatus: number) {
      status = nextStatus
      return this
    },
    end(chunk?: string) {
      body = chunk ?? ''
      return this
    },
  } as unknown as ServerResponse
  await route?.handler(req, response)
  return { status, body }
}

describe('OpenAI Codex Web routes', () => {
  it('returns the local profile directory without reading profile credentials or quota', async () => {
    const listProfiles = vi.fn().mockResolvedValue([
      { id: 'profile-a', label: 'Account A', createdAt: 100, updatedAt: 200, access: 'must-not-leak' },
      { id: 'profile-b', label: 'Account B', createdAt: 300, updatedAt: 400 },
    ])
    const forProfile = vi.fn(() => { throw new Error('profile credentials must remain untouched') })
    const store = { listProfiles, forProfile } as unknown as OpenAICodexCredentialStore
    const { routes, routingEvents, dispose } = setupRoutes(new OutboundNetwork({}), store)
    routingEvents.begin({
      allocation: { profileId: 'profile-b', reason: 'quota_fallback', previousProfileId: 'profile-a' },
      profileOrder: ['profile-a', 'profile-b'],
      model: 'gpt-5.6-sol',
    })

    const result = await request(routes.get(OPENAI_CODEX_PROFILE_DIRECTORY_PATH), 'GET')

    expect(result.status).toBe(200)
    expect(JSON.parse(result.body)).toEqual({
      status: 'ready',
      profiles: [
        { id: 'profile-a', label: 'Account A', createdAt: 100, updatedAt: 200, inUse: false },
        { id: 'profile-b', label: 'Account B', createdAt: 300, updatedAt: 400, inUse: true },
      ],
    })
    expect(listProfiles).toHaveBeenCalledTimes(1)
    expect(forProfile).not.toHaveBeenCalled()
    expect(result.body).not.toContain('must-not-leak')
    await dispose()
  })

  it('returns only secret-free outbound network flags', async () => {
    const network = new OutboundNetwork({
      HTTPS_PROXY: 'http://proxy-user:proxy-password@proxy.test:8080',
      NO_PROXY: 'localhost,127.0.0.1',
    })
    const { routes, dispose } = setupRoutes(network)
    const route = routes.get(OPENAI_CODEX_NETWORK_STATUS_PATH)
    expect(route).toBeDefined()
    const { status, body } = await request(route, 'GET')

    expect(status).toBe(200)
    expect(JSON.parse(body)).toEqual({
      enabled: true,
      httpProxy: false,
      httpsProxy: true,
      noProxy: true,
    })
    expect(body).not.toContain('proxy.test')
    expect(body).not.toContain('proxy-password')
    await dispose()
  })

  it('makes cancellation idempotent when no browser login is active', async () => {
    const { routes, dispose } = setupRoutes(new OutboundNetwork({}))

    const result = await request(routes.get(OPENAI_CODEX_PROFILE_LOGIN_CANCEL_PATH), 'POST')

    expect(result.status).toBe(200)
    expect(JSON.parse(result.body)).toEqual({ cancelled: false })
    await dispose()
  })

  it('cancels an active Host attempt through the route and immediately restores retryable state', async () => {
    auth.loginOpenAICodexProfile.mockImplementation(async (interaction: AuthInteraction) => {
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.test/authorize' })
      await new Promise<void>((_resolve, reject) => {
        interaction.signal?.addEventListener('abort', () => reject(interaction.signal?.reason), { once: true })
      })
    })
    const listProfiles = vi.fn().mockResolvedValue([])
    const store = { listProfiles } as unknown as OpenAICodexCredentialStore
    const { routes, dispose } = setupRoutes(new OutboundNetwork({}), store)

    const started = await request(routes.get(OPENAI_CODEX_PROFILE_LOGIN_PATH), 'POST')
    const directoryDuringLogin = await request(routes.get(OPENAI_CODEX_PROFILE_DIRECTORY_PATH), 'GET')

    expect(started.status).toBe(200)
    expect(JSON.parse(started.body)).toEqual({ url: 'https://auth.openai.test/authorize' })
    expect(JSON.parse(directoryDuringLogin.body)).toEqual({ status: 'signing-in' })
    expect(listProfiles).not.toHaveBeenCalled()

    const firstCancel = await request(routes.get(OPENAI_CODEX_PROFILE_LOGIN_CANCEL_PATH), 'POST')
    const secondCancel = await request(routes.get(OPENAI_CODEX_PROFILE_LOGIN_CANCEL_PATH), 'POST')
    const status = await request(routes.get(OPENAI_CODEX_PROFILES_PATH), 'GET')

    expect(JSON.parse(firstCancel.body)).toEqual({ cancelled: true })
    expect(JSON.parse(secondCancel.body)).toEqual({ cancelled: false })
    expect(JSON.parse(status.body)).toEqual({ status: 'ready', profiles: [] })
    await dispose()
  })

  it('keeps authorization failures in the fast directory lifecycle without listing profiles', async () => {
    auth.loginOpenAICodexProfile.mockRejectedValueOnce(new Error('provider rejected login'))
    const listProfiles = vi.fn().mockResolvedValue([])
    const webAuth = new OpenAICodexWebAuth(
      { listProfiles } as unknown as OpenAICodexCredentialStore,
    )

    await expect(webAuth.signInProfile()).rejects.toThrow('provider rejected login')
    await webAuth.waitForCompletion()

    await expect(webAuth.profileDirectoryStatus()).resolves.toEqual({
      status: 'error',
      reason: 'authorization-failed',
    })
    expect(listProfiles).not.toHaveBeenCalled()
    await webAuth.dispose()
  })

  it('keeps the cancellation projection JSON-safe and rejects unsupported methods', async () => {
    const { routes, dispose } = setupRoutes(new OutboundNetwork({}))
    const route = routes.get(OPENAI_CODEX_PROFILE_LOGIN_CANCEL_PATH)

    const unsupported = await request(route, 'GET')
    const cancelled = await request(route, 'POST')

    expect(unsupported.status).toBe(405)
    expect(JSON.parse(unsupported.body)).toEqual({ error: 'method not allowed' })
    expect(cancelled.status).toBe(200)
    expect(JSON.parse(cancelled.body)).toEqual({ cancelled: false })
    expect(Object.keys(JSON.parse(cancelled.body))).toEqual(['cancelled'])
    await dispose()
  })

  it('returns only bounded Browser-safe local routing receipts over GET', async () => {
    const { routes, routingEvents, dispose } = setupRoutes(new OutboundNetwork({}))
    const id = routingEvents.begin({
      allocation: {
        profileId: 'raw-profile-b',
        previousProfileId: 'raw-profile-a',
        reason: 'quota_fallback',
      },
      profileOrder: ['raw-profile-a', 'raw-profile-b'],
      model: 'gpt-5.6-sol',
    })
    routingEvents.settle(id, 'succeeded')

    const get = await request(routes.get(OPENAI_CODEX_ROUTING_EVENTS_PATH), 'GET')
    const post = await request(routes.get(OPENAI_CODEX_ROUTING_EVENTS_PATH), 'POST')

    expect(get.status).toBe(200)
    expect(JSON.parse(get.body)).toEqual({
      events: [{
        id: 'event-1',
        profileAlias: 'B',
        previousProfileAlias: 'A',
        model: 'gpt-5.6-sol',
        reason: 'quota_fallback',
        unit: 'request',
        status: 'succeeded',
        startedAt: 1_000,
        finishedAt: 1_000,
      }],
    })
    expect(get.body).not.toContain('raw-profile')
    expect(get.body).not.toContain('prompt')
    expect(get.body).not.toContain('response')
    expect(get.body).not.toContain('token')
    expect(get.body).not.toContain('error')
    expect(post.status).toBe(405)
    await dispose()
  })
})
