// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { SubscriptionEstimate } from '../src/client/SubscriptionEstimate.tsx'
import { projectSubscription } from '../src/shared/subscription.ts'

afterEach(cleanup)
const labels = { subscriptionTier: '订阅档位', weeklyEstimate: '周额度预估', weeklyRemainingEstimate: '周剩余预估', unknownSubscription: '未知' }

it('shows the tier and direct weekly remaining estimate without provenance', () => {
  render(<SubscriptionEstimate subscription={projectSubscription('plus', 75)} labels={labels} />)
  expect(screen.getByText('Plus')).toBeDefined()
  expect(screen.getByText('US$75.00 / US$100.00')).toBeDefined()
  expect(screen.getByText('周剩余预估')).toBeDefined()
  expect(screen.queryByText(/样本|校准|依据/)).toBeNull()
})
it('does not invent dollar values for unsupported or unknown subscriptions', () => {
  const { container } = render(<SubscriptionEstimate subscription={projectSubscription('business', 75)} labels={labels} />)
  expect(screen.getByText('Business')).toBeDefined()
  expect(container.textContent).not.toContain('US$')
})
it('shows a total without pretending that missing weekly usage is zero', () => {
  render(<SubscriptionEstimate subscription={projectSubscription('prolite')} labels={labels} />)
  expect(screen.getByText('周额度预估')).toBeDefined()
  expect(screen.getByText('US$600.00')).toBeDefined()
  expect(screen.queryByText('周剩余预估')).toBeNull()
})
it('renders nothing when the subscription is unavailable', () => {
  const { container } = render(<SubscriptionEstimate labels={labels} />)
  expect(container.textContent).toBe('')
})
