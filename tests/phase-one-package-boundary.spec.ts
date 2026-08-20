import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

describe('phase one package boundary', () => {
  it('ships only the local Shared Pool product surface', async () => {
    const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as {
      bin?: Record<string, string>
      files?: string[]
      scripts?: Record<string, string>
      dependencies?: Record<string, string>
    }
    const publishedFiles = pkg.files ?? []

    expect(Object.keys(pkg.bin ?? {})).toEqual(['dsh-openai-codex'])
    expect(publishedFiles).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/team|broker|edge|postgres|self-hosted/iu),
    ]))
    expect(Object.keys(pkg.scripts ?? {})).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/team|postgres/iu),
    ]))
    expect(pkg.dependencies).not.toHaveProperty('pg')

    for (const relativePath of [
      'src/team',
      'src/client/team',
      'src/shared/team-management.ts',
      'src/team-broker-bin.ts',
      'src/team-migrate-bin.ts',
      'deploy/broker',
      'deploy/edge',
      'deploy/postgres',
      'deploy/self-hosted',
      'deploy/host/smoke-live-sharing.mjs',
      'deploy/host/smoke-multi-team.mjs',
      'deploy/host/team-host.patch.yml',
      'scripts/smoke-team-web.mjs',
    ]) {
      expect(existsSync(resolve(root, relativePath)), relativePath).toBe(false)
    }
  })

  it('does not advertise the deferred Team product in the phase one overview', async () => {
    const readme = await readFile(resolve(root, 'README.md'), 'utf8')

    expect(readme).not.toMatch(/\bteam\b|团队|邀请制|贡献账号/iu)
  })

  it('keeps the phase one CI workflow local-only', async () => {
    const workflow = await readFile(resolve(root, '.github/workflows/ci.yml'), 'utf8')

    expect(workflow).not.toMatch(/team|postgres|self-hosted|docker compose/iu)
  })
})
