/** Stable, non-secret identities for Host-owned Codex homes. */

export interface CodexAccount {
  /** Configuration-stable id carried in quota projections. */
  readonly id: string
  /** Absolute Host-only Codex home. */
  readonly home: string
}

const ACCOUNT_ID = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/

function validateId(value: string, index: number): string {
  const id = value.trim()
  if (!ACCOUNT_ID.test(id)) {
    throw new TypeError(`dsh-codex-shared-pool: accountIds[${index}] must start with a letter and contain only letters, numbers, '.', '_' or '-'`)
  }
  return id
}

/** Pair resolved account homes with stable ids while preserving config order. */
export function resolveCodexAccounts(
  accountHomes: readonly string[],
  accountIds?: readonly string[],
): readonly CodexAccount[] {
  const supplied = accountIds !== undefined && accountIds.length > 0
  if (supplied && accountIds.length !== accountHomes.length) {
    throw new TypeError('dsh-codex-shared-pool: accountIds must have the same length as accountHomes')
  }
  const seen = new Set<string>()
  return Object.freeze(accountHomes.map((home, index) => {
    const id = validateId(supplied ? accountIds[index]! : `account-${index + 1}`, index)
    if (seen.has(id)) throw new TypeError(`dsh-codex-shared-pool: duplicate account id "${id}"`)
    seen.add(id)
    return Object.freeze({ id, home })
  }))
}

/** Select the configured account, falling back to the first account. */
export function selectCodexAccount(
  accounts: readonly CodexAccount[],
  activeAccountId?: string,
): CodexAccount | undefined {
  if (accounts.length === 0) return undefined
  const requested = activeAccountId?.trim()
  return (requested === undefined || requested.length === 0
    ? undefined
    : accounts.find(account => account.id === requested)) ?? accounts[0]
}
