import { expect, it } from 'vitest'
import { createProxyBypassMatcher } from '../src/proxy-bypass.ts'

it('matches system IP networks, wildcard hosts and simple names without overmatching', () => {
  const bypass = createProxyBypassMatcher('10.0.0.0/8,fe80::/10,10.*,*.internal.test,<local>')
  for (const host of ['10.2.3.4', '[fe80::1]', 'a.internal.test', 'printer']) expect(bypass(host)).toBe(true)
  for (const host of ['11.2.3.4', '[2001:db8::1]', 'internal.test.attacker.test', 'chatgpt.com']) expect(bypass(host)).toBe(false)
})

it('matches exact IPv6 exceptions in bare and bracketed form', () => {
  const bypass = createProxyBypassMatcher('fd00::123,[fd00::456]')
  expect(bypass('[fd00::123]')).toBe(true)
  expect(bypass('[fd00::456]')).toBe(true)
  expect(bypass('[fd00::789]')).toBe(false)
})
