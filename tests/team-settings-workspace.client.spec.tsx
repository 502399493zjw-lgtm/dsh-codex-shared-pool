// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import styles from '../src/client/team/TeamSettings.module.css'

const { managementApi } = vi.hoisted(() => ({
  managementApi: {
    connections: vi.fn(),
    switchConnection: vi.fn(),
    status: vi.fn(),
    overview: vi.fn(),
    acknowledgeDisplayNameMigration: vi.fn(),
    usage: vi.fn(),
    startOAuth: vi.fn(),
    cancelOAuth: vi.fn(),
    reauthorizeOAuth: vi.fn(),
    updateContribution: vi.fn(),
    revokeContribution: vi.fn(),
    previewInvite: vi.fn(),
    join: vi.fn(),
    recoverJoin: vi.fn(),
    discardPendingJoin: vi.fn(),
    disconnect: vi.fn(),
    leaveTeam: vi.fn(),
    dissolveTeam: vi.fn(),
    recoverTeamDissolution: vi.fn(),
    clearTeamDissolution: vi.fn(),
    clearConnectionTerminal: vi.fn(),
    setTeamStatus: vi.fn(),
    createInvite: vi.fn(),
    revealInvite: vi.fn(),
    revokeInvite: vi.fn(),
    requestOwnershipTransfer: vi.fn(),
    acceptOwnershipTransfer: vi.fn(),
    rejectOwnershipTransfer: vi.fn(),
    revokeOwnershipTransfer: vi.fn(),
    removeMember: vi.fn(),
  },
}))

const { authorizationPopupBridge } = vi.hoisted(() => ({
  authorizationPopupBridge: {
    open: vi.fn(),
  },
}))

vi.mock('../src/client/team/api.ts', () => ({
  createTeamManagementApi: () => managementApi,
}))

vi.mock('../src/client/authorization-popup.ts', () => ({
  openAuthorizationPopupBridge: authorizationPopupBridge.open,
}))

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children, icon: _icon, size: _size, variant: _variant, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    icon?: React.ReactNode
    size?: string
    variant?: string
  }) => <button type="button" {...props}>{children}</button>,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Modal: ({ open, title, description, children, footer }: {
    open: boolean
    title: string
    description?: string
    children?: React.ReactNode
    footer?: React.ReactNode
  }) => open ? (
    <div role="dialog" aria-label={title}>
      <h2>{title}</h2>
      {description === undefined ? null : <p>{description}</p>}
      {children}
      {footer}
    </div>
  ) : null,
  Pill: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  StateDot: ({ state }: { state: string }) => <span data-state={state} />,
  IconCopyOutline16: () => null,
  IconLinkOutline16: () => null,
  IconPauseOutline16: () => null,
  IconPlayOutline16: () => null,
  IconPlusOutline16: () => null,
  IconRefreshOutline16: () => null,
  IconTrashOutline16: () => null,
  writeClipboard: vi.fn().mockResolvedValue(true),
}))

import { formatWeeklyUsdMicros, TeamSettings } from '../src/client/team/TeamSettings.tsx'
import { zh, type TeamSettingsKey } from '../src/client/team/locales.ts'
import { TEAM_AUTHORIZATION_FAILED_CODE } from '../src/shared/team-management.ts'

// Keep fixture expirations deterministic and safely ahead of the wall clock.
const NOW = Date.UTC(2030, 7, 21, 12)
let oauthPopupReplace: ReturnType<typeof vi.fn>
let oauthPopupClose: ReturnType<typeof vi.fn>

const completeOwnerUsage = {
  role: 'owner',
  window: { startedAt: NOW - 86_400_000, endedAt: NOW },
  currency: 'USD',
  team: {
    requestCount: 39,
    tokenMeasuredRequestCount: 39,
    pricedRequestCount: 39,
    totalTokens: '3900000',
    estimatedCostUsdMicros: '5880000',
  },
  mine: {
    requestCount: 12,
    tokenMeasuredRequestCount: 12,
    pricedRequestCount: 12,
    totalTokens: '1200000',
    estimatedCostUsdMicros: '1750000',
  },
  ownedAccounts: [],
} as const

function translate(key: TeamSettingsKey, params?: Record<string, unknown>): string {
  let value = zh[key]
  for (const [name, replacement] of Object.entries(params ?? {})) {
    value = value.replaceAll(`{${name}}`, String(replacement))
  }
  return value
}

const mine = {
  id: 'mine-active', teamId: 'team-1', ownerMemberId: 'member-me', label: '个人 Pro', status: 'active',
  personalReservePercent: 20, maxSharedRequestsPerWindow: null,
  maxSharedConcurrency: 1, allowedModels: [], createdAt: 1, updatedAt: 1,
  capacity: { sharedInFlight: 0, buckets: [{ id: 'codex', reason: 'ready', remainingPercent: 74,
    subscription: { planType: 'pro', weeklyEstimatedUsd: 2100 },
  }] },
} as const
const paused = { ...mine, id: 'mine-paused', label: '备用账号', status: 'paused' as const }
const friend = {
  id: 'friend-active',
  ownerMemberId: 'member-mia',
  label: 'Mia 的账号',
  status: 'active' as const,
}
const CREATED_INVITE_TOKEN = 'dsh_invite_share-once-1234567890'
const REVEALED_INVITE_TOKEN = 'dsh_invite_revealed-secret-1234567890'

function expectedContext(currentMemberId = 'member-me') {
  return {
    serverOrigin: 'https://team.example.test',
    teamId: 'team-1',
    currentMemberId,
  }
}

it('keeps compact weekly amounts in dollar-sign form for Chinese UI', () => {
  const previousLanguage = document.documentElement.lang
  document.documentElement.lang = 'zh-CN'
  expect(formatWeeklyUsdMicros(157_500)).toBe('$0.16')
  expect(formatWeeklyUsdMicros(null)).toBe('—')
  document.documentElement.lang = previousLanguage
})

function confirmingDissolution() {
  return { state: 'confirming' as const, teamName: '周末造物局', requestedAt: NOW }
}

function confirmedDissolution(localCleanup: 'completed' | 'retry_required' | 'manual_required' = 'completed') {
  return { state: 'confirmed' as const, teamName: '周末造物局', dissolvedAt: NOW + 1_000, localCleanup }
}

function pendingInvite(id: string, label: string, revealable: boolean) {
  return {
    id, teamId: 'team-1', invitedByMemberId: 'member-me', label, status: 'pending' as const,
    revealable, expiresAt: NOW + 7 * 86_400_000, createdAt: NOW,
  }
}

function pendingOwnershipTransfer() {
  return {
    id: 'transfer-1',
    teamId: 'team-1',
    requestedByMemberId: 'member-me',
    targetMemberId: 'member-mia',
    status: 'pending' as const,
    createdAt: NOW,
    expiresAt: NOW + 24 * 60 * 60 * 1000,
  }
}

function switchToSecondOwnerTeam(): void {
  overviewState = {
    ...overviewState,
    team: { ...overviewState.team, id: 'team-2' },
    currentMember: {
      ...overviewState.currentMember,
      id: 'member-other-owner',
      teamId: 'team-2',
      displayName: 'Second Owner',
    },
    members: [
      {
        id: 'member-other-owner', teamId: 'team-2', displayName: 'Second Owner', role: 'owner', status: 'active', joinedAt: 1,
        canReceiveOwnership: false,
      },
      {
        id: 'member-mia-2', teamId: 'team-2', displayName: 'Mia', role: 'member', status: 'active', joinedAt: 2,
        canReceiveOwnership: true,
      },
    ],
    invites: [],
    contributions: [],
    activeSharedAccounts: [],
  }
}

function switchToSecondMemberTeam(): void {
  overviewState = {
    ...overviewState,
    viewerRole: 'member',
    team: { ...overviewState.team, id: 'team-2' },
    currentMember: {
      ...overviewState.currentMember,
      id: 'member-other',
      teamId: 'team-2',
      displayName: 'Second Member',
      role: 'member',
    },
    members: [
      {
        id: 'member-other-owner', teamId: 'team-2', displayName: 'Second Owner', role: 'owner', status: 'active', joinedAt: 1,
        canReceiveOwnership: false,
      },
      {
        id: 'member-other', teamId: 'team-2', displayName: 'Second Member', role: 'member', status: 'active', joinedAt: 2,
        canReceiveOwnership: true,
      },
    ],
    contributions: [],
    activeSharedAccounts: [],
  }
}

function uiTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

let overviewState: any

beforeEach(() => {
  oauthPopupReplace = vi.fn()
  oauthPopupClose = vi.fn()
  vi.spyOn(window, 'open').mockReturnValue({
    location: { replace: oauthPopupReplace },
    close: oauthPopupClose,
    opener: null,
  } as unknown as Window)
  authorizationPopupBridge.open.mockImplementation(() => {
    const popup = window.open('about:blank', '_blank')
    if (popup === null) return null
    return {
      window: popup,
      navigate: vi.fn(async (authorizationUrl: string) => {
        popup.location.replace(authorizationUrl)
        return true
      }),
      close: () => { popup.close() },
    }
  })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      status: 'ready',
      profiles: [
        { id: 'local-a', label: '本机账号 A', createdAt: 1, updatedAt: 1, usage: { planType: 'plus', rateLimits: [{ id: 'codex', windows: [{ remainingPercent: 68, windowSeconds: 604800 }] }] }, inUse: true },
        { id: 'local-b', label: '本机账号 B', createdAt: 2, updatedAt: 2, usage: {}, inUse: false },
        { id: 'local-c', label: '本机账号 C', createdAt: 3, updatedAt: 3, usage: {}, inUse: false },
      ],
    }),
  }))
  overviewState = {
    viewerRole: 'owner',
    team: { id: 'team-1', name: '周末造物局', status: 'active', lifecycleRevision: 7, createdAt: 1 },
    currentMember: {
      id: 'member-me', teamId: 'team-1', displayName: 'Edison', role: 'owner', status: 'active', joinedAt: 1,
      canReceiveOwnership: false,
    },
    members: [
      {
        id: 'member-me', teamId: 'team-1', displayName: 'Edison', role: 'owner', status: 'active', joinedAt: 1,
        canReceiveOwnership: false,
      },
      {
        id: 'member-mia', teamId: 'team-1', displayName: 'Mia', role: 'member', status: 'active', joinedAt: 2,
        canReceiveOwnership: true,
      },
    ],
    invites: [],
    contributions: [mine, paused],
    activeSharedAccounts: [
      { id: mine.id, ownerMemberId: mine.ownerMemberId, label: mine.label, status: 'active' },
      friend,
    ],
  }
  managementApi.status.mockResolvedValue({
    enabled: true, keyConfigured: true, keyWritable: true, pendingJoinConfigured: false, serverOrigin: 'https://team.example.test',
  })
  managementApi.overview.mockImplementation(async () => overviewState)
  managementApi.acknowledgeDisplayNameMigration.mockImplementation(async (migrationVersion: number) => {
    const nextOverview = { ...overviewState }
    if (nextOverview.displayNameMigrationNotice?.migrationVersion === migrationVersion) {
      delete nextOverview.displayNameMigrationNotice
    }
    overviewState = nextOverview
    return { migrationVersion, acknowledged: true }
  })
  managementApi.usage.mockResolvedValue(completeOwnerUsage)
  managementApi.startOAuth.mockResolvedValue({
    account: { ...mine, id: 'oauth-new', label: '朋友 Pro', status: 'authorizing' },
    method: 'browser',
    authorizationUrl: 'https://auth.openai.com/oauth/authorize?client_id=codex_cli',
    expiresAt: NOW + 600_000,
  })
  managementApi.cancelOAuth.mockResolvedValue({ account: { ...mine, status: 'revoked' } })
  managementApi.reauthorizeOAuth.mockResolvedValue({
    account: { ...mine, status: 'authorizing' },
    method: 'browser',
    authorizationUrl: 'https://auth.openai.com/oauth/authorize?client_id=codex_cli',
    expiresAt: NOW + 600_000,
  })
  managementApi.updateContribution.mockImplementation(async (accountId: string, patch: { status?: string }) => {
    overviewState = {
      ...overviewState,
      contributions: overviewState.contributions.map((account: any) =>
        account.id === accountId ? { ...account, ...patch } : account),
    }
    return { account: overviewState.contributions.find((account: any) => account.id === accountId) }
  })
  managementApi.revokeContribution.mockResolvedValue({ account: { ...mine, status: 'revoked' } })
  managementApi.previewInvite.mockResolvedValue({
    teamName: '周末造物局', label: '周末协作', expiresAt: NOW + 86_400_000, teamStatus: 'active',
    joinHandle: `dsh_join_${'a'.repeat(43)}`,
  })
  managementApi.connections.mockResolvedValue([])
  managementApi.switchConnection.mockResolvedValue({})
  managementApi.join.mockResolvedValue({ team: overviewState.team, member: overviewState.currentMember })
  managementApi.recoverJoin.mockResolvedValue({ team: overviewState.team, member: overviewState.currentMember })
  managementApi.discardPendingJoin.mockResolvedValue({ discarded: true })
  managementApi.disconnect.mockResolvedValue({ ok: true, remoteRevoked: false })
  managementApi.leaveTeam.mockResolvedValue({})
  managementApi.dissolveTeam.mockResolvedValue(confirmedDissolution())
  managementApi.recoverTeamDissolution.mockResolvedValue(confirmedDissolution())
  managementApi.clearTeamDissolution.mockResolvedValue(confirmedDissolution())
  managementApi.clearConnectionTerminal.mockResolvedValue({ cleared: true })
  managementApi.setTeamStatus.mockResolvedValue({
    team: { ...overviewState.team, status: 'paused', lifecycleRevision: 8 },
  })
  managementApi.createInvite.mockResolvedValue({
    invite: {
      id: 'invite-1', teamId: 'team-1', invitedByMemberId: 'member-me', label: '周末协作', status: 'pending',
      revealable: true, expiresAt: NOW + 7 * 86_400_000, createdAt: NOW,
    },
    inviteToken: CREATED_INVITE_TOKEN,
  })
  managementApi.revealInvite.mockResolvedValue({
    inviteId: 'invite-1',
    inviteToken: REVEALED_INVITE_TOKEN,
    expiresAt: NOW + 7 * 86_400_000,
  })
  managementApi.revokeInvite.mockImplementation(async (inviteId: string) => {
    const invite = overviewState.invites.find((candidate: any) => candidate.id === inviteId)
    const revoked = { ...invite, status: 'revoked' as const }
    overviewState = {
      ...overviewState,
      invites: overviewState.invites.map((candidate: any) => candidate.id === inviteId ? revoked : candidate),
    }
    return { invite: revoked }
  })
  managementApi.requestOwnershipTransfer.mockImplementation(async (targetMemberId: string) => {
    const transfer = { ...pendingOwnershipTransfer(), targetMemberId }
    overviewState = { ...overviewState, ownershipTransfer: transfer }
    return transfer
  })
  managementApi.acceptOwnershipTransfer.mockResolvedValue({
    transfer: { ...pendingOwnershipTransfer(), status: 'accepted', resolvedAt: NOW + 1_000 },
    formerOwner: { ...overviewState.members[0], role: 'member' },
    owner: { ...overviewState.members[1], role: 'owner' },
  })
  managementApi.rejectOwnershipTransfer.mockResolvedValue({
    ...pendingOwnershipTransfer(), status: 'rejected', resolvedAt: NOW + 1_000,
  })
  managementApi.revokeOwnershipTransfer.mockImplementation(async () => {
    const transfer = { ...pendingOwnershipTransfer(), status: 'revoked' as const, resolvedAt: NOW + 1_000 }
    const nextOverview = { ...overviewState }
    delete nextOverview.ownershipTransfer
    overviewState = nextOverview
    return transfer
  })
  managementApi.removeMember.mockResolvedValue({ member: { ...overviewState.members[1], status: 'removed' } })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

async function openTeamSettings(view?: 'usage' | 'members' | 'invitations') {
  const existing = screen.queryByRole('region', { name: zh.teamSettingsTitle })
  if (existing === null) {
    fireEvent.click(await screen.findByRole('button', { name: zh.teamSettings }))
  }
  const settings = await screen.findByRole('region', { name: zh.teamSettingsTitle })
  if (view !== undefined) {
    const navigation = within(settings).getByRole('navigation', { name: zh.workspaceNavigation })
    const label = view === 'usage'
      ? zh.usageSectionTitle
      : view === 'members'
        ? zh.membersTitle
        : zh.invitationsTitle
    fireEvent.click(within(navigation).getByRole('button', { name: label }))
  }
  return settings
}

function openTeamManagement(settings: HTMLElement) {
  fireEvent.click(within(settings).getByRole('button', { name: /团队管理/u }))
  return within(settings).getByRole('menu', { name: zh.teamManagement })
}

async function openDissolutionDialog() {
  const settings = await openTeamSettings()
  fireEvent.click(within(openTeamManagement(settings)).getByRole('menuitem', { name: '永久解散团队' }))
  return screen.getByRole('dialog', { name: /永久解散.*周末造物局/u })
}

it('does not expose local-only disconnect as a normal action for a valid Team connection', async () => {
  render(<TeamSettings t={translate} />)

  const settings = await openTeamSettings()

  expect(within(settings).queryByRole('button', { name: zh.disconnect })).toBeNull()
  expect(screen.queryByText(zh.disconnectLocal)).toBeNull()
})

async function submitDissolution() {
  const dialog = await openDissolutionDialog()
  fireEvent.change(within(dialog).getByLabelText('输入完整团队名称以确认'), {
    target: { value: '周末造物局' },
  })
  fireEvent.click(within(dialog).getByRole('button', { name: '永久解散团队' }))
  return dialog
}

