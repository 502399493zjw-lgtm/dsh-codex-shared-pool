/** Additional system proxy exception forms not understood by Undici NO_PROXY. */
import { BlockList, isIP } from 'node:net'

export function createProxyBypassMatcher(noProxy: string): (hostname: string) => boolean {
  const networks = new BlockList()
  const patterns: RegExp[] = []
  let simpleNames = false
  for (const item of noProxy.toLowerCase().split(/[\s,]+/)) {
    if (item === '<local>') simpleNames = true
    else if (isIP(item.replace(/^\[|\]$/g, '')) === 6) {
      networks.addAddress(item.replace(/^\[|\]$/g, ''), 'ipv6')
    } else if (item.includes('/')) {
      const [address = '', prefix = ''] = item.split('/')
      const family = isIP(address)
      if (family !== 0 && /^\d+$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128)) {
        networks.addSubnet(address, Number(prefix), family === 4 ? 'ipv4' : 'ipv6')
      }
    } else if (item.includes('*')) {
      // Escape every regex metacharacter except the system's wildcard.
      patterns.push(new RegExp(`^${item.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`))
    }
  }
  return (hostname) => {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
    const family = isIP(host)
    if (family !== 0 && networks.check(host, family === 4 ? 'ipv4' : 'ipv6')) return true
    if (simpleNames && family === 0 && !host.includes('.')) return true
    return patterns.some(pattern => pattern.test(host))
  }
}
