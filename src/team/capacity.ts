/** Secret-free provider quota projection used by Team admission. */

import { openAICodexQuotaBucket } from '../account-allocation.ts'
import type { OpenAICodexUsage } from '../usage.ts'
import type { TeamCredentialBroker, TeamCredentialRef } from './credentials.ts'
import type { TeamQuotaSnapshot } from './routing.ts'

export interface TeamCapacityProviderOptions {
  readonly ttlMs?: number
  readonly errorTtlMs?: number
  readonly now?: () => number
}

interface CachedUsage {
  readonly expiresAt: number
  readonly usage?: OpenAICodexUsage
}

/**
 * Project all provider limits relevant to one model into a conservative Team
 * admission signal. The reserve uses the lowest known remaining percentage,
 * while the local request cap is anchored to the longest provider window so a
 * changing short-window bottleneck cannot reset local accounting early.
 * Missing reset evidence for that longest window stays missing.
 */
export function projectTeamQuota(usage: OpenAICodexUsage, model: string): TeamQuotaSnapshot {
  const bucket = usage.rateLimits.find(limit => limit.id === openAICodexQuotaBucket(model))
  const windows = bucket?.windows ?? []
  const remaining = [
    usage.individualLimit?.remainingPercent,
    ...windows.map(window => window.remainingPercent),
  ].filter((value): value is number => value !== undefined)
  const remainingPercent = remaining.length === 0 ? undefined : Math.min(...remaining)
  const durations = windows
    .map(window => window.windowSeconds)
    .filter(value => Number.isSafeInteger(value) && value > 0)
  const longestDuration = durations.length === 0 ? undefined : Math.max(...durations)
  const capWindows = longestDuration === undefined
    ? []
    : windows.filter(window => window.windowSeconds === longestDuration)
  const capResets = capWindows
    .map(window => window.resetsAt)
    .filter((value): value is number => value !== undefined && Number.isSafeInteger(value) && value >= 0)
  const resetAt = capWindows.length > 0 && capResets.length === capWindows.length
    ? Math.max(...capResets)
    : undefined
  return {
    healthy: true,
    ...remainingPercent === undefined ? {} : { remainingPercent },
    ...resetAt === undefined ? {} : { resetAt },
  }
}

/** Short-lived, coalesced provider reads prevent one Team request burst from
 * turning into a quota-endpoint burst. Failures are fail-closed for sharing. */
export class TeamCapacityProvider {
  private readonly broker: Pick<TeamCredentialBroker, 'readUsage'>
  private readonly ttlMs: number
  private readonly errorTtlMs: number
  private readonly now: () => number
  private readonly cache = new Map<string, CachedUsage>()
  private readonly inFlight = new Map<string, Promise<CachedUsage>>()

  constructor(broker: Pick<TeamCredentialBroker, 'readUsage'>, options: TeamCapacityProviderOptions = {}) {
    this.broker = broker
    this.ttlMs = boundedDuration(options.ttlMs ?? 15_000, 'ttlMs')
    this.errorTtlMs = boundedDuration(options.errorTtlMs ?? 2_000, 'errorTtlMs')
    this.now = options.now ?? Date.now
  }

  async read(ref: TeamCredentialRef, model: string): Promise<TeamQuotaSnapshot> {
    const key = capacityKey(ref)
    const now = this.now()
    const cached = this.cache.get(key)
    if (cached !== undefined && cached.expiresAt > now) {
      return cached.usage === undefined ? { healthy: false } : projectTeamQuota(cached.usage, model)
    }
    let pending = this.inFlight.get(key)
    if (pending === undefined) {
      pending = this.load(ref)
      this.inFlight.set(key, pending)
    }
    const loaded = await pending
    return loaded.usage === undefined ? { healthy: false } : projectTeamQuota(loaded.usage, model)
  }

  invalidate(ref: TeamCredentialRef): void {
    this.cache.delete(capacityKey(ref))
  }

  private async load(ref: TeamCredentialRef): Promise<CachedUsage> {
    const key = capacityKey(ref)
    try {
      const usage = await this.broker.readUsage(ref)
      const loaded = { usage, expiresAt: this.now() + this.ttlMs }
      this.cache.set(key, loaded)
      return loaded
    } catch {
      const loaded = { expiresAt: this.now() + this.errorTtlMs }
      this.cache.set(key, loaded)
      return loaded
    } finally {
      this.inFlight.delete(key)
    }
  }
}

function capacityKey(ref: TeamCredentialRef): string {
  return `${ref.teamId}:${ref.accountId}`
}

function boundedDuration(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 100 || value > 300_000) throw new Error(`${field} is outside the allowed range`)
  return value
}