describe('Team subscription-pool workspace', () => {
  it('shows subscription metadata for Spark-only accounts without Spark quota telemetry', async () => {
    overviewState.contributions = [{
      ...mine,
      allowedModels: ['gpt-5.3-codex-spark'],
      capacity: { sharedInFlight: 0, buckets: [{
        id: 'codex_spark', reason: 'quota_unavailable',
        subscription: mine.capacity.buckets[0].subscription,
      }] },
    }] as typeof overviewState.contributions
    render(<TeamSettings t={translate} embedded />)
    fireEvent.click(await screen.findByRole('button', { name: /个人 Pro/u }))
    expect(await screen.findByText('Pro 20x')).toBeDefined()
    expect(screen.getByText('US$2,100.00')).toBeDefined()
  })

  it('opens management only from the Team panel', async () => {
    render(<TeamSettings t={translate} embedded />)

    const panel = await screen.findByRole('region', { name: '团队面板' })
    expect(screen.queryByRole('region', { name: zh.teamSettingsTitle })).toBeNull()
    expect(within(panel).getByRole('region', { name: /账号（\d+）/u })).toBeDefined()
    const trigger = within(panel).getByRole('button', { name: zh.teamSettings })

    fireEvent.click(trigger)
    const settings = await screen.findByRole('region', { name: zh.teamSettingsTitle })
    expect(within(settings).queryByText(zh.workspaceKicker)).toBeNull()
    expect(within(settings).getByRole('heading', { name: zh.teamSettingsTitle })).toBeDefined()
    expect(within(settings).queryByRole('heading', { name: zh.workspaceTitle })).toBeNull()
    expect(within(settings).queryByText(zh.workspaceBreadcrumb)).toBeNull()
    expect(within(settings).getByRole('heading', { name: overviewState.team.name })).toBeDefined()
    expect(within(settings).getByRole('navigation', { name: zh.workspaceNavigation })).toBeDefined()
    expect(within(settings).getByRole('button', { name: zh.teamManagement })).toBeDefined()
    expect(within(settings).queryByRole('button', { name: zh.accountsNavigation })).toBeNull()
    expect(within(settings).queryByRole('region', { name: zh.accountsNavigation })).toBeNull()

    const back = within(settings).getByRole('button', { name: zh.backToTeam })
    expect(back.closest('aside')).not.toBeNull()
    expect(back.textContent?.trim()).toBe('←')
    expect(back.getAttribute('title')).toBe(zh.backToTeam)
    const refresh = within(settings).getByRole('button', { name: zh.refresh })
    expect(refresh.textContent?.trim()).toBe('')
    expect(refresh.getAttribute('title')).toBe(zh.refresh)

    fireEvent.click(back)
    expect(await screen.findByRole('region', { name: '团队面板' })).toBeDefined()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: zh.teamSettings }))
    expect(screen.getByRole('button', { name: zh.addAccount })).toBeDefined()
  })

  it('opens only after the Team settings button and returns focus when closed', async () => {
    render(<TeamSettings t={translate} embedded />)

    expect(screen.queryByRole('region', { name: zh.teamSettingsTitle })).toBeNull()
    const trigger = await screen.findByRole('button', { name: zh.teamSettings })

    fireEvent.click(trigger)
    expect(screen.getByRole('region', { name: zh.teamSettingsTitle })).toBeDefined()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: zh.backToTeam }))

    fireEvent.click(screen.getByRole('button', { name: zh.backToTeam }))
    expect(screen.queryByRole('region', { name: zh.teamSettingsTitle })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: zh.teamSettings }))
  })

  it('keeps account sharing in the Team panel and management behind Team settings', async () => {
    render(<TeamSettings t={translate} embedded />)

    expect(screen.queryByRole('navigation', { name: '团队工作区' })).toBeNull()
    const panel = await screen.findByRole('region', { name: zh.teamPanelTitle })
    expect(within(panel).getByRole('button', { name: /个人 Pro/u })).toBeDefined()
    expect(within(panel).getByRole('button', { name: /备用账号/u })).toBeDefined()
    expect(within(panel).getByRole('button', { name: `Mia 的账号 · ${translate('contributedBy', { name: 'Mia' })}` })).toBeDefined()
    expect(within(panel).getByRole('button', { name: zh.addAccount })).toBeDefined()

    const settings = await openTeamSettings()
    const navigation = within(settings).getByRole('navigation', { name: '团队工作区' })
    const usageEntry = within(navigation).getByRole('button', { name: '用量' })
    const membersEntry = within(navigation).getByRole('button', { name: '成员' })
    const invitationsEntry = within(navigation).getByRole('button', { name: '邀请码' })

    expect(usageEntry.getAttribute('aria-current')).toBe('page')
    expect(within(settings).queryByRole('button', { name: '账号' })).toBeNull()
    expect(within(settings).queryByRole('region', { name: zh.accountsNavigation })).toBeNull()
    expect(fetch).toHaveBeenCalledWith('/plugins/dsh-openai-codex/profiles', {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })

    expect(screen.getByRole('region', { name: '用量' })).toBeDefined()

    fireEvent.click(membersEntry)
    expect(membersEntry.getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('heading', { name: '成员' })).toBeDefined()
    expect(screen.getByRole('button', { name: '邀请成员' })).toBeDefined()
    expect(screen.queryByRole('region', { name: '用量' })).toBeNull()

    fireEvent.click(invitationsEntry)
    expect(invitationsEntry.getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('heading', { name: '邀请码' })).toBeDefined()
    expect(screen.getByRole('button', { name: '邀请成员' })).toBeDefined()
    expect(screen.queryByRole('heading', { name: '成员' })).toBeNull()
  })

  it('keeps browser authorization transient and exposes only cancellation', async () => {
    managementApi.startOAuth.mockImplementationOnce(async () => {
      const account = { ...mine, id: 'oauth-new', label: '朋友 Pro', status: 'authorizing' as const }
      overviewState = {
        ...overviewState,
        contributions: [...overviewState.contributions, account],
      }
      return {
        account,
        method: 'browser',
        authorizationUrl: 'https://auth.openai.com/oauth/authorize?client_id=codex_cli',
        expiresAt: NOW + 600_000,
      }
    })
    render(<TeamSettings t={translate} embedded />)
    const settings = await screen.findByRole('region', { name: zh.teamPanelTitle })

    fireEvent.click(within(settings).getByRole('button', { name: zh.addAccount }))
    const dialog = screen.getByRole('dialog', { name: zh.addAccountTitle })
    fireEvent.change(within(dialog).getByLabelText(zh.accountLabel), { target: { value: '朋友 Pro' } })
    fireEvent.click(within(dialog).getByRole('button', { name: zh.startAuthorization }))

    await waitFor(() => {
      expect(managementApi.startOAuth).toHaveBeenCalledWith('朋友 Pro', expectedContext(), 'browser')
    })
    expect(oauthPopupReplace).toHaveBeenCalledWith('https://auth.openai.com/oauth/authorize?client_id=codex_cli')
    const waiting = await screen.findByRole('region', { name: '等待浏览器授权' })
    expect(within(waiting).getByRole('status')).toBeDefined()
    expect(waiting.textContent).toContain('请在 OpenAI 窗口完成登录；你可以在这里继续等待或取消。')
    expect(waiting.textContent).not.toContain('一次性加密交接')
    expect(within(waiting).getAllByRole('button')).toHaveLength(1)
    expect(within(waiting).getByRole('button', { name: zh.cancelAuthorization })).toBeDefined()
    expect(within(waiting).queryByRole('button', { name: zh.openProvider })).toBeNull()
    expect(within(waiting).queryByRole('button', { name: zh.useDeviceCode })).toBeNull()
    expect(within(settings).queryByText('朋友 Pro')).toBeNull()
    expect(within(settings).getByRole('button', { name: zh.addAccount })).toHaveProperty('disabled', true)
    fireEvent.click(within(settings).getByRole('button', { name: zh.addAccount }))
    expect(managementApi.startOAuth).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog', { name: zh.deviceTitle })).toBeNull()
  })

  it('continues Team authorization when the in-app browser adopts the popup', async () => {
    const navigate = vi.fn().mockResolvedValue(true)
    const close = vi.fn()
    authorizationPopupBridge.open.mockReturnValueOnce({ window: null, navigate, close })
    managementApi.startOAuth.mockImplementationOnce(async () => {
      const account = { ...mine, id: 'oauth-adopted', label: '朋友 Pro', status: 'authorizing' as const }
      overviewState = { ...overviewState, contributions: [...overviewState.contributions, account] }
      return {
        account,
        method: 'browser',
        authorizationUrl: 'https://auth.openai.com/oauth/authorize?client_id=codex_cli',
        expiresAt: NOW + 600_000,
      }
    })

    render(<TeamSettings t={translate} embedded />)
    const settings = await screen.findByRole('region', { name: zh.teamPanelTitle })
    fireEvent.click(within(settings).getByRole('button', { name: zh.addAccount }))
    const dialog = screen.getByRole('dialog', { name: zh.addAccountTitle })
    fireEvent.change(within(dialog).getByLabelText(zh.accountLabel), { target: { value: '朋友 Pro' } })
    fireEvent.click(within(dialog).getByRole('button', { name: zh.startAuthorization }))

    expect(await screen.findByRole('region', { name: '等待浏览器授权' })).toBeDefined()
    expect(navigate).toHaveBeenCalledWith('https://auth.openai.com/oauth/authorize?client_id=codex_cli')
    expect(screen.queryByText(zh.browserPopupBlocked)).toBeNull()
    expect(close).not.toHaveBeenCalled()
  })

  it('reports a blocked Team authorization navigation and closes its popup controller', async () => {
    const navigate = vi.fn().mockResolvedValue(false)
    const close = vi.fn()
    authorizationPopupBridge.open.mockReturnValueOnce({ window: window, navigate, close })
    managementApi.startOAuth.mockResolvedValueOnce({
      account: { ...mine, id: 'oauth-blocked', label: '朋友 Pro', status: 'authorizing' },
      method: 'browser',
      authorizationUrl: 'https://auth.openai.com/oauth/authorize?client_id=codex_cli',
      expiresAt: NOW + 600_000,
    })

    render(<TeamSettings t={translate} embedded />)
    const settings = await screen.findByRole('region', { name: zh.teamPanelTitle })
    fireEvent.click(within(settings).getByRole('button', { name: zh.addAccount }))
    const dialog = screen.getByRole('dialog', { name: zh.addAccountTitle })
    fireEvent.change(within(dialog).getByLabelText(zh.accountLabel), { target: { value: '朋友 Pro' } })
    fireEvent.click(within(dialog).getByRole('button', { name: zh.startAuthorization }))

    expect(await screen.findByText(zh.browserPopupBlocked)).toBeDefined()
    expect(navigate).toHaveBeenCalledWith('https://auth.openai.com/oauth/authorize?client_id=codex_cli')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('does not start Team authorization when the popup bridge cannot be initialized', async () => {
    authorizationPopupBridge.open.mockReturnValueOnce(null)
    render(<TeamSettings t={translate} embedded />)
    const settings = await screen.findByRole('region', { name: zh.teamPanelTitle })

    fireEvent.click(within(settings).getByRole('button', { name: zh.addAccount }))
    const addDialog = screen.getByRole('dialog', { name: zh.addAccountTitle })
    fireEvent.change(within(addDialog).getByLabelText(zh.accountLabel), { target: { value: '朋友 Pro' } })
    fireEvent.click(within(addDialog).getByRole('button', { name: zh.startAuthorization }))

    await waitFor(() => { expect(screen.getByText(zh.browserPopupOpenFailed)).toBeDefined() })
    expect(managementApi.startOAuth).not.toHaveBeenCalled()
  })

  it('confirms before separately authorizing a signed-in local Codex account for the Team', async () => {
    overviewState = { ...overviewState, contributions: [], activeSharedAccounts: [] }
    managementApi.startOAuth.mockImplementationOnce(async () => {
      const account = { ...mine, id: 'oauth-new', label: '本机账号 A', status: 'authorizing' as const }
      overviewState = { ...overviewState, contributions: [account] }
      return {
        account,
        method: 'browser' as const,
        authorizationUrl: 'https://auth.openai.com/oauth/authorize?client_id=codex_cli',
        expiresAt: NOW + 600_000,
      }
    })
    render(<TeamSettings t={translate} embedded />)

    const panel = await screen.findByRole('region', { name: zh.teamPanelTitle })
    expect(await within(panel).findByRole('heading', { name: '本机账号 A' })).toBeDefined()
    expect(within(panel).getByRole('button', { name: /本机账号 B/u })).toBeDefined()
    expect(within(panel).getByRole('button', { name: /本机账号 C/u })).toBeDefined()
    expect(within(panel).getByText((content) => content.includes('需要再次授权后，团队才能使用这个账号。'))).toBeDefined()

    const localAccount = within(panel).getByRole('heading', { name: '本机账号 A' }).closest('article')!
    fireEvent.click(within(localAccount).getByRole('button', { name: zh.shareToTeam }))

    expect(managementApi.startOAuth).not.toHaveBeenCalled()
    const confirmation = screen.getByRole('dialog', { name: '将 本机账号 A 用于团队' })
    expect(within(confirmation).getByText('请再次登录这个 OpenAI 账号。')).toBeDefined()
    expect(within(confirmation).getByText((content) => content.includes('你的本机登录保持不变。'))).toBeDefined()
    expect(within(confirmation).getByText((content) => content.includes('不会上传本机 auth.json。'))).toBeDefined()
    fireEvent.click(within(confirmation).getByRole('button', { name: zh.cancel }))
    expect(screen.queryByRole('dialog', { name: '将 本机账号 A 用于团队' })).toBeNull()
    expect(managementApi.startOAuth).not.toHaveBeenCalled()

    fireEvent.click(within(localAccount).getByRole('button', { name: zh.shareToTeam }))
    fireEvent.click(within(screen.getByRole('dialog', { name: '将 本机账号 A 用于团队' })).getByRole('button', { name: '继续，再次授权' }))

    await waitFor(() => {
      expect(managementApi.startOAuth).toHaveBeenCalledWith(
        '本机账号 A',
        expectedContext(),
        'browser',
        'local-a',
      )
    })
    expect(oauthPopupReplace).toHaveBeenCalledWith('https://auth.openai.com/oauth/authorize?client_id=codex_cli')
    expect(await screen.findByRole('region', { name: '等待浏览器授权' })).toBeDefined()
  })

  it('invalidates a local-account authorization confirmation when the active Team identity changes', async () => {
    overviewState = { ...overviewState, contributions: [], activeSharedAccounts: [] }
    render(<TeamSettings t={translate} embedded />)

    const panel = await screen.findByRole('region', { name: zh.teamPanelTitle })
    const localAccount = within(panel).getByRole('heading', { name: '本机账号 A' }).closest('article')!
    fireEvent.click(within(localAccount).getByRole('button', { name: zh.shareToTeam }))
    expect(screen.getByRole('dialog', { name: '将 本机账号 A 用于团队' })).toBeDefined()

    switchToSecondOwnerTeam()
    fireEvent.click(within(panel).getByRole('button', { name: zh.teamSettings }))
    const settings = await screen.findByRole('region', { name: zh.teamSettingsTitle })
    fireEvent.click(within(settings).getByRole('button', { name: zh.refresh }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '将 本机账号 A 用于团队' })).toBeNull()
    })
    expect(managementApi.startOAuth).not.toHaveBeenCalled()
  })

  it('refreshes a stale Team snapshot and asks for confirmation again without replaying authorization', async () => {
    overviewState = { ...overviewState, contributions: [], activeSharedAccounts: [] }
    managementApi.startOAuth.mockImplementationOnce(async () => {
      switchToSecondOwnerTeam()
      throw Object.assign(
        new Error('Team connection changed; refresh before trying again'),
        { status: 409 },
      )
    })
    render(<TeamSettings t={translate} embedded />)

    const panel = await screen.findByRole('region', { name: zh.teamPanelTitle })
    const localAccount = within(panel).getByRole('heading', { name: '本机账号 A' }).closest('article')!
    fireEvent.click(within(localAccount).getByRole('button', { name: zh.shareToTeam }))
    fireEvent.click(within(screen.getByRole('dialog', { name: '将 本机账号 A 用于团队' }))
      .getByRole('button', { name: '继续，再次授权' }))

    const recoveryTitle = await screen.findByText('团队已更新，请重新确认后继续。')
    expect(recoveryTitle.parentElement?.getAttribute('aria-live')).toBe('polite')
    expect(managementApi.startOAuth).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).not.toContain('Team connection changed; refresh before trying again')
    expect(screen.queryByRole('dialog', { name: '将 本机账号 A 用于团队' })).toBeNull()
  })

  it('discards a newly-added placeholder and restores the prior account after cancellation', async () => {
    managementApi.startOAuth.mockImplementationOnce(async () => {
      const account = { ...mine, id: 'oauth-new', label: '朋友 Pro', status: 'authorizing' as const }
      overviewState = {
        ...overviewState,
        contributions: [...overviewState.contributions, account],
      }
      return {
        account,
        method: 'browser',
        authorizationUrl: 'https://auth.openai.com/oauth/authorize?client_id=codex_cli',
        expiresAt: NOW + 600_000,
      }
    })
    managementApi.cancelOAuth.mockImplementationOnce(async () => {
      overviewState = {
        ...overviewState,
        contributions: overviewState.contributions.filter((account: any) => account.id !== 'oauth-new'),
      }
      return { account: { ...mine, id: 'oauth-new', label: '朋友 Pro', status: 'revoked' as const } }
    })
    render(<TeamSettings t={translate} embedded />)
    const settings = await screen.findByRole('region', { name: zh.teamPanelTitle })
    fireEvent.click(within(settings).getByRole('button', { name: `${paused.label} · ${zh.paused}` }))
    expect(within(settings).getByRole('heading', { name: paused.label })).toBeDefined()
    fireEvent.click(within(settings).getByRole('button', { name: zh.addAccount }))
    const addDialog = screen.getByRole('dialog', { name: zh.addAccountTitle })
    fireEvent.change(within(addDialog).getByLabelText(zh.accountLabel), { target: { value: '朋友 Pro' } })
    fireEvent.click(within(addDialog).getByRole('button', { name: zh.startAuthorization }))

    const waiting = await screen.findByRole('region', { name: '等待浏览器授权' })
    fireEvent.click(within(waiting).getByRole('button', { name: zh.cancelAuthorization }))

    await waitFor(() => {
      expect(managementApi.cancelOAuth).toHaveBeenCalledWith('oauth-new', expectedContext(), true)
    })
    expect(oauthPopupClose).toHaveBeenCalled()
    expect(within(settings).getByRole('heading', { name: paused.label })).toBeDefined()
    expect(within(settings).getByRole('button', { name: `${paused.label} · ${zh.paused}` }).getAttribute('aria-pressed')).toBe('true')
    expect(within(settings).queryByText('朋友 Pro')).toBeNull()
  })

  it('keeps a completed account selected when cancellation races with browser completion', async () => {
    const authorizing = { ...mine, id: 'oauth-new', label: '朋友 Pro', status: 'authorizing' as const }
    const active = { ...authorizing, status: 'active' as const }
    managementApi.startOAuth.mockImplementationOnce(async () => {
      overviewState = {
        ...overviewState,
        contributions: [...overviewState.contributions, authorizing],
      }
      return {
        account: authorizing,
        method: 'browser',
        authorizationUrl: 'https://auth.openai.com/oauth/authorize?client_id=codex_cli',
        expiresAt: NOW + 600_000,
      }
    })
    managementApi.cancelOAuth.mockImplementationOnce(async () => {
      overviewState = {
        ...overviewState,
        contributions: overviewState.contributions.map((account: any) => account.id === active.id ? active : account),
      }
      return { account: active }
    })
    render(<TeamSettings t={translate} embedded />)
    const panel = await screen.findByRole('region', { name: zh.teamPanelTitle })
    fireEvent.click(within(panel).getByRole('button', { name: `${paused.label} · ${zh.paused}` }))
    fireEvent.click(within(panel).getByRole('button', { name: zh.addAccount }))
    const addDialog = screen.getByRole('dialog', { name: zh.addAccountTitle })
    fireEvent.change(within(addDialog).getByLabelText(zh.accountLabel), { target: { value: '朋友 Pro' } })
    fireEvent.click(within(addDialog).getByRole('button', { name: zh.startAuthorization }))

    const waiting = await screen.findByRole('region', { name: '等待浏览器授权' })
    fireEvent.click(within(waiting).getByRole('button', { name: zh.cancelAuthorization }))

    await waitFor(() => {
      expect(screen.queryByRole('region', { name: '等待浏览器授权' })).toBeNull()
      expect(within(panel).getByRole('heading', { name: active.label })).toBeDefined()
    })
    expect(within(panel).getByRole('button', { name: `${active.label} · ${zh.contributedByMe}` }).getAttribute('aria-pressed')).toBe('true')
  })

  it('selects the real account automatically when browser authorization completes', async () => {
    const authorizing = { ...mine, id: 'oauth-new', label: '朋友 Pro', status: 'authorizing' as const }
    managementApi.startOAuth.mockImplementationOnce(async () => {
      overviewState = {
        ...overviewState,
        contributions: [...overviewState.contributions, authorizing],
      }
      return {
        account: authorizing,
        method: 'browser',
        authorizationUrl: 'https://auth.openai.com/oauth/authorize?client_id=codex_cli',
        expiresAt: NOW + 600_000,
      }
    })
    render(<TeamSettings t={translate} embedded />)
    const panel = await screen.findByRole('region', { name: zh.teamPanelTitle })
    fireEvent.click(within(panel).getByRole('button', { name: zh.addAccount }))
    const addDialog = screen.getByRole('dialog', { name: zh.addAccountTitle })
    fireEvent.change(within(addDialog).getByLabelText(zh.accountLabel), { target: { value: '朋友 Pro' } })
    fireEvent.click(within(addDialog).getByRole('button', { name: zh.startAuthorization }))
    expect(await screen.findByRole('region', { name: '等待浏览器授权' })).toBeDefined()

    overviewState = {
      ...overviewState,
      contributions: overviewState.contributions.map((account: any) =>
        account.id === authorizing.id ? { ...account, status: 'active' as const } : account),
    }
    const settings = await openTeamSettings('usage')
    const callsBeforeRefresh = managementApi.overview.mock.calls.length
    fireEvent.click(within(settings).getByRole('button', { name: zh.refresh }))
    await waitFor(() => {
      expect(managementApi.overview.mock.calls.length).toBeGreaterThan(callsBeforeRefresh)
    })
    fireEvent.click(within(settings).getByRole('button', { name: zh.backToTeam }))

    await waitFor(() => {
      expect(screen.queryByRole('region', { name: '等待浏览器授权' })).toBeNull()
      expect(screen.getByRole('heading', { name: '朋友 Pro' })).toBeDefined()
    })
  })

  it('shows a safe localized error when browser authorization finishes without activating the account', async () => {
    const authorizing = { ...mine, id: 'oauth-failed', label: '朋友 Pro', status: 'authorizing' as const }
    managementApi.startOAuth.mockImplementationOnce(async () => {
      overviewState = {
        ...overviewState,
        contributions: [...overviewState.contributions, authorizing],
      }
      return {
        account: authorizing,
        method: 'browser',
        authorizationUrl: 'https://auth.openai.com/oauth/authorize?client_id=codex_cli',
        expiresAt: NOW + 600_000,
      }
    })
    render(<TeamSettings t={translate} embedded />)
    const panel = await screen.findByRole('region', { name: zh.teamPanelTitle })
    fireEvent.click(within(panel).getByRole('button', { name: zh.addAccount }))
    const addDialog = screen.getByRole('dialog', { name: zh.addAccountTitle })
    fireEvent.change(within(addDialog).getByLabelText(zh.accountLabel), { target: { value: authorizing.label } })
    fireEvent.click(within(addDialog).getByRole('button', { name: zh.startAuthorization }))
    expect(await screen.findByRole('region', { name: '等待浏览器授权' })).toBeDefined()

    overviewState = {
      ...overviewState,
      contributions: overviewState.contributions.map((account: any) => account.id === authorizing.id
        ? { ...account, status: 'revoked' as const, lastError: TEAM_AUTHORIZATION_FAILED_CODE }
        : account),
    }
    const settings = await openTeamSettings('usage')
    fireEvent.click(within(settings).getByRole('button', { name: zh.refresh }))
    fireEvent.click(within(settings).getByRole('button', { name: zh.backToTeam }))

    expect(await screen.findByText(zh.authorizationFailed)).toBeDefined()
    expect(screen.queryByRole('region', { name: '等待浏览器授权' })).toBeNull()
    expect(document.body.textContent).not.toContain(TEAM_AUTHORIZATION_FAILED_CODE)
  })

  it('captures the return selection before a slow browser authorization request begins', async () => {
    const authorizing = { ...mine, id: 'oauth-new', label: '朋友 Pro', status: 'authorizing' as const }
    let resolveOAuth!: (value: any) => void
    managementApi.startOAuth.mockImplementationOnce(() => new Promise(resolve => { resolveOAuth = resolve }))
    managementApi.cancelOAuth.mockImplementationOnce(async () => {
      overviewState = {
        ...overviewState,
        contributions: overviewState.contributions.filter((account: any) => account.id !== authorizing.id),
      }
      return { account: { ...authorizing, status: 'revoked' as const } }
    })

    render(<TeamSettings t={translate} embedded />)
    const panel = await screen.findByRole('region', { name: zh.teamPanelTitle })
    fireEvent.click(within(panel).getByRole('button', { name: `${paused.label} · ${zh.paused}` }))
    fireEvent.click(within(panel).getByRole('button', { name: zh.addAccount }))
    const addDialog = screen.getByRole('dialog', { name: zh.addAccountTitle })
    fireEvent.change(within(addDialog).getByLabelText(zh.accountLabel), { target: { value: '朋友 Pro' } })
    fireEvent.click(within(addDialog).getByRole('button', { name: zh.startAuthorization }))

    await waitFor(() => { expect(managementApi.startOAuth).toHaveBeenCalledTimes(1) })
    fireEvent.click(within(panel).getByRole('button', { name: `${mine.label} · ${zh.contributedByMe}` }))
    overviewState = { ...overviewState, contributions: [...overviewState.contributions, authorizing] }
    await act(async () => {
      resolveOAuth({
        account: authorizing,
        method: 'browser',
        authorizationUrl: 'https://auth.openai.com/oauth/authorize?client_id=codex_cli',
        expiresAt: NOW + 600_000,
      })
    })

    const waiting = await screen.findByRole('region', { name: '等待浏览器授权' })
    await waitFor(() => { expect(within(waiting).getByRole('button', { name: zh.cancelAuthorization })).not.toHaveProperty('disabled', true) })
    fireEvent.click(within(waiting).getByRole('button', { name: zh.cancelAuthorization }))

    await waitFor(() => {
      expect(within(panel).getByRole('button', { name: `${paused.label} · ${zh.paused}` }).getAttribute('aria-pressed')).toBe('true')
    })
  })

  it('keeps cancellation actionable while the first authorization refresh is still in flight', async () => {
    const authorizing = { ...mine, id: 'oauth-new', label: '朋友 Pro', status: 'authorizing' as const }
    let resolveOverview!: (value: any) => void
    managementApi.startOAuth.mockImplementationOnce(async () => {
      overviewState = { ...overviewState, contributions: [...overviewState.contributions, authorizing] }
      managementApi.overview.mockImplementationOnce(() => new Promise(resolve => { resolveOverview = resolve }))
      return {
        account: authorizing,
        method: 'browser',
        authorizationUrl: 'https://auth.openai.com/oauth/authorize?client_id=codex_cli',
        expiresAt: NOW + 600_000,
      }
    })

    render(<TeamSettings t={translate} embedded />)
    const panel = await screen.findByRole('region', { name: zh.teamPanelTitle })
    fireEvent.click(within(panel).getByRole('button', { name: zh.addAccount }))
    const addDialog = screen.getByRole('dialog', { name: zh.addAccountTitle })
    fireEvent.change(within(addDialog).getByLabelText(zh.accountLabel), { target: { value: '朋友 Pro' } })
    fireEvent.click(within(addDialog).getByRole('button', { name: zh.startAuthorization }))

    const waiting = await screen.findByRole('region', { name: '等待浏览器授权' })
    const cancel = within(waiting).getByRole('button', { name: zh.cancelAuthorization })
    expect(cancel).not.toHaveProperty('disabled', true)
    fireEvent.click(cancel)
    await waitFor(() => {
      expect(managementApi.cancelOAuth).toHaveBeenCalledWith(authorizing.id, expectedContext(), true)
    })
    await act(async () => { resolveOverview(overviewState) })
  })

  it('ends browser waiting safely when the first post-challenge snapshot has no placeholder', async () => {
    const authorizing = { ...mine, id: 'oauth-new', label: '朋友 Pro', status: 'authorizing' as const }
    managementApi.startOAuth.mockResolvedValueOnce({
      account: authorizing,
      method: 'browser',
      authorizationUrl: 'https://auth.openai.com/oauth/authorize?client_id=codex_cli',
      expiresAt: NOW + 600_000,
    })

    render(<TeamSettings t={translate} embedded />)
    const panel = await screen.findByRole('region', { name: zh.teamPanelTitle })
    fireEvent.click(within(panel).getByRole('button', { name: `${paused.label} · ${zh.paused}` }))
    fireEvent.click(within(panel).getByRole('button', { name: zh.addAccount }))
    const addDialog = screen.getByRole('dialog', { name: zh.addAccountTitle })
    fireEvent.change(within(addDialog).getByLabelText(zh.accountLabel), { target: { value: '朋友 Pro' } })
    fireEvent.click(within(addDialog).getByRole('button', { name: zh.startAuthorization }))

    expect(await screen.findByText('授权未完成，请重试。')).toBeDefined()
    expect(screen.queryByRole('region', { name: '等待浏览器授权' })).toBeNull()
    expect(within(panel).getByRole('button', { name: `${paused.label} · ${zh.paused}` }).getAttribute('aria-pressed')).toBe('true')
  })

  it('keeps a safe cancel path when the post-challenge overview refresh fails', async () => {
    const authorizing = { ...mine, id: 'oauth-new', label: '朋友 Pro', status: 'authorizing' as const }
    managementApi.startOAuth.mockImplementationOnce(async () => {
      managementApi.overview.mockRejectedValueOnce(new Error('temporary overview failure'))
      return {
        account: authorizing,
        method: 'browser',
        authorizationUrl: 'https://auth.openai.com/oauth/authorize?client_id=codex_cli',
        expiresAt: NOW + 600_000,
      }
    })

    render(<TeamSettings t={translate} embedded />)
    const panel = await screen.findByRole('region', { name: zh.teamPanelTitle })
    fireEvent.click(within(panel).getByRole('button', { name: zh.addAccount }))
    const addDialog = screen.getByRole('dialog', { name: zh.addAccountTitle })
    fireEvent.change(within(addDialog).getByLabelText(zh.accountLabel), { target: { value: '朋友 Pro' } })
    fireEvent.click(within(addDialog).getByRole('button', { name: zh.startAuthorization }))

    const waiting = await screen.findByRole('region', { name: '等待浏览器授权' })
    expect(await within(waiting).findByText('暂时无法刷新授权状态；你仍可取消本次授权。')).toBeDefined()
    const cancel = within(waiting).getByRole('button', { name: zh.cancelAuthorization })
    expect(cancel).not.toHaveProperty('disabled', true)
    fireEvent.click(cancel)
    await waitFor(() => {
      expect(managementApi.cancelOAuth).toHaveBeenCalledWith(authorizing.id, expectedContext(), true)
    })
  })

  it('keeps polling after the first post-challenge overview refresh fails', async () => {
    const authorizing = { ...mine, id: 'oauth-new', label: '朋友 Pro', status: 'authorizing' as const }
    managementApi.startOAuth.mockImplementationOnce(async () => {
      managementApi.overview.mockRejectedValueOnce(new Error('temporary overview failure'))
      return {
        account: authorizing,
        method: 'browser',
        authorizationUrl: 'https://auth.openai.com/oauth/authorize?client_id=codex_cli',
        expiresAt: NOW + 600_000,
      }
    })

    render(<TeamSettings t={translate} embedded />)
    const panel = await screen.findByRole('region', { name: zh.teamPanelTitle })
    fireEvent.click(within(panel).getByRole('button', { name: zh.addAccount }))
    const addDialog = screen.getByRole('dialog', { name: zh.addAccountTitle })
    fireEvent.change(within(addDialog).getByLabelText(zh.accountLabel), { target: { value: authorizing.label } })
    fireEvent.click(within(addDialog).getByRole('button', { name: zh.startAuthorization }))

    const waiting = await screen.findByRole('region', { name: '等待浏览器授权' })
    expect(await within(waiting).findByText('暂时无法刷新授权状态；你仍可取消本次授权。')).toBeDefined()

    const active = { ...authorizing, status: 'active' as const }
    overviewState = {
      ...overviewState,
      contributions: [...overviewState.contributions, active],
      activeSharedAccounts: [
        ...overviewState.activeSharedAccounts,
        { id: active.id, ownerMemberId: active.ownerMemberId, label: active.label, status: active.status },
      ],
    }

    await waitFor(() => {
      expect(screen.queryByRole('region', { name: '等待浏览器授权' })).toBeNull()
      expect(within(panel).getByRole('heading', { name: active.label })).toBeDefined()
    }, { timeout: 3_500 })
    expect(managementApi.overview.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('clears stale browser authorization projection when cancel succeeds but refresh fails', async () => {
    const authorizing = { ...mine, id: 'oauth-new', label: '朋友 Pro', status: 'authorizing' as const }
    managementApi.startOAuth.mockImplementationOnce(async () => {
      overviewState = {
        ...overviewState,
        contributions: [...overviewState.contributions, authorizing],
        pendingBrowserAuthorization: {
          accountId: authorizing.id,
          method: 'browser',
          expiresAt: NOW + 600_000,
          discardInitial: true,
        },
      }
      return {
        account: authorizing,
        method: 'browser',
        authorizationUrl: 'https://auth.openai.com/oauth/authorize?client_id=codex_cli',
        expiresAt: NOW + 600_000,
      }
    })
    managementApi.cancelOAuth.mockImplementationOnce(async () => {
      managementApi.overview.mockRejectedValueOnce(new Error('temporary overview failure after cancel'))
      return { account: { ...authorizing, status: 'revoked' as const } }
    })

    render(<TeamSettings t={translate} embedded />)
    const panel = await screen.findByRole('region', { name: zh.teamPanelTitle })
    fireEvent.click(within(panel).getByRole('button', { name: `${paused.label} · ${zh.paused}` }))
    fireEvent.click(within(panel).getByRole('button', { name: zh.addAccount }))
    const addDialog = screen.getByRole('dialog', { name: zh.addAccountTitle })
    fireEvent.change(within(addDialog).getByLabelText(zh.accountLabel), { target: { value: authorizing.label } })
    fireEvent.click(within(addDialog).getByRole('button', { name: zh.startAuthorization }))

    const waiting = await screen.findByRole('region', { name: '等待浏览器授权' })
    fireEvent.click(within(waiting).getByRole('button', { name: zh.cancelAuthorization }))

    await waitFor(() => {
      expect(managementApi.cancelOAuth).toHaveBeenCalledWith(authorizing.id, expectedContext(), true)
      expect(screen.queryByRole('region', { name: '等待浏览器授权' })).toBeNull()
    })
    expect(within(panel).getByRole('button', { name: zh.addAccount })).not.toHaveProperty('disabled', true)
    expect(within(panel).getByRole('button', { name: `${paused.label} · ${zh.paused}` }).getAttribute('aria-pressed')).toBe('true')
    expect(within(panel).queryByText(authorizing.label)).toBeNull()
  })

  it('clears an old browser presentation when the refreshed Team identity changes', async () => {
    const authorizing = { ...mine, id: 'oauth-new', label: '朋友 Pro', status: 'authorizing' as const }
    managementApi.startOAuth.mockImplementationOnce(async () => {
      switchToSecondOwnerTeam()
      overviewState = { ...overviewState, team: { ...overviewState.team, name: '另一个团队' } }
      return {
        account: authorizing,
        method: 'browser',
        authorizationUrl: 'https://auth.openai.com/oauth/authorize?client_id=codex_cli',
        expiresAt: NOW + 600_000,
      }
    })

    render(<TeamSettings t={translate} embedded />)
    const panel = await screen.findByRole('region', { name: zh.teamPanelTitle })
    fireEvent.click(within(panel).getByRole('button', { name: zh.addAccount }))
    const addDialog = screen.getByRole('dialog', { name: zh.addAccountTitle })
    fireEvent.change(within(addDialog).getByLabelText(zh.accountLabel), { target: { value: '朋友 Pro' } })
    fireEvent.click(within(addDialog).getByRole('button', { name: zh.startAuthorization }))

    await waitFor(() => {
      expect(screen.queryByRole('region', { name: '等待浏览器授权' })).toBeNull()
      expect(screen.getByText('另一个团队')).toBeDefined()
    })
    expect(oauthPopupClose).toHaveBeenCalled()
    expect(managementApi.cancelOAuth).not.toHaveBeenCalled()
  })

  it('clears browser authorization when cancellation discovers a different Team context', async () => {
    const authorizing = { ...mine, id: 'oauth-new', label: '朋友 Pro', status: 'authorizing' as const }
    managementApi.startOAuth.mockImplementationOnce(async () => {
      overviewState = {
        ...overviewState,
        contributions: [...overviewState.contributions, authorizing],
        pendingBrowserAuthorization: {
          accountId: authorizing.id,
          method: 'browser',
          expiresAt: NOW + 600_000,
          discardInitial: true,
        },
      }
      return {
        account: authorizing,
        method: 'browser',
        authorizationUrl: 'https://auth.openai.com/oauth/authorize?client_id=codex_cli',
        expiresAt: NOW + 600_000,
      }
    })
    managementApi.cancelOAuth.mockImplementationOnce(async () => {
      switchToSecondOwnerTeam()
      const { pendingBrowserAuthorization: _pendingBrowserAuthorization, ...nextOverview } = overviewState
      overviewState = { ...nextOverview, team: { ...nextOverview.team, name: '另一个团队' } }
      throw Object.assign(
        new Error('Team connection changed; refresh before trying again'),
        { status: 409 },
      )
    })

    render(<TeamSettings t={translate} embedded />)
    const panel = await screen.findByRole('region', { name: zh.teamPanelTitle })
    fireEvent.click(within(panel).getByRole('button', { name: zh.addAccount }))
    const addDialog = screen.getByRole('dialog', { name: zh.addAccountTitle })
    fireEvent.change(within(addDialog).getByLabelText(zh.accountLabel), { target: { value: authorizing.label } })
    fireEvent.click(within(addDialog).getByRole('button', { name: zh.startAuthorization }))

    const waiting = await screen.findByRole('region', { name: '等待浏览器授权' })
    fireEvent.click(within(waiting).getByRole('button', { name: zh.cancelAuthorization }))

    await waitFor(() => {
      expect(screen.queryByRole('region', { name: '等待浏览器授权' })).toBeNull()
      expect(screen.getByText('另一个团队')).toBeDefined()
      expect(screen.getByText('团队已更新，请重新确认后继续。')).toBeDefined()
    })
    expect(managementApi.cancelOAuth).toHaveBeenCalledTimes(1)
  })

  it('rehydrates a server-owned browser authorization after remount and exposes only cancellation', async () => {
    const authorizing = { ...mine, id: 'oauth-existing', label: '朋友 Pro', status: 'authorizing' as const }
    overviewState = {
      ...overviewState,
      contributions: [...overviewState.contributions, authorizing],
      pendingBrowserAuthorization: {
        accountId: authorizing.id,
        method: 'browser',
        expiresAt: NOW + 600_000,
        discardInitial: true,
      },
    }
    managementApi.cancelOAuth.mockImplementationOnce(async () => {
      overviewState = {
        ...overviewState,
        contributions: overviewState.contributions.filter((account: any) => account.id !== authorizing.id),
      }
      delete overviewState.pendingBrowserAuthorization
      return { account: { ...authorizing, status: 'revoked' as const } }
    })

    render(<TeamSettings t={translate} embedded />)
    const panel = await screen.findByRole('region', { name: zh.teamPanelTitle })
    const waiting = await screen.findByRole('region', { name: '等待浏览器授权' })
    expect(within(waiting).getAllByRole('button')).toHaveLength(1)
    expect(within(panel).queryByText(authorizing.label)).toBeNull()
    expect(within(panel).getByRole('button', { name: zh.addAccount })).toHaveProperty('disabled', true)
    fireEvent.click(within(waiting).getByRole('button', { name: zh.cancelAuthorization }))

    await waitFor(() => {
      expect(managementApi.cancelOAuth).toHaveBeenCalledWith(authorizing.id, expectedContext(), true)
    })
  })

  it('shows a safe error when a rehydrated browser authorization fails', async () => {
    const authorizing = { ...mine, id: 'oauth-existing', label: '朋友 Pro', status: 'authorizing' as const }
    overviewState = {
      ...overviewState,
      contributions: [...overviewState.contributions, authorizing],
      pendingBrowserAuthorization: {
        accountId: authorizing.id,
        method: 'browser',
        expiresAt: NOW + 600_000,
        discardInitial: true,
      },
    }

    render(<TeamSettings t={translate} embedded />)
    const waiting = await screen.findByRole('region', { name: '等待浏览器授权' })
    expect(within(waiting).getByRole('button', { name: zh.cancelAuthorization })).toBeDefined()

    const { pendingBrowserAuthorization: _pendingBrowserAuthorization, ...nextOverview } = overviewState
    overviewState = {
      ...nextOverview,
      contributions: nextOverview.contributions.map((account: any) => account.id === authorizing.id
        ? { ...account, status: 'revoked' as const, lastError: TEAM_AUTHORIZATION_FAILED_CODE }
        : account),
    }
    const settings = await openTeamSettings('usage')
    fireEvent.click(within(settings).getByRole('button', { name: zh.refresh }))
    fireEvent.click(within(settings).getByRole('button', { name: zh.backToTeam }))

    expect(await screen.findByText(zh.authorizationFailed)).toBeDefined()
    expect(screen.queryByRole('region', { name: '等待浏览器授权' })).toBeNull()
    expect(document.body.textContent).not.toContain(TEAM_AUTHORIZATION_FAILED_CODE)
  })

  it('shows a safe action-oriented message when Team authorization cannot reach OpenAI', async () => {
    overviewState = { ...overviewState, contributions: [], activeSharedAccounts: [] }
    managementApi.startOAuth.mockRejectedValueOnce(
      new Error('remote Team request failed: team_authorization_network_unavailable'),
    )
    render(<TeamSettings t={translate} embedded />)

    const panel = await screen.findByRole('region', { name: zh.teamPanelTitle })
    const localAccount = within(panel).getByRole('heading', { name: '本机账号 A' }).closest('article')!
    fireEvent.click(within(localAccount).getByRole('button', { name: zh.shareToTeam }))
    fireEvent.click(within(screen.getByRole('dialog', { name: '将 本机账号 A 用于团队' }))
      .getByRole('button', { name: '继续，再次授权' }))

    expect(await screen.findByText('暂时无法连接 OpenAI 授权服务，请检查团队 Host 的网络或代理配置后重试。')).toBeDefined()
    expect(document.body.textContent).not.toMatch(/team_authorization_network_unavailable|Country, region|provider-detail/iu)
  })

  it('localizes the stable generic authorization failure without exposing its code', async () => {
    overviewState = { ...overviewState, contributions: [], activeSharedAccounts: [] }
    managementApi.startOAuth.mockRejectedValueOnce(
      new Error('remote Team request failed: team_authorization_failed'),
    )
    render(<TeamSettings t={translate} embedded />)

    const panel = await screen.findByRole('region', { name: zh.teamPanelTitle })
    const localAccount = within(panel).getByRole('heading', { name: '本机账号 A' }).closest('article')!
    fireEvent.click(within(localAccount).getByRole('button', { name: zh.shareToTeam }))
    fireEvent.click(within(screen.getByRole('dialog', { name: '将 本机账号 A 用于团队' }))
      .getByRole('button', { name: '继续，再次授权' }))

    expect(await screen.findByText('OpenAI 授权未能完成，未添加账号。请重试。')).toBeDefined()
    expect(document.body.textContent).not.toContain('team_authorization_failed')
  })

  it('refreshes a reconciled local account and localizes the already-shared conflict', async () => {
    overviewState = { ...overviewState, contributions: [], activeSharedAccounts: [] }
    managementApi.startOAuth.mockImplementationOnce(async () => {
      overviewState = {
        ...overviewState,
        contributions: [{ ...mine, label: '本机账号 A', sourceLocalProfileId: 'local-a' }],
      }
      throw Object.assign(
        new Error('remote Team request failed: team_local_account_already_shared'),
        { status: 409 },
      )
    })
    render(<TeamSettings t={translate} embedded />)

    const panel = await screen.findByRole('region', { name: zh.teamPanelTitle })
    const localAccount = within(panel).getByRole('heading', { name: '本机账号 A' }).closest('article')!
    fireEvent.click(within(localAccount).getByRole('button', { name: zh.shareToTeam }))
    fireEvent.click(within(screen.getByRole('dialog', { name: '将 本机账号 A 用于团队' }))
      .getByRole('button', { name: '继续，再次授权' }))

    expect(await screen.findByText('这个 OpenAI 账号已在团队中共享，已自动关联到现有账号，无需再次授权。')).toBeDefined()
    expect(document.body.textContent).not.toContain('team_local_account_already_shared')
    expect(screen.queryByRole('dialog', { name: '将 本机账号 A 用于团队' })).toBeNull()
    const directory = within(panel).getByRole('complementary')
    expect(within(directory).getByRole('button', { name: /本机账号 A · 我贡献/u })).toBeDefined()
    expect(within(directory).queryByRole('button', { name: /本机账号 A · 本机已登录/u })).toBeNull()
  })

  it('localizes a competing browser authorization and closes the stale local-account confirmation', async () => {
    overviewState = { ...overviewState, contributions: [], activeSharedAccounts: [] }
    managementApi.startOAuth.mockRejectedValueOnce(Object.assign(
      new Error('remote Team request failed: team_browser_authorization_already_pending'),
      { status: 409 },
    ))
    render(<TeamSettings t={translate} embedded />)

    const panel = await screen.findByRole('region', { name: zh.teamPanelTitle })
    const localAccount = within(panel).getByRole('heading', { name: '本机账号 A' }).closest('article')!
    fireEvent.click(within(localAccount).getByRole('button', { name: zh.shareToTeam }))
    const dialogName = '将 本机账号 A 用于团队'
    fireEvent.click(within(screen.getByRole('dialog', { name: dialogName }))
      .getByRole('button', { name: '继续，再次授权' }))

    expect(await screen.findByText('已有另一个 OpenAI 浏览器授权正在进行，请先完成或取消后再发起新的授权。')).toBeDefined()
    expect(document.body.textContent).not.toContain('team_browser_authorization_already_pending')
    expect(screen.queryByRole('dialog', { name: dialogName })).toBeNull()
  })

  it('edits sharing limits from the owned account card', async () => {
    render(<TeamSettings t={translate} embedded />)
    const settings = await screen.findByRole('region', { name: zh.teamPanelTitle })
    const account = within(settings).getByRole('heading', { name: '个人 Pro' }).closest('article')!

    expect(within(account).getByText((_, element) => element?.tagName === 'DD'
      && /—\s*\/\s*∞\s*编辑/u.test(element.textContent ?? ''))).toBeDefined()
    fireEvent.click(within(account).getByRole('button', { name: zh.editSharingLimit }))
    const dialog = screen.getByRole('dialog', { name: zh.editProtection })
    expect(within(dialog).getByLabelText(zh.weeklyLimitLabel)).toBeDefined()
    expect(within(dialog).queryByLabelText(zh.reserveLabel)).toBeNull()
    expect(within(dialog).queryByLabelText(zh.requestCapLabel)).toBeNull()
    expect(within(dialog).queryByLabelText(zh.allowedModelsLabel)).toBeNull()
    fireEvent.change(within(dialog).getByLabelText(zh.weeklyLimitLabel), { target: { value: '25' } })
    fireEvent.click(within(dialog).getByRole('button', { name: zh.save }))

    await waitFor(() => {
      expect(managementApi.updateContribution).toHaveBeenCalledWith('mine-active', {
        weeklySharedEstimatedApiCostLimitMicros: 25_000_000,
      }, expectedContext())
    })
  })

  it('keeps an open sharing confirmation in sync with the slower quota refresh', async () => {
    let resolveQuota!: (value: Response) => void
    vi.mocked(fetch).mockImplementation((input) => {
      if (input === '/plugins/dsh-openai-codex/profiles/directory') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            status: 'ready',
            profiles: [{
              id: 'local-a',
              label: '本机账号 A',
              createdAt: 1,
              updatedAt: 1,
              inUse: true,
            }],
          }),
        } as Response)
      }
      if (input === '/plugins/dsh-openai-codex/profiles') {
        return new Promise(resolve => { resolveQuota = resolve })
      }
      throw new Error(`Unexpected fetch: ${String(input)}`)
    })

    render(<TeamSettings t={translate} embedded />)
    const panel = await screen.findByRole('region', { name: zh.teamPanelTitle })
    fireEvent.click(await within(panel).findByRole('button', { name: /本机账号 A · 本机已登录/u }))
    const localAccount = within(panel).getByRole('heading', { name: '本机账号 A' }).closest('article')!

    fireEvent.click(within(localAccount).getByRole('button', { name: zh.shareToTeam }))

    const dialog = screen.getByRole('dialog', { name: '将 本机账号 A 用于团队' })
    const quota = within(dialog).getByRole('region', { name: zh.sharingQuotaConfirmation })
    expect(within(quota).getByText(zh.sharingQuotaUnavailable)).toBeDefined()
    expect(managementApi.startOAuth).not.toHaveBeenCalled()

    await act(async () => {
      resolveQuota({
        ok: true,
        json: async () => ({
          status: 'ready',
          profiles: [{
            id: 'local-a',
            label: '本机账号 A',
            createdAt: 1,
            updatedAt: 1,
            usage: { rateLimits: [{ id: 'codex', windows: [{ remainingPercent: 68, windowSeconds: 604800 }] }] },
            inUse: true,
          }],
        }),
      } as Response)
    })

    expect(within(quota).getByText('68%')).toBeDefined()
    expect(within(quota).queryByText(zh.sharingQuotaUnavailable)).toBeNull()
    expect(within(quota).getByText('20%')).toBeDefined()
    expect(within(quota).getByText(zh.sharingQuotaNoWeeklyLimit)).toBeDefined()
    expect(managementApi.startOAuth).not.toHaveBeenCalled()
  })

  it('shows an immediate saving state while sharing limits are being updated', async () => {
    let resolveUpdate!: (value: { account: typeof mine }) => void
    managementApi.updateContribution.mockImplementationOnce(() => new Promise(resolve => {
      resolveUpdate = resolve
    }))
    render(<TeamSettings t={translate} embedded />)
    const settings = await screen.findByRole('region', { name: zh.teamPanelTitle })
    const account = within(settings).getByRole('heading', { name: mine.label }).closest('article')!

    fireEvent.click(within(account).getByRole('button', { name: zh.editSharingLimit }))
    const dialog = screen.getByRole('dialog', { name: zh.editProtection })
    fireEvent.change(within(dialog).getByLabelText(zh.weeklyLimitLabel), { target: { value: '25' } })
    fireEvent.click(within(dialog).getByRole('button', { name: zh.save }))

    const saving = await within(dialog).findByRole('button', { name: zh.savingContribution })
    expect(saving).toHaveProperty('disabled', true)
    expect(saving.getAttribute('aria-busy')).toBe('true')

    resolveUpdate({ account: { ...mine, weeklySharedEstimatedApiCostLimitMicros: 25_000_000 } })
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: zh.editProtection })).toBeNull() })
  })

  it('restores the approved active-account contribution semantics', async () => {
    render(<TeamSettings t={translate} embedded />)

    const settings = await screen.findByRole('region', { name: zh.teamPanelTitle })
    const teamBar = settings.querySelector<HTMLElement>(`.${styles.teamBar}`)!
    const directory = within(settings).getByRole('complementary')
    const contribution = within(directory).getByRole('button', { name: `${mine.label} · ${zh.contributedByMe}` })
    const account = within(settings).getByRole('heading', { name: mine.label }).closest('article')!

    expect(within(teamBar).getByText(translate('membersCount', { count: 2 }))).toBeDefined()
    expect(within(teamBar).queryByText(translate('connectedAs', { name: 'Edison' }))).toBeNull()
    expect(within(contribution).getByText(zh.contributedByMe)).toBeDefined()
    expect(within(account).getByText('本机已登录 · 团队可用')).toBeDefined()
    expect(within(account).getByRole('button', { name: '终止共享' })).toBeDefined()
    expect(within(account).queryByText(zh.contributionActiveHint)).toBeNull()
  })

  it('keeps a provider-unavailable contribution manageable without claiming Team availability', async () => {
    overviewState = {
      ...overviewState,
      contributions: [{
        ...mine,
        capacity: {
          sharedInFlight: 0,
          buckets: [{ id: 'codex', reason: 'provider_unavailable' }],
        },
      }],
    }
    render(<TeamSettings t={translate} embedded />)

    const panel = await screen.findByRole('region', { name: zh.teamPanelTitle })
    const directory = within(panel).getByRole('complementary')
    const contribution = within(directory).getByRole('button', { name: `${mine.label} · ${zh.contributedByMe}` })
    const account = within(panel).getByRole('heading', { name: mine.label }).closest('article')!

    expect(contribution.querySelector('[data-state]')?.getAttribute('data-state')).toBe('error')
    expect(within(account).getByText(`${zh.localSignedIn} · ${zh.capacityProviderUnavailable}`)).toBeDefined()
    expect(account.querySelector('header [data-state]')?.getAttribute('data-state')).toBe('error')
    expect(within(account).queryByText(`${zh.localSignedIn} · ${zh.teamAvailable}`)).toBeNull()
    expect(within(account).getByRole('button', { name: zh.revokeContribution })).toBeDefined()
  })

  it('keeps a contribution available when at least one model bucket is ready', async () => {
    overviewState = {
      ...overviewState,
      contributions: [{
        ...mine,
        capacity: {
          sharedInFlight: 0,
          buckets: [
            { id: 'codex', reason: 'provider_unavailable' },
            { id: 'codex_spark', reason: 'ready', remainingPercent: 61 },
          ],
        },
      }],
    }
    render(<TeamSettings t={translate} embedded />)

    const panel = await screen.findByRole('region', { name: zh.teamPanelTitle })
    const directory = within(panel).getByRole('complementary')
    const contribution = within(directory).getByRole('button', { name: `${mine.label} · ${zh.contributedByMe}` })
    const account = within(panel).getByRole('heading', { name: mine.label }).closest('article')!

    expect(contribution.querySelector('[data-state]')?.getAttribute('data-state')).toBe('done')
    expect(within(account).getByText(`${zh.localSignedIn} · ${zh.teamAvailable}`)).toBeDefined()
  })

  it('shows teammate shared accounts in the directory and opens a safe read-only detail', async () => {
    render(<TeamSettings t={translate} embedded />)

    const panel = await screen.findByRole('region', { name: zh.teamPanelTitle })
    const directory = within(panel).getByRole('complementary')
    const details = within(panel).getByRole('region', { name: zh.accountDetails })
    const contributionLabel = translate('contributedBy', { name: 'Mia' })
    const teammateAccount = within(directory).getByRole('button', {
      name: `${friend.label} · ${contributionLabel}`,
    })

    expect(within(teammateAccount).getByText(contributionLabel)).toBeDefined()
    expect(teammateAccount.querySelector('[data-state]')?.getAttribute('data-state')).toBe('ongoing')
    fireEvent.click(teammateAccount)

    const account = within(details).getByRole('heading', { name: friend.label }).closest('article')!
    expect(account).toBeDefined()
    expect(account.querySelector('header [data-state]')?.getAttribute('data-state')).toBe('ongoing')
    expect(within(details).getByText(`${contributionLabel} · ${zh.teamShared}`)).toBeDefined()
    expect(within(details).queryByText(`${contributionLabel} · ${zh.teamAvailable}`)).toBeNull()
    expect(within(details).getByText(zh.sharedAccountReadonlyHint)).toBeDefined()
    expect(within(details).queryByRole('button', { name: zh.revokeContribution })).toBeNull()
    expect(within(details).queryByRole('button', { name: zh.editProtection })).toBeNull()
    expect(within(details).queryByRole('button', { name: zh.recentRequests })).toBeNull()
  })

  it('keeps authorizing accounts out of the stable directory while preserving actionable statuses', async () => {
    const authorizing = { ...mine, id: 'mine-authorizing', label: '授权中账号', status: 'authorizing' as const }
    const reauthRequired = { ...mine, id: 'mine-reauth', label: '待登录账号', status: 'reauth_required' as const }
    overviewState = { ...overviewState, contributions: [paused, authorizing, reauthRequired] }
    render(<TeamSettings t={translate} embedded />)

    const settings = await screen.findByRole('region', { name: zh.teamPanelTitle })
    const directory = within(settings).getByRole('complementary')
    const details = within(settings).getByRole('region', { name: zh.accountDetails })

    expect(within(directory).queryByRole('button', { name: `${authorizing.label} · ${zh.authorizing}` })).toBeNull()

    for (const account of [paused, reauthRequired]) {
      const status = zh[account.status]
      fireEvent.click(within(directory).getByRole('button', { name: `${account.label} · ${status}` }))
      expect(within(details).getByText(status)).toBeDefined()
    }

    expect(within(details).getByText(zh.contributionReauthHint)).toBeDefined()
  })

  it('shows which account action is pending while sharing is being terminated', async () => {
    let resolveRevoke!: (value: { account: typeof mine }) => void
    managementApi.revokeContribution.mockImplementationOnce(() => new Promise(resolve => {
      resolveRevoke = resolve
    }))
    render(<TeamSettings t={translate} embedded />)
    const settings = await screen.findByRole('region', { name: zh.teamPanelTitle })
    const account = within(settings).getByRole('heading', { name: mine.label }).closest('article')!

    fireEvent.click(within(account).getByRole('button', { name: '终止共享' }))

    const stopping = await within(account).findByRole('button', { name: '正在终止共享…' })
    expect(stopping).toHaveProperty('disabled', true)
    expect(stopping.getAttribute('aria-busy')).toBe('true')

    resolveRevoke({ account: { ...mine, status: 'revoked' } })
    await waitFor(() => {
      expect(managementApi.revokeContribution).toHaveBeenCalledWith(
        mine.id,
        expectedContext(),
      )
    })
    expect(managementApi.updateContribution).not.toHaveBeenCalled()
  })

  it('places subscription details below remaining capacity in the weekly summary', async () => {
    render(<TeamSettings t={translate} embedded />)
    const settings = await screen.findByRole('region', { name: zh.teamPanelTitle })
    const account = within(settings).getByRole('heading', { name: mine.label }).closest('article')!
    const summary = within(account).getByRole('region', { name: zh.weeklySharingTitle })
    const capacity = within(summary).getByText(zh.accountRemainingCapacity)
    const tier = within(summary).getByText(zh.subscriptionTier)
    const estimate = within(summary).getByText(zh.weeklyEstimate)
    expect(capacity.compareDocumentPosition(tier) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(tier.compareDocumentPosition(estimate) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
  })

  it('keeps unavailable usage inline without an account warning or retry button', async () => {
    managementApi.usage.mockRejectedValueOnce(new Error('upstream-usage-secret'))

    render(<TeamSettings t={translate} embedded />)

    const settings = await screen.findByRole('region', { name: zh.teamPanelTitle })
    const account = within(settings).getByRole('heading', { name: mine.label }).closest('article')!
    expect(await within(account).findByText(zh.recentUsageUnavailable)).toBeDefined()

    expect(within(account).queryByRole('alert')).toBeNull()
    expect(within(account).queryByText(zh.usageUnavailableTitle)).toBeNull()
    expect(within(account).queryByRole('button', { name: zh.retry })).toBeNull()
    expect(within(account).getByText(zh.accountRemainingCapacity).nextElementSibling?.textContent).toBe('74%')
    expect(account.textContent).not.toContain('upstream-usage-secret')

    const usageSettings = await openTeamSettings('usage')
    const usage = within(usageSettings).getByRole('region', { name: '用量' })
    fireEvent.click(within(usage).getByRole('button', { name: zh.retry }))
    expect(await within(usage).findByRole('group', { name: zh.myTeamUsage })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '返回团队' }))
    const restoredAccount = (await screen.findByRole('heading', { name: mine.label })).closest('article')!
    expect(within(restoredAccount).getByText(zh.accountRemainingCapacity).nextElementSibling?.textContent).toBe('74%')
  })

  it('matches the approved weekly-sharing and recent-day account detail', async () => {
    overviewState = {
      ...overviewState,
      contributions: overviewState.contributions.map((account: any) => account.id === mine.id
        ? { ...account, weeklySharedEstimatedApiCostLimitMicros: 1_000_000 }
        : account),
    }
    managementApi.usage.mockResolvedValueOnce({
      ...completeOwnerUsage,
      ownedAccounts: [{
        accountId: mine.id,
        label: mine.label,
        window: { startedAt: NOW - 7 * 86_400_000, endedAt: NOW },
        aggregate: {
          requestCount: 3,
          tokenMeasuredRequestCount: 3,
          pricedRequestCount: 3,
          totalTokens: '12500',
          estimatedCostUsdMicros: '157500',
        },
        currentUtcWeek: {
          window: { startedAt: NOW - 3 * 86_400_000, endedAt: NOW },
          resetAt: NOW + 4 * 86_400_000,
          aggregate: {
            requestCount: 3,
            tokenMeasuredRequestCount: 3,
            pricedRequestCount: 3,
            totalTokens: '12500',
            estimatedCostUsdMicros: '157500',
          },
        },
        last24Hours: {
          window: { startedAt: NOW - 86_400_000, endedAt: NOW },
          aggregate: {
            requestCount: 2,
            tokenMeasuredRequestCount: 2,
            pricedRequestCount: 2,
            totalTokens: '4800',
            estimatedCostUsdMicros: '63000',
          },
        },
        recentRequests: [{
          id: 'recent-1',
          model: 'gpt-5-codex',
          status: 'succeeded',
          startedAt: NOW - 60_000,
          totalTokens: '2500',
          estimatedCostUsdMicros: '31500',
        }],
      }],
    })

    render(<TeamSettings t={translate} embedded />)
    const settings = await screen.findByRole('region', { name: zh.teamPanelTitle })
    const account = within(settings).getByRole('heading', { name: mine.label }).closest('article')!
    const weekly = within(account).getByRole('region', { name: zh.weeklySharingTitle })
    const recentUsage = within(account).getByRole('region', { name: zh.recentUsageRegionLabel })
    const actions = within(account).getByRole('group', { name: zh.accountActions })

    expect(weekly.querySelectorAll('dl > div')).toHaveLength(2)
    expect(within(weekly).getByText(zh.weeklySharedAmount)).toBeDefined()
    const weeklyAmount = within(weekly).getByText((_, element) => element?.tagName === 'DD'
      && /\$0\.16\s*\/\s*\$1\.00\s*编辑/u.test(element.textContent ?? ''))
    expect(weeklyAmount.textContent).not.toMatch(/已用|共享上限/u)
    expect(within(weekly).queryByRole('img')).toBeNull()
    const editLimit = within(weekly).getByRole('button', { name: zh.editSharingLimit })
    expect(editLimit.textContent).toBe(zh.edit)
    expect(editLimit.querySelector('svg')).toBeNull()
    expect(within(weekly).getByText('Pro 20x')).toBeDefined()
    expect(within(weekly).getByText('US$2,100.00')).toBeDefined()
    expect(within(weekly).queryByText(/US\$1,554|周剩余预估/)).toBeNull()
    expect(within(weekly).queryByLabelText(zh.amountEstimateHelpLabel)).toBeNull()
    expect(within(weekly).getByText(zh.accountRemainingCapacity).nextElementSibling?.textContent).toBe('74%')
    expect(within(recentUsage).getByRole('heading', { name: zh.recentUsageTitle })).toBeDefined()
    expect(within(recentUsage).getByRole('button', { name: zh.viewSevenDays })).toBeDefined()
    expect(within(recentUsage).getByText((_, element) => element?.tagName === 'P'
      && /2 次请求.*API 价格估算（非实际扣费）.*0\.06/u.test(element.textContent ?? ''))).toBeDefined()
    expect(within(account).queryByRole('button', { name: zh.recentRequests })).toBeNull()
    expect(within(actions).getByRole('button', { name: '终止共享' })).toBeDefined()

    fireEvent.click(within(weekly).getByRole('button', { name: zh.editSharingLimit }))
    expect((within(screen.getByRole('dialog', { name: zh.editProtection }))
      .getByLabelText(zh.weeklyLimitLabel) as HTMLInputElement).value).toBe('1')
    fireEvent.click(within(screen.getByRole('dialog', { name: zh.editProtection })).getByRole('button', { name: zh.cancel }))

    fireEvent.click(within(recentUsage).getByRole('button', { name: zh.viewSevenDays }))
    const recent = screen.getByRole('dialog', { name: `近期请求 · ${mine.label}` })
    expect(within(recent).getByText('gpt-5-codex')).toBeDefined()
    expect(within(recent).getByText('2500 tokens')).toBeDefined()
    expect(recent.textContent).not.toContain('0.03')
  })

  it('labels missing recent-day usage as unavailable instead of showing dash totals', async () => {
    render(<TeamSettings t={translate} embedded />)

    const settings = await screen.findByRole('region', { name: zh.teamPanelTitle })
    const account = within(settings).getByRole('heading', { name: mine.label }).closest('article')!
    const recentUsage = within(account).getByRole('region', { name: zh.recentUsageRegionLabel })

    expect(within(recentUsage).getByText('最近 1 天用量暂不可用')).toBeDefined()
    expect(recentUsage.textContent).not.toContain('— 次请求')
  })

  it('uses the approved account directory and selected-account detail workspace', async () => {
    render(<TeamSettings t={translate} embedded />)

    const settings = await screen.findByRole('region', { name: zh.teamPanelTitle })
    const directory = within(settings).getByRole('complementary')
    const details = within(settings).getByRole('region', { name: zh.accountDetails })
    const directoryTitle = within(directory).getByRole('heading', { name: /^账号/u })
    const directoryHeader = directoryTitle.parentElement

    expect(within(directory).getByRole('button', { name: new RegExp(mine.label, 'u') })).toBeDefined()
    expect(within(details).getByRole('heading', { name: mine.label })).toBeDefined()
    expect(directoryHeader?.classList.contains(styles.directoryHeader)).toBe(true)
    expect(within(directoryHeader!).getByText(zh.accountDirectoryHint).classList.contains(styles.directoryHint)).toBe(true)
    expect(settings.compareDocumentPosition(directory) & Node.DOCUMENT_POSITION_CONTAINED_BY).not.toBe(0)
  })

  it('keeps the zero-account empty state only in the detail pane', async () => {
    overviewState = {
      ...overviewState,
      contributions: [],
      activeSharedAccounts: [],
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ready', profiles: [] }),
    }))

    render(<TeamSettings t={translate} embedded />)

    const settings = await screen.findByRole('region', { name: zh.teamPanelTitle })
    const directory = within(settings).getByRole('complementary')
    const details = within(settings).getByRole('region', { name: zh.accountDetails })

    expect(within(directory).getByRole('heading', { name: `${zh.accountsLabel}${translate('accountsCount', { count: 0 })}` })).toBeDefined()
    expect(within(directory).getByRole('button', { name: zh.addAccount })).toBeDefined()
    expect(within(directory).getByText(zh.accountDirectoryHint)).toBeDefined()
    expect(within(directory).queryByText(zh.noLocalAccountsTitle)).toBeNull()
    expect(within(directory).queryByText(zh.noLocalAccountsHint)).toBeNull()
    expect(within(details).getByText(zh.noLocalAccountsTitle)).toBeDefined()
    expect(within(details).getByText(zh.noLocalAccountsHint)).toBeDefined()
    expect(within(settings).getAllByText(zh.noLocalAccountsTitle)).toHaveLength(1)
    expect(within(settings).getAllByText(zh.noLocalAccountsHint)).toHaveLength(1)
  })

  it('uses stable account aliases and omits empty account groups like the approved prototype', async () => {
    overviewState = {
      ...overviewState,
      contributions: [],
      activeSharedAccounts: [],
    }

    render(<TeamSettings t={translate} embedded />)

    const settings = await screen.findByRole('region', { name: zh.teamPanelTitle })
    const directory = within(settings).getByRole('complementary')

    expect(within(directory).queryByRole('heading', { name: zh.sharedAccounts })).toBeNull()
    expect(within(directory).getByRole('heading', { name: zh.unsharedAccounts })).toBeDefined()
    expect(within(directory).getByText('账号 A')).toBeDefined()
    expect(within(directory).getByText('本机账号 A')).toBeDefined()
    expect(within(directory).getByText('账号 B')).toBeDefined()
    expect(within(directory).getByText('本机账号 B')).toBeDefined()
  })

  it('renders the prototype local-account detail and credential boundary after selection', async () => {
    render(<TeamSettings t={translate} embedded />)

    const settings = await screen.findByRole('region', { name: zh.teamPanelTitle })
    const directory = within(settings).getByRole('complementary')
    const details = within(settings).getByRole('region', { name: zh.accountDetails })

    fireEvent.click(within(directory).getByRole('button', { name: /本机账号 A/u }))

    expect(within(details).getByRole('heading', { name: '本机账号 A' })).toBeDefined()
    expect(within(details).getAllByText('本机正在使用')).toHaveLength(1)
    expect(details.textContent).toContain('需要再次授权后，团队才能使用这个账号。')
    expect(details.textContent).toContain('不会上传本机 auth.json。')
    const shareRegion = within(details).getByRole('region', { name: zh.shareToTeam })
    expect(shareRegion.textContent).toContain('需要再次授权后，团队才能使用这个账号。')
    expect(shareRegion.textContent).toContain(zh.localCredentialBoundary)
    expect(shareRegion.textContent).not.toContain(zh.localCredentialBoundaryHint)
    expect(within(shareRegion).getByRole('button', { name: zh.shareToTeam })).toBeDefined()
    expect(details.querySelector(`.${styles.credentialBoundary}`)).toBeNull()
    expect(within(details).getByRole('region', { name: zh.capacityTitle })).toBeDefined()
    expect(within(details).getByRole('progressbar', { name: zh.capacityCodex }).getAttribute('aria-valuenow')).toBe('68')
    expect(within(details).getByText('Plus')).toBeDefined()
    expect(within(details).getByText('US$100.00')).toBeDefined()
    expect(within(details).queryByText(/US\$68|周剩余预估/)).toBeNull()
    expect(within(details).getByRole('button', { name: zh.recentRequests })).toBeDefined()
    expect(within(directory).getByRole('button', { name: /本机账号 A/u }).getAttribute('aria-pressed')).toBe('true')
  })

  it('moves a durably bound local profile into shared accounts immediately and after remount', async () => {
    overviewState = {
      ...overviewState,
      contributions: [{ ...mine, label: '本机账号 A', sourceLocalProfileId: 'local-a' }],
    }

    const first = render(<TeamSettings t={translate} embedded />)
    let settings = await screen.findByRole('region', { name: zh.teamPanelTitle })
    let directory = within(settings).getByRole('complementary')
    let details = within(settings).getByRole('region', { name: zh.accountDetails })

    expect(within(directory).queryByRole('button', { name: /本机账号 A · 本机已登录/u })).toBeNull()
    expect(within(directory).getByRole('button', { name: /本机账号 A · 我贡献/u })).toBeDefined()
    expect(within(details).getByRole('button', { name: zh.revokeContribution })).toBeDefined()

    first.unmount()
    render(<TeamSettings t={translate} embedded />)
    settings = await screen.findByRole('region', { name: zh.teamPanelTitle })
    directory = within(settings).getByRole('complementary')
    details = within(settings).getByRole('region', { name: zh.accountDetails })
    expect(within(directory).getByRole('button', { name: /本机账号 A · 我贡献/u })).toBeDefined()
    expect(within(details).getByRole('button', { name: zh.revokeContribution })).toBeDefined()
  })

  it('shows which local account authorization is pending immediately after click', async () => {
    let resolveOAuth!: (value: Awaited<ReturnType<typeof managementApi.startOAuth>>) => void
    managementApi.startOAuth.mockImplementationOnce(() => new Promise(resolve => {
      resolveOAuth = resolve
    }))

    render(<TeamSettings t={translate} embedded />)
    const settings = await screen.findByRole('region', { name: zh.teamPanelTitle })
    const directory = within(settings).getByRole('complementary')
    fireEvent.click(within(directory).getByRole('button', { name: /本机账号 A/u }))
    const details = within(settings).getByRole('region', { name: zh.accountDetails })
    fireEvent.click(within(details).getByRole('button', { name: zh.shareToTeam }))

    const confirmation = screen.getByRole('dialog', { name: '将 本机账号 A 用于团队' })
    expect(managementApi.startOAuth).not.toHaveBeenCalled()
    fireEvent.click(within(confirmation).getByRole('button', { name: '继续，再次授权' }))

    const pending = await within(confirmation).findByRole('button', { name: zh.working })
    expect(pending).toHaveProperty('disabled', true)
    expect(pending.getAttribute('aria-busy')).toBe('true')

    resolveOAuth({
      account: { ...mine, id: 'oauth-local-a', label: '本机账号 A', status: 'authorizing' },
      method: 'browser',
      authorizationUrl: 'https://auth.openai.com/oauth/authorize?client_id=codex_cli',
      expiresAt: NOW + 600_000,
    })
    expect(await screen.findByRole('region', { name: '等待浏览器授权' })).toBeDefined()
    expect(oauthPopupReplace).toHaveBeenCalledWith('https://auth.openai.com/oauth/authorize?client_id=codex_cli')
  })

  it('shows a safe warning when the local quota refresh fails without exposing fake progress semantics', async () => {
    vi.mocked(fetch).mockImplementation(async input => ({
      ok: true,
      json: async () => ({
        status: 'ready',
        profiles: [{
          id: 'local-a',
          label: '本机账号 A',
          createdAt: 1,
          updatedAt: 1,
          ...(input === '/plugins/dsh-openai-codex/profiles'
            ? { usage: {}, quotaError: 'telemetry unavailable' }
            : {}),
          inUse: true,
        }],
      }),
    } as Response))

    render(<TeamSettings t={translate} embedded />)

    const settings = await screen.findByRole('region', { name: zh.teamPanelTitle })
    const directory = within(settings).getByRole('complementary')
    const details = within(settings).getByRole('region', { name: zh.accountDetails })
    const localAccountNavigation = within(directory).getByRole('button', { name: /本机账号 A/u })
    fireEvent.click(localAccountNavigation)

    const capacity = within(details).getByRole('region', { name: zh.capacityTitle })
    const account = within(details).getByRole('heading', { name: '本机账号 A' }).closest('article')!
    expect(localAccountNavigation.querySelector('[data-state]')?.getAttribute('data-state')).toBe('error')
    expect(account.querySelector('header [data-state]')?.getAttribute('data-state')).toBe('error')
    expect(within(account.querySelector('header')!).getByText(zh.capacityQuotaError)).toBeDefined()
    expect(within(account).queryByText(zh.localInUse)).toBeNull()
    expect(within(capacity).getByText(zh.capacityQuotaError)).toBeDefined()
    expect(within(capacity).getByText(zh.capacityQuotaErrorHint)).toBeDefined()
    expect(capacity.textContent).not.toContain('telemetry unavailable')
    expect(capacity.getAttribute('data-tone')).toBe('warning')
    expect(within(capacity).queryByRole('progressbar')).toBeNull()
    expect(capacity.querySelector(`.${styles.quotaTrack}`)?.getAttribute('data-error')).toBe('true')
  })

  it.each([
    ['fetch rejection', () => Promise.reject(new Error('socket failed with upstream-secret'))],
    ['non-2xx response', () => Promise.resolve({
      ok: false,
      status: 502,
      json: async () => ({ detail: 'proxy-secret' }),
    } as Response)],
    ['invalid JSON', () => Promise.resolve({
      ok: true,
      json: async () => { throw new SyntaxError('unexpected token upstream-secret') },
    } as Response)],
    ['empty JSON object', () => Promise.resolve({
      ok: true,
      json: async () => ({ diagnostic: 'empty-shape-secret' }),
    } as Response)],
    ['non-ready status', () => Promise.resolve({
      ok: true,
      json: async () => ({ status: 'pending-shape-secret', profiles: [] }),
    } as Response)],
    ['non-array profiles', () => Promise.resolve({
      ok: true,
      json: async () => ({ status: 'ready', profiles: { diagnostic: 'profiles-shape-secret' } }),
    } as Response)],
  ])('turns an initial quota %s into a safe warning', async (_scenario, failQuotaRequest) => {
    overviewState = { ...overviewState, contributions: [], activeSharedAccounts: [] }
    vi.mocked(fetch).mockImplementation((input) => {
      if (input === '/plugins/dsh-openai-codex/profiles/directory') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            status: 'ready',
            profiles: [{
              id: 'local-a',
              label: '本机账号 A',
              createdAt: 1,
              updatedAt: 1,
              inUse: true,
            }],
          }),
        } as Response)
      }
      if (input === '/plugins/dsh-openai-codex/profiles') return failQuotaRequest()
      throw new Error(`Unexpected fetch: ${String(input)}`)
    })

    render(<TeamSettings t={translate} embedded />)

    const settings = await screen.findByRole('region', { name: zh.teamPanelTitle })
    const details = within(settings).getByRole('region', { name: zh.accountDetails })
    const capacity = await within(details).findByRole('region', { name: zh.capacityTitle })

    expect(await within(capacity).findByText(zh.capacityQuotaError)).toBeDefined()
    expect(within(capacity).getByText(zh.capacityQuotaErrorHint)).toBeDefined()
    expect(capacity.getAttribute('data-tone')).toBe('warning')
    expect(within(capacity).queryByRole('progressbar')).toBeNull()
    expect(capacity.querySelector(`.${styles.quotaTrack}`)?.getAttribute('data-error')).toBe('true')
    expect(settings.textContent).not.toMatch(
      /upstream-secret|proxy-secret|unexpected token|socket failed|empty-shape-secret|pending-shape-secret|profiles-shape-secret/u,
    )
  })

  it('keeps the compact Team bar and account workspace as full-width sibling regions', async () => {
    render(<TeamSettings t={translate} embedded />)

    const settings = await screen.findByRole('region', { name: zh.teamPanelTitle })
    const directChildren = Array.from(settings.children)

    expect(settings.classList.contains(styles.teamOverview)).toBe(true)
    expect(settings.classList.contains(styles.teamPanel)).toBe(false)
    expect(directChildren).toHaveLength(2)
    expect(directChildren[0]?.classList.contains(styles.teamBar)).toBe(true)
    expect(directChildren[1]?.classList.contains(styles.accountWorkspace)).toBe(true)
  })

  it('reveals local accounts before the slower quota refresh completes', async () => {
    overviewState = { ...overviewState, contributions: [], activeSharedAccounts: [] }
    let resolveDirectory!: (value: Response) => void
    let resolveQuota!: (value: Response) => void
    vi.mocked(fetch).mockImplementation((input) => {
      if (input === '/plugins/dsh-openai-codex/profiles/directory') {
        return new Promise(resolve => { resolveDirectory = resolve })
      }
      if (input === '/plugins/dsh-openai-codex/profiles') {
        return new Promise(resolve => { resolveQuota = resolve })
      }
      throw new Error(`Unexpected fetch: ${String(input)}`)
    })

    render(<TeamSettings t={translate} embedded />)

    const settings = await screen.findByRole('region', { name: zh.teamPanelTitle })
    const workspace = settings.querySelector<HTMLElement>(`.${styles.accountWorkspace}`)
    expect(workspace).not.toBeNull()
    expect(workspace?.getAttribute('aria-busy')).toBe('true')
    expect(within(workspace!).getAllByRole('status')).toHaveLength(1)
    expect(within(workspace!).getByText(zh.loadingLocalAccounts)).toBeDefined()
    expect(workspace?.querySelectorAll(`.${styles.accountSkeletonRow}`)).toHaveLength(3)
    expect(workspace?.querySelector(`.${styles.accountDetailSkeleton}`)).not.toBeNull()
    expect(within(workspace!).queryByText(zh.working)).toBeNull()
    expect(within(workspace!).queryByText(zh.accountsCount.replace('{count}', '0'))).toBeNull()
    expect(within(workspace!).queryByText(zh.noUnsharedAccounts)).toBeNull()

    await act(async () => {
      resolveDirectory({
        ok: true,
        json: async () => ({
          status: 'ready',
          profiles: [{
            id: 'local-a',
            label: '本机账号 A',
            createdAt: 1,
            updatedAt: 1,
            inUse: true,
          }],
        }),
      } as Response)
    })

    const account = await within(workspace!).findByRole('button', { name: /本机账号 A/u })
    expect(account).toBeDefined()
    expect(workspace?.getAttribute('aria-busy')).toBe('false')
    expect(workspace?.querySelector(`.${styles.accountDetailSkeleton}`)).toBeNull()
    const quotaStatus = within(workspace!).getByRole('status')
    expect(quotaStatus.textContent).toBe(zh.loadingLocalQuota)
    expect(quotaStatus.classList.contains(styles.screenReaderOnly)).toBe(true)
    expect(workspace?.querySelector(`.${styles.quotaValueSkeleton}`)).not.toBeNull()
    expect(workspace?.querySelector(`.${styles.quotaTrack}[data-loading='true']`)).not.toBeNull()

    await act(async () => {
      resolveQuota({
        ok: true,
        json: async () => ({
          status: 'ready',
          profiles: [{
            id: 'local-a',
            label: '本机账号 A',
            createdAt: 1,
            updatedAt: 1,
            usage: { rateLimits: [{ id: 'codex', windows: [{ remainingPercent: 68, windowSeconds: 604800 }] }] },
            inUse: true,
          }],
        }),
      } as Response)
    })

    expect(await within(workspace!).findByText('68%')).toBeDefined()
    expect(within(workspace!).queryByText(zh.loadingLocalQuota)).toBeNull()
    expect(workspace?.querySelector(`.${styles.quotaValueSkeleton}`)).toBeNull()
    expect(workspace?.querySelector(`.${styles.quotaTrack}[data-loading='true']`)).toBeNull()
  })

  it.each([
    ['transport fails', () => Promise.reject(new Error('quota telemetry timed out'))],
    ['response structure is invalid', () => Promise.resolve({
      ok: true,
      json: async () => ({ status: 'ready', profiles: { diagnostic: 'background-shape-secret' } }),
    } as Response)],
  ])('preserves settled quota while the background quota %s', async (_scenario, failQuotaRequest) => {
    overviewState = { ...overviewState, contributions: [], activeSharedAccounts: [] }
    const refreshCallbacks: Array<() => void> = []
    vi.spyOn(globalThis, 'setInterval').mockImplementation((handler, timeout) => {
      if (timeout === 60_000 && typeof handler === 'function') {
        refreshCallbacks.push(handler as () => void)
      }
      return 1
    })
    let directoryRequests = 0
    let quotaRequests = 0
    vi.mocked(fetch).mockImplementation((input) => {
      if (input === '/plugins/dsh-openai-codex/profiles/directory') {
        directoryRequests += 1
        return Promise.resolve({
          ok: true,
          json: async () => ({
            status: 'ready',
            profiles: [{
              id: 'local-a',
              label: directoryRequests === 1 ? '本机账号 A' : '已重命名账号 A',
              createdAt: 1,
              updatedAt: directoryRequests,
              inUse: true,
            }],
          }),
        } as Response)
      }
      if (input === '/plugins/dsh-openai-codex/profiles') {
        quotaRequests += 1
        if (quotaRequests > 1) return failQuotaRequest()
        return Promise.resolve({
          ok: true,
          json: async () => ({
            status: 'ready',
            profiles: [{
              id: 'local-a',
              label: '本机账号 A',
              createdAt: 1,
              updatedAt: 1,
              usage: { rateLimits: [{ id: 'codex', windows: [{ remainingPercent: 68, windowSeconds: 604800 }] }] },
              inUse: true,
            }],
          }),
        } as Response)
      }
      throw new Error(`Unexpected fetch: ${String(input)}`)
    })

    render(<TeamSettings t={translate} embedded />)

    const settings = await screen.findByRole('region', { name: zh.teamPanelTitle })
    expect(await within(settings).findByText('68%')).toBeDefined()
    expect(refreshCallbacks.length).toBeGreaterThan(0)

    await act(async () => {
      refreshCallbacks.forEach(refresh => { refresh() })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(await within(settings).findAllByText('已重命名账号 A')).toHaveLength(2)
    await waitFor(() => {
      expect(directoryRequests).toBe(2)
      expect(quotaRequests).toBe(2)
    })
    expect(within(settings).getByText('68%')).toBeDefined()
    expect(settings.querySelector(`.${styles.quotaValueSkeleton}`)).toBeNull()
    expect(settings.querySelector(`.${styles.quotaTrack}[data-loading='true']`)).toBeNull()
    const capacity = within(settings).getByRole('region', { name: zh.capacityTitle })
    expect(capacity.getAttribute('data-tone')).toBe('warning')
    expect(capacity.getAttribute('data-stale')).toBe('true')
    expect(within(capacity).getByText(zh.capacityQuotaStaleHint)).toBeDefined()
    expect(capacity.querySelector(`.${styles.quotaTrack}`)?.getAttribute('data-error')).toBe('true')
    expect(capacity.textContent).not.toMatch(/quota telemetry timed out|background-shape-secret/u)
  })

  it('places the workspace rail before Team context in the document reading order', async () => {
    render(<TeamSettings t={translate} embedded />)

    const settings = await openTeamSettings()
    const context = within(settings).getByRole('heading', { name: '周末造物局' }).closest('header')
    const navigation = within(settings).getByRole('navigation', { name: zh.workspaceNavigation })

    expect(context).not.toBeNull()
    expect(navigation.compareDocumentPosition(context!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
  })

  it('shows the one-time display-name migration notice until the server ACK succeeds', async () => {
    overviewState = {
      ...overviewState,
      displayNameMigrationNotice: { migrationVersion: 20 },
    }
    let resolveAcknowledgement: ((value: { migrationVersion: number; acknowledged: true }) => void) | undefined
    managementApi.acknowledgeDisplayNameMigration.mockImplementationOnce(() => new Promise(resolve => {
      resolveAcknowledgement = resolve
    }))
    render(<TeamSettings t={translate} embedded />)

    const settings = await openTeamSettings('usage')
    const workspaceNoticeTitle = await within(settings).findByText('你的成员名称已更新')
    expect(workspaceNoticeTitle.parentElement?.getAttribute('aria-live')).toBe('polite')
    expect(screen.getByText(/当前的成员名称是「Edison」/u)).toBeDefined()

    expect(within(settings).getByText('你的成员名称已更新')).toBeDefined()
    expect(within(settings).getByText(/当前的成员名称是「Edison」/u)).toBeDefined()
    expect(within(settings).queryByText(/原名称|旧名称|repair|migration/iu)).toBeNull()

    const acknowledgeButton = within(settings).getByRole('button', { name: '知道了' })
    expect(acknowledgeButton.parentElement?.classList.contains(styles.noticeActions)).toBe(true)
    fireEvent.click(acknowledgeButton)

    await waitFor(() => { expect(managementApi.acknowledgeDisplayNameMigration).toHaveBeenCalledWith(20, expectedContext()) })
    await waitFor(() => { expect(acknowledgeButton).toHaveProperty('disabled', true) })
    await act(async () => { resolveAcknowledgement?.({ migrationVersion: 20, acknowledged: true }) })
    await waitFor(() => { expect(within(settings).queryByText('你的成员名称已更新')).toBeNull() })
  })

  it('does not attach an older ACK pending or failure state to a newer notice', async () => {
    overviewState = {
      ...overviewState,
      displayNameMigrationNotice: { migrationVersion: 20 },
    }
    let rejectOldAcknowledgement: ((reason: Error) => void) | undefined
    managementApi.acknowledgeDisplayNameMigration.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectOldAcknowledgement = reject
    }))
    render(<TeamSettings t={translate} embedded />)

    const settings = await openTeamSettings('usage')
    fireEvent.click(within(settings).getByRole('button', { name: '知道了' }))
    await waitFor(() => { expect(managementApi.acknowledgeDisplayNameMigration).toHaveBeenCalledWith(20, expectedContext()) })

    overviewState = {
      ...overviewState,
      displayNameMigrationNotice: { migrationVersion: 21 },
    }
    fireEvent.click(within(settings).getByRole('button', { name: zh.refresh }))
    await waitFor(() => { expect(managementApi.overview).toHaveBeenCalledTimes(2) })
    await waitFor(() => {
      expect(within(settings).getByRole('button', { name: '知道了' }).hasAttribute('disabled')).toBe(false)
    })

    await act(async () => { rejectOldAcknowledgement?.(new Error('old request failed')) })
    expect(within(settings).queryByText('暂时无法确认，请重试。')).toBeNull()
  })

  it('does not let an older overview response replace a newer migration notice', async () => {
    overviewState = {
      ...overviewState,
      displayNameMigrationNotice: { migrationVersion: 20 },
    }
    render(<TeamSettings t={translate} embedded />)

    const settings = await openTeamSettings('usage')
    const delayedOverview = {
      ...overviewState,
      currentMember: { ...overviewState.currentMember, displayName: 'Edison' },
      displayNameMigrationNotice: { migrationVersion: 20 },
    }
    let resolveDelayedOverview: ((value: typeof delayedOverview) => void) | undefined
    managementApi.overview.mockImplementationOnce(() => new Promise(resolve => {
      resolveDelayedOverview = resolve
    }))

    fireEvent.click(within(settings).getByRole('button', { name: zh.refresh }))
    await waitFor(() => { expect(managementApi.overview).toHaveBeenCalledTimes(2) })

    const acknowledgement = within(settings).getByRole('button', { name: '知道了' })
    expect(acknowledgement.hasAttribute('disabled')).toBe(true)
    fireEvent.click(acknowledgement)
    expect(managementApi.acknowledgeDisplayNameMigration).not.toHaveBeenCalled()

    overviewState = {
      ...overviewState,
      currentMember: { ...overviewState.currentMember, displayName: 'Edison · 2' },
      displayNameMigrationNotice: { migrationVersion: 21 },
    }
    fireEvent.click(within(settings).getByRole('button', { name: zh.refresh }))
    await waitFor(() => {
      expect(within(settings).getByText(/当前的成员名称是「Edison · 2」/u)).toBeDefined()
    })

    await act(async () => { resolveDelayedOverview?.(delayedOverview) })
    await waitFor(() => {
      expect(within(settings).getByText(/当前的成员名称是「Edison · 2」/u)).toBeDefined()
    })
  })

  it('does not let a stale 410 status refresh clear a newer migration notice', async () => {
    overviewState = {
      ...overviewState,
      displayNameMigrationNotice: { migrationVersion: 20 },
    }
    render(<TeamSettings t={translate} embedded />)

    const settings = await openTeamSettings('usage')
    let resolveStaleStatus: ((value: {
      enabled: boolean
      keyConfigured: boolean
      keyWritable: boolean
      pendingJoinConfigured: boolean
      dissolution: { state: 'confirmed'; localCleanup: 'completed' }
    }) => void) | undefined
    managementApi.status
      .mockResolvedValueOnce({
        enabled: true, keyConfigured: true, keyWritable: true, pendingJoinConfigured: false,
        serverOrigin: 'https://team.example.test',
      })
      .mockImplementationOnce(() => new Promise(resolve => {
        resolveStaleStatus = resolve
      }))
      .mockResolvedValueOnce({
        enabled: true, keyConfigured: true, keyWritable: true, pendingJoinConfigured: false,
        serverOrigin: 'https://team.example.test',
      })
    managementApi.overview.mockRejectedValueOnce(
      Object.assign(new Error('remote Team connection is terminal'), { status: 410 }),
    )

    fireEvent.click(within(settings).getByRole('button', { name: zh.refresh }))
    await waitFor(() => { expect(managementApi.status).toHaveBeenCalledTimes(3) })

    overviewState = {
      ...overviewState,
      currentMember: { ...overviewState.currentMember, displayName: 'Edison · 2' },
      displayNameMigrationNotice: { migrationVersion: 21 },
    }
    fireEvent.click(within(settings).getByRole('button', { name: zh.refresh }))
    await waitFor(() => {
      expect(within(settings).getByText(/当前的成员名称是「Edison · 2」/u)).toBeDefined()
    })

    await act(async () => {
      resolveStaleStatus?.({
        enabled: true,
        keyConfigured: false,
        keyWritable: true,
        pendingJoinConfigured: false,
        dissolution: { state: 'confirmed', localCleanup: 'completed' },
      })
    })
    await waitFor(() => {
      expect(within(settings).getByText(/当前的成员名称是「Edison · 2」/u)).toBeDefined()
    })
    expect(screen.queryByText('这个团队已永久解散，无法继续访问。')).toBeNull()
  })

  it('keeps the display-name migration notice visible when the server ACK fails', async () => {
    overviewState = {
      ...overviewState,
      displayNameMigrationNotice: { migrationVersion: 20 },
    }
    managementApi.acknowledgeDisplayNameMigration.mockRejectedValueOnce(new Error('temporary failure'))
    render(<TeamSettings t={translate} embedded />)

    const settings = await openTeamSettings()
    fireEvent.click(within(settings).getByRole('button', { name: '知道了' }))

    await waitFor(() => { expect(managementApi.acknowledgeDisplayNameMigration).toHaveBeenCalledWith(20, expectedContext()) })
    expect(within(settings).getByText('你的成员名称已更新')).toBeDefined()

    fireEvent.click(within(settings).getByRole('button', { name: '知道了' }))
    await waitFor(() => { expect(managementApi.acknowledgeDisplayNameMigration).toHaveBeenCalledTimes(2) })
    await waitFor(() => { expect(within(settings).queryByText('你的成员名称已更新')).toBeNull() })
  })

  it('shows the same display-name migration notice to a Team member', async () => {
    const { invites: _invites, ...memberOverview } = overviewState
    overviewState = {
      ...memberOverview,
      viewerRole: 'member',
      currentMember: { ...overviewState.currentMember, role: 'member' },
      members: overviewState.members.map((member: any) => member.id === 'member-me'
        ? { ...member, role: 'member' }
        : { ...member, role: 'owner' }),
      displayNameMigrationNotice: { migrationVersion: 20 },
    }
    render(<TeamSettings t={translate} embedded />)

    const settings = await openTeamSettings()
    expect(within(settings).getByText('你的成员名称已更新')).toBeDefined()
    expect(within(settings).getByText(/当前的成员名称是「Edison」/u)).toBeDefined()
  })

  it('does not restore an acknowledged notice when an older overview request finishes later', async () => {
    const staleOverview = {
      ...overviewState,
      displayNameMigrationNotice: { migrationVersion: 20 },
    }
    overviewState = staleOverview
    let resolveStaleOverview: ((value: typeof staleOverview) => void) | undefined
    let resolveAcknowledgement: ((value: { migrationVersion: number; acknowledged: true }) => void) | undefined
    managementApi.overview
      .mockResolvedValueOnce(staleOverview)
      .mockImplementationOnce(() => new Promise(resolve => { resolveStaleOverview = resolve }))
    managementApi.acknowledgeDisplayNameMigration.mockImplementationOnce(() => new Promise(resolve => {
      resolveAcknowledgement = resolve
    }))
    render(<TeamSettings t={translate} embedded />)

    const settings = await openTeamSettings('usage')
    fireEvent.click(within(settings).getByRole('button', { name: '知道了' }))
    await waitFor(() => {
      expect(managementApi.acknowledgeDisplayNameMigration).toHaveBeenCalledWith(20, expectedContext())
    })

    fireEvent.click(within(settings).getByRole('button', { name: zh.refresh }))
    await waitFor(() => { expect(managementApi.overview).toHaveBeenCalledTimes(2) })

    await act(async () => { resolveAcknowledgement?.({ migrationVersion: 20, acknowledged: true }) })
    await waitFor(() => { expect(within(settings).queryByText('你的成员名称已更新')).toBeNull() })

    await act(async () => { resolveStaleOverview?.(staleOverview) })
    await waitFor(() => { expect(managementApi.overview).toHaveBeenCalledTimes(2) })
    expect(within(settings).queryByText('你的成员名称已更新')).toBeNull()
  })

  it('previews invitation identity before joining and never joins on preview', async () => {
    managementApi.status.mockResolvedValue({
      enabled: true, keyConfigured: false, keyWritable: true, pendingJoinConfigured: false,
      serverOrigin: 'https://team.example.test',
    })
    render(<TeamSettings t={translate} embedded />)

    const inviteInput = await screen.findByLabelText(zh.inviteToken)
    fireEvent.change(inviteInput, { target: { value: 'dsh_invite_secret-1234567890' } })
    fireEvent.click(screen.getByRole('button', { name: zh.previewInvitation }))

    expect(await screen.findByText('周末造物局')).toBeDefined()
    expect(screen.getByText('周末协作')).toBeDefined()
    expect(screen.getByRole('status')).toBeDefined()
    expect(managementApi.previewInvite).toHaveBeenCalledWith('dsh_invite_secret-1234567890')
    expect(managementApi.join).not.toHaveBeenCalled()
    expect((inviteInput as HTMLInputElement).value).toBe('')
    expect(screen.queryByLabelText('Team API key')).toBeNull()

    const displayNameInput = screen.getByLabelText(zh.displayName)
    expect(displayNameInput.getAttribute('maxlength')).toBeNull()
    fireEvent.change(displayNameInput, { target: { value: '\u3000Edison\u3000' } })
    fireEvent.click(screen.getByRole('button', { name: zh.confirmJoin }))
    await waitFor(() => { expect(managementApi.join).toHaveBeenCalledWith(`dsh_join_${'a'.repeat(43)}`, '\u3000Edison\u3000') })
  })

  it('rejects an obviously malformed invitation token without a remote request', async () => {
    managementApi.status.mockResolvedValue({
      enabled: true, keyConfigured: false, keyWritable: true, pendingJoinConfigured: false,
      serverOrigin: 'https://team.example.test',
    })
    render(<TeamSettings t={translate} embedded />)

    const token = await screen.findByLabelText(zh.inviteToken)
    fireEvent.change(token, { target: { value: 'x' } })

    expect(token.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText(zh.inviteTokenInvalid)).toBeDefined()
    expect(screen.getByRole('button', { name: zh.previewInvitation }).hasAttribute('disabled')).toBe(true)
    expect(managementApi.previewInvite).not.toHaveBeenCalled()
  })

  it('offers recovery and discard when a previous join is uncertain', async () => {
    managementApi.status.mockResolvedValue({
      enabled: true, keyConfigured: false, keyWritable: true, pendingJoinConfigured: true,
      serverOrigin: 'https://team.example.test',
    })
    render(<TeamSettings t={translate} embedded />)

    expect(await screen.findByText(zh.pendingJoinTitle)).toBeDefined()
    expect(screen.queryByRole('button', { name: zh.previewInvitation })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.recoverJoin }))
    await waitFor(() => { expect(managementApi.recoverJoin).toHaveBeenCalledTimes(1) })
  })

  it('keeps a configured but invalid Team key out of onboarding and lets the user clear it locally', async () => {
    managementApi.status.mockResolvedValue({
      enabled: true, keyConfigured: true, keyWritable: true, pendingJoinConfigured: false,
      serverOrigin: 'https://team.example.test',
    })
    managementApi.disconnect.mockImplementationOnce(async () => {
      managementApi.status.mockResolvedValue({
        enabled: true, keyConfigured: false, keyWritable: true, pendingJoinConfigured: false,
        serverOrigin: 'https://team.example.test',
      })
      return { ok: true, remoteRevoked: false }
    })
    managementApi.overview.mockRejectedValue(Object.assign(new Error('Team API key is revoked'), { status: 401 }))

    render(<TeamSettings t={translate} embedded />)

    expect(await screen.findByText('此设备的团队访问已失效')).toBeDefined()
    expect(screen.queryByRole('button', { name: zh.previewInvitation })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '清除本地连接' }))

    await waitFor(() => { expect(managementApi.disconnect).toHaveBeenCalledWith(false) })
    expect(await screen.findByRole('button', { name: zh.previewInvitation })).toBeDefined()
  })

  it('preserves capacity and subscription when the usage ledger fails', async () => {
    managementApi.usage.mockRejectedValue(new Error('usage unavailable'))
    overviewState = { ...overviewState, contributions: [{ ...mine, capacity: {
      sharedInFlight: 0, buckets: [{ id: 'codex', reason: 'ready', remainingPercent: 73,
        subscription: { planType: 'plus' } }],
    } }] }
    render(<TeamSettings t={translate} embedded />)
    await waitFor(() => { expect(managementApi.usage).toHaveBeenCalled() })
    const panel = await screen.findByRole('region', { name: zh.teamPanelTitle })
    const account = within(panel).getByRole('heading', { name: mine.label }).closest('article')!
    await waitFor(() => { expect(within(account).getByText('73%')).toBeDefined() })
    expect(within(account).getByText('Plus')).toBeDefined()
    expect(within(account).queryByText(zh.accountCapacityFetchFailed)).toBeNull()
  })

  it('keeps the connected workspace available when only usage loading fails', async () => {
    managementApi.usage.mockRejectedValue(new Error('usage temporarily unavailable'))

    render(<TeamSettings t={translate} embedded />)

    const settings = await openTeamSettings('usage')
    expect(within(settings).getByText('周末造物局')).toBeDefined()
    expect(within(settings).getByText('用量暂时无法获取')).toBeDefined()
    expect(screen.queryByText('usage temporarily unavailable')).toBeNull()
    expect(screen.getByRole('button', { name: zh.retry })).toBeDefined()
    expect(screen.queryByRole('button', { name: zh.previewInvitation })).toBeNull()
  })

  it('discards a stale invitation preview response after the token input changes', async () => {
    managementApi.status.mockResolvedValue({
      enabled: true, keyConfigured: false, keyWritable: true, pendingJoinConfigured: false,
      serverOrigin: 'https://team.example.test',
    })
    let resolvePreview!: (value: { teamName: string; label: string; expiresAt: number; teamStatus: 'active'; joinHandle: string }) => void
    managementApi.previewInvite.mockImplementationOnce(() => new Promise(resolve => { resolvePreview = resolve }))
    render(<TeamSettings t={translate} embedded />)

    const tokenInput = await screen.findByLabelText(zh.inviteToken)
    fireEvent.change(tokenInput, { target: { value: 'dsh_invite_team-a-secret-1234567890' } })
    fireEvent.click(screen.getByRole('button', { name: zh.previewInvitation }))
    await waitFor(() => { expect(managementApi.previewInvite).toHaveBeenCalledTimes(1) })
    fireEvent.change(tokenInput, { target: { value: 'dsh_invite_team-b-secret-1234567890' } })
    resolvePreview({
      teamName: 'Team A', label: 'A invite', expiresAt: NOW + 86_400_000, teamStatus: 'active',
      joinHandle: `dsh_join_${'b'.repeat(43)}`,
    })

    await waitFor(() => { expect(screen.getByRole('button', { name: zh.previewInvitation })).toBeDefined() })
    expect(screen.queryByText('Team A')).toBeNull()
  })

  it('refreshes the Host state after a definite pending recovery rejection', async () => {
    managementApi.status
      .mockResolvedValueOnce({
        enabled: true, keyConfigured: false, keyWritable: true, pendingJoinConfigured: true,
        serverOrigin: 'https://team.example.test',
      })
      .mockResolvedValue({
        enabled: true, keyConfigured: false, keyWritable: true, pendingJoinConfigured: false,
        serverOrigin: 'https://team.example.test',
      })
    managementApi.recoverJoin.mockRejectedValue(Object.assign(new Error('invite expired'), { status: 409 }))
    render(<TeamSettings t={translate} embedded />)

    fireEvent.click(await screen.findByRole('button', { name: zh.recoverJoin }))

    expect(await screen.findByRole('button', { name: zh.previewInvitation })).toBeDefined()
    expect(screen.getByText('invite expired')).toBeDefined()
  })

  it('keeps Team usage concise and places lifecycle actions in Team management', async () => {
    render(<TeamSettings t={translate} embedded />)

    const settingsWorkspace = await openTeamSettings('usage')
    const usage = within(settingsWorkspace).getByRole('region', { name: zh.usageSectionTitle })
    const teamUsage = within(usage).getByRole('group', { name: zh.teamUsage })
    const mineUsage = within(usage).getByRole('group', { name: zh.myTeamUsage })
    expect(within(teamUsage).queryByText('完整数据')).toBeNull()
    expect(within(teamUsage).getByText('US$5.88')).toBeDefined()
    expect(within(teamUsage).getByText('3,900,000 Token')).toBeDefined()
    expect(within(teamUsage).getByText('39')).toBeDefined()
    expect(within(mineUsage).getByText('US$1.75')).toBeDefined()
    expect(within(mineUsage).getByText('1,200,000 Token')).toBeDefined()
    expect(document.body.textContent).not.toMatch(/Credits|gpt-5-codex|共享账号|未共享账号/u)

    await openTeamSettings('members')
    expect(within(settingsWorkspace).getByRole('heading', { name: zh.membersTitle })).toBeDefined()
    expect(within(settingsWorkspace).queryByRole('heading', { name: zh.routingTitle })).toBeNull()

    const menu = openTeamManagement(settingsWorkspace)
    expect(within(menu).getByRole('menuitem', { name: zh.pauseTeam })).toBeDefined()
    expect(within(menu).queryByRole('menuitem', { name: zh.leaveTeam })).toBeNull()
    expect(within(menu).getByText(zh.ownerLeaveUnavailable)).toBeDefined()
  })

  it('counts only active members in the workspace header', async () => {
    overviewState = {
      ...overviewState,
      members: [
        ...overviewState.members,
        {
          ...overviewState.members[1],
          id: 'member-removed',
          displayName: 'Removed',
          status: 'removed',
        },
        {
          ...overviewState.members[1],
          id: 'member-suspended',
          displayName: 'Suspended',
          status: 'suspended',
        },
      ],
    }

    render(<TeamSettings t={translate} embedded />)

    const settings = await openTeamSettings('members')
    expect(within(settings).getByText('2 位成员')).toBeDefined()
    expect(within(settings).queryByText('4 位成员')).toBeNull()
    expect(within(settings).getAllByRole('listitem')).toHaveLength(2)
  })

  it.each(['active', 'paused'] as const)('shows permanent dissolution only to the Owner of an %s Team', async status => {
    overviewState = { ...overviewState, team: { ...overviewState.team, status } }
    render(<TeamSettings t={translate} embedded />)

    const settings = await openTeamSettings()
    const menu = openTeamManagement(settings)

    expect(within(menu).getByRole('menuitem', { name: '永久解散团队' })).toBeDefined()
  })

  it('binds an Owner pause request to the rendered lifecycle revision', async () => {
    render(<TeamSettings t={translate} embedded />)

    const settings = await openTeamSettings()
    fireEvent.click(within(openTeamManagement(settings)).getByRole('menuitem', { name: zh.pauseTeam }))
    const confirmation = screen.getByRole('dialog', { name: '暂停“周末造物局”？' })
    expect(managementApi.setTeamStatus).not.toHaveBeenCalled()
    fireEvent.click(within(confirmation).getByRole('button', { name: '确认暂停' }))

    await waitFor(() => {
      expect(managementApi.setTeamStatus).toHaveBeenCalledWith('paused', 7, expectedContext())
    })
  })

  it('explains all four irreversible consequences and requires an exact Team-name match', async () => {
    render(<TeamSettings t={translate} embedded />)

    const dialog = await openDissolutionDialog()
    expect(within(dialog).getByText(/全部成员.*失去访问/u)).toBeDefined()
    expect(within(dialog).getByText(/全部邀请码.*失效/u)).toBeDefined()
    expect(within(dialog).getByText(/全部团队设备连接.*失效/u)).toBeDefined()
    expect(within(dialog).getByText(/共享账号.*停止承接新请求/u)).toBeDefined()

    const confirmation = within(dialog).getByLabelText('输入完整团队名称以确认')
    const submit = within(dialog).getByRole('button', { name: '永久解散团队' })
    expect(submit.hasAttribute('disabled')).toBe(true)

    fireEvent.change(confirmation, { target: { value: '周末造物' } })
    expect(submit.hasAttribute('disabled')).toBe(true)
    fireEvent.change(confirmation, { target: { value: '周末造物局 ' } })
    expect(submit.hasAttribute('disabled')).toBe(true)
    fireEvent.change(confirmation, { target: { value: '周末造物局' } })
    expect(submit.hasAttribute('disabled')).toBe(false)
  })

  it('locks the dissolution dialog while submitting and sends the request only once', async () => {
    let resolveDissolution!: (value: ReturnType<typeof confirmingDissolution>) => void
    managementApi.dissolveTeam.mockImplementationOnce(() => new Promise(resolve => { resolveDissolution = resolve }))
    render(<TeamSettings t={translate} embedded />)
    const dialog = await openDissolutionDialog()
    const confirmation = within(dialog).getByLabelText('输入完整团队名称以确认')
    const cancel = within(dialog).getByRole('button', { name: zh.cancel })
    const submit = within(dialog).getByRole('button', { name: '永久解散团队' })
    fireEvent.change(confirmation, { target: { value: '周末造物局' } })

    fireEvent.click(submit)
    await waitFor(() => {
      expect(managementApi.dissolveTeam).toHaveBeenCalledWith({
        confirmationName: '周末造物局',
        expectedLifecycleRevision: 7,
      }, expectedContext())
    })
    expect((confirmation as HTMLInputElement).disabled).toBe(true)
    expect(cancel.hasAttribute('disabled')).toBe(true)
    expect(submit.hasAttribute('disabled')).toBe(true)
    expect(submit.textContent).toBe('正在永久解散…')

    fireEvent.click(submit)
    fireEvent.click(cancel)
    expect(managementApi.dissolveTeam).toHaveBeenCalledTimes(1)
    expect(document.body.contains(dialog)).toBe(true)

    await act(async () => { resolveDissolution(confirmingDissolution()) })
    expect(await screen.findByRole('heading', { name: '正在确认团队解散结果' })).toBeDefined()
  })

  it.each([403, 409])('keeps the confirmation form and refreshes Owner state after a definite %s rejection', async status => {
    managementApi.dissolveTeam.mockRejectedValueOnce(Object.assign(new Error('Team lifecycle changed'), { status }))
    render(<TeamSettings t={translate} embedded />)
    const dialog = await openDissolutionDialog()
    const confirmation = within(dialog).getByLabelText('输入完整团队名称以确认')
    fireEvent.change(confirmation, { target: { value: '周末造物局' } })

    fireEvent.click(within(dialog).getByRole('button', { name: '永久解散团队' }))

    await waitFor(() => { expect(managementApi.overview).toHaveBeenCalledTimes(2) })
    expect(screen.getByRole('dialog', { name: /永久解散.*周末造物局/u })).toBe(dialog)
    expect((confirmation as HTMLInputElement).value).toBe('周末造物局')
    expect((confirmation as HTMLInputElement).disabled).toBe(false)
  })

  it('moves an unknown result to an independent page whose only action continues the same confirmation', async () => {
    managementApi.dissolveTeam.mockResolvedValueOnce(confirmingDissolution())
    render(<TeamSettings t={translate} embedded />)

    await submitDissolution()

    expect(await screen.findByRole('heading', { name: '正在确认团队解散结果' })).toBeDefined()
    expect(screen.getByText('正在确认团队解散结果。')).toBeDefined()
    expect(screen.queryByRole('region', { name: zh.teamSettingsTitle })).toBeNull()
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.getByRole('button', { name: '继续确认' })).toBeDefined()
    expect(managementApi.overview).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: '继续确认' }))
    await waitFor(() => { expect(managementApi.recoverTeamDissolution).toHaveBeenCalledTimes(1) })
  })

  it.each([
    { cleanupState: 'completed' as const, copy: '本机连接已清理。' },
    { cleanupState: 'retry_required' as const, copy: '远端操作已完成，本机连接清理待重试。' },
    {
      cleanupState: 'manual_required' as const,
      copy: '团队端操作已完成，请按说明手动清理这台设备上的只读配置。',
    },
  ])('keeps confirmed dissolution terminal when local cleanup is $cleanupState', async ({ cleanupState, copy }) => {
    managementApi.dissolveTeam.mockResolvedValueOnce(confirmedDissolution(cleanupState))
    render(<TeamSettings t={translate} embedded />)

    await submitDissolution()

    expect(await screen.findByText('这个团队已永久解散，无法继续访问。')).toBeDefined()
    expect(screen.getByText(copy)).toBeDefined()
    expect(screen.queryByRole('region', { name: zh.teamSettingsTitle })).toBeNull()
    expect(managementApi.overview).toHaveBeenCalledTimes(1)

    if (cleanupState === 'retry_required') {
      fireEvent.click(screen.getByRole('button', { name: '重试清理' }))
      await waitFor(() => { expect(managementApi.clearTeamDissolution).toHaveBeenCalledTimes(1) })
      expect(managementApi.overview).toHaveBeenCalledTimes(1)
    } else {
      expect(screen.queryByRole('button', { name: '重试清理' })).toBeNull()
    }
  })

  it('renders the normalized 410 team_dissolved projection as terminal without requesting overview', async () => {
    managementApi.status.mockResolvedValue({
      enabled: true,
      keyConfigured: false,
      keyWritable: true,
      pendingJoinConfigured: false,
      dissolution: confirmedDissolution('completed'),
    })
    render(<TeamSettings t={translate} embedded />)

    expect(await screen.findByText('这个团队已永久解散，无法继续访问。')).toBeDefined()
    expect(managementApi.overview).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('team_dissolved')
  })

  it('forgets a completed dissolution terminal before returning to the join flow', async () => {
    managementApi.status
      .mockResolvedValueOnce({
        enabled: true,
        keyConfigured: false,
        keyWritable: true,
        pendingJoinConfigured: false,
        dissolution: { state: 'confirmed', localCleanup: 'completed' },
      })
      .mockResolvedValueOnce({
        enabled: true, keyConfigured: false, keyWritable: true, pendingJoinConfigured: false,
      })
    managementApi.clearTeamDissolution.mockResolvedValueOnce({ cleared: true })
    render(<TeamSettings t={translate} embedded />)

    fireEvent.click(await screen.findByRole('button', { name: '继续加入团队' }))

    expect(await screen.findByRole('heading', { name: zh.notConnected })).toBeDefined()
    expect(managementApi.clearTeamDissolution).toHaveBeenCalledTimes(1)
    expect(managementApi.status).toHaveBeenCalledTimes(2)
    expect(managementApi.overview).not.toHaveBeenCalled()
  })

  it.each([
    ['member_removed', '你已不再是这个团队的成员。'],
    ['member_left', '你已经退出这个团队。'],
    ['device_revoked', '当前团队连接已失效。'],
  ] as const)('renders the %s terminal without requesting overview', async (code, copy) => {
    managementApi.status.mockResolvedValue({
      enabled: true,
      keyConfigured: false,
      keyWritable: true,
      pendingJoinConfigured: false,
      connectionTerminal: { code, localCleanup: 'completed' },
    })
    render(<TeamSettings t={translate} embedded />)

    expect(await screen.findByText(copy)).toBeDefined()
    expect(managementApi.overview).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain(code)
    expect(document.body.textContent).not.toContain('这个团队已永久解散')
  })

  it('forgets a completed connection terminal before returning to the join flow', async () => {
    managementApi.status
      .mockResolvedValueOnce({
        enabled: true,
        keyConfigured: false,
        keyWritable: true,
        pendingJoinConfigured: false,
        connectionTerminal: { code: 'member_removed', localCleanup: 'completed' },
      })
      .mockResolvedValueOnce({
        enabled: true, keyConfigured: false, keyWritable: true, pendingJoinConfigured: false,
      })
    render(<TeamSettings t={translate} embedded />)

    fireEvent.click(await screen.findByRole('button', { name: '继续加入团队' }))

    expect(await screen.findByRole('heading', { name: zh.notConnected })).toBeDefined()
    expect(managementApi.clearConnectionTerminal).toHaveBeenCalledTimes(1)
    expect(managementApi.status).toHaveBeenCalledTimes(2)
    expect(managementApi.overview).not.toHaveBeenCalled()
  })

  it('refreshes Host status after an overview 410 and renders only the coarse terminal', async () => {
    managementApi.status
      .mockResolvedValueOnce({
        enabled: true, keyConfigured: true, keyWritable: true, pendingJoinConfigured: false,
        serverOrigin: 'https://team.example.test',
      })
      .mockResolvedValueOnce({
        enabled: true,
        keyConfigured: false,
        keyWritable: true,
        pendingJoinConfigured: false,
        dissolution: { state: 'confirmed', localCleanup: 'completed' },
      })
    managementApi.overview.mockRejectedValueOnce(Object.assign(new Error('remote Team connection is terminal'), { status: 410 }))

    render(<TeamSettings t={translate} embedded />)

    expect(await screen.findByText('这个团队已永久解散，无法继续访问。')).toBeDefined()
    expect(managementApi.status).toHaveBeenCalledTimes(2)
    expect(managementApi.overview).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).not.toContain('team_dissolved')
    expect(document.body.textContent).not.toContain('周末造物局')
  })

  it('refreshes Host status after a usage 410 and removes the stale Team workspace', async () => {
    managementApi.status
      .mockResolvedValueOnce({
        enabled: true, keyConfigured: true, keyWritable: true, pendingJoinConfigured: false,
        serverOrigin: 'https://team.example.test',
      })
      .mockResolvedValueOnce({
        enabled: true,
        keyConfigured: false,
        keyWritable: true,
        pendingJoinConfigured: false,
        connectionTerminal: { code: 'member_removed', localCleanup: 'completed' },
      })
    managementApi.usage.mockRejectedValueOnce(Object.assign(new Error('remote Team connection is terminal'), { status: 410 }))

    render(<TeamSettings t={translate} embedded />)

    expect(await screen.findByText('你已不再是这个团队的成员。')).toBeDefined()
    expect(managementApi.status).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).not.toContain('周末造物局')
    expect(document.body.textContent).not.toContain('US$5.88')
  })

  it('refreshes Host status after a mutation 410 and removes stale Owner controls', async () => {
    managementApi.status
      .mockResolvedValueOnce({
        enabled: true, keyConfigured: true, keyWritable: true, pendingJoinConfigured: false,
        serverOrigin: 'https://team.example.test',
      })
      .mockResolvedValueOnce({
        enabled: true,
        keyConfigured: false,
        keyWritable: true,
        pendingJoinConfigured: false,
        connectionTerminal: { code: 'device_revoked', localCleanup: 'completed' },
      })
    managementApi.setTeamStatus.mockRejectedValueOnce(Object.assign(new Error('remote Team connection is terminal'), { status: 410 }))
    render(<TeamSettings t={translate} embedded />)

    const settings = await openTeamSettings()
    fireEvent.click(within(openTeamManagement(settings)).getByRole('menuitem', { name: zh.pauseTeam }))
    fireEvent.click(within(screen.getByRole('dialog', { name: '暂停“周末造物局”？' })).getByRole('button', { name: '确认暂停' }))

    expect(await screen.findByText('当前团队连接已失效。')).toBeDefined()
    expect(managementApi.status).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).not.toContain('周末造物局')
    expect(screen.queryByRole('button', { name: zh.pauseTeam })).toBeNull()
  })

  it('refreshes Host status after an invite reveal 410 and unmounts the secret dialog', async () => {
    overviewState = { ...overviewState, invites: [pendingInvite('invite-1', '新邀请', true)] }
    managementApi.status
      .mockResolvedValueOnce({
        enabled: true, keyConfigured: true, keyWritable: true, pendingJoinConfigured: false,
        serverOrigin: 'https://team.example.test',
      })
      .mockResolvedValueOnce({
        enabled: true,
        keyConfigured: false,
        keyWritable: true,
        pendingJoinConfigured: false,
        connectionTerminal: { code: 'member_removed', localCleanup: 'completed' },
      })
    managementApi.revealInvite.mockRejectedValueOnce(Object.assign(new Error('remote Team connection is terminal'), { status: 410 }))
    render(<TeamSettings t={translate} embedded />)

    const settings = await openTeamSettings('invitations')
    fireEvent.click(within(settings).getByRole('button', { name: zh.revealInvite }))

    expect(await screen.findByText('你已不再是这个团队的成员。')).toBeDefined()
    expect(managementApi.status).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('dialog', { name: zh.inviteRevealed })).toBeNull()
    expect(screen.queryByText(REVEALED_INVITE_TOKEN)).toBeNull()
    expect(document.body.textContent).not.toContain('周末造物局')
  })

  it('ignores a late usage success after a mutation has entered a terminal state', async () => {
    let resolveLateUsage!: (value: typeof completeOwnerUsage) => void
    managementApi.status
      .mockResolvedValueOnce({
        enabled: true, keyConfigured: true, keyWritable: true, pendingJoinConfigured: false,
        serverOrigin: 'https://team.example.test',
      })
      .mockResolvedValueOnce({
        enabled: true, keyConfigured: true, keyWritable: true, pendingJoinConfigured: false,
        serverOrigin: 'https://team.example.test',
      })
      .mockResolvedValueOnce({
        enabled: true,
        keyConfigured: false,
        keyWritable: true,
        pendingJoinConfigured: false,
        connectionTerminal: { code: 'member_removed', localCleanup: 'completed' },
      })
      .mockResolvedValueOnce({
        enabled: true, keyConfigured: false, keyWritable: true, pendingJoinConfigured: false,
      })
    managementApi.usage
      .mockResolvedValueOnce(completeOwnerUsage)
      .mockImplementationOnce(() => new Promise(resolve => { resolveLateUsage = resolve }))
    managementApi.setTeamStatus.mockRejectedValueOnce(Object.assign(new Error('remote Team connection is terminal'), { status: 410 }))
    render(<TeamSettings t={translate} embedded />)

    const settings = await openTeamSettings('usage')
    const usage = within(settings).getByRole('region', { name: zh.usageSectionTitle })
    fireEvent.click(within(usage).getByRole('button', { name: zh.refresh }))
    await waitFor(() => { expect(managementApi.overview).toHaveBeenCalledTimes(2) })
    openTeamManagement(settings)
    fireEvent.click(screen.getByRole('menuitem', { name: zh.pauseTeam }))
    fireEvent.click(within(screen.getByRole('dialog', { name: '暂停“周末造物局”？' })).getByRole('button', { name: '确认暂停' }))
    fireEvent.click(await screen.findByRole('button', { name: zh.continueToJoin }))
    expect(await screen.findByRole('heading', { name: zh.notConnected })).toBeDefined()

    await act(async () => { resolveLateUsage(completeOwnerUsage) })

    expect(screen.getByRole('heading', { name: zh.notConnected })).toBeDefined()
    expect(document.body.textContent).not.toContain('US$5.88')
    expect(document.body.textContent).not.toContain('周末造物局')
  })

  it('shows only the current member aggregate to a Member', async () => {
    overviewState = {
      viewerRole: 'member',
      team: overviewState.team,
      currentMember: { ...overviewState.currentMember, role: 'member' },
      members: overviewState.members,
      contributions: [mine, paused],
    }
    managementApi.usage.mockResolvedValue({
      role: 'member',
      window: completeOwnerUsage.window,
      currency: 'USD',
      mine: completeOwnerUsage.mine,
    })

    render(<TeamSettings t={translate} embedded />)

    const settings = await openTeamSettings('usage')
    const usage = within(settings).getByRole('region', { name: '用量' })
    expect(within(usage).queryByRole('group', { name: zh.teamUsage })).toBeNull()
    const mineUsage = within(usage).getByRole('group', { name: zh.myTeamUsage })
    expect(within(mineUsage).getByText('US$1.75')).toBeDefined()
    expect(usage.textContent).not.toMatch(/Mia|Credits|model/u)
  })

  it.each([
    {
      label: 'partial',
      aggregate: {
        requestCount: 39, tokenMeasuredRequestCount: 31, pricedRequestCount: 25,
        totalTokens: '3100000', estimatedCostUsdMicros: '4200000',
      },
      state: '部分数据', amount: 'US$4.20', tokens: '3,100,000 Token',
    },
    {
      label: 'unpriced',
      aggregate: {
        requestCount: 39, tokenMeasuredRequestCount: 39, pricedRequestCount: 0,
        totalTokens: '3900000', estimatedCostUsdMicros: null,
      },
      state: '费用未计量', amount: '—', tokens: '3,900,000 Token',
    },
    {
      label: 'unmeasured',
      aggregate: {
        requestCount: 39, tokenMeasuredRequestCount: 0, pricedRequestCount: 0,
        totalTokens: null, estimatedCostUsdMicros: null,
      },
      state: '暂无计量数据', amount: '—', tokens: '—',
    },
    {
      label: 'zero',
      aggregate: {
        requestCount: 0, tokenMeasuredRequestCount: 0, pricedRequestCount: 0,
        totalTokens: '0', estimatedCostUsdMicros: '0',
      },
      state: '暂无请求', amount: 'US$0.00', tokens: '0 Token',
    },
  ])('renders the $label usage state without inventing totals', async ({ aggregate, state, amount, tokens }) => {
    managementApi.usage.mockResolvedValue({
      role: 'member', window: completeOwnerUsage.window, currency: 'USD', mine: aggregate,
    })

    render(<TeamSettings t={translate} embedded />)

    const settings = await openTeamSettings('usage')
    const mineUsage = within(within(settings).getByRole('region', { name: '用量' }))
      .getByRole('group', { name: zh.myTeamUsage })
    if (state === zh.usageStateZero) {
      expect(within(mineUsage).queryByText(state)).toBeNull()
    } else {
      expect(within(mineUsage).getByText(state)).toBeDefined()
    }
    if (amount === tokens) {
      expect(within(mineUsage).getAllByText(amount)).toHaveLength(2)
    } else {
      expect(within(mineUsage).getByText(amount)).toBeDefined()
      expect(within(mineUsage).getByText(tokens)).toBeDefined()
    }
    expect(within(mineUsage).getByText(String(aggregate.requestCount))).toBeDefined()
  })

  it('clears a stale projection on failure and can retry the usage request', async () => {
    managementApi.usage
      .mockResolvedValueOnce(completeOwnerUsage)
      .mockRejectedValueOnce(new Error('host unavailable'))
      .mockResolvedValueOnce({
        ...completeOwnerUsage,
        team: { ...completeOwnerUsage.team, estimatedCostUsdMicros: '7200000' },
      })

    render(<TeamSettings t={translate} embedded />)

    const settings = await openTeamSettings('usage')
    let usage = within(settings).getByRole('region', { name: '用量' })
    expect(within(usage).getByText('US$5.88')).toBeDefined()
    fireEvent.click(within(usage).getByRole('button', { name: zh.refresh }))

    expect(await within(usage).findByText('用量暂时无法获取')).toBeDefined()
    expect(within(usage).queryByText('US$5.88')).toBeNull()
    fireEvent.click(within(usage).getByRole('button', { name: zh.retry }))

    usage = await screen.findByRole('region', { name: '用量' })
    expect(await within(usage).findByText('US$7.20')).toBeDefined()
    expect(managementApi.usage).toHaveBeenCalledTimes(3)
  })

  it('keeps aggregate usage readable while the Team is paused', async () => {
    overviewState = { ...overviewState, team: { ...overviewState.team, status: 'paused' } }

    render(<TeamSettings t={translate} embedded />)

    const settings = await openTeamSettings('usage')
    const usage = within(settings).getByRole('region', { name: '用量' })
    expect(screen.getByText(/团队已暂停/u)).toBeDefined()
    expect(usage.textContent).toContain('US$5.88')
    expect(managementApi.usage).toHaveBeenCalledTimes(1)
  })

  it('confirms the impact scope before pausing or resuming the Team', async () => {
    managementApi.setTeamStatus.mockImplementation(async (targetStatus: 'active' | 'paused', expectedLifecycleRevision: number) => {
      const nextTeam = {
        ...overviewState.team,
        status: targetStatus,
        lifecycleRevision: expectedLifecycleRevision + 1,
      }
      overviewState = { ...overviewState, team: nextTeam }
      return { team: nextTeam }
    })
    render(<TeamSettings t={translate} embedded />)

    let settings = await openTeamSettings()
    fireEvent.click(within(openTeamManagement(settings)).getByRole('menuitem', { name: zh.pauseTeam }))

    expect(managementApi.setTeamStatus).not.toHaveBeenCalled()
    let confirmation = screen.getByRole('dialog', { name: '暂停“周末造物局”？' })
    expect(confirmation.textContent).toContain('暂停后，团队将停止接受新的共享请求；正在进行的请求可以完成。')
    expect(confirmation.textContent).toContain('暂停期间不能生成或使用邀请码；现有邀请码会继续自然到期。')
    expect(confirmation.textContent).toContain('成员、用量和共享设置会保留，之后可以恢复。')
    fireEvent.click(within(confirmation).getByRole('button', { name: '确认暂停' }))

    await waitFor(() => {
      expect(managementApi.setTeamStatus).toHaveBeenCalledWith('paused', 7, expectedContext())
    })
    settings = screen.getByRole('region', { name: zh.teamSettingsTitle })
    fireEvent.click(within(openTeamManagement(settings)).getByRole('menuitem', { name: zh.resumeTeam }))

    expect(managementApi.setTeamStatus).toHaveBeenCalledTimes(1)
    confirmation = screen.getByRole('dialog', { name: '恢复“周末造物局”？' })
    expect(confirmation.textContent).toContain('恢复后，团队会重新接受新的共享请求，并允许使用仍有效的邀请码加入。')
    expect(confirmation.textContent).toContain('成员自己的共享设置将按当前状态继续生效。')
    fireEvent.click(within(confirmation).getByRole('button', { name: '确认恢复' }))

    await waitFor(() => {
      expect(managementApi.setTeamStatus).toHaveBeenLastCalledWith('active', 8, expectedContext())
    })
  })

  it('blocks new invitations while paused but keeps existing invitation controls available', async () => {
    overviewState = {
      ...overviewState,
      team: { ...overviewState.team, status: 'paused' },
      invites: [pendingInvite('invite-1', '暂停前的邀请', true)],
    }
    render(<TeamSettings t={translate} embedded />)

    const settings = await openTeamSettings('invitations')
    expect(within(settings).getByRole('button', { name: zh.inviteFriend }).hasAttribute('disabled')).toBe(true)
    expect(within(settings).getByText('团队已暂停。暂停期间不能生成或使用邀请码，但仍可查看或撤销。以下邀请码会继续自然到期；恢复后，届时仍有效的邀请码可继续使用。')).toBeDefined()
    expect(within(settings).getByText('暂停期间不可用')).toBeDefined()
    expect(within(settings).getByRole('button', { name: zh.revealInvite }).hasAttribute('disabled')).toBe(false)
    expect(within(settings).getByRole('button', { name: zh.revokeInvite }).hasAttribute('disabled')).toBe(false)
  })

  it('creates invitations without asking for a purpose and exposes Owner removal without legacy role controls', async () => {
    render(<TeamSettings t={translate} embedded />)
    const settings = await openTeamSettings('members')

    fireEvent.click(within(settings).getByRole('button', { name: '邀请成员' }))
    fireEvent.click(within(settings).getByRole('button', { name: zh.inviteFriend }))
    const inviteDialog = screen.getByRole('dialog', { name: zh.createInviteTitle })
    expect(zh.createInviteTitle).toBe('生成邀请码')
    expect(zh.createInvite).toBe('生成邀请码')
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.queryByRole('dialog', { name: zh.teamSettingsTitle })).toBeNull()
    expect(within(inviteDialog).queryByText('邀请用途')).toBeNull()
    expect(within(inviteDialog).getByLabelText(zh.inviteExpiry)).toBeDefined()
    fireEvent.click(within(inviteDialog).getByRole('button', { name: zh.createInvite }))
    await waitFor(() => {
      expect(managementApi.createInvite).toHaveBeenCalledWith(zh.inviteFriend, 7 * 86_400_000, expectedContext())
    })

    const tokenDialog = await screen.findByRole('dialog', { name: zh.inviteCreated })
    expect(tokenDialog.textContent).toContain('关闭后仍可从邀请码列表再次查看。')
    fireEvent.click(within(tokenDialog).getByRole('button', { name: zh.close }))
    const reopenedSettings = await screen.findByRole('region', { name: zh.teamSettingsTitle })
    const navigation = within(reopenedSettings).getByRole('navigation', { name: zh.workspaceNavigation })
    fireEvent.click(within(navigation).getByRole('button', { name: zh.membersTitle }))

    expect(within(reopenedSettings).getByText('团队所有者 · 我')).toBeDefined()
    expect(within(reopenedSettings).getAllByText('成员').length).toBeGreaterThan(0)
    expect(within(reopenedSettings).queryByRole('button', { name: '设为 Admin' })).toBeNull()
    expect(within(reopenedSettings).queryByRole('button', { name: '设为 Member' })).toBeNull()

    fireEvent.click(within(reopenedSettings).getByRole('button', { name: '管理 Mia' }))
    fireEvent.click(within(screen.getByRole('menu', { name: '管理 Mia' })).getByRole('menuitem', { name: zh.removeMember }))
    const removeDialog = screen.getByRole('dialog', { name: /Mia/u })
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.queryByRole('dialog', { name: zh.teamSettingsTitle })).toBeNull()
    fireEvent.click(within(removeDialog).getByRole('button', { name: zh.confirmRemoveMember }))
    await waitFor(() => { expect(managementApi.removeMember).toHaveBeenCalledWith('member-mia', expectedContext()) })
  })

  it('clears a newly-created invitation when the document is hidden', async () => {
    render(<TeamSettings t={translate} embedded />)
    const settings = await openTeamSettings('invitations')

    fireEvent.click(within(settings).getByRole('button', { name: zh.inviteFriend }))
    const inviteDialog = screen.getByRole('dialog', { name: zh.createInviteTitle })
    fireEvent.click(within(inviteDialog).getByRole('button', { name: zh.createInvite }))
    await screen.findByText(CREATED_INVITE_TOKEN)

    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    fireEvent(document, new Event('visibilitychange'))

    expect(screen.queryByText(CREATED_INVITE_TOKEN)).toBeNull()
  })

  it('never renders a newly-created invitation if its response arrives after the document is hidden', async () => {
    let resolveCreate: ((value: any) => void) | undefined
    managementApi.createInvite.mockImplementationOnce(() => new Promise(resolve => { resolveCreate = resolve }))
    render(<TeamSettings t={translate} embedded />)
    const settings = await openTeamSettings('invitations')

    fireEvent.click(within(settings).getByRole('button', { name: zh.inviteFriend }))
    const inviteDialog = screen.getByRole('dialog', { name: zh.createInviteTitle })
    fireEvent.click(within(inviteDialog).getByRole('button', { name: zh.createInvite }))

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await act(async () => {
      resolveCreate?.({
        invite: pendingInvite('invite-1', '周末协作', true),
        inviteToken: CREATED_INVITE_TOKEN,
      })
    })

    expect(screen.queryByText(CREATED_INVITE_TOKEN)).toBeNull()
  })

  it('never reopens a newly-created invitation after the Owner cancels the pending request dialog', async () => {
    let resolveCreate: ((value: any) => void) | undefined
    managementApi.createInvite.mockImplementationOnce(() => new Promise(resolve => { resolveCreate = resolve }))
    render(<TeamSettings t={translate} embedded />)
    const settings = await openTeamSettings('invitations')

    fireEvent.click(within(settings).getByRole('button', { name: zh.inviteFriend }))
    const inviteDialog = screen.getByRole('dialog', { name: zh.createInviteTitle })
    fireEvent.click(within(inviteDialog).getByRole('button', { name: zh.createInvite }))
    fireEvent.click(within(inviteDialog).getByRole('button', { name: zh.cancel }))

    await act(async () => {
      resolveCreate?.({
        invite: pendingInvite('invite-1', '周末协作', true),
        inviteToken: CREATED_INVITE_TOKEN,
      })
    })

    expect(screen.queryByText(CREATED_INVITE_TOKEN)).toBeNull()
    expect(screen.queryByRole('dialog', { name: zh.inviteCreated })).toBeNull()
  })

  it('clears a newly-created invitation no later than 60 seconds after it appears', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    render(<TeamSettings t={translate} embedded />)
    const settings = await openTeamSettings('invitations')

    fireEvent.click(within(settings).getByRole('button', { name: zh.inviteFriend }))
    const inviteDialog = screen.getByRole('dialog', { name: zh.createInviteTitle })
    fireEvent.click(within(inviteDialog).getByRole('button', { name: zh.createInvite }))
    await screen.findByText(CREATED_INVITE_TOKEN)

    const clearCall = setTimeoutSpy.mock.calls.find(([, delay]) => delay === 60_000)
    expect(clearCall).toBeDefined()
    act(() => { if (typeof clearCall?.[0] === 'function') clearCall[0]() })
    expect(screen.queryByText(CREATED_INVITE_TOKEN)).toBeNull()
  })

  it('clears a newly-created invitation if the viewer loses the Owner context', async () => {
    managementApi.createInvite.mockImplementationOnce(async () => {
      overviewState = {
        viewerRole: 'member',
        team: overviewState.team,
        currentMember: { ...overviewState.currentMember, role: 'member' },
        members: overviewState.members,
        contributions: overviewState.contributions,
      }
      return {
        invite: {
          id: 'invite-1', teamId: 'team-1', invitedByMemberId: 'member-me', label: '周末协作', status: 'pending',
          revealable: true, expiresAt: NOW + 7 * 86_400_000, createdAt: NOW,
        },
        inviteToken: CREATED_INVITE_TOKEN,
      }
    })
    render(<TeamSettings t={translate} embedded />)
    const settings = await openTeamSettings('invitations')

    fireEvent.click(within(settings).getByRole('button', { name: zh.inviteFriend }))
    const inviteDialog = screen.getByRole('dialog', { name: zh.createInviteTitle })
    fireEvent.click(within(inviteDialog).getByRole('button', { name: zh.createInvite }))

    await waitFor(() => { expect(managementApi.overview).toHaveBeenCalledTimes(2) })
    await waitFor(() => { expect(screen.queryByText(CREATED_INVITE_TOKEN)).toBeNull() })
  })

  it('orders active members with the Owner first and keeps removal inside each member menu', async () => {
    const owner = overviewState.members[0]
    const mia = overviewState.members[1]
    overviewState = {
      ...overviewState,
      members: [
        { ...mia, id: 'member-bob', displayName: 'Bob', joinedAt: 3 },
        { ...owner, joinedAt: 2 },
        { ...mia, joinedAt: 1 },
        { ...mia, id: 'member-removed', displayName: 'Removed', status: 'removed', joinedAt: 0 },
      ],
    }
    render(<TeamSettings t={translate} embedded />)

    const settings = await openTeamSettings('members')
    const memberList = within(settings).getByRole('list', { name: zh.membersTitle })
    const rows = within(memberList).getAllByRole('listitem')
    expect(rows.map(row => row.firstElementChild?.textContent)).toEqual([
      'Edison',
      'Mia',
      'Bob',
    ])
    expect(within(rows[0]!).getByText('团队所有者 · 我')).toBeDefined()
    expect(within(settings).queryByRole('button', { name: zh.leaveTeam })).toBeNull()
    expect(within(settings).queryByRole('button', { name: zh.removeMember })).toBeNull()
    expect(within(settings).queryByRole('button', { name: '管理 Edison' })).toBeNull()

    fireEvent.click(within(settings).getByRole('button', { name: '管理 Mia' }))
    const menu = screen.getByRole('menu', { name: '管理 Mia' })
    expect(within(menu).getByRole('menuitem', { name: zh.removeMember })).toBeDefined()
  })

  it('lets the Owner request a two-phase transfer without changing either role', async () => {
    overviewState = {
      ...overviewState,
      members: [
        ...overviewState.members,
        {
          ...overviewState.members[1],
          id: 'member-bob',
          displayName: 'Bob',
          joinedAt: 3,
          canReceiveOwnership: false,
        },
      ],
    }
    render(<TeamSettings t={translate} embedded />)

    let settings = await openTeamSettings()
    fireEvent.click(within(openTeamManagement(settings)).getByRole('menuitem', { name: zh.transferOwnership }))

    let transferDialog = screen.getByRole('dialog', { name: zh.transferOwnership })
    const eligibleTarget = within(transferDialog).getByRole('radio', { name: 'Mia' })
    expect(within(transferDialog).queryByRole('radio', { name: 'Bob' })).toBeNull()
    fireEvent.click(eligibleTarget)

    transferDialog = screen.getByRole('dialog', { name: '邀请「Mia」接任团队所有者？' })
    expect(within(transferDialog).getByText('对方接受前，你仍是团队所有者。对方接受后，你会变为成员，全部尚未使用的邀请码会失效。成员显示名称不代表经过验证的身份，请先通过可信渠道确认「Mia」是预期成员。')).toBeDefined()
    fireEvent.click(within(transferDialog).getByRole('button', { name: '发送转让请求' }))

    await waitFor(() => {
      expect(managementApi.requestOwnershipTransfer).toHaveBeenCalledWith('member-mia', expectedContext())
    })
    settings = await screen.findByRole('region', { name: zh.teamSettingsTitle })
    fireEvent.click(within(within(settings).getByRole('navigation', { name: zh.workspaceNavigation })).getByRole('button', { name: zh.membersTitle }))
    expect(within(settings).getByText('团队所有者 · 我')).toBeDefined()
    expect(within(settings).getAllByText('成员').length).toBeGreaterThan(0)
    expect(within(settings).getByText('已邀请「Mia」接任团队所有者。')).toBeDefined()
    expect(within(settings).getByText(`转让请求将在 ${uiTime(pendingOwnershipTransfer().expiresAt)} 到期。`)).toBeDefined()
    expect(managementApi.overview.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('keeps the pending transfer visible to the requesting Owner and lets them revoke it', async () => {
    overviewState = { ...overviewState, ownershipTransfer: pendingOwnershipTransfer() }
    render(<TeamSettings t={translate} embedded />)

    let settings = await openTeamSettings()
    const ownership = within(settings).getByRole('region', { name: '所有权转让' })
    expect(within(ownership).getByText('已邀请「Mia」接任团队所有者。')).toBeDefined()
    expect(within(ownership).getByText(`转让请求将在 ${uiTime(pendingOwnershipTransfer().expiresAt)} 到期。`)).toBeDefined()
    expect(within(ownership).queryByRole('button', { name: zh.transferOwnership })).toBeNull()

    fireEvent.click(within(ownership).getByRole('button', { name: '撤销转让请求' }))
    await waitFor(() => {
      expect(managementApi.revokeOwnershipTransfer).toHaveBeenCalledWith('transfer-1', expectedContext())
    })
    settings = await screen.findByRole('region', { name: zh.teamSettingsTitle })
    expect(within(settings).queryByText('已邀请「Mia」接任团队所有者。')).toBeNull()
    expect(within(openTeamManagement(settings)).getByRole('menuitem', { name: zh.transferOwnership })).toBeDefined()
  })

  it('lets the nominated member accept the transfer and refreshes the overview', async () => {
    const owner = overviewState.members[0]
    const mia = overviewState.members[1]
    overviewState = {
      ...overviewState,
      viewerRole: 'member',
      currentMember: mia,
      ownershipTransfer: pendingOwnershipTransfer(),
    }
    managementApi.acceptOwnershipTransfer.mockImplementation(async () => {
      const accepted = {
        transfer: { ...pendingOwnershipTransfer(), status: 'accepted' as const, resolvedAt: NOW + 1_000 },
        formerOwner: { ...owner, role: 'member' as const },
        owner: { ...mia, role: 'owner' as const },
      }
      overviewState = {
        ...overviewState,
        viewerRole: 'owner',
        currentMember: accepted.owner,
        members: [accepted.formerOwner, accepted.owner],
        ownershipTransfer: undefined,
      }
      return accepted
    })
    render(<TeamSettings t={translate} embedded />)

    let settings = await openTeamSettings()
    const ownership = within(settings).getByRole('region', { name: '所有权转让' })
    expect(within(ownership).getByText('「Edison」邀请你接任团队所有者。')).toBeDefined()
    expect(within(ownership).getByText('接受后，你将负责邀请成员、管理团队运行和解散团队。')).toBeDefined()
    expect(within(ownership).getByText(`转让请求将在 ${uiTime(pendingOwnershipTransfer().expiresAt)} 到期。`)).toBeDefined()

    fireEvent.click(within(ownership).getByRole('button', { name: '接受并成为团队所有者' }))
    await waitFor(() => {
      expect(managementApi.acceptOwnershipTransfer).toHaveBeenCalledWith('transfer-1', expectedContext('member-mia'))
      expect(managementApi.overview.mock.calls.length).toBeGreaterThanOrEqual(2)
    })
    settings = await screen.findByRole('region', { name: zh.teamSettingsTitle })
    fireEvent.click(
      within(within(settings).getByRole('navigation', { name: zh.workspaceNavigation })).getByRole('button', {
        name: zh.membersTitle,
      }),
    )
    expect(within(settings).getByText('团队所有者 · 我')).toBeDefined()
    expect(within(settings).getByRole('button', { name: zh.invitationsTitle })).toBeDefined()
    expect(within(settings).queryByText('「Edison」邀请你接任团队所有者。')).toBeNull()
  })

  it('lets the nominated member reject the transfer without gaining Owner controls', async () => {
    const mia = overviewState.members[1]
    overviewState = {
      ...overviewState,
      viewerRole: 'member',
      currentMember: mia,
      ownershipTransfer: pendingOwnershipTransfer(),
    }
    managementApi.rejectOwnershipTransfer.mockImplementation(async () => {
      const rejected = { ...pendingOwnershipTransfer(), status: 'rejected' as const, resolvedAt: NOW + 1_000 }
      overviewState = { ...overviewState, ownershipTransfer: undefined }
      return rejected
    })
    render(<TeamSettings t={translate} embedded />)

    let settings = await openTeamSettings()
    const ownership = within(settings).getByRole('region', { name: '所有权转让' })
    fireEvent.click(within(ownership).getByRole('button', { name: '拒绝' }))

    await waitFor(() => {
      expect(managementApi.rejectOwnershipTransfer).toHaveBeenCalledWith('transfer-1', expectedContext('member-mia'))
    })
    settings = await screen.findByRole('region', { name: zh.teamSettingsTitle })
    expect(within(settings).queryByText('「Edison」邀请你接任团队所有者。')).toBeNull()
    expect(within(settings).queryByRole('button', { name: zh.invitationsTitle })).toBeNull()
  })

  it('does not expose someone else’s pending transfer to an observing member', async () => {
    const bob = {
      ...overviewState.members[1],
      id: 'member-bob',
      displayName: 'Bob',
      joinedAt: 3,
      canReceiveOwnership: true,
    }
    overviewState = {
      ...overviewState,
      viewerRole: 'member',
      currentMember: bob,
      members: [...overviewState.members, bob],
      ownershipTransfer: pendingOwnershipTransfer(),
    }
    render(<TeamSettings t={translate} embedded />)

    const settings = await openTeamSettings()
    expect(within(settings).queryByRole('region', { name: '所有权转让' })).toBeNull()
    expect(within(settings).queryByText('已邀请「Mia」接任团队所有者。')).toBeNull()
    expect(within(settings).queryByText('「Edison」邀请你接任团队所有者。')).toBeNull()
    expect(within(settings).queryByRole('button', { name: '接受并成为团队所有者' })).toBeNull()
    expect(within(settings).queryByRole('button', { name: '拒绝' })).toBeNull()
    expect(within(settings).queryByRole('button', { name: '撤销转让请求' })).toBeNull()
  })

  it('reveals only decryptable invitations in a separate modal and clears the token on close or unmount', async () => {
    overviewState = {
      ...overviewState,
      invites: [pendingInvite('invite-1', '新邀请', true), pendingInvite('invite-legacy', '旧邀请', false)],
    }
    const view = render(<TeamSettings t={translate} embedded />)
    const settings = await openTeamSettings('invitations')

    expect(within(settings).getByText(zh.inviteNotRevealable)).toBeDefined()
    expect(within(settings).getAllByRole('button', { name: zh.revealInvite })).toHaveLength(1)
    expect(screen.queryByText(REVEALED_INVITE_TOKEN)).toBeNull()

    fireEvent.click(within(settings).getByRole('button', { name: zh.revealInvite }))
    const revealDialog = await screen.findByRole('dialog', { name: zh.inviteRevealed })
    expect(managementApi.revealInvite).toHaveBeenCalledWith('invite-1', expectedContext())
    expect(within(revealDialog).getByText(REVEALED_INVITE_TOKEN)).toBeDefined()

    fireEvent.click(within(revealDialog).getByRole('button', { name: zh.close }))
    expect(screen.queryByText(REVEALED_INVITE_TOKEN)).toBeNull()

    fireEvent.click(within(settings).getByRole('button', { name: zh.revealInvite }))
    await screen.findByText(REVEALED_INVITE_TOKEN)
    view.unmount()
    expect(screen.queryByText(REVEALED_INVITE_TOKEN)).toBeNull()
  })

  it('clears a revealed invitation when the document is hidden or the Owner context changes', async () => {
    overviewState = { ...overviewState, invites: [pendingInvite('invite-1', '新邀请', true)] }
    render(<TeamSettings t={translate} embedded />)
    let settings = await openTeamSettings('invitations')
    fireEvent.click(within(settings).getByRole('button', { name: zh.revealInvite }))
    await screen.findByText(REVEALED_INVITE_TOKEN)

    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    fireEvent(document, new Event('visibilitychange'))
    expect(screen.queryByText(REVEALED_INVITE_TOKEN)).toBeNull()
    visibility.mockReturnValue('visible')

    settings = screen.getByRole('region', { name: zh.teamSettingsTitle })
    fireEvent.click(within(settings).getByRole('button', { name: zh.revealInvite }))
    await screen.findByText(REVEALED_INVITE_TOKEN)
    overviewState = {
      viewerRole: 'member',
      team: overviewState.team,
      currentMember: { ...overviewState.currentMember, role: 'member' },
      members: overviewState.members,
      contributions: overviewState.contributions,
    }
    fireEvent.click(
      within(within(settings).getByRole('navigation', { name: zh.workspaceNavigation })).getByRole('button', {
        name: zh.usageSectionTitle,
      }),
    )
    fireEvent.click(within(settings).getByRole('button', { name: zh.refresh }))
    await waitFor(() => { expect(screen.queryByText(REVEALED_INVITE_TOKEN)).toBeNull() })
  })

  it('never renders a revealed invitation if its response arrives after the document is hidden', async () => {
    overviewState = { ...overviewState, invites: [pendingInvite('invite-1', '新邀请', true)] }
    let resolveReveal: ((value: any) => void) | undefined
    managementApi.revealInvite.mockImplementationOnce(() => new Promise(resolve => { resolveReveal = resolve }))
    render(<TeamSettings t={translate} embedded />)
    const settings = await openTeamSettings('invitations')

    fireEvent.click(within(settings).getByRole('button', { name: zh.revealInvite }))
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await act(async () => {
      resolveReveal?.({
        inviteId: 'invite-1',
        inviteToken: REVEALED_INVITE_TOKEN,
        expiresAt: NOW + 7 * 86_400_000,
      })
    })

    expect(screen.queryByText(REVEALED_INVITE_TOKEN)).toBeNull()
  })

  it('requires confirmation before revoking an invitation', async () => {
    overviewState = { ...overviewState, invites: [pendingInvite('invite-1', '产品设计协作', true)] }
    render(<TeamSettings t={translate} embedded />)
    let settings = await openTeamSettings('invitations')

    fireEvent.click(within(settings).getByRole('button', { name: zh.revokeInvite }))
    expect(managementApi.revokeInvite).not.toHaveBeenCalled()
    let confirmation = screen.getByRole('dialog', { name: '撤销“产品设计协作”的邀请码？' })
    expect(confirmation.textContent).toContain('撤销后，该邀请码会立即失效')
    fireEvent.click(within(confirmation).getByRole('button', { name: zh.cancel }))
    expect(managementApi.revokeInvite).not.toHaveBeenCalled()

    settings = await openTeamSettings('invitations')
    fireEvent.click(within(settings).getByRole('button', { name: zh.revokeInvite }))
    confirmation = screen.getByRole('dialog', { name: '撤销“产品设计协作”的邀请码？' })
    fireEvent.click(within(confirmation).getByRole('button', { name: zh.revokeInvite }))

    await waitFor(() => { expect(managementApi.revokeInvite).toHaveBeenCalledTimes(1) })
    expect(managementApi.revokeInvite).toHaveBeenCalledWith('invite-1', expectedContext())
    await waitFor(() => { expect(screen.queryByText('产品设计协作')).toBeNull() })
  })

  it('closes a Team status confirmation when the viewer loses Owner access', async () => {
    render(<TeamSettings t={translate} embedded />)
    const settings = await openTeamSettings('usage')

    fireEvent.click(within(openTeamManagement(settings)).getByRole('menuitem', { name: zh.pauseTeam }))
    expect(screen.getByRole('dialog', { name: '暂停“周末造物局”？' })).toBeDefined()

    overviewState = {
      viewerRole: 'member',
      team: overviewState.team,
      currentMember: { ...overviewState.currentMember, role: 'member' },
      members: overviewState.members,
      contributions: overviewState.contributions,
    }
    fireEvent.click(within(settings).getByRole('button', { name: zh.refresh }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '暂停“周末造物局”？' })).toBeNull()
    })
    expect(managementApi.setTeamStatus).not.toHaveBeenCalled()
  })

  it('closes a Team dissolution confirmation when the viewer loses Owner access', async () => {
    render(<TeamSettings t={translate} embedded />)
    const settings = await openTeamSettings('usage')

    fireEvent.click(within(openTeamManagement(settings)).getByRole('menuitem', { name: '永久解散团队' }))
    expect(screen.getByRole('dialog', { name: /永久解散.*周末造物局/u })).toBeDefined()

    overviewState = {
      viewerRole: 'member',
      team: overviewState.team,
      currentMember: { ...overviewState.currentMember, role: 'member' },
      members: overviewState.members,
      contributions: overviewState.contributions,
    }
    fireEvent.click(within(settings).getByRole('button', { name: zh.refresh }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /永久解散.*周末造物局/u })).toBeNull()
    })
    expect(managementApi.dissolveTeam).not.toHaveBeenCalled()
  })

  it('closes a Team status confirmation when the active Owner identity changes', async () => {
    render(<TeamSettings t={translate} embedded />)
    const settings = await openTeamSettings('usage')

    fireEvent.click(within(openTeamManagement(settings)).getByRole('menuitem', { name: zh.pauseTeam }))
    expect(screen.getByRole('dialog', { name: '暂停“周末造物局”？' })).toBeDefined()

    switchToSecondOwnerTeam()
    fireEvent.click(within(settings).getByRole('button', { name: zh.refresh }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '暂停“周末造物局”？' })).toBeNull()
    })
    expect(managementApi.setTeamStatus).not.toHaveBeenCalled()
  })

  it('invalidates an Owner confirmation while a refreshed overview is still pending', async () => {
    render(<TeamSettings t={translate} embedded />)
    const settings = await openTeamSettings('usage')

    fireEvent.click(within(openTeamManagement(settings)).getByRole('menuitem', { name: zh.pauseTeam }))
    expect(screen.getByRole('dialog', { name: '暂停“周末造物局”？' })).toBeDefined()

    let resolveOverview: ((value: any) => void) | undefined
    managementApi.overview.mockImplementationOnce(() => new Promise(resolve => { resolveOverview = resolve }))
    fireEvent.click(within(settings).getByRole('button', { name: zh.refresh }))
    await waitFor(() => { expect(managementApi.overview).toHaveBeenCalledTimes(2) })

    const pendingConfirmation = screen.getByRole('dialog', { name: '暂停“周末造物局”？' })
    const pendingSubmit = within(pendingConfirmation).getByRole('button', { name: '确认暂停' })
    expect(pendingSubmit.hasAttribute('disabled')).toBe(true)
    fireEvent.click(pendingSubmit)
    expect(managementApi.setTeamStatus).not.toHaveBeenCalled()

    switchToSecondOwnerTeam()
    await act(async () => { resolveOverview?.(overviewState) })
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '暂停“周末造物局”？' })).toBeNull()
    })
    expect(managementApi.setTeamStatus).not.toHaveBeenCalled()
  })

  it('closes a Team dissolution confirmation when the active Owner identity changes', async () => {
    render(<TeamSettings t={translate} embedded />)
    const settings = await openTeamSettings('usage')

    fireEvent.click(within(openTeamManagement(settings)).getByRole('menuitem', { name: '永久解散团队' }))
    expect(screen.getByRole('dialog', { name: /永久解散.*周末造物局/u })).toBeDefined()

    switchToSecondOwnerTeam()
    fireEvent.click(within(settings).getByRole('button', { name: zh.refresh }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /永久解散.*周末造物局/u })).toBeNull()
    })
    expect(managementApi.dissolveTeam).not.toHaveBeenCalled()
  })

  it('closes an ownership transfer dialog when the viewer loses Owner access', async () => {
    render(<TeamSettings t={translate} embedded />)
    const settings = await openTeamSettings('usage')

    fireEvent.click(within(openTeamManagement(settings)).getByRole('menuitem', { name: zh.transferOwnership }))
    expect(screen.getByRole('dialog', { name: zh.transferOwnership })).toBeDefined()

    overviewState = {
      viewerRole: 'member',
      team: overviewState.team,
      currentMember: { ...overviewState.currentMember, role: 'member' },
      members: overviewState.members,
      contributions: overviewState.contributions,
    }
    fireEvent.click(within(settings).getByRole('button', { name: zh.refresh }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: zh.transferOwnership })).toBeNull()
    })
    expect(managementApi.requestOwnershipTransfer).not.toHaveBeenCalled()
  })

  it('closes a member removal confirmation when the viewer loses Owner access', async () => {
    render(<TeamSettings t={translate} embedded />)
    const settings = await openTeamSettings('members')

    fireEvent.click(within(settings).getByRole('button', { name: '管理 Mia' }))
    fireEvent.click(within(screen.getByRole('menu', { name: '管理 Mia' })).getByRole('menuitem', { name: zh.removeMember }))
    expect(screen.getByRole('dialog', { name: /Mia/u })).toBeDefined()

    overviewState = {
      viewerRole: 'member',
      team: overviewState.team,
      currentMember: { ...overviewState.currentMember, role: 'member' },
      members: overviewState.members,
      contributions: overviewState.contributions,
    }
    const navigation = within(settings).getByRole('navigation', { name: zh.workspaceNavigation })
    fireEvent.click(within(navigation).getByRole('button', { name: zh.usageSectionTitle }))
    fireEvent.click(within(await screen.findByRole('region', { name: zh.usageSectionTitle })).getByRole('button', { name: zh.refresh }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /Mia/u })).toBeNull()
    })
    expect(managementApi.removeMember).not.toHaveBeenCalled()
  })

  it('closes an invitation revoke confirmation when the viewer loses Owner access', async () => {
    overviewState = { ...overviewState, invites: [pendingInvite('invite-1', '产品设计协作', true)] }
    render(<TeamSettings t={translate} embedded />)
    const settings = await openTeamSettings('invitations')

    fireEvent.click(within(settings).getByRole('button', { name: zh.revokeInvite }))
    expect(screen.getByRole('dialog', { name: '撤销“产品设计协作”的邀请码？' })).toBeDefined()

    overviewState = {
      viewerRole: 'member',
      team: overviewState.team,
      currentMember: { ...overviewState.currentMember, role: 'member' },
      members: overviewState.members,
      contributions: overviewState.contributions,
    }
    const navigation = within(settings).getByRole('navigation', { name: zh.workspaceNavigation })
    fireEvent.click(within(navigation).getByRole('button', { name: zh.usageSectionTitle }))
    fireEvent.click(within(await screen.findByRole('region', { name: zh.usageSectionTitle })).getByRole('button', { name: zh.refresh }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '撤销“产品设计协作”的邀请码？' })).toBeNull()
    })
    expect(managementApi.revokeInvite).not.toHaveBeenCalled()
  })

  it('closes an invitation revoke confirmation when the active Owner identity changes', async () => {
    overviewState = { ...overviewState, invites: [pendingInvite('invite-1', '产品设计协作', true)] }
    render(<TeamSettings t={translate} embedded />)
    const settings = await openTeamSettings('invitations')

    fireEvent.click(within(settings).getByRole('button', { name: zh.revokeInvite }))
    expect(screen.getByRole('dialog', { name: '撤销“产品设计协作”的邀请码？' })).toBeDefined()

    switchToSecondOwnerTeam()
    overviewState = {
      ...overviewState,
      invites: [{
        ...pendingInvite('invite-1', '新团队邀请', true),
        teamId: 'team-2',
        invitedByMemberId: 'member-other-owner',
      }],
    }
    const navigation = within(settings).getByRole('navigation', { name: zh.workspaceNavigation })
    fireEvent.click(within(navigation).getByRole('button', { name: zh.usageSectionTitle }))
    fireEvent.click(within(await screen.findByRole('region', { name: zh.usageSectionTitle })).getByRole('button', { name: zh.refresh }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '撤销“产品设计协作”的邀请码？' })).toBeNull()
    })
    expect(managementApi.revokeInvite).not.toHaveBeenCalled()
  })

  it('closes an invitation draft when the viewer loses Owner access', async () => {
    render(<TeamSettings t={translate} embedded />)
    const settings = await openTeamSettings('invitations')

    fireEvent.click(within(settings).getByRole('button', { name: zh.inviteFriend }))
    expect(screen.getByRole('dialog', { name: zh.createInviteTitle })).toBeDefined()

    overviewState = {
      viewerRole: 'member',
      team: overviewState.team,
      currentMember: { ...overviewState.currentMember, role: 'member' },
      members: overviewState.members,
      contributions: overviewState.contributions,
    }
    const navigation = within(settings).getByRole('navigation', { name: zh.workspaceNavigation })
    fireEvent.click(within(navigation).getByRole('button', { name: zh.usageSectionTitle }))
    fireEvent.click(within(await screen.findByRole('region', { name: zh.usageSectionTitle })).getByRole('button', { name: zh.refresh }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: zh.createInviteTitle })).toBeNull()
    })
    expect(managementApi.createInvite).not.toHaveBeenCalled()
  })

  it('closes an invitation draft when the active Owner identity changes', async () => {
    render(<TeamSettings t={translate} embedded />)
    const settings = await openTeamSettings('invitations')

    fireEvent.click(within(settings).getByRole('button', { name: zh.inviteFriend }))
    expect(screen.getByRole('dialog', { name: zh.createInviteTitle })).toBeDefined()

    switchToSecondOwnerTeam()
    const navigation = within(settings).getByRole('navigation', { name: zh.workspaceNavigation })
    fireEvent.click(within(navigation).getByRole('button', { name: zh.usageSectionTitle }))
    fireEvent.click(within(await screen.findByRole('region', { name: zh.usageSectionTitle })).getByRole('button', { name: zh.refresh }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: zh.createInviteTitle })).toBeNull()
    })
    expect(managementApi.createInvite).not.toHaveBeenCalled()
  })

  it('refreshes at the next invitation expiry so an expired pending invite disappears', async () => {
    const expiresAt = NOW + 1_000
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(NOW)
    overviewState = {
      ...overviewState,
      invites: [{ ...pendingInvite('invite-1', '即将过期', true), expiresAt }],
    }
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    render(<TeamSettings t={translate} embedded />)
    const settings = await openTeamSettings('invitations')
    expect(within(settings).getByText('即将过期')).toBeDefined()

    const expiryCall = setTimeoutSpy.mock.calls.find(([, delay]) => delay === 1_001)
    expect(expiryCall).toBeDefined()
    overviewState = { ...overviewState, invites: [] }
    nowSpy.mockReturnValue(expiresAt + 1)
    act(() => { if (typeof expiryCall?.[0] === 'function') expiryCall[0]() })

    await waitFor(() => { expect(screen.queryByText('即将过期')).toBeNull() })
  })

  it('clears a revealed invitation no later than 60 seconds after it arrives', async () => {
    overviewState = { ...overviewState, invites: [pendingInvite('invite-1', '新邀请', true)] }
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    render(<TeamSettings t={translate} embedded />)
    const settings = await openTeamSettings('invitations')
    fireEvent.click(within(settings).getByRole('button', { name: zh.revealInvite }))
    await screen.findByText(REVEALED_INVITE_TOKEN)

    const clearCall = setTimeoutSpy.mock.calls.find(([, delay]) => delay === 60_000)
    expect(clearCall).toBeDefined()
    act(() => { if (typeof clearCall?.[0] === 'function') clearCall[0]() })
    expect(screen.queryByText(REVEALED_INVITE_TOKEN)).toBeNull()
  })

  it('moves focus into child dialogs and restores the originating Team settings action', async () => {
    render(<TeamSettings t={translate} embedded />)
    let settings = await openTeamSettings('invitations')
    const inviteTrigger = within(settings).getByRole('button', { name: zh.inviteFriend })
    inviteTrigger.focus()
    fireEvent.click(inviteTrigger)

    const inviteDialog = screen.getByRole('dialog', { name: zh.createInviteTitle })
    const inviteExpiry = within(inviteDialog).getByLabelText(zh.inviteExpiry)
    await waitFor(() => { expect(document.activeElement).toBe(inviteExpiry) })
    fireEvent.click(within(inviteDialog).getByRole('button', { name: zh.cancel }))

    settings = await screen.findByRole('region', { name: zh.teamSettingsTitle })
    await waitFor(() => {
      expect(document.activeElement).toBe(within(settings).getByRole('button', { name: zh.inviteFriend }))
    })

    const navigation = within(settings).getByRole('navigation', { name: zh.workspaceNavigation })
    fireEvent.click(within(navigation).getByRole('button', { name: zh.membersTitle }))
    const memberMenuTrigger = within(settings).getByRole('button', { name: '管理 Mia' })
    memberMenuTrigger.focus()
    fireEvent.click(memberMenuTrigger)
    fireEvent.click(within(screen.getByRole('menu', { name: '管理 Mia' })).getByRole('menuitem', { name: zh.removeMember }))

    const removeDialog = screen.getByRole('dialog', { name: /Mia/u })
    const removeWarning = within(removeDialog).getByText(zh.removeMemberWarning)
    await waitFor(() => { expect(document.activeElement).toBe(removeWarning) })
    fireEvent.click(within(removeDialog).getByRole('button', { name: zh.cancel }))

    settings = await screen.findByRole('region', { name: zh.teamSettingsTitle })
    await waitFor(() => {
      expect(document.activeElement).toBe(within(settings).getByRole('button', { name: '管理 Mia' }))
    })
  })

  it('does not expose Owner invitations or management controls to Members', async () => {
    overviewState = {
      viewerRole: 'member',
      team: overviewState.team,
      currentMember: { ...overviewState.currentMember, role: 'member' },
      members: overviewState.members,
      contributions: [mine, paused],
    }
    render(<TeamSettings t={translate} embedded />)

    const settings = await openTeamSettings('members')

    expect(within(settings).queryByRole('heading', { name: zh.pendingInvitesTitle })).toBeNull()
    expect(within(settings).queryByRole('button', { name: zh.invitationsTitle })).toBeNull()
    expect(within(settings).queryByRole('button', { name: zh.revokeInvite })).toBeNull()
    expect(within(settings).queryByRole('button', { name: zh.pauseTeam })).toBeNull()
    expect(within(settings).queryByRole('button', { name: '永久解散团队' })).toBeNull()
    expect(within(settings).queryByRole('button', { name: zh.removeMember })).toBeNull()
    expect(within(settings).queryByRole('button', { name: '设为 Admin' })).toBeNull()
    expect(within(settings).queryByRole('button', { name: '设为 Member' })).toBeNull()
    expect(within(settings).queryByRole('img')).toBeNull()

    fireEvent.click(within(openTeamManagement(settings)).getByRole('menuitem', { name: zh.leaveTeam }))
    const leaveDialog = screen.getByRole('dialog', { name: zh.leaveTeamTitle })
    fireEvent.click(within(leaveDialog).getByRole('button', { name: zh.confirmLeaveTeam }))
    await waitFor(() => { expect(managementApi.leaveTeam).toHaveBeenCalledTimes(1) })
  })

  it('closes a leave confirmation when the active member identity changes', async () => {
    overviewState = {
      viewerRole: 'member',
      team: overviewState.team,
      currentMember: { ...overviewState.currentMember, role: 'member' },
      members: overviewState.members,
      contributions: [mine, paused],
    }
    render(<TeamSettings t={translate} embedded />)
    const settings = await openTeamSettings('usage')

    fireEvent.click(within(openTeamManagement(settings)).getByRole('menuitem', { name: zh.leaveTeam }))
    expect(screen.getByRole('dialog', { name: zh.leaveTeamTitle })).toBeDefined()

    switchToSecondMemberTeam()
    fireEvent.click(within(settings).getByRole('button', { name: zh.refresh }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: zh.leaveTeamTitle })).toBeNull()
    })
    expect(managementApi.leaveTeam).not.toHaveBeenCalled()
  })

  it('uses the role-shaped overview instead of legacy member roles for Owner controls', async () => {
    overviewState = {
      viewerRole: 'member',
      team: overviewState.team,
      currentMember: { ...overviewState.currentMember, role: 'admin' },
      members: overviewState.members,
      contributions: [mine, paused],
    }
    render(<TeamSettings t={translate} embedded />)

    const settings = await openTeamSettings('members')
    expect(within(settings).getAllByText('成员').length).toBeGreaterThan(0)
    expect(within(settings).queryByRole('button', { name: zh.invitationsTitle })).toBeNull()
    expect(within(settings).queryByRole('button', { name: zh.pauseTeam })).toBeNull()
    expect(within(settings).queryByRole('button', { name: '永久解散团队' })).toBeNull()
  })
})

