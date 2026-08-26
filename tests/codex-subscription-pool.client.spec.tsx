// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/client/OpenAICodexSettings.tsx', () => ({
  OpenAICodexSettings: ({ embedded }: { embedded?: boolean }) => (
    <div data-testid="local-settings" data-embedded={String(embedded)}>local settings</div>
  ),
}))

vi.mock('../src/client/team/TeamSettings.tsx', () => ({
  TeamSettings: ({ embedded }: { embedded?: boolean }) => (
    <div data-testid="team-settings" data-embedded={String(embedded)}>team settings</div>
  ),
}))

import { CodexSubscriptionPoolSettings } from '../src/client/CodexSubscriptionPoolSettings.tsx'
import { en, type OpenAICodexSettingsKey } from '../src/client/locales.ts'
import { en as teamEn, type TeamSettingsKey } from '../src/client/team/locales.ts'

afterEach(cleanup)

const localT = (key: OpenAICodexSettingsKey): string => en[key]
const teamT = (key: TeamSettingsKey): string => teamEn[key]

describe('Codex subscription pool settings shell', () => {
  it('uses one page heading and switches between embedded local and Team settings', () => {
    render(<CodexSubscriptionPoolSettings localT={localT} teamT={teamT} />)

    expect(screen.getByRole('heading', { name: en.poolTitle })).toBeDefined()
    expect(screen.getByRole('tab', { name: en.localTab }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('local-settings').getAttribute('data-embedded')).toBe('true')
    expect(screen.queryByTestId('team-settings')).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: en.teamTab }))

    expect(screen.getByRole('tab', { name: en.teamTab }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('team-settings').getAttribute('data-embedded')).toBe('true')
    expect(screen.queryByTestId('local-settings')).toBeNull()
  })
})
