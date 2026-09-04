// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { SubscriptionEstimate } from '../src/client/SubscriptionEstimate.tsx'
import { projectSubscription } from '../src/shared/subscription.ts'

afterEach(cleanup)
const labels = { subscriptionTier: '订阅档位', weeklyEstimate: '周额度预估', unknownSubscription: '未知', weeklyEstimateUnavailable: '暂不可用' }

it('shows only the tier and total even when a legacy projection includes remaining dollars', () => {
  const legacy = { ...projectSubscription('plus')!, weeklyRemainingEstimatedUsd: 75 }
  render(<SubscriptionEstimate subscription={legacy} labels={labels} />)
  expect(screen.getByText('Plus')).toBeDefined()
  expect(screen.getByText('US$100.00')).toBeDefined()
  expect(screen.getByText('周额度预估')).toBeDefined()
  expect(screen.queryByText(/US\$75|周剩余预估/)).toBeNull()
  expect(screen.queryByText(/样本|校准|依据/)).toBeNull()
})
it('does not invent dollar values for unsupported or unknown subscriptions', () => {
  const { container } = render(<SubscriptionEstimate subscription={projectSubscription('business')} labels={labels} />)
  expect(screen.getByText('Business')).toBeDefined()
  expect(container.textContent).not.toContain('US$')
  expect(screen.getByText('周额度预估')).toBeDefined()
  expect(screen.getByText('暂不可用')).toBeDefined()
})
it('shows a total without pretending that missing weekly usage is zero', () => {
  render(<SubscriptionEstimate subscription={projectSubscription('prolite')} labels={labels} />)
  expect(screen.getByText('周额度预估')).toBeDefined()
  expect(screen.getByText('US$600.00')).toBeDefined()
  expect(screen.queryByText('周剩余预估')).toBeNull()
})
it('keeps the estimate row when subscription metadata is unavailable', () => {
  const { container } = render(<SubscriptionEstimate labels={labels} />)
  expect(screen.getByText('周额度预估')).toBeDefined()
  expect(screen.getByText('暂不可用')).toBeDefined()
  expect(container.textContent).not.toContain('US$')
})
