import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { delimiter, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assembleCodexQuotaSnapshot,
  CodexQuotaProvider,
  resolveCodexAccountHomes,
} from '../src/quota/provider.ts'
import {
  openAICodexAccountName,
  readOpenAICodexAccountName,
} from '../src/quota/account-name.ts'
import { projectCodexAccountQuota } from '../src/quota/wire.ts'

const savedPool = process.env.DSH_CODEX_ACCOUNT_HOMES
const savedHome = process.env.CODEX_HOME

afterEach(() => {
  if (savedPool === undefined) delete process.env.DSH_CODEX_ACCOUNT_HOMES
  else process.env.DSH_CODEX_ACCOUNT_HOMES = savedPool
  if (savedHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = savedHome
})

describe('Codex quota account pool', () => {
  it('uses configured homes in order and removes duplicates', () => {
    expect(resolveCodexAccountHomes(['./a', './a', './b'])).toEqual([
      resolve('./a'),
      resolve('./b'),
    ])
  })

  it('accepts a platform-delimited pool environment', () => {
    process.env.DSH_CODEX_ACCOUNT_HOMES = ['./one', './two'].join(delimiter)
    expect(resolveCodexAccountHomes(undefined)).toEqual([resolve('./one'), resolve('./two')])
  })

  it('does not count the implicit Codex home before a Pool profile is stored', async () => {
    delete process.env.DSH_CODEX_ACCOUNT_HOMES
    process.env.CODEX_HOME = '/private/implicit-codex-home'
    const readAccount = vi.fn(async () => { throw new Error('signed out') })
    const provider = new CodexQuotaProvider({}, {
      cwd: process.cwd(),
      spawn: (() => { throw new Error('not used') }) as never,
      readAccount,
      readStoredProfileCount: async () => 0,
    })

    await expect(provider.read()).resolves.toMatchObject({
      currentAccountName: null,
      currentRemainingPercent: null,
      currentResetsAt: null,
      poolAccountCount: 0,
      poolRemainingPercent: null,
    })
    expect(readAccount).not.toHaveBeenCalled()
  })

  it('keeps explicitly configured homes in the Pool when their quota reads are offline', async () => {
    const provider = new CodexQuotaProvider({
      accountHomes: ['/private/current', '/private/offline'],
    }, {
      cwd: process.cwd(),
      spawn: (() => { throw new Error('not used') }) as never,
      readAccount: async () => { throw new Error('offline') },
      readStoredProfileCount: async () => 0,
    })

    await expect(provider.read()).resolves.toMatchObject({
      poolAccountCount: 2,
      poolRemainingPercent: null,
    })
  })

  it('keeps configured pool count while averaging successful reads', async () => {
    const snapshot = await assembleCodexQuotaSnapshot(
      ['current', 'offline', 'other'],
      async (home) => {
        if (home === 'offline') throw new Error('offline')
        return home === 'current'
          ? { accountName: 'current@example.com', remainingPercent: 80, resetsAt: 5_000 }
          : { accountName: 'other@example.com', remainingPercent: 20, resetsAt: 8_000 }
      },
      () => 42,
    )
    expect(snapshot).toEqual({
      currentAccountName: 'current@example.com',
      currentRemainingPercent: 80,
      currentResetsAt: 5_000,
      poolAccountCount: 3,
      poolRemainingPercent: 50,
      refreshedAt: 42,
    })
  })

  it('does not promote another account when the active account is unavailable', async () => {
    const snapshot = await assembleCodexQuotaSnapshot(
      ['current', 'other'],
      async (home) => {
        if (home === 'current') throw new Error('offline')
        return { accountName: 'other@example.com', remainingPercent: 65, resetsAt: null }
      },
      () => 100,
    )
    expect(snapshot).toMatchObject({
      currentAccountName: null,
      currentRemainingPercent: null,
      currentResetsAt: null,
      poolAccountCount: 2,
      poolRemainingPercent: 65,
    })
  })

  it('uses the explicitly selected account for current quota fields', async () => {
    const snapshot = await assembleCodexQuotaSnapshot(
      ['personal', 'work'],
      async (home) => home === 'work'
        ? { accountName: 'work@example.com', remainingPercent: 35, resetsAt: 9_000 }
        : { accountName: 'personal@example.com', remainingPercent: 85, resetsAt: 8_000 },
      () => 150,
      'work',
    )
    expect(snapshot).toMatchObject({
      currentAccountName: 'work@example.com',
      currentRemainingPercent: 35,
      currentResetsAt: 9_000,
      poolAccountCount: 2,
      poolRemainingPercent: 60,
      refreshedAt: 150,
    })
  })

  it('reads a stable account id for request routing and caches it briefly', async () => {
    const readAccount = vi.fn(async (spec: { accountHome: string }) => ({
      accountName: spec.accountHome,
      remainingPercent: 70,
      resetsAt: null,
    }))
    const provider = new CodexQuotaProvider({
      accountHomes: ['/private/personal', '/private/work'],
      accountIds: ['personal', 'work'],
      refreshIntervalMs: 60_000,
    }, {
      cwd: process.cwd(),
      spawn: (() => { throw new Error('not used') }) as never,
      readAccount: readAccount as never,
    })

    await expect(provider.readAccountQuota('work')).resolves.toMatchObject({
      accountName: '/private/work',
      remainingPercent: 70,
    })
    await expect(provider.readAccountQuota('work')).resolves.toMatchObject({ remainingPercent: 70 })
    await expect(provider.readAccountQuota('unknown')).resolves.toBeUndefined()
    expect(readAccount).toHaveBeenCalledTimes(1)
    expect(readAccount.mock.calls[0]?.[0]).toMatchObject({ accountHome: '/private/work' })
  })
})

describe('Codex account display name', () => {
  function token(profile: Record<string, unknown>): string {
    const payload = Buffer.from(JSON.stringify({
      'https://api.openai.com/profile': profile,
    })).toString('base64url')
    return `header.${payload}.signature`
  }

  it('uses the same name-then-email display precedence as Settings', () => {
    expect(openAICodexAccountName(token({
      name: '  Codex   User  ',
      email: 'codex@example.com',
    }))).toBe('Codex User')
    expect(openAICodexAccountName(token({ name: ' ', email: 'codex@example.com' })))
      .toBe('codex@example.com')
  })

  it('does not surface malformed or missing credential data', () => {
    expect(openAICodexAccountName(undefined)).toBeUndefined()
    expect(openAICodexAccountName('not-a-token')).toBeUndefined()
    expect(openAICodexAccountName('a.invalid-json.c')).toBeUndefined()
    expect(openAICodexAccountName(`a.${Buffer.from('null').toString('base64url')}.c`))
      .toBeUndefined()
    expect(openAICodexAccountName(token({ name: '' }))).toBeUndefined()
  })

  it('reads only the display claim from the local Codex auth document', async () => {
    const accountHome = await mkdtemp(join(tmpdir(), 'dsh-codex-quota-'))
    try {
      await writeFile(join(accountHome, 'auth.json'), JSON.stringify({
        tokens: { access_token: token({ name: 'Local User' }), refresh_token: 'secret' },
      }))
      await expect(readOpenAICodexAccountName(accountHome)).resolves.toBe('Local User')
    } finally {
      await rm(accountHome, { recursive: true, force: true })
    }
  })

  it('falls back for oversized or malformed local Codex auth documents', async () => {
    const accountHome = await mkdtemp(join(tmpdir(), 'dsh-codex-quota-invalid-'))
    const authFile = join(accountHome, 'auth.json')
    try {
      for (const text of [
        ' '.repeat(64 * 1024 + 1),
        '{',
        'null',
        JSON.stringify({ tokens: null }),
      ]) {
        await writeFile(authFile, text)
        await expect(readOpenAICodexAccountName(accountHome)).resolves.toBeUndefined()
      }
    } finally {
      await rm(accountHome, { recursive: true, force: true })
    }
  })
})

describe('Codex app-server projection', () => {
  it('clamps used percentage and converts reset seconds to milliseconds', () => {
    expect(projectCodexAccountQuota(
      { account: { type: 'chatgpt', email: 'codex@example.com' } },
      { rateLimits: { primary: { usedPercent: -20, resetsAt: 12 } } },
    )).toEqual({
      accountName: 'codex@example.com',
      remainingPercent: 100,
      resetsAt: 12_000,
    })
  })
})
