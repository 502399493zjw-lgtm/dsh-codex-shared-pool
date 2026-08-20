/** Host-owned metadata-only receipts for local Codex pool requests. */

import { randomUUID } from 'node:crypto'
import type { LocalProfileAllocation } from './account-allocation.ts'
import type {
  LocalRoutingEventSummary,
  LocalRoutingStatus,
} from './shared/types.ts'

const MAX_EVENTS = 100

interface LocalRoutingEventLedgerOptions {
  readonly id?: () => string
  readonly now?: () => number
}

export interface BeginLocalRoutingEvent {
  readonly allocation: LocalProfileAllocation
  readonly profileOrder: readonly string[]
  readonly model: string
}

function ordinalAlias(index: number): string {
  if (index < 0) return '?'
  let value = index + 1
  let alias = ''
  while (value > 0) {
    value -= 1
    alias = String.fromCharCode(65 + (value % 26)) + alias
    value = Math.floor(value / 26)
  }
  return alias
}

function profileAlias(profileOrder: readonly string[], profileId: string): string {
  return ordinalAlias(profileOrder.indexOf(profileId))
}

/** Bounded process-memory ledger that never stores account labels or request content. */
export class LocalRoutingEventLedger {
  private readonly events: LocalRoutingEventSummary[] = []
  private activeProfileId: string | undefined
  private readonly id: () => string
  private readonly now: () => number

  constructor(options: LocalRoutingEventLedgerOptions = {}) {
    this.id = options.id ?? randomUUID
    this.now = options.now ?? Date.now
  }

  /** Begin one actual provider request after the local profile has been selected. */
  begin(input: BeginLocalRoutingEvent): string {
    const id = this.id()
    const event: LocalRoutingEventSummary = {
      id,
      profileAlias: profileAlias(input.profileOrder, input.allocation.profileId),
      ...input.allocation.previousProfileId === undefined ? {} : {
        previousProfileAlias: profileAlias(input.profileOrder, input.allocation.previousProfileId),
      },
      model: input.model,
      reason: input.allocation.reason,
      unit: 'request',
      status: 'in_progress',
      startedAt: this.now(),
    }
    this.events.unshift(event)
    this.activeProfileId = input.allocation.profileId
    if (this.events.length > MAX_EVENTS) this.events.length = MAX_EVENTS
    return id
  }

  /** Host-only identity of the profile selected for the newest provider attempt. */
  currentProfileId(): string | undefined {
    return this.activeProfileId
  }

  /** Settle one request without retaining an upstream error or response body. */
  settle(id: string, status: Exclude<LocalRoutingStatus, 'in_progress'>): void {
    const index = this.events.findIndex(event => event.id === id)
    if (index < 0 || this.events[index]?.status !== 'in_progress') return
    this.events[index] = { ...this.events[index], status, finishedAt: this.now() }
  }

  /** Return newest-first immutable snapshots. HTTP callers cap this at 50. */
  list(limit = 50): readonly LocalRoutingEventSummary[] {
    const bounded = Number.isInteger(limit) ? Math.max(1, Math.min(MAX_EVENTS, limit)) : 50
    return this.events.slice(0, bounded).map(event => ({ ...event }))
  }
}