it('lets a connected owner preview another invitation without disconnecting the current Team', async () => {
  render(<TeamSettings t={translate} embedded />)
  fireEvent.click(await screen.findByRole('button', { name: '加入其他团队' }))
  fireEvent.change(screen.getByLabelText('邀请 Token'), { target: { value: `dsh_invite_${'a'.repeat(32)}` } })
  fireEvent.click(screen.getByRole('button', { name: '查看邀请' }))
  await screen.findByText('邀请已验证')
  expect(managementApi.disconnect).not.toHaveBeenCalled()
  expect(managementApi.leaveTeam).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '返回当前团队' }))
  expect(await screen.findByRole('button', { name: '加入其他团队' })).toBeDefined()
})

it('switches to a saved Team using the displayed context and refreshes its identity', async () => {
  managementApi.connections.mockResolvedValue([{ id: 'saved-b', teamId: 'team-2', teamName: '第二团队', currentMemberId: 'member-b', memberName: 'Edison' }])
  managementApi.switchConnection.mockResolvedValue({})
  render(<TeamSettings t={translate} embedded />)
  fireEvent.click(await screen.findByRole('button', { name: '切换团队' }))
  fireEvent.click(await screen.findByRole('button', { name: '第二团队 · Edison' }))
  await waitFor(() => expect(managementApi.switchConnection).toHaveBeenCalledWith('saved-b', {
    serverOrigin: 'https://team.example.test', teamId: 'team-1', currentMemberId: 'member-me',
  }))
  expect(managementApi.disconnect).not.toHaveBeenCalled()
})

