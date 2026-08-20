import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const directory = fileURLToPath(new URL('..', import.meta.url))

describe('standalone dsh-codex-shared-pool project boundary', () => {
  it('exposes every Codex product surface through one publishable package and Loader row', () => {
    const manifest = JSON.parse(readFileSync(`${directory}/package.json`, 'utf8')) as {
      name: string
      main: string
      types: string
      exports: Record<string, unknown>
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string }; client?: { platform?: string } }
    }
    const patch = readFileSync(`${directory}/cordis.patch.yml`, 'utf8')
    const dependencySpecs = Object.values({
      ...manifest.dependencies,
      ...manifest.peerDependencies,
      ...manifest.devDependencies,
    })

    expect(manifest.name).toBe('dsh-codex-shared-pool')
    expect(manifest.main).toBe('lib/index.js')
    expect(manifest.types).toBe('lib/types/index.d.ts')
    expect(manifest.exports).toHaveProperty('.')
    expect(manifest.exports).toHaveProperty('./client')
    expect(manifest.exports).toHaveProperty('./cordis.patch.yml')
    expect(manifest.exports).toHaveProperty('./package.json')
    expect(manifest.dsh).toMatchObject({
      bundle: { patch: './cordis.patch.yml' },
      client: { platform: 'web' },
    })
    expect(dependencySpecs.every(specifier => !specifier.startsWith('workspace:'))).toBe(true)

    expect(patch.match(/id:\s*codex-shared-pool/gu)).toHaveLength(1)
    expect(patch).toMatch(/id:\s*codex-shared-pool\s+name:\s*dsh-codex-shared-pool/u)
    expect(patch).toMatch(/provider:\s*openai-codex/u)
    expect(patch).toMatch(/searchProvider:\s*openai-codex/u)
    expect(patch).not.toMatch(/@deepseek-ai\/dsh-codex_shared_pool|dsh-(?:host|client-ui)-codex-quota/u)
  })
})
