import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { OAuthCredential } from '@earendil-works/pi-ai'
import {
  OpenAICodexCredentialStore,
  OPENAI_CODEX_PROVIDER,
} from '../src/store.ts'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function credential(access = 'access-secret'): OAuthCredential {
  return {
    type: 'oauth',
    access,
    refresh: 'refresh-secret',
    expires: Date.now() + 60_000,
    accountId: 'account-1',
  }
}

function accessToken(profile: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({ 'https://api.openai.com/profile': profile })}.signature`
}

async function store(): Promise<OpenAICodexCredentialStore> {
  root = await mkdtemp(join(tmpdir(), 'dsh-openai-codex-'))
  return new OpenAICodexCredentialStore(join(root, 'auth.json'))
}

describe('OpenAICodexCredentialStore', () => {
  it('persists, lists, detaches, and removes the first OAuth profile owner-only', async () => {
    const auth = await store()
    expect(await auth.read(OPENAI_CODEX_PROVIDER)).toBeUndefined()

    await auth.modify(OPENAI_CODEX_PROVIDER, () => Promise.resolve(credential()))
    expect(await auth.list()).toEqual([{ providerId: OPENAI_CODEX_PROVIDER, type: 'oauth' }])
    const first = await auth.read(OPENAI_CODEX_PROVIDER)
    expect(first).toMatchObject({ type: 'oauth', accountId: 'account-1' })
    if (first?.type !== 'oauth') throw new Error('expected OAuth credential')
    first.access = 'mutated-only-in-caller'
    expect(await auth.read(OPENAI_CODEX_PROVIDER)).toMatchObject({ access: 'access-secret' })
    if (process.platform !== 'win32') expect((await stat(auth.filename)).mode & 0o777).toBe(0o600)
    expect(await auth.listProfiles()).toEqual([
      expect.objectContaining({ label: 'Default' }),
    ])

    await auth.delete(OPENAI_CODEX_PROVIDER)
    expect(await auth.list()).toEqual([])
  })

  it('serializes cross-instance refresh writes so each sees the prior value', async () => {
    const first = await store()
    const second = new OpenAICodexCredentialStore(first.filename)
    await first.modify(OPENAI_CODEX_PROVIDER, () => Promise.resolve(credential('zero')))
    const seen: string[] = []
    await Promise.all([
      first.modify(OPENAI_CODEX_PROVIDER, async (current) => {
        seen.push(current?.type === 'oauth' ? current.access : 'missing')
        await new Promise(resolve => setTimeout(resolve, 20))
        return credential('one')
      }),
      second.modify(OPENAI_CODEX_PROVIDER, async (current) => {
        seen.push(current?.type === 'oauth' ? current.access : 'missing')
        return credential('two')
      }),
    ])
    expect(seen[0]).toBe('zero')
    expect(seen[1]).toMatch(/one|two/)
    expect(seen[1]).not.toBe('zero')
  })

  it('rejects malformed and over-broad documents without echoing their contents', async () => {
    const auth = await store()
    await writeFile(auth.filename, '{"version":2,"profiles":[{"id":"one","label":"Main","createdAt":1,"updatedAt":1,"credential":{"type":"oauth","access":"leaked-secret"}}]}', { mode: 0o600 })
    const failure = await auth.read(OPENAI_CODEX_PROVIDER).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toContain('refresh')
    expect(String(failure)).not.toContain('leaked-secret')

    if (process.platform !== 'win32') {
      await writeFile(auth.filename, JSON.stringify({
        version: 2,
        profiles: [{ id: 'one', label: 'Main', createdAt: 1, updatedAt: 1, credential: credential() }],
      }), { mode: 0o644 })
      await chmod(auth.filename, 0o644)
      await expect(auth.read(OPENAI_CODEX_PROVIDER)).rejects.toThrow(/readable beyond its owner/)
    }
  })

  it('writes the ordered v2 document and refuses provider ids it does not own', async () => {
    const auth = await store()
    await auth.modify(OPENAI_CODEX_PROVIDER, () => Promise.resolve(credential()))
    expect(JSON.parse(await readFile(auth.filename, 'utf8'))).toMatchObject({
      version: 2,
      profiles: [{ credential: { type: 'oauth', accountId: 'account-1' } }],
    })
    await expect(auth.modify('other', () => Promise.resolve(credential())))
      .rejects.toThrow(/does not own provider/)
    expect(await auth.read('other')).toBeUndefined()
  })

  it('keeps named profiles separate and changes global priority only explicitly', async () => {
    const auth = await store()
    const first = await auth.addProfile('Personal', credential('first'))
    const second = await auth.addProfile('Work', { ...credential('second'), accountId: 'account-2' })

    expect(await auth.listProfiles()).toEqual([
      expect.objectContaining({ id: first.id, label: 'Personal' }),
      expect.objectContaining({ id: second.id, label: 'Work' }),
    ])
    expect(await auth.read(OPENAI_CODEX_PROVIDER)).toMatchObject({ access: 'first' })

    await auth.prioritizeProfile(second.id)
    expect((await auth.listProfiles()).map(profile => profile.id)).toEqual([second.id, first.id])
    expect(await auth.read(OPENAI_CODEX_PROVIDER)).toMatchObject({ access: 'second' })
    expect(await auth.forProfile(first.id).read(OPENAI_CODEX_PROVIDER)).toMatchObject({ access: 'first' })

    await expect(auth.addProfile(' work ', { ...credential('third'), accountId: 'account-3' }))
      .resolves.toMatchObject({ label: 'work' })
    await expect(auth.addProfile('Other', { ...credential('third'), accountId: 'account-2' }))
      .rejects.toThrow(/account already exists/)
  })

  it('reads only a profile provider account id for Host-side identity coordination', async () => {
    const auth = await store()
    const profile = await auth.addProfile('Personal', credential('private-access-token'))

    expect(await auth.readProfileProviderAccountId(profile.id)).toBe('account-1')
    expect(await auth.readProfileProviderAccountId('missing-profile')).toBeUndefined()
  })

  it('shows the OpenAI account name, falling back to email and then the stored label', async () => {
    const auth = await store()
    await auth.addProfile('Stored label', credential(accessToken({ name: ' Ada Lovelace ', email: 'ada@example.com' })))
    await auth.addProfile('Email fallback', {
      ...credential(accessToken({ name: ' ', email: 'grace@example.com' })),
      accountId: 'account-2',
    })
    await auth.addProfile('Local fallback', { ...credential('not-a-jwt'), accountId: 'account-3' })

    expect((await auth.listProfiles()).map(profile => profile.label)).toEqual([
      'Ada Lovelace',
      'grace@example.com',
      'Local fallback',
    ])
  })

  it('pins each session to its first resolved profile without priority-driven switching', async () => {
    let sessionId: string | undefined = 'session-a'
    const auth = await store()
    const sessionStore = new OpenAICodexCredentialStore(auth.filename, () => sessionId)
    const first = await auth.addProfile('First', credential('first'))
    const second = await auth.addProfile('Second', { ...credential('second'), accountId: 'account-2' })

    expect(await sessionStore.read(OPENAI_CODEX_PROVIDER)).toMatchObject({ access: 'first' })
    await auth.prioritizeProfile(second.id)
    expect(await sessionStore.read(OPENAI_CODEX_PROVIDER)).toMatchObject({ access: 'first' })

    sessionId = 'session-b'
    expect(await sessionStore.read(OPENAI_CODEX_PROVIDER)).toMatchObject({ access: 'second' })
    await sessionStore.modify(OPENAI_CODEX_PROVIDER, current => Promise.resolve({
      ...(current as OAuthCredential),
      access: 'second-refreshed',
    }))
    expect(await auth.forProfile(second.id).read(OPENAI_CODEX_PROVIDER)).toMatchObject({ access: 'second-refreshed' })
    expect(await auth.forProfile(first.id).read(OPENAI_CODEX_PROVIDER)).toMatchObject({ access: 'first' })
  })

  it('imports the prior single-account file without modifying or deleting it', async () => {
    const auth = await store()
    const legacyFilename = join(root as string, '.openai-codex-auth.json')
    const legacyText = `${JSON.stringify({ version: 1, credential: credential('legacy') }, null, 2)}\n`
    await writeFile(legacyFilename, legacyText, { mode: 0o600 })

    expect(await auth.read(OPENAI_CODEX_PROVIDER)).toMatchObject({ access: 'legacy' })
    expect(await auth.listProfiles()).toEqual([
      expect.objectContaining({ label: 'Imported account' }),
    ])
    expect(await readFile(legacyFilename, 'utf8')).toBe(legacyText)

    const imported = (await auth.listProfiles())[0]
    if (imported === undefined) throw new Error('expected imported profile')
    await auth.removeProfile(imported.id)
    expect(await auth.listProfiles()).toEqual([])
    expect(await readFile(legacyFilename, 'utf8')).toBe(legacyText)
  })
})
