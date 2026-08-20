import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { OAuthCredential } from '@earendil-works/pi-ai'
import { OpenAICodexCredentialStore } from '../src/store.ts'

function credential(accountId: string): OAuthCredential {
  return {
    type: 'oauth',
    access: 'header.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL3Byb2ZpbGUiOnsibmFtZSI6IkFjY291bnQifX0.sig',
    refresh: `refresh-${accountId}`,
    expires: Date.now() + 60_000,
    accountId,
  }
}

describe('ordered profile document migration', () => {
  it('reads the original v1 active profile and writes the equivalent v2 order on change', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-codex-store-migration-'))
    const filename = join(directory, '.openai-codex-profiles.json')
    try {
      const first = {
        id: 'first',
        label: 'First',
        credential: credential('account-first'),
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
      }
      const second = {
        id: 'second',
        label: 'Second',
        credential: credential('account-second'),
        createdAt: 1_700_000_000_001,
        updatedAt: 1_700_000_000_001,
      }
      await writeFile(filename, JSON.stringify({ version: 1, activeProfileId: 'second', profiles: [first, second] }))
      await chmod(filename, 0o600)

      const store = new OpenAICodexCredentialStore(filename)
      expect((await store.listProfiles()).map(profile => profile.id)).toEqual(['second', 'first'])
      expect((await store.read('openai-codex'))?.accountId).toBe('account-second')

      await store.prioritizeProfile('first')
      const migrated = JSON.parse(await readFile(filename, 'utf8')) as { version: number; activeProfileId?: string; profiles: Array<{ id: string }> }
      expect(migrated.version).toBe(2)
      expect(migrated.activeProfileId).toBeUndefined()
      expect(migrated.profiles.map(profile => profile.id)).toEqual(['first', 'second'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
