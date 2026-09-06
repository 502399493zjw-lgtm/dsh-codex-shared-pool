import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'

describe('Codex subscription pool registration', () => {
  it('registers one settings section whose label opens the unified pool', async () => {
    const source = await readFile(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
    const sectionRegistrations = source.match(/ctx\.slots\.inject\('settings\.section'/gu) ?? []

    expect(sectionRegistrations).toHaveLength(1)
    expect(source).toContain('CodexSubscriptionPoolSettings')
    expect(source).not.toContain("id: 'codex-team'")
    expect(en.nav).toBe('Codex subscription pool')
    expect(zh.nav).toBe('Codex 订阅池')
  })
})
