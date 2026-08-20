import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { describe, expect, it } from 'vitest'
import {
  OPENAI_CODEX_NETWORK_STATUS_PATH,
  OPENAI_CODEX_PROFILE_LOGIN_CANCEL_PATH,
  registerOpenAICodexAuthRoutes,
} from '../src/auth-routes.ts'
import { OutboundNetwork } from '../src/network.ts'
import type { OpenAICodexCredentialStore } from '../src/store.ts'
import type { ImageToolPolicy } from '../src/tool-policy.ts'

function setupRoutes(network: OutboundNetwork): {
  routes: Map<string, WebRoute>
  dispose: () => Promise<void>
} {
  const routes = new Map<string, WebRoute>()
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
    {} as OpenAICodexCredentialStore,
    {} as ImageToolPolicy,
    network,
  )
  return {
    routes,
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
})
