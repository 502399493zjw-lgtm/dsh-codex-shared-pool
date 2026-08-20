import { describe, expect, it } from 'vitest'
import { resolveCodexAccounts, selectCodexAccount } from '../src/quota/accounts.ts'

describe('Codex account identities', () => {
  it('derives stable ordinal ids for legacy accountHomes', () => {
    expect(resolveCodexAccounts(['/one', '/two'])).toEqual([
      { id: 'account-1', home: '/one' },
      { id: 'account-2', home: '/two' },
    ])
  })

  it('accepts explicit ids and selects the requested account', () => {
    const accounts = resolveCodexAccounts(['/one', '/two'], ['personal', 'work'])
    expect(selectCodexAccount(accounts, 'work')).toEqual({ id: 'work', home: '/two' })
  })

  it('falls back to the first account when the active id is absent or unknown', () => {
    const accounts = resolveCodexAccounts(['/one', '/two'], ['personal', 'work'])
    expect(selectCodexAccount(accounts)).toEqual({ id: 'personal', home: '/one' })
    expect(selectCodexAccount(accounts, 'missing')).toEqual({ id: 'personal', home: '/one' })
  })

  it('rejects mismatched, duplicate, and unsafe ids', () => {
    expect(() => resolveCodexAccounts(['/one'], ['one', 'two'])).toThrow(/same length/)
    expect(() => resolveCodexAccounts(['/one', '/two'], ['same', 'same'])).toThrow(/duplicate/)
    expect(() => resolveCodexAccounts(['/one'], ['../secret'])).toThrow(/accountIds/)
  })
})
