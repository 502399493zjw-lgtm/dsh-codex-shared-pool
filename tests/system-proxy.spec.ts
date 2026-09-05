import { describe, expect, it, vi } from 'vitest'
import { readMacOSSystemProxy } from '../src/system-proxy.ts'

describe('macOS system proxy', () => {
  it('reads enabled HTTP/HTTPS proxies and exception hosts without leaking configuration', () => {
    const read = vi.fn(() => `<dictionary> {
 HTTPEnable : 1
 HTTPProxy : 127.0.0.1
 HTTPPort : 8080
 HTTPSEnable : 1
 HTTPSProxy : proxy.test
 HTTPSPort : 443
 ExceptionsList : <array> {
  0 : *.internal.test
  1 : 10.0.0.0/8
 }
}`)
    expect(readMacOSSystemProxy(read)).toEqual({
      httpProxy: 'http://127.0.0.1:8080', httpsProxy: 'http://proxy.test:443',
      noProxy: 'localhost,127.0.0.1,::1,*.internal.test,10.0.0.0/8',
    })
    expect(read).toHaveBeenCalledOnce()
  })
  it('does not infer a proxy from disabled settings or a PAC URL', () => {
    expect(readMacOSSystemProxy(() => 'HTTPEnable : 0\nHTTPProxy : proxy.test\nHTTPPort : 8080\nProxyAutoConfigEnable : 1')).toBeUndefined()
  })
  it('fails safely for unavailable or malformed settings', () => {
    expect(readMacOSSystemProxy(() => { throw new Error('scutil unavailable') })).toBeUndefined()
    expect(readMacOSSystemProxy(() => 'HTTPEnable : 1\nHTTPProxy : user:secret@proxy.test\nHTTPPort : 8080')).toBeUndefined()
    expect(readMacOSSystemProxy(() => 'HTTPEnable : 1\nHTTPProxy : proxy.test\nHTTPPort : 65536')).toBeUndefined()
  })
})
