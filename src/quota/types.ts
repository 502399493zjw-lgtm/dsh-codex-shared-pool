/** Display-safe Codex quota projection returned to browser clients. */
export interface CodexQuotaSnapshot {
  /** Settings-compatible ChatGPT name or email, or a non-secret account-kind fallback. */
  readonly currentAccountName: string | null
  /** Remaining share of the priority account's primary Codex window, from 0 to 100. */
  readonly currentRemainingPercent: number | null
  /** Primary-window reset instant in Unix epoch milliseconds. */
  readonly currentResetsAt: number | null
  /** Number of configured accounts, including temporarily unreadable accounts. */
  readonly poolAccountCount: number
  /** Mean remaining primary-window share across the accounts read successfully. */
  readonly poolRemainingPercent: number | null
  /** Instant when this projection was assembled, in Unix epoch milliseconds. */
  readonly refreshedAt: number
}

/** One account's validated app-server projection before pool aggregation. */
export interface CodexAccountQuota {
  readonly accountName: string
  readonly remainingPercent: number
  readonly resetsAt: number | null
}
