const PLAN_LABELS = {
  free: 'Free', go: 'Go', plus: 'Plus', prolite: 'Pro 5x', pro: 'Pro 20x',
  team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu',
  self_serve_business_prolite: 'Business Pro Lite',
  self_serve_business_usage_based: 'Business Usage Based', ent26: 'Enterprise',
  enterprise_cbp_automation: 'Enterprise Automation',
  enterprise_cbp_usage_based: 'Enterprise Usage Based', edu_plus: 'Edu Plus', edu_pro: 'Edu Pro',
  unknown: 'Unknown',
} as const

export type CodexPlanType = keyof typeof PLAN_LABELS

/** Display-only estimates, never a credit balance or routing signal. */
export interface CodexSubscription {
  readonly planType: CodexPlanType
  readonly weeklyEstimatedUsd?: number
  readonly weeklyRemainingEstimatedUsd?: number
}

export function normalizeCodexPlan(value: unknown): CodexPlanType | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  return Object.hasOwn(PLAN_LABELS, value) ? value as CodexPlanType : 'unknown'
}

export function subscriptionPlanLabel(plan: CodexPlanType): string {
  return PLAN_LABELS[plan]
}

export function projectSubscription(plan: unknown, weeklyRemainingPercent?: number): CodexSubscription | undefined {
  const planType = normalizeCodexPlan(plan)
  if (planType === undefined) return undefined
  const total = planType === 'plus' ? 100 : planType === 'prolite' ? 600 : planType === 'pro' ? 2100 : undefined
  if (total === undefined) return { planType }
  const validPercent = typeof weeklyRemainingPercent === 'number'
    && Number.isFinite(weeklyRemainingPercent) && weeklyRemainingPercent >= 0 && weeklyRemainingPercent <= 100
  return {
    planType,
    weeklyEstimatedUsd: total,
    ...(validPercent ? { weeklyRemainingEstimatedUsd: Math.round(total * weeklyRemainingPercent) / 100 } : {}),
  }
}

export function subscriptionFromUsage(value: unknown): CodexSubscription | undefined {
  if (!isRecord(value)) return undefined
  const bucket: unknown = Array.isArray(value.rateLimits)
    ? value.rateLimits.find((limit: unknown) => isRecord(limit) && limit.id === 'codex') : undefined
  const weekly: unknown = isRecord(bucket) && Array.isArray(bucket.windows)
    ? bucket.windows.find((window: unknown) => isRecord(window) && window.windowSeconds === 604_800) : undefined
  return projectSubscription(value.planType,
    isRecord(weekly) && typeof weekly.remainingPercent === 'number' ? weekly.remainingPercent : undefined)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Rebuild a remote projection from allowlisted metadata; never forward arbitrary fields. */
export function parseSubscription(value: unknown): CodexSubscription | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  const base = projectSubscription(item.planType)
  if (base === undefined || base.weeklyEstimatedUsd === undefined) return base
  const remaining = item.weeklyRemainingEstimatedUsd
  return {
    ...base,
    ...(typeof remaining === 'number' && Number.isFinite(remaining) && remaining >= 0 && remaining <= base.weeklyEstimatedUsd
      ? { weeklyRemainingEstimatedUsd: Math.round(remaining * 100) / 100 } : {}),
  }
}
