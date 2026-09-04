import { subscriptionPlanLabel } from '../shared/subscription.ts'
import type { CodexSubscription } from '../shared/subscription.ts'

type LabelKey = 'subscriptionTier' | 'weeklyEstimate' | 'unknownSubscription'
type Labels = Readonly<Record<LabelKey, string>>

export function subscriptionEstimateLabels(t: (key: LabelKey) => string): Labels {
  return {
    subscriptionTier: t('subscriptionTier'), weeklyEstimate: t('weeklyEstimate'),
    unknownSubscription: t('unknownSubscription'),
  }
}

const dollars = (value: number) => `US$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function SubscriptionEstimate({ subscription, labels }: {
  subscription?: CodexSubscription | undefined
  labels: Labels
}) {
  if (subscription === undefined) return null
  const { planType, weeklyEstimatedUsd: total } = subscription
  const rowStyle = { display: 'flex', flexWrap: 'wrap' as const, justifyContent: 'space-between', gap: '4px 16px' }
  return <div style={{ display: 'grid', gap: 8, fontSize: 13, marginBlock: 12 }}>
    <div style={rowStyle}>
      <span>{labels.subscriptionTier}</span>
      <span>{planType === 'unknown' ? labels.unknownSubscription : subscriptionPlanLabel(planType)}</span>
    </div>
    {total === undefined ? null : <div style={rowStyle}>
      <span>{labels.weeklyEstimate}</span>
      <span>{dollars(total)}</span>
    </div>}
  </div>
}
