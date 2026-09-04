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
  AUTHORIZATION_POPUP_SESSION_TTL_MS,
  AuthorizationPopupSessions,
  OpenAICodexWebAuth,
  registerOpenAICodexAuthRoutes,
} from '../src/auth-routes.ts'
import { LocalRoutingEventLedger } from '../src/local-routing-events.ts'
import { OutboundNetwork } from '../src/network.ts'
import type { OpenAICodexCredentialStore } from '../src/store.ts'
import type { ImageToolPolicy } from '../src/tool-policy.ts'
import {
  OPENAI_CODEX_AUTHORIZATION_POPUP_PATH,
  OPENAI_CODEX_AUTHORIZATION_POPUP_SESSION_PATH,
} from '../src/shared/authorization-popup.ts'

const auth = vi.hoisted(() => ({
  loginOpenAICodex: vi.fn(),
  loginOpenAICodexLocalProfile: vi.fn(),
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

async function request(route: WebRoute | undefined, method: string, options: {
  readonly url?: string
  readonly body?: unknown
  readonly headers?: Readonly<Record<string, string>>
  readonly remoteAddress?: string
} = {}): Promise<{
  status: number
  body: string
  headers: Record<string, string | number | readonly string[]>
}> {
  let status = 0
  let body = ''
  let headers: Record<string, string | number | readonly string[]> = {}
  const encodedBody = options.body === undefined ? undefined : JSON.stringify(options.body)
  const req = {
    method,
    url: options.url,
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    headers: {
      host: '127.0.0.1:3080',
      ...(encodedBody === undefined ? {} : { 'content-type': 'application/json' }),
      ...options.headers,
    },
    async *[Symbol.asyncIterator]() {
      if (encodedBody !== undefined) yield Buffer.from(encodedBody)
    },
  } as IncomingMessage
  const response = {
    writeHead(nextStatus: number, nextHeaders?: Record<string, string | number | readonly string[]>) {
      status = nextStatus
      headers = nextHeaders ?? {}
      return this
    },
    end(chunk?: string) {
      body = chunk ?? ''
      return this
    },
  } as unknown as ServerResponse
  await route?.handler(req, response)
  return { status, body, headers }
}

describe('OpenAI Codex Web routes', () => {
  it('bounds and expires popup handoff sessions', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-29T12:00:00Z'))
    const sessions = new AuthorizationPopupSessions(Date.now, AUTHORIZATION_POPUP_SESSION_TTL_MS, 2)
    try {
      const first = '00'.repeat(32)
      const second = '11'.repeat(32)
      const third = '22'.repeat(32)
      sessions.open(first)
      sessions.publish(second, 'https://auth.openai.com/oauth/authorize?state=second')
      sessions.cancel(third)
      expect(sessions.size).toBe(2)
      expect(sessions.status(first)).toBeNull()

      vi.advanceTimersByTime(AUTHORIZATION_POPUP_SESSION_TTL_MS + 1)
      await vi.runOnlyPendingTimersAsync()
      expect(sessions.size).toBe(0)
    } finally {
      sessions.clear()
      vi.useRealTimers()
    }
  })

  it('hands an adopted popup the provider URL and records acknowledgement', async () => {
    const { routes, dispose } = setupRoutes(new OutboundNetwork({}))
    const popup = routes.get(OPENAI_CODEX_AUTHORIZATION_POPUP_PATH)
    const session = routes.get(OPENAI_CODEX_AUTHORIZATION_POPUP_SESSION_PATH)
    const attemptToken = 'abcdef0123456789'.repeat(4)
    const authorizationUrl = 'https://auth.openai.com/oauth/authorize?client_id=test&state=opaque'
    try {
      const opened = await request(popup, 'GET', {
        url: `${OPENAI_CODEX_AUTHORIZATION_POPUP_PATH}?attempt=${attemptToken}`,
      })
      expect(opened.status).toBe(200)
      expect(opened.headers['content-security-policy']).toContain("default-src 'none'")
      expect(opened.body).toContain(OPENAI_CODEX_AUTHORIZATION_POPUP_SESSION_PATH)
      expect(opened.body).toContain('try{window.opener=null}catch{}')
      expect(opened.body.indexOf('window.opener=null')).toBeLessThan(opened.body.indexOf('window.location.replace'))
      expect(opened.body).not.toContain('client_id=')

      const published = await request(session, 'POST', {
        url: OPENAI_CODEX_AUTHORIZATION_POPUP_SESSION_PATH,
        body: { attemptToken, authorizationUrl },
      })
      expect(JSON.parse(published.body)).toEqual({ status: 'published' })

      const redirected = await request(session, 'GET', {
        url: `${OPENAI_CODEX_AUTHORIZATION_POPUP_SESSION_PATH}?attempt=${attemptToken}`,
        headers: { accept: 'text/html' },
      })
      expect(redirected.status).toBe(302)
      expect(redirected.headers.location).toBe(authorizationUrl)

      const acknowledged = await request(session, 'GET', {
        url: `${OPENAI_CODEX_AUTHORIZATION_POPUP_SESSION_PATH}?attempt=${attemptToken}`,
        headers: { accept: 'application/json' },
      })
      expect(JSON.parse(acknowledged.body)).toEqual({ status: 'acknowledged' })
      expect(acknowledged.body).not.toContain('client_id')
    } finally {
      await dispose()
    }
  })

  it('holds navigation until publication and rejects unsafe handoffs', async () => {
    const { routes, dispose } = setupRoutes(new OutboundNetwork({}))
    const popup = routes.get(OPENAI_CODEX_AUTHORIZATION_POPUP_PATH)
    const session = routes.get(OPENAI_CODEX_AUTHORIZATION_POPUP_SESSION_PATH)
    const attemptToken = '1234567890abcdef'.repeat(4)
    const authorizationUrl = 'https://auth.openai.com/oauth/authorize?state=late'
    try {
      await request(popup, 'GET', { url: `${OPENAI_CODEX_AUTHORIZATION_POPUP_PATH}?attempt=${attemptToken}` })
      let settled = false
      const navigation = request(session, 'GET', {
        url: `${OPENAI_CODEX_AUTHORIZATION_POPUP_SESSION_PATH}?attempt=${attemptToken}`,
        headers: { accept: 'text/html' },
      }).then(result => { settled = true; return result })
      await Promise.resolve()
      expect(settled).toBe(false)

      const unsafe = await request(session, 'POST', {
        url: OPENAI_CODEX_AUTHORIZATION_POPUP_SESSION_PATH,
        body: { attemptToken, authorizationUrl: 'https://example.com/oauth/authorize' },
      })
      expect(unsafe.status).toBe(400)
      await request(session, 'POST', {
        url: OPENAI_CODEX_AUTHORIZATION_POPUP_SESSION_PATH,
        body: { attemptToken, authorizationUrl },
      })
      await expect(navigation).resolves.toMatchObject({ status: 302 })

      const rebound = await request(session, 'GET', {
        url: `${OPENAI_CODEX_AUTHORIZATION_POPUP_SESSION_PATH}?attempt=${attemptToken}`,
        headers: { host: 'evil.example:3181', origin: 'http://evil.example:3181' },
      })
      expect(rebound.status).toBe(403)
    } finally {
      await dispose()
    }
  })

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
    auth.loginOpenAICodexLocalProfile.mockImplementation(async (interaction: AuthInteraction) => {
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
    auth.loginOpenAICodexLocalProfile.mockRejectedValueOnce(new Error('provider rejected login'))
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
