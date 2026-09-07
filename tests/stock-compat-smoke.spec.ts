import { describe, expect, it } from 'vitest'

import { authenticateStockWeb, probeStockPlugin } from '../scripts/smoke-stock-compat.mjs'

const plugin = 'dsh-codex-shared-pool'
const dependency = '@deepseek-ai/dsh-client-ui-session'
const bundleUrl = `/plugins/??${plugin}/client.js&rev=abc123`
const entry = { id: plugin, url: bundleUrl, initialUrl: bundleUrl, inject: [dependency], external: [] }
const teamStatusPath = `/plugins/${plugin}/team-client/status`
const cloudStatus = { enabled: true, keyConfigured: false, keyWritable: true, pendingJoinConfigured: false, serverOrigin: 'https://47.84.77.193' }

function page(entries: unknown[]): string {
  return `<html><head><script>globalThis["__DSH_BOOT__"] = ${JSON.stringify({ rev: 'abc123', entries, batches: [] })}</script><script type="module" src="./assets/shell.js"></script></head><body>DeepSeek Harness</body></html>`
}

function fixtureFetch(html: string, routeStatus = 200, bundle = `window.__ModuleLoader__.load({id: "${plugin}", factory() { return {} }})`): typeof fetch {
  return async (input, options) => {
    const url = new URL(String(input))
    if (url.pathname === '/') return new Response(html)
    if (url.pathname === '/assets/shell.js') return new Response('function platformModules(){return{"@deepseek-ai/dsh-client-ui-primitives":primitives}}loader.create({staticModules:platformModules()})')
    if (url.pathname === '/plugins/') return new Response(bundle, { headers: { 'content-type': 'text/javascript' } })
    if (url.pathname === teamStatusPath) {
      expect(new Headers(options?.headers).get('origin')).toBe(url.origin)
      expect(new Headers(options?.headers).get('sec-fetch-site')).toBe('same-origin')
      return Response.json(cloudStatus, { status: routeStatus })
    }
    return Response.json({ enabled: true }, { status: routeStatus })
  }
}

describe('stock compatibility smoke assertions (HTTP fixtures, not stock evidence)', () => {
  it('exchanges the launch token for a same-origin cookie without disabling stock authentication', async () => {
    const requests: { url: string; cookie: string | null }[] = []
    const fetcher: typeof fetch = async (input, options) => {
      const url = new URL(String(input))
      requests.push({ url: url.href, cookie: new Headers(options?.headers).get('cookie') })
      if (url.searchParams.has('token')) return new Response(null, {
        status: 303,
        headers: { location: '/', 'set-cookie': 'dsh-auth-test=signed-session; Path=/; HttpOnly; SameSite=Strict' },
      })
      return new Response('', { status: requests.at(-1)?.cookie ? 200 : 401 })
    }
    const authenticated = await authenticateStockWeb('http://127.0.0.1:3099/', 'http://127.0.0.1:3099/?token=launch-secret', fetcher)
    expect((await authenticated('http://127.0.0.1:3099/')).status).toBe(200)
    expect(requests.map(request => request.cookie)).toEqual([null, null, 'dsh-auth-test=signed-session'])
    expect(requests.at(-1)?.url).toBe('http://127.0.0.1:3099/')
    await expect(authenticated('https://example.invalid/')).rejects.toThrow(/same-origin/u)
    expect(requests).toHaveLength(3)
  })

  it('requires authentication to remain enabled in the stock runtime', async () => {
    await expect(authenticateStockWeb('http://127.0.0.1:3099/', 'http://127.0.0.1:3099/?token=launch-secret', async () => new Response('')))
      .rejects.toThrow(/unauthenticated root/u)
  })

  it('accepts the new combo bundle URL from the actual boot graph', async () => {
    await expect(probeStockPlugin('http://127.0.0.1:3099/', fixtureFetch(page([entry, { id: dependency }]))))
      .resolves.toMatchObject({ plugin, routes: 4, bundle: bundleUrl })
  })

  it.each([
    { ...cloudStatus, enabled: false },
    { ...cloudStatus, keyConfigured: true },
    { ...cloudStatus, keyWritable: false },
    { ...cloudStatus, pendingJoinConfigured: true },
    { ...cloudStatus, serverOrigin: 'http://127.0.0.1:3080' },
  ])('rejects a fresh install with unexpected Team connection state %j', async status => {
    const fixture = fixtureFetch(page([entry, { id: dependency }]))
    await expect(probeStockPlugin('http://127.0.0.1:3099/', async (url, options) =>
      new URL(String(url)).pathname === teamStatusPath ? Response.json(status) : fixture(url, options)))
      .rejects.toThrow(/fresh.*Team/iu)
  })

  it('resolves primitives from the served shell static-module table instead of dynamic boot entries', async () => {
    const staticEntry = { ...entry, inject: [...entry.inject, '@deepseek-ai/dsh-client-ui-primitives'] }
    await expect(probeStockPlugin('http://127.0.0.1:3099/', fixtureFetch(page([staticEntry, { id: dependency }]))))
      .resolves.toMatchObject({ plugin })
  })

  it('fails when the stock shell loads but the plugin import failed', async () => {
    await expect(probeStockPlugin('http://127.0.0.1:3099/', fixtureFetch(page([]))))
      .rejects.toThrow(/plugin is absent from the boot manifest/u)
  })

  it('fails when a browser dependency was removed by the new DSH release', async () => {
    await expect(probeStockPlugin('http://127.0.0.1:3099/', fixtureFetch(page([entry]))))
      .rejects.toThrow(/boot dependency.*missing/u)
  })

  it('fails when plugin routes are absent even though its browser bundle is advertised', async () => {
    await expect(probeStockPlugin('http://127.0.0.1:3099/', fixtureFetch(page([entry, { id: dependency }]), 404)))
      .rejects.toThrow(/HTTP 404/u)
  })

  it('rejects a shell fallback served in place of the bundle', async () => {
    await expect(probeStockPlugin('http://127.0.0.1:3099/', fixtureFetch(page([entry, { id: dependency }]), 200, '<html>DeepSeek Harness</html>')))
      .rejects.toThrow(/client bundle/u)
  })

  it('rejects another registered bundle that only mentions this plugin in its source', async () => {
    const otherBundle = `window.__ModuleLoader__.load({id: "other-plugin", factory() { return "${plugin}" }})`
    await expect(probeStockPlugin('http://127.0.0.1:3099/', fixtureFetch(page([entry, { id: dependency }]), 200, otherBundle)))
      .rejects.toThrow(/client bundle/u)
  })

  it('does not fetch a cross-origin URL from a malformed manifest', async () => {
    const urls: string[] = []
    const fetcher = fixtureFetch(page([{ ...entry, url: 'https://example.invalid/client.js' }, { id: dependency }]))
    await expect(probeStockPlugin('http://127.0.0.1:3099/', async (url) => {
      urls.push(String(url))
      return fetcher(url)
    })).rejects.toThrow(/same-origin/u)
    expect(urls.every(url => url.startsWith('http://127.0.0.1:3099/'))).toBe(true)
  })
})
