import { subscriptionPlanLabel } from '../shared/subscription.ts'
import type { CodexSubscription } from '../shared/subscription.ts'

type LabelKey = 'subscriptionTier' | 'weeklyEstimate' | 'unknownSubscription' | 'weeklyEstimateUnavailable'
type Labels = Readonly<Record<LabelKey, string>>

export function subscriptionEstimateLabels(t: (key: LabelKey) => string): Labels {
  return {
    subscriptionTier: t('subscriptionTier'), weeklyEstimate: t('weeklyEstimate'),
    unknownSubscription: t('unknownSubscription'), weeklyEstimateUnavailable: t('weeklyEstimateUnavailable'),
  }
}

const dollars = (value: number) => `US$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function SubscriptionEstimate({ subscription, labels }: {
  subscription?: CodexSubscription | undefined
  labels: Labels
}) {
  const planType = subscription?.planType
  const total = subscription?.weeklyEstimatedUsd
  const rowStyle = { display: 'flex', flexWrap: 'wrap' as const, justifyContent: 'space-between', gap: '4px 16px' }
  return <div style={{ display: 'grid', gap: 8, fontSize: 13, marginBlock: 12 }}>
    <div style={rowStyle}>
      <span>{labels.subscriptionTier}</span>
      <span>{planType === undefined || planType === 'unknown' ? labels.unknownSubscription : subscriptionPlanLabel(planType)}</span>
    </div>
    <div style={rowStyle}>
      <span>{labels.weeklyEstimate}</span>
      <span>{total === undefined ? labels.weeklyEstimateUnavailable : dollars(total)}</span>
    </div>
  </div>
}
