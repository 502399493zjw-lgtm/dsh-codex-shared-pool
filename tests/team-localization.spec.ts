import { describe, expect, it } from 'vitest'
import { zh as poolZh } from '../src/client/locales.ts'
import { en, zh } from '../src/client/team/locales.ts'

describe('Chinese team terminology', () => {
  it('uses 团队 throughout Chinese pool and team copy', () => {
    const untranslated = [...Object.entries(poolZh), ...Object.entries(zh)]
      .filter(([, value]) => /\bteam\b/i.test(value.replace(/\{\w+\}/g, '')))
    expect(untranslated).toEqual([])
    expect(zh.accountDirectoryHint).toBe('团队账号单独授权，并按共享状态分组。')
  })

  it('preserves English copy, configuration keys, and interpolation parameters', () => {
    expect(en.workspaceTitle).toBe('Team')
    expect(zh.enabledHint).toContain('teamClient.serverUrl')
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      const parameters = (value: string) => [...value.matchAll(/\{\w+\}/g)].map(([name]) => name).sort()
      expect(parameters(zh[key]), key).toEqual(parameters(en[key]))
    }
  })
})
