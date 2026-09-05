/** Host-only discovery of explicitly enabled macOS HTTP proxy settings. */
import { execFileSync } from 'node:child_process'
import { isIP } from 'node:net'
import type { OutboundProxyEnvironment } from './network.ts'

/** PAC and SOCKS settings are not HTTP proxy URLs and are never guessed. */
export function readMacOSSystemProxy(
  read: () => string = () => execFileSync('/usr/sbin/scutil', ['--proxy'], {
    encoding: 'utf8', timeout: 1_000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  }),
): OutboundProxyEnvironment | undefined {
  try {
    const output = read()
    const values = new Map<string, string>()
    for (const line of output.split('\n')) {
      const match = /^\s*(\w+)\s*:\s*(.*?)\s*$/.exec(line)
      if (match !== null) values.set(match[1]!, match[2]!)
    }
    const proxy = (prefix: string): string | undefined => {
      if (values.get(`${prefix}Enable`) !== '1') return undefined
      const host = values.get(`${prefix}Proxy`) ?? ''
      const port = values.get(`${prefix}Port`) ?? ''
      if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) return undefined
      const ipv6 = isIP(host) === 6
      if (!ipv6 && !/^[a-zA-Z0-9.-]+$/.test(host)) return undefined
      return `http://${ipv6 ? `[${host}]` : host}:${port}`
    }
    const httpProxy = proxy('HTTP')
    const httpsProxy = proxy('HTTPS')
    if (httpProxy === undefined && httpsProxy === undefined) return undefined
    const exceptions = /ExceptionsList\s*:\s*<array>\s*\{([^}]*)\}/.exec(output)?.[1] ?? ''
    const hosts = exceptions.split('\n').flatMap(line => {
      const host = /^\s*\d+\s*:\s*([\w.*:/-]+)\s*$/.exec(line)?.[1]
      return host === undefined ? [] : [host]
    })
    return { httpProxy, httpsProxy, noProxy: ['localhost', '127.0.0.1', '::1', ...hosts].join(',') }
  } catch {
    return undefined
  }
}