it('shows recovery immediately after an uncertain join while keeping the original connection', async () => {
  managementApi.join.mockImplementationOnce(async () => {
    managementApi.status.mockResolvedValue({ enabled: true, keyConfigured: true, keyWritable: true, pendingJoinConfigured: true, serverOrigin: 'https://team.example.test' })
    throw new Error('network interrupted')
  })
  render(<TeamSettings t={translate} embedded />)
  fireEvent.click(await screen.findByRole('button', { name: zh.joinOtherTeam }))
  fireEvent.change(screen.getByLabelText(zh.inviteToken), { target: { value: 'dsh_invite_secret-1234567890' } })
  fireEvent.click(screen.getByRole('button', { name: zh.previewInvitation }))
  await screen.findByText(zh.invitationVerified)
  fireEvent.change(screen.getByLabelText(zh.displayName), { target: { value: 'Edison' } })
  fireEvent.click(screen.getByRole('button', { name: zh.confirmJoin }))
  expect(await screen.findByRole('button', { name: zh.recoverJoin })).toBeDefined()
  expect(managementApi.join).toHaveBeenCalledWith(`dsh_join_${'a'.repeat(43)}`, 'Edison', {
    serverOrigin: 'https://team.example.test', teamId: 'team-1', currentMemberId: 'member-me',
  })
  expect(managementApi.disconnect).not.toHaveBeenCalled()
})
