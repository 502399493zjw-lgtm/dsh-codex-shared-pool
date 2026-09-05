/** Strict JSON-safe sharing controls used at both remote and Browser boundaries. */
import type { TeamSharedAccountSharingSummary } from '../team/types.ts'

export function parseTeamSharing(value: unknown): TeamSharedAccountSharingSummary {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid sharing controls')
  const item = value as Record<string, unknown>
  const keys = ['personalReservePercent', 'maxSharedRequestsPerWindow', 'weeklySharedEstimatedApiCostLimitMicros', 'maxSharedConcurrency', 'allowedModels']
  if (Object.keys(item).some(key => !keys.includes(key))) throw new Error('unexpected sharing control')
  const integer = (key: string, min: number, max: number): number => {
    const n = item[key]
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < min || n > max) throw new Error('invalid sharing control')
    return n
  }
  const models = item.allowedModels
  if (!Array.isArray(models) || models.length > 32 || models.some(model => typeof model !== 'string' || model.length === 0 || model.length > 120)) {
    throw new Error('invalid shared models')
  }
  return {
    personalReservePercent: integer('personalReservePercent', 0, 99),
    maxSharedRequestsPerWindow: item.maxSharedRequestsPerWindow === null ? null : integer('maxSharedRequestsPerWindow', 1, 1_000_000),
    weeklySharedEstimatedApiCostLimitMicros: item.weeklySharedEstimatedApiCostLimitMicros === null ? null : integer('weeklySharedEstimatedApiCostLimitMicros', 0, Number.MAX_SAFE_INTEGER),
    maxSharedConcurrency: integer('maxSharedConcurrency', 1, 16),
    allowedModels: models as string[],
  }
}
