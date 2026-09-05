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
    const hosts: string[] = []
    const rootDepth = output.trimStart().startsWith('<dictionary>') ? 1 : 0
    let depth = 0
    let inExceptions = false
    for (const line of output.split('\n')) {
      const match = /^\s*(\w+)\s*:\s*(.*?)\s*$/.exec(line)
      if (depth === rootDepth && match !== null) {
        if (match[1] === 'ExceptionsList' && match[2] === '<array> {') inExceptions = true
        else if (!match[2]!.endsWith('{')) values.set(match[1]!, match[2]!)
      } else if (depth === rootDepth + 1 && inExceptions && match !== null) {
        if (/^[\w.*:/<>\[\]-]+$/.test(match[2]!)) hosts.push(match[2]!)
      }
      if (line.trimEnd().endsWith('{')) depth += 1
      if (line.trim() === '}') {
        depth -= 1
        if (depth === rootDepth) inExceptions = false
      }
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
    if (values.get('ExcludeSimpleHostnames') === '1') hosts.push('<local>')
    return { httpProxy, httpsProxy, noProxy: ['localhost', '127.0.0.1', '[::1]', ...hosts].join(',') }
  } catch {
    return undefined
  }
}
