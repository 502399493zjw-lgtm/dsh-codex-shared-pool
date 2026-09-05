import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import {
  OutboundNetwork,
  resolveOutboundProxyEnvironment,
  resolveOutboundNetworkEnvironment,
} from '../src/network.ts'

const originalDispatcher = getGlobalDispatcher()
const ownedDispatchers: Agent[] = []

afterEach(async () => {
  setGlobalDispatcher(originalDispatcher)
  await Promise.all(ownedDispatchers.splice(0).map(async (dispatcher) => { await dispatcher.close() }))
})

describe('OutboundNetwork', () => {
  it('discovers macOS system proxies only without explicit proxy overrides', () => {
    const discover = () => ({ httpProxy: 'http://proxy.test:8080', httpsProxy: 'http://proxy.test:8080', noProxy: 'localhost,127.0.0.1,::1' })
    expect(resolveOutboundNetworkEnvironment({}, 'darwin', discover)).toEqual(discover())
    expect(resolveOutboundNetworkEnvironment({ HTTPS_PROXY: '' }, 'darwin', discover).httpsProxy).toBeUndefined()
    expect(resolveOutboundNetworkEnvironment({ HTTPS_PROXY: 'http://explicit.test' }, 'darwin', discover).httpsProxy).toBe('http://explicit.test')
    expect(resolveOutboundNetworkEnvironment({}, 'linux', discover).httpsProxy).toBeUndefined()
    expect(resolveOutboundNetworkEnvironment({ NO_PROXY: 'internal.test' }, 'darwin', discover).noProxy).toBe('localhost,127.0.0.1,::1,internal.test')
  })

  it('uses lowercase standard variables before uppercase variants', () => {
    expect(resolveOutboundProxyEnvironment({
      http_proxy: 'http://lower-http.test:8080',
      HTTP_PROXY: 'http://upper-http.test:8080',
      https_proxy: 'http://lower-https.test:8080',
      HTTPS_PROXY: 'http://upper-https.test:8080',
      no_proxy: 'lower.test',
      NO_PROXY: 'upper.test',
    })).toEqual({
      httpProxy: 'http://lower-http.test:8080',
      httpsProxy: 'http://lower-https.test:8080',
      noProxy: 'lower.test',
    })
  })

  it('exposes only secret-free presence flags', () => {
    const secret = 'proxy-user:proxy-password@proxy.test:8080'
    const network = new OutboundNetwork({
      HTTPS_PROXY: `http://${secret}`,
      NO_PROXY: 'localhost,127.0.0.1',
    })

    expect(network.status()).toEqual({
      enabled: true,
      httpProxy: false,
      httpsProxy: true,
      noProxy: true,
    })
    expect(JSON.stringify(network.status())).not.toContain(secret)
  })

  it('does not replace the dispatcher without a configured proxy', async () => {
    const before = getGlobalDispatcher()
    const dispose = new OutboundNetwork({ NO_PROXY: 'localhost' }).install()

    expect(getGlobalDispatcher()).toBe(before)
    await dispose()
    expect(getGlobalDispatcher()).toBe(before)
  })

  it('installs an environment proxy dispatcher and restores its predecessor', async () => {
    const before = getGlobalDispatcher()
    const dispose = new OutboundNetwork({
      HTTP_PROXY: 'http://127.0.0.1:18080',
      NO_PROXY: 'localhost',
    }).install()

    expect(getGlobalDispatcher()).not.toBe(before)
    await dispose()
    await dispose()
    expect(getGlobalDispatcher()).toBe(before)
  })

  it('does not overwrite a dispatcher installed by another component later', async () => {
    const dispose = new OutboundNetwork({ HTTP_PROXY: 'http://127.0.0.1:18080' }).install()
    const later = new Agent()
    ownedDispatchers.push(later)
    setGlobalDispatcher(later)

    await dispose()

    expect(getGlobalDispatcher()).toBe(later)
  })

  it('lets built-in fetch bypass an unreachable proxy for a NO_PROXY host', async () => {
    const server = createServer((_request, response) => { response.end('direct') })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo
    const dispose = new OutboundNetwork({
      HTTP_PROXY: 'http://127.0.0.1:1',
      NO_PROXY: '127.0.0.1',
    }).install()

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}`)
      expect(await response.text()).toBe('direct')
    } finally {
      await dispose()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
    }
  })
})

