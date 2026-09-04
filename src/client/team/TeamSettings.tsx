/** Invite-only Team capacity management inside the dsh Settings shell. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  IconCopyOutline16,
  IconPlusOutline16,
  IconRefreshOutline16,
  IconTrashOutline16,
  Input,
  Modal,
  Pill,
  StateDot,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  TeamConnectionTerminalView,
  TeamDissolutionView,
  TeamManagementInvitePreview,
  TeamManagementInviteRevealResult,
  TeamManagementContributionSummary,
  TeamManagementMemberSummary,
  TeamManagementOAuthResult,
  TeamManagementOverview,
  TeamManagementSharedAccountDirectoryEntry,
  TeamManagementExpectedContext,
  TeamManagementStatus,
  TeamManagementUsageResult,
} from '../../shared/team-management.ts'
import {
  TEAM_AUTHORIZATION_FAILED_CODE,
  TEAM_AUTHORIZATION_NETWORK_UNAVAILABLE_CODE,
  TEAM_BROWSER_AUTHORIZATION_ALREADY_PENDING_CODE,
  TEAM_LOCAL_ACCOUNT_ALREADY_SHARED_CODE,
  TEAM_MANAGEMENT_CONTEXT_CHANGED_MESSAGE,
} from '../../shared/team-management.ts'
import { createTeamManagementApi } from './api.ts'
import { en } from './locales.ts'
import type { TeamSettingsKey } from './locales.ts'
import { createTeamUsageViewModel } from './team-usage-view-model.ts'
import type { TeamUsageAggregateInput, TeamUsageState } from './team-usage-view-model.ts'
import {
  openAuthorizationPopupBridge,
  type AuthorizationPopupController,
} from '../authorization-popup.ts'
import {
  canMemberLeaveTeam,
  canRemoveTeamMember,
  canTransferTeamOwnership,
  groupTeamContributions,
  localProfilesAvailableForTeam,
  parseContributionProtectionDraft,
} from './team-settings-contract.ts'
import styles from './TeamSettings.module.css'

const api = createTeamManagementApi()
const USAGE_REFRESH_MS = 60_000
const AUTHORIZATION_POLL_MS = 2_000
const INVITE_SECRET_VISIBLE_MS = 60_000
const TEAM_INVITE_TOKEN_PATTERN = /^dsh_invite_[A-Za-z0-9_-]{16,}$/u
const LOCAL_PROFILE_DIRECTORY_PATH = '/plugins/dsh-openai-codex/profiles/directory'
const LOCAL_PROFILES_PATH = '/plugins/dsh-openai-codex/profiles'
const LOCAL_QUOTA_REFRESH_ERROR = 'quota_refresh_failed'
const DEFAULT_PERSONAL_RESERVE_PERCENT = 20
/** Frozen design reference from the phase-two prototype; it is not a live account balance. */
const CODEX_WEEKLY_SHAREABLE_ESTIMATED_API_COST_REFERENCE_MICROS = 5_960_000

export interface TeamSettingsInjected {
  t: (key: TeamSettingsKey, params?: Record<string, unknown>) => string
}

export interface TeamSettingsProps extends Partial<TeamSettingsInjected> {
  /** Suppress the standalone heading when rendered inside subscription-pool tabs. */
  readonly embedded?: boolean
}

interface InviteDraft {
  readonly expiresInMs: number
  readonly authorizationContext: string
}

interface InviteRevealRequest {
  readonly inviteId: string
  readonly authorizationContext: string
}

interface CreatedInviteSecret {
  readonly token: string
  readonly expiresAt: number
  readonly authorizationContext: string
}

interface TeamRefreshSnapshot {
  readonly status: TeamManagementStatus
  readonly overview: TeamManagementOverview
}

interface TeamConnectionIssue {
  readonly kind: 'invalid' | 'unavailable'
  readonly detail: string
}

interface ActiveBrowserAuthorization {
  readonly accountId: string
  readonly expiresAt: number
  readonly discardInitial: boolean
  readonly expectedContext: TeamManagementExpectedContext
  readonly returnSelection?: string
}

interface LocalCodexProfileSummary {
  readonly id: string
  readonly label: string
  readonly inUse: boolean
  readonly remainingPercent?: number
  readonly quotaError?: string
}

type SelectedAccount =
  | { readonly kind: 'contribution'; readonly account: TeamManagementContributionSummary }
  | { readonly kind: 'shared-directory'; readonly account: TeamManagementSharedAccountDirectoryEntry }
  | { readonly kind: 'local'; readonly account: LocalCodexProfileSummary }

interface RecentUsageTarget {
  readonly id: string
  readonly kind: 'contribution' | 'local'
  readonly label: string
}

interface PendingLocalAuthorization {
  readonly id: string
  readonly label: string
  readonly authorizationContext: string
  readonly expectedContext: TeamManagementExpectedContext
}

type TeamOAuthMethod = 'browser' | 'device_code'

function contributionSelectionKey(accountId: string): string {
  return `contribution:${accountId}`
}

function sharedDirectorySelectionKey(accountId: string): string {
  return `shared-directory:${accountId}`
}

function localSelectionKey(profileId: string): string {
  return `local:${profileId}`
}

function accountAliasLetter(index: number): string {
  let value = index + 1
  let result = ''
  while (value > 0) {
    value -= 1
    result = String.fromCharCode(65 + (value % 26)) + result
    value = Math.floor(value / 26)
  }
  return result
}

function parseLocalRemainingPercent(value: Record<string, unknown>): number | undefined {
  if (typeof value.usage !== 'object' || value.usage === null) return undefined
  const usage = value.usage as Record<string, unknown>
  if (!Array.isArray(usage.rateLimits)) return undefined
  const rateLimit = usage.rateLimits.find((candidate) => (
    typeof candidate === 'object'
    && candidate !== null
    && (candidate as Record<string, unknown>).id === 'codex'
  )) ?? usage.rateLimits[0]
  if (typeof rateLimit !== 'object' || rateLimit === null) return undefined
  const windows = (rateLimit as Record<string, unknown>).windows
  if (!Array.isArray(windows) || typeof windows[0] !== 'object' || windows[0] === null) return undefined
  const remainingPercent = (windows[0] as Record<string, unknown>).remainingPercent
  return typeof remainingPercent === 'number' && Number.isFinite(remainingPercent)
    ? Math.min(100, Math.max(0, remainingPercent))
    : undefined
}

function parseLocalProfiles(value: unknown): readonly LocalCodexProfileSummary[] {
  if (typeof value !== 'object' || value === null) return []
  const result = value as Record<string, unknown>
  if (result.status !== 'ready' || !Array.isArray(result.profiles)) return []
  return result.profiles.flatMap((profile): LocalCodexProfileSummary[] => {
    if (typeof profile !== 'object' || profile === null) return []
    const item = profile as Record<string, unknown>
    if (typeof item.id !== 'string' || typeof item.label !== 'string') return []
    const remainingPercent = parseLocalRemainingPercent(item)
    return [{
      id: item.id,
      label: item.label,
      inUse: item.inUse === true,
      ...(remainingPercent === undefined ? {} : { remainingPercent }),
      ...(typeof item.quotaError === 'string' ? { quotaError: item.quotaError } : {}),
    }]
  })
}

function isReadyLocalProfilesResponse(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const result = value as Record<string, unknown>
  return result.status === 'ready' && Array.isArray(result.profiles)
}

function mergeLocalProfileDirectory(
  current: readonly LocalCodexProfileSummary[],
  directory: readonly LocalCodexProfileSummary[],
): readonly LocalCodexProfileSummary[] {
  const currentById = new Map(current.map(profile => [profile.id, profile]))
  return directory.map((profile) => {
    const previous = currentById.get(profile.id)
    if (previous === undefined) return profile
    return {
      ...profile,
      ...(previous.remainingPercent === undefined ? {} : { remainingPercent: previous.remainingPercent }),
      ...(previous.quotaError === undefined ? {} : { quotaError: previous.quotaError }),
    }
  })
}

interface TeamStatusConfirmation {
  readonly targetStatus: 'active' | 'paused'
  readonly expectedLifecycleRevision: number
  readonly teamName: string
  readonly authorizationContext: string
}

type TeamStatusDisposition = 'connected' | 'unconnected' | 'terminal'
type DisplayNameMigrationAckState = 'pending' | 'failed'
type TeamWorkspaceView = 'usage' | 'members' | 'invitations'

interface ContributionProtectionEdit {
  readonly account: TeamManagementContributionSummary
  readonly reserve: string
  readonly requestCap: string
  readonly weeklyLimitUsd: string
  readonly models: string
}

type PendingTeamInvite = Extract<TeamManagementOverview, { readonly viewerRole: 'owner' }>['invites'][number]

type TeamSettingsDialogFocusTarget = 'dissolve' | 'invite' | 'invite-result' | 'invite-reveal' | 'invite-revoke' | 'leave' | 'remove' | 'team-status' | 'transfer'

function displayNameMigrationKey(
  overview: TeamManagementOverview,
  migrationVersion: number,
): string {
  return `${overview.team.id}\u0000${overview.currentMember.id}\u0000${migrationVersion}`
}

function hideAcknowledgedDisplayNameMigration(
  overview: TeamManagementOverview,
  acknowledgedKeys: ReadonlySet<string>,
): TeamManagementOverview {
  const notice = overview.displayNameMigrationNotice
  if (notice === undefined || !acknowledgedKeys.has(displayNameMigrationKey(overview, notice.migrationVersion))) {
    return overview
  }
  const nextOverview = { ...overview }
  delete nextOverview.displayNameMigrationNotice
  return nextOverview
}

function errorMessage(
  cause: unknown,
  fallback: string,
  authorizationNetworkUnavailable?: string,
  authorizationFailed?: string,
  localAccountAlreadyShared?: string,
  browserAuthorizationAlreadyPending?: string,
): string {
  const message = cause instanceof Error ? cause.message : fallback
  if (authorizationNetworkUnavailable !== undefined
    && message.includes(TEAM_AUTHORIZATION_NETWORK_UNAVAILABLE_CODE)
  ) return authorizationNetworkUnavailable
  if (authorizationFailed !== undefined
    && message.includes(TEAM_AUTHORIZATION_FAILED_CODE)
  ) return authorizationFailed
  if (localAccountAlreadyShared !== undefined
    && message.includes(TEAM_LOCAL_ACCOUNT_ALREADY_SHARED_CODE)
  ) return localAccountAlreadyShared
  if (browserAuthorizationAlreadyPending !== undefined
    && message.includes(TEAM_BROWSER_AUTHORIZATION_ALREADY_PENDING_CODE)
  ) return browserAuthorizationAlreadyPending
  return message
}

function browserAuthorizationFailureMessage(
  failureCode: string | undefined,
  t: TeamSettingsInjected['t'],
): string {
  if (failureCode === TEAM_AUTHORIZATION_NETWORK_UNAVAILABLE_CODE) return t('authorizationNetworkUnavailable')
  if (failureCode === TEAM_AUTHORIZATION_FAILED_CODE) return t('authorizationFailed')
  return t('browserAuthorizationEnded')
}

function errorStatus(cause: unknown): number | undefined {
  if (typeof cause !== 'object' || cause === null || !('status' in cause)) return undefined
  return typeof cause.status === 'number' ? cause.status : undefined
}

function isTeamContextMismatch(cause: unknown): boolean {
  return errorStatus(cause) === 409
    && cause instanceof Error
    && cause.message === TEAM_MANAGEMENT_CONTEXT_CHANGED_MESSAGE
}

function fallbackTranslate(key: TeamSettingsKey, params?: Record<string, unknown>): string {
  let value: string = en[key]
  for (const [name, replacement] of Object.entries(params ?? {})) {
    value = value.replaceAll(`{${name}}`, String(replacement))
  }
  return value
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function formatUsdMicros(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  const micros = typeof value === 'number' ? value : Number(value)
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .format(micros / 1_000_000)
}

function documentAllowsInviteSecret(): boolean {
  return typeof document !== 'undefined' && document.visibilityState !== 'hidden'
}

function createTeamAuthorizationContext(
  status: TeamManagementStatus | undefined,
  overview: TeamManagementOverview | undefined,
): string | undefined {
  const expectedContext = createTeamExpectedContext(status, overview)
  if (expectedContext === undefined) return undefined
  return `${expectedContext.serverOrigin}\u0000${expectedContext.teamId}\u0000${expectedContext.currentMemberId}\u0000${overview?.viewerRole ?? ''}`
}

function createTeamExpectedContext(
  status: TeamManagementStatus | undefined,
  overview: TeamManagementOverview | undefined,
): TeamManagementExpectedContext | undefined {
  if (
    overview === undefined
    || status?.enabled !== true
    || !status.keyConfigured
    || status.serverOrigin === undefined
  ) return undefined
  return {
    serverOrigin: status.serverOrigin,
    teamId: overview.team.id,
    currentMemberId: overview.currentMember.id,
  }
}

function isSameTeamExpectedContext(
  left: TeamManagementExpectedContext | undefined,
  right: TeamManagementExpectedContext | undefined,
): boolean {
  return left !== undefined
    && right !== undefined
    && left.serverOrigin === right.serverOrigin
    && left.teamId === right.teamId
    && left.currentMemberId === right.currentMemberId
}

function reconcileCancelledBrowserAuthorization(
  overview: TeamManagementOverview,
  account: TeamManagementContributionSummary,
): TeamManagementOverview {
  const existingIndex = overview.contributions.findIndex(item => item.id === account.id)
  const contributions = account.status === 'revoked'
    ? overview.contributions.filter(item => item.id !== account.id)
    : existingIndex < 0
      ? [...overview.contributions, account]
      : overview.contributions.map(item => item.id === account.id ? account : item)
  const activeSharedAccounts = account.status === 'active'
    ? overview.activeSharedAccounts.some(item => item.id === account.id)
      ? overview.activeSharedAccounts.map(item => item.id === account.id
          ? { id: account.id, ownerMemberId: account.ownerMemberId, label: account.label, status: 'active' as const }
          : item)
      : [
          ...overview.activeSharedAccounts,
          { id: account.id, ownerMemberId: account.ownerMemberId, label: account.label, status: 'active' as const },
        ]
    : overview.activeSharedAccounts.filter(item => item.id !== account.id)
  const nextOverview = {
    ...overview,
    contributions,
    activeSharedAccounts,
  }
  if (overview.pendingBrowserAuthorization?.accountId !== account.id) return nextOverview
  const { pendingBrowserAuthorization: _pendingBrowserAuthorization, ...withoutPendingAuthorization } = nextOverview
  return withoutPendingAuthorization
}

function createOwnerAuthorizationContext(
  status: TeamManagementStatus | undefined,
  overview: TeamManagementOverview | undefined,
): string | undefined {
  return overview?.viewerRole === 'owner' ? createTeamAuthorizationContext(status, overview) : undefined
}

function createMemberAuthorizationContext(
  status: TeamManagementStatus | undefined,
  overview: TeamManagementOverview | undefined,
): string | undefined {
  return overview?.viewerRole === 'member' ? createTeamAuthorizationContext(status, overview) : undefined
}

function useInviteSecretLifecycle({ active, secretVisible, onClear }: {
  readonly active: boolean
  readonly secretVisible: boolean
  readonly onClear: () => void
}) {
  useEffect(() => {
    if (!secretVisible) return
    const timer = globalThis.setTimeout(onClear, INVITE_SECRET_VISIBLE_MS)
    return () => { globalThis.clearTimeout(timer) }
  }, [onClear, secretVisible])

  useEffect(() => {
    if (!active) return
    const clearWhenHidden = () => {
      if (document.visibilityState === 'hidden') onClear()
    }
    clearWhenHidden()
    document.addEventListener('visibilitychange', clearWhenHidden)
    return () => { document.removeEventListener('visibilitychange', clearWhenHidden) }
  }, [active, onClear])
}

function InviteRevealModal({ inviteId, authorizationContext, getAuthorizationContext, getExpectedContext, t, onClose, onFailure }: {
  readonly inviteId: string
  readonly authorizationContext: string
  readonly getAuthorizationContext: () => string | undefined
  readonly getExpectedContext: () => TeamManagementExpectedContext | undefined
  readonly t: TeamSettingsInjected['t']
  readonly onClose: () => void
  readonly onFailure: (cause: unknown) => void
}) {
  const [secret, setSecret] = useState<TeamManagementInviteRevealResult>()
  const [error, setError] = useState<string>()
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let active = true
    const expectedContext = getExpectedContext()
    if (expectedContext === undefined || getAuthorizationContext() !== authorizationContext) {
      onClose()
      return () => { active = false }
    }
    void api.revealInvite(inviteId, expectedContext).then(result => {
      if (!active) return
      if (!documentAllowsInviteSecret() || getAuthorizationContext() !== authorizationContext) {
        onClose()
        return
      }
      setSecret(result)
    }).catch((cause: unknown) => {
      if (!active) return
      setError(errorMessage(
        cause,
        t('requestFailed'),
        t('authorizationNetworkUnavailable'),
        t('authorizationFailed'),
      ))
      onFailure(cause)
    })
    return () => { active = false }
  }, [authorizationContext, getAuthorizationContext, getExpectedContext, inviteId, onClose, onFailure, t])

  useEffect(() => {
    if (secret === undefined) return
    document.querySelector<HTMLElement>('[data-team-dialog-focus="invite-reveal"]')?.focus()
  }, [secret])

  useInviteSecretLifecycle({ active: true, secretVisible: secret !== undefined, onClear: onClose })

  const visibleSecret = documentAllowsInviteSecret() && getAuthorizationContext() === authorizationContext
    ? secret
    : undefined

  return (
    <Modal
      open
      onClose={onClose}
      title={t('inviteRevealed')}
      closeLabel={t('close')}
      {...visibleSecret === undefined ? {} : { description: t('inviteRevealedHint', { time: formatTime(visibleSecret.expiresAt) }) }}
      footer={<Button variant="primary" onClick={onClose}>{t('close')}</Button>}
    >
      {error === undefined ? null : <Notice tone="error" title={t('requestFailed')} detail={error} />}
      {visibleSecret === undefined ? (
        error === undefined ? <p className={styles.hint}>{t('working')}</p> : null
      ) : (
        <div className={styles.modalBody}>
          <p className={styles.dangerNote}>{t('inviteCredentialWarning')}</p>
          <div className={styles.secretValue}>
            <span className={styles.code} data-team-dialog-focus="invite-reveal" tabIndex={-1}>{visibleSecret.inviteToken}</span>
            <Button size="sm" variant="ghost" icon={<IconCopyOutline16 />} onClick={() => {
              void writeClipboard(visibleSecret.inviteToken).then(success => { if (success) setCopied(true) })
            }}>{copied ? t('copied') : t('copyInvite')}</Button>
          </div>
        </div>
      )}
    </Modal>
  )
}

export function TeamSettings({ t = fallbackTranslate, embedded = false }: TeamSettingsProps) {
  const [status, setStatus] = useState<TeamManagementStatus>()
  const [overview, setOverview] = useState<TeamManagementOverview>()
  const [usageProjection, setUsageProjection] = useState<TeamManagementUsageResult>()
  const [usageLoading, setUsageLoading] = useState(false)
  const [usageUnavailable, setUsageUnavailable] = useState(false)
  const [localProfiles, setLocalProfiles] = useState<readonly LocalCodexProfileSummary[]>([])
  const [localProfilesLoading, setLocalProfilesLoading] = useState(true)
  const [localProfilesQuotaLoading, setLocalProfilesQuotaLoading] = useState(false)
  const [localProfilesUnavailable, setLocalProfilesUnavailable] = useState(false)
  const [selectedAccountId, setSelectedAccountId] = useState<string>()
  const overviewRequestId = useRef(0)
  const usageRequestId = useRef(0)
  const localProfileDirectoryRequestId = useRef(0)
  const localProfileQuotaRequestId = useRef(0)
  const localProfileDirectoryReady = useRef(false)
  const acknowledgedDisplayNameMigrationKeys = useRef(new Set<string>())
  const pendingDisplayNameMigrationAckKeys = useRef(new Set<string>())
  const [displayNameMigrationAckStates, setDisplayNameMigrationAckStates] = useState<ReadonlyMap<string, DisplayNameMigrationAckState>>(
    () => new Map(),
  )
  const [loading, setLoading] = useState(true)
  const [authorizationSnapshotReady, setAuthorizationSnapshotReady] = useState(false)
  const [authorizationSnapshotPending, setAuthorizationSnapshotPending] = useState(false)
  const [error, setError] = useState<string>()
  const [connectionIssue, setConnectionIssue] = useState<TeamConnectionIssue>()
  const [busy, setBusy] = useState<string>()
  const [displayName, setDisplayName] = useState('')
  const [inviteToken, setInviteToken] = useState('')
  const [invitePreview, setInvitePreview] = useState<TeamManagementInvitePreview>()
  const previewRequestId = useRef(0)
  const [inviteResult, setInviteResult] = useState<CreatedInviteSecret>()
  const [inviteDraft, setInviteDraft] = useState<InviteDraft>()
  const [inviteRevealRequest, setInviteRevealRequest] = useState<InviteRevealRequest>()
  const [copied, setCopied] = useState(false)
  const [revokeInvite, setRevokeInvite] = useState<PendingTeamInvite>()
  const [revokeInviteAuthorizationContext, setRevokeInviteAuthorizationContext] = useState<string>()
  const [ownershipTransferOpen, setOwnershipTransferOpen] = useState(false)
  const [ownershipTransferAuthorizationContext, setOwnershipTransferAuthorizationContext] = useState<string>()
  const [ownershipTransferTargetId, setOwnershipTransferTargetId] = useState('')
  const [removeMember, setRemoveMember] = useState<TeamManagementMemberSummary>()
  const [removeMemberAuthorizationContext, setRemoveMemberAuthorizationContext] = useState<string>()
  const [memberMenuId, setMemberMenuId] = useState<string>()
  const [teamStatusConfirmation, setTeamStatusConfirmation] = useState<TeamStatusConfirmation>()
  const [dissolution, setDissolution] = useState<TeamDissolutionView>()
  const [connectionTerminal, setConnectionTerminal] = useState<TeamConnectionTerminalView>()
  const [dissolutionOpen, setDissolutionOpen] = useState(false)
  const [dissolutionAuthorizationContext, setDissolutionAuthorizationContext] = useState<string>()
  const [dissolutionConfirmationName, setDissolutionConfirmationName] = useState('')
  const [leaveOpen, setLeaveOpen] = useState(false)
  const [leaveAuthorizationContext, setLeaveAuthorizationContext] = useState<string>()
  const [teamSettingsOpen, setTeamSettingsOpen] = useState(false)
  const [workspaceView, setWorkspaceView] = useState<TeamWorkspaceView>('usage')
  const [addAccountOpen, setAddAccountOpen] = useState(false)
  const [accountLabel, setAccountLabel] = useState('')
  const [pendingLocalAuthorization, setPendingLocalAuthorization] = useState<PendingLocalAuthorization>()
  const [teamContextChanged, setTeamContextChanged] = useState(false)
  const [oauth, setOAuth] = useState<TeamManagementOAuthResult>()
  const [oauthDiscardInitial, setOAuthDiscardInitial] = useState(false)
  const [oauthNavigationBlocked, setOAuthNavigationBlocked] = useState(false)
  const [oauthRefreshUnavailable, setOAuthRefreshUnavailable] = useState(false)
  const [overviewSnapshotRequestId, setOverviewSnapshotRequestId] = useState(0)
  const [protectionEdit, setProtectionEdit] = useState<ContributionProtectionEdit>()
  const [recentUsageAccount, setRecentUsageAccount] = useState<RecentUsageTarget>()
  const [teamMenuOpen, setTeamMenuOpen] = useState(false)
  const teamSettingsTriggerRef = useRef<HTMLButtonElement>(null)
  const workspaceBackRef = useRef<HTMLButtonElement>(null)
  const restoreTeamSettingsTriggerFocus = useRef(false)
  const inviteCreationPresentationId = useRef(0)
  const teamExpectedContextRef = useRef<TeamManagementExpectedContext | undefined>(undefined)
  const ownerExpectedContextRef = useRef<TeamManagementExpectedContext | undefined>(undefined)
  const memberExpectedContextRef = useRef<TeamManagementExpectedContext | undefined>(undefined)
  const ownerAuthorizationContextRef = useRef<string | undefined>(undefined)
  const memberAuthorizationContextRef = useRef<string | undefined>(undefined)
  const teamSettingsReturnFocus = useRef<string | undefined>(undefined)
  const oauthPopup = useRef<AuthorizationPopupController | null>(null)
  const oauthStartLocked = useRef(false)
  const oauthTransitionLocked = useRef(false)
  const oauthPresentationActive = useRef(false)
  const oauthReturnSelection = useRef<string | undefined>(undefined)
  const oauthExpectedContext = useRef<TeamManagementExpectedContext | undefined>(undefined)
  const oauthPresentedAfterRequestId = useRef(0)
  const pendingBrowserAuthorizationActive = useRef(false)
  const recoveredBrowserAuthorization = useRef<ActiveBrowserAuthorization | undefined>(undefined)
  const oauthOperationEpoch = useRef(0)
  const mounted = useRef(true)

  const isCurrentOAuthOperation = useCallback((epoch: number) => (
    mounted.current && oauthOperationEpoch.current === epoch
  ), [])

  const clearOAuthPresentation = useCallback(() => {
    oauthPopup.current?.close()
    oauthPopup.current = null
    oauthPresentationActive.current = false
    oauthReturnSelection.current = undefined
    oauthExpectedContext.current = undefined
    oauthPresentedAfterRequestId.current = 0
    recoveredBrowserAuthorization.current = undefined
    setOAuth(undefined)
    setOAuthDiscardInitial(false)
    setOAuthNavigationBlocked(false)
    setOAuthRefreshUnavailable(false)
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      oauthOperationEpoch.current += 1
      oauthStartLocked.current = false
      oauthTransitionLocked.current = false
      oauthPresentationActive.current = false
      oauthReturnSelection.current = undefined
      oauthExpectedContext.current = undefined
      oauthPresentedAfterRequestId.current = 0
      pendingBrowserAuthorizationActive.current = false
      recoveredBrowserAuthorization.current = undefined
      oauthPopup.current?.close()
      oauthPopup.current = null
    }
  }, [])

  const refreshLocalProfileQuota = useCallback(async () => {
    const requestId = ++localProfileQuotaRequestId.current
    setLocalProfilesQuotaLoading(true)
    try {
      const response = await fetch(LOCAL_PROFILES_PATH, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      if (!response.ok) throw new Error(`Local Codex profiles request failed (${response.status})`)
      const payload: unknown = await response.json()
      if (!isReadyLocalProfilesResponse(payload)) throw new Error(LOCAL_QUOTA_REFRESH_ERROR)
      const refreshedProfiles = parseLocalProfiles(payload)
      if (requestId !== localProfileQuotaRequestId.current) return
      const refreshedById = new Map(refreshedProfiles.map(profile => [profile.id, profile]))
      setLocalProfiles(current => current.map(profile => refreshedById.get(profile.id) ?? profile))
    } catch {
      if (requestId !== localProfileQuotaRequestId.current) return
      // Keep transport details out of the Browser UI while making the failed
      // refresh visible. Any settled quota remains available as a stale value.
      setLocalProfiles(current => current.map(profile => ({
        ...profile,
        quotaError: LOCAL_QUOTA_REFRESH_ERROR,
      })))
    } finally {
      if (requestId === localProfileQuotaRequestId.current) setLocalProfilesQuotaLoading(false)
    }
  }, [])

  const refreshLocalProfiles = useCallback(async () => {
    const requestId = ++localProfileDirectoryRequestId.current
    const showInitialLoading = !localProfileDirectoryReady.current
    if (showInitialLoading) {
      setLocalProfilesLoading(true)
      setLocalProfilesUnavailable(false)
    }
    try {
      const response = await fetch(LOCAL_PROFILE_DIRECTORY_PATH, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      if (!response.ok) throw new Error(`Local Codex profile directory request failed (${response.status})`)
      const profiles = parseLocalProfiles(await response.json())
      if (requestId !== localProfileDirectoryRequestId.current) return
      localProfileDirectoryReady.current = true
      setLocalProfiles(current => mergeLocalProfileDirectory(current, profiles))
      setLocalProfilesUnavailable(false)
      void refreshLocalProfileQuota()
    } catch {
      if (requestId !== localProfileDirectoryRequestId.current) return
      setLocalProfilesUnavailable(true)
    } finally {
      if (requestId === localProfileDirectoryRequestId.current) setLocalProfilesLoading(false)
    }
  }, [refreshLocalProfileQuota])
  const teamExpectedContext = authorizationSnapshotReady
    ? createTeamExpectedContext(status, overview)
    : undefined
  const teamAuthorizationContext = authorizationSnapshotReady
    ? createTeamAuthorizationContext(status, overview)
    : undefined
  const ownerExpectedContext = overview?.viewerRole === 'owner' ? teamExpectedContext : undefined
  const memberExpectedContext = overview?.viewerRole === 'member' ? teamExpectedContext : undefined
  const ownerAuthorizationContext = authorizationSnapshotReady
    ? createOwnerAuthorizationContext(status, overview)
    : undefined
  const memberAuthorizationContext = authorizationSnapshotReady
    ? createMemberAuthorizationContext(status, overview)
    : undefined
  const projectedBrowserAuthorization = overview?.pendingBrowserAuthorization
  const activeBrowserAuthorization: ActiveBrowserAuthorization | undefined = oauth?.method === 'browser'
    && oauthExpectedContext.current !== undefined
    ? {
        accountId: oauth.account.id,
        expiresAt: oauth.expiresAt,
        discardInitial: oauthDiscardInitial,
        expectedContext: oauthExpectedContext.current,
        ...(oauthReturnSelection.current === undefined ? {} : { returnSelection: oauthReturnSelection.current }),
      }
    : projectedBrowserAuthorization !== undefined
      && (teamExpectedContext ?? teamExpectedContextRef.current) !== undefined
      ? {
          ...projectedBrowserAuthorization,
          expectedContext: (teamExpectedContext ?? teamExpectedContextRef.current) as TeamManagementExpectedContext,
        }
      : undefined
  const activePendingLocalAuthorization = pendingLocalAuthorization !== undefined
    && (authorizationSnapshotPending
      || pendingLocalAuthorization.authorizationContext === teamAuthorizationContext)
    ? pendingLocalAuthorization
    : undefined
  const activePendingLocalProfile = activePendingLocalAuthorization === undefined
    ? undefined
    : localProfiles.find(profile => profile.id === activePendingLocalAuthorization.id)
  const activeInviteDraft = inviteDraft !== undefined
    && (authorizationSnapshotPending || inviteDraft.authorizationContext === ownerAuthorizationContext)
    ? inviteDraft
    : undefined
  const activeInviteRevealRequest = teamSettingsOpen
    && inviteRevealRequest?.authorizationContext === ownerAuthorizationContext
    ? inviteRevealRequest
    : undefined
  const visibleInviteResult = documentAllowsInviteSecret()
    && inviteResult?.authorizationContext === ownerAuthorizationContext
    ? inviteResult
    : undefined
  const activeRevokeInvite = revokeInvite !== undefined
    && revokeInviteAuthorizationContext !== undefined
    && (authorizationSnapshotPending || revokeInviteAuthorizationContext === ownerAuthorizationContext)
    && overview?.viewerRole === 'owner'
    && overview.invites.some(invite => invite.id === revokeInvite.id
      && invite.status === 'pending'
      && invite.expiresAt > Date.now())
    ? revokeInvite
    : undefined
  const activeTeamStatusConfirmation = teamStatusConfirmation !== undefined
    && (authorizationSnapshotPending || teamStatusConfirmation.authorizationContext === ownerAuthorizationContext)
    && overview?.team.name === teamStatusConfirmation.teamName
    && overview.team.lifecycleRevision === teamStatusConfirmation.expectedLifecycleRevision
    ? teamStatusConfirmation
    : undefined
  const activeDissolutionOpen = dissolutionOpen
    && dissolutionAuthorizationContext !== undefined
    && (authorizationSnapshotPending || dissolutionAuthorizationContext === ownerAuthorizationContext)
  const activeOwnershipTransferOpen = ownershipTransferOpen
    && ownershipTransferAuthorizationContext !== undefined
    && (authorizationSnapshotPending || ownershipTransferAuthorizationContext === ownerAuthorizationContext)
  const activeRemoveMember = removeMember !== undefined
    && removeMemberAuthorizationContext !== undefined
    && (authorizationSnapshotPending || removeMemberAuthorizationContext === ownerAuthorizationContext)
    ? overview?.members.find(member => member.id === removeMember.id
      && member.status === 'active'
      && member.role === 'member')
    : undefined
  const activeLeaveOpen = leaveOpen
    && leaveAuthorizationContext !== undefined
    && (authorizationSnapshotPending || leaveAuthorizationContext === memberAuthorizationContext)
  const closeInviteDraft = useCallback(() => {
    inviteCreationPresentationId.current += 1
    setInviteDraft(undefined)
    setTeamSettingsOpen(true)
  }, [])
  const closeInviteResult = useCallback(() => {
    setInviteResult(undefined)
    setCopied(false)
    setTeamSettingsOpen(true)
  }, [])
  useInviteSecretLifecycle({
    active: inviteResult !== undefined,
    secretVisible: inviteResult !== undefined,
    onClear: closeInviteResult,
  })
  const childDialogFocusTarget: TeamSettingsDialogFocusTarget | undefined = activeInviteDraft !== undefined
    ? 'invite'
    : visibleInviteResult !== undefined
      ? 'invite-result'
      : activeInviteRevealRequest !== undefined
        ? 'invite-reveal'
        : activeRevokeInvite !== undefined
          ? 'invite-revoke'
          : activeDissolutionOpen
            ? 'dissolve'
            : activeTeamStatusConfirmation !== undefined
              ? 'team-status'
              : activeOwnershipTransferOpen
                ? 'transfer'
                : activeRemoveMember !== undefined
                  ? 'remove'
                  : activeLeaveOpen
                    ? 'leave'
                    : undefined

  useEffect(() => {
    if (childDialogFocusTarget === undefined) return
    document.querySelector<HTMLElement>(`[data-team-dialog-focus="${childDialogFocusTarget}"]`)?.focus()
  }, [childDialogFocusTarget])

  useEffect(() => {
    if (teamExpectedContext !== undefined || !authorizationSnapshotPending) {
      teamExpectedContextRef.current = teamExpectedContext
    }
  }, [authorizationSnapshotPending, teamExpectedContext])

  useEffect(() => {
    if (ownerExpectedContext !== undefined || !authorizationSnapshotPending) {
      ownerExpectedContextRef.current = ownerExpectedContext
    }
  }, [authorizationSnapshotPending, ownerExpectedContext])

  useEffect(() => {
    if (memberExpectedContext !== undefined || !authorizationSnapshotPending) {
      memberExpectedContextRef.current = memberExpectedContext
    }
  }, [authorizationSnapshotPending, memberExpectedContext])

  useEffect(() => {
    if (ownerAuthorizationContext !== undefined || !authorizationSnapshotPending) {
      ownerAuthorizationContextRef.current = ownerAuthorizationContext
    }
  }, [authorizationSnapshotPending, ownerAuthorizationContext])

  useEffect(() => {
    if (memberAuthorizationContext !== undefined || !authorizationSnapshotPending) {
      memberAuthorizationContextRef.current = memberAuthorizationContext
    }
  }, [authorizationSnapshotPending, memberAuthorizationContext])

  useEffect(() => {
    if (!authorizationSnapshotPending && inviteDraft !== undefined && activeInviteDraft === undefined) closeInviteDraft()
  }, [activeInviteDraft, authorizationSnapshotPending, closeInviteDraft, inviteDraft])

  useEffect(() => {
    if (
      !authorizationSnapshotPending
      && pendingLocalAuthorization !== undefined
      && activePendingLocalAuthorization === undefined
    ) setPendingLocalAuthorization(undefined)
  }, [activePendingLocalAuthorization, authorizationSnapshotPending, pendingLocalAuthorization])

  useEffect(() => {
    if (!authorizationSnapshotPending && revokeInvite !== undefined && activeRevokeInvite === undefined) {
      setRevokeInvite(undefined)
      setRevokeInviteAuthorizationContext(undefined)
      setTeamSettingsOpen(true)
    }
  }, [activeRevokeInvite, authorizationSnapshotPending, revokeInvite])

  useEffect(() => {
    if (!authorizationSnapshotPending && teamStatusConfirmation !== undefined && activeTeamStatusConfirmation === undefined) {
      setTeamStatusConfirmation(undefined)
      setTeamSettingsOpen(true)
    }
  }, [activeTeamStatusConfirmation, authorizationSnapshotPending, teamStatusConfirmation])

  useEffect(() => {
    if (!authorizationSnapshotPending && dissolutionOpen && !activeDissolutionOpen) {
      setDissolutionOpen(false)
      setDissolutionAuthorizationContext(undefined)
      setDissolutionConfirmationName('')
      setTeamSettingsOpen(true)
    }
  }, [activeDissolutionOpen, authorizationSnapshotPending, dissolutionOpen])

  useEffect(() => {
    if (!authorizationSnapshotPending && ownershipTransferOpen && !activeOwnershipTransferOpen) {
      setOwnershipTransferOpen(false)
      setOwnershipTransferAuthorizationContext(undefined)
      setOwnershipTransferTargetId('')
      setTeamSettingsOpen(true)
    }
  }, [activeOwnershipTransferOpen, authorizationSnapshotPending, ownershipTransferOpen])

  useEffect(() => {
    if (!authorizationSnapshotPending && removeMember !== undefined && activeRemoveMember === undefined) {
      setRemoveMember(undefined)
      setRemoveMemberAuthorizationContext(undefined)
      setTeamSettingsOpen(true)
    }
  }, [activeRemoveMember, authorizationSnapshotPending, removeMember])

  useEffect(() => {
    if (!authorizationSnapshotPending && leaveOpen && !activeLeaveOpen) {
      setLeaveOpen(false)
      setLeaveAuthorizationContext(undefined)
      setTeamSettingsOpen(true)
    }
  }, [activeLeaveOpen, authorizationSnapshotPending, leaveOpen])

  useEffect(() => {
    if (childDialogFocusTarget === undefined) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previousOverflow }
  }, [childDialogFocusTarget])

  useEffect(() => {
    const focusTarget = teamSettingsReturnFocus.current
    if (!teamSettingsOpen || childDialogFocusTarget !== undefined || focusTarget === undefined) return
    const target = Array.from(document.querySelectorAll<HTMLElement>('[data-team-settings-focus]'))
      .find(element => element.dataset.teamSettingsFocus === focusTarget)
    target?.focus()
    teamSettingsReturnFocus.current = undefined
  }, [childDialogFocusTarget, teamSettingsOpen])

  const clearUsage = useCallback(() => {
    usageRequestId.current += 1
    setUsageProjection(undefined)
    setUsageLoading(false)
    setUsageUnavailable(false)
  }, [])

  const clearTeamProjection = useCallback(() => {
    oauthOperationEpoch.current += 1
    oauthStartLocked.current = false
    oauthTransitionLocked.current = false
    pendingBrowserAuthorizationActive.current = false
    clearOAuthPresentation()
    teamExpectedContextRef.current = undefined
    ownerExpectedContextRef.current = undefined
    memberExpectedContextRef.current = undefined
    ownerAuthorizationContextRef.current = undefined
    memberAuthorizationContextRef.current = undefined
    setAuthorizationSnapshotReady(false)
    setAuthorizationSnapshotPending(false)
    setOverviewSnapshotRequestId(0)
    inviteCreationPresentationId.current += 1
    setOverview(undefined)
    clearUsage()
    setConnectionIssue(undefined)
    setInviteResult(undefined)
    setInviteDraft(undefined)
    setInviteRevealRequest(undefined)
    setCopied(false)
    setRevokeInvite(undefined)
    setRevokeInviteAuthorizationContext(undefined)
    setOwnershipTransferOpen(false)
    setOwnershipTransferAuthorizationContext(undefined)
    setOwnershipTransferTargetId('')
    setRemoveMember(undefined)
    setRemoveMemberAuthorizationContext(undefined)
    setMemberMenuId(undefined)
    setTeamStatusConfirmation(undefined)
    setDissolutionOpen(false)
    setDissolutionAuthorizationContext(undefined)
    setLeaveOpen(false)
    setLeaveAuthorizationContext(undefined)
    setTeamSettingsOpen(false)
    setWorkspaceView('usage')
    setTeamMenuOpen(false)
    previewRequestId.current += 1
    setInvitePreview(undefined)
  }, [clearOAuthPresentation, clearUsage])

  const applyManagementStatus = useCallback((nextStatus: TeamManagementStatus): TeamStatusDisposition => {
    setStatus(nextStatus)
    setDissolution(nextStatus.dissolution)
    setConnectionTerminal(nextStatus.connectionTerminal)
    if (nextStatus.dissolution !== undefined || nextStatus.connectionTerminal !== undefined) {
      clearTeamProjection()
      setError(undefined)
      return 'terminal'
    }
    if (!nextStatus.enabled || !nextStatus.keyConfigured) {
      clearTeamProjection()
      setError(undefined)
      return 'unconnected'
    }
    return 'connected'
  }, [clearTeamProjection])

  const refreshStatusOnly = useCallback(async (): Promise<TeamStatusDisposition> => {
    setAuthorizationSnapshotPending(true)
    setAuthorizationSnapshotReady(false)
    try {
      return applyManagementStatus(await api.status())
    } finally {
      setAuthorizationSnapshotPending(false)
    }
  }, [applyManagementStatus])

  const refreshUsage = useCallback(async () => {
    const requestId = ++usageRequestId.current
    setUsageLoading(true)
    setUsageUnavailable(false)
    try {
      const nextUsage = await api.usage()
      if (requestId !== usageRequestId.current) return
      setUsageProjection(nextUsage)
    } catch (cause: unknown) {
      if (requestId !== usageRequestId.current) return
      if (errorStatus(cause) === 410) {
        try {
          if (await refreshStatusOnly() !== 'connected') return
        } catch {
          // Fall through to the ordinary unavailable state when status cannot be refreshed.
        }
      }
      if (requestId !== usageRequestId.current) return
      setUsageProjection(undefined)
      setUsageUnavailable(true)
    } finally {
      if (requestId === usageRequestId.current) setUsageLoading(false)
    }
  }, [refreshStatusOnly])

  const refresh = useCallback(async (showLoading = false): Promise<TeamRefreshSnapshot | undefined> => {
    const requestId = ++overviewRequestId.current
    setAuthorizationSnapshotPending(true)
    setAuthorizationSnapshotReady(false)
    if (showLoading) setLoading(true)
    try {
      const nextStatus = await api.status()
      if (requestId !== overviewRequestId.current) return
      if (applyManagementStatus(nextStatus) !== 'connected') return
      let projectedOverview: TeamManagementOverview | undefined
      try {
        const nextOverview = await api.overview()
        if (requestId !== overviewRequestId.current) return
        projectedOverview = hideAcknowledgedDisplayNameMigration(
          nextOverview,
          acknowledgedDisplayNameMigrationKeys.current,
        )
        const nextExpectedContext = createTeamExpectedContext(nextStatus, projectedOverview)
        teamExpectedContextRef.current = nextExpectedContext
        ownerExpectedContextRef.current = projectedOverview.viewerRole === 'owner' ? nextExpectedContext : undefined
        memberExpectedContextRef.current = projectedOverview.viewerRole === 'member' ? nextExpectedContext : undefined
        ownerAuthorizationContextRef.current = createOwnerAuthorizationContext(nextStatus, projectedOverview)
        memberAuthorizationContextRef.current = createMemberAuthorizationContext(nextStatus, projectedOverview)
        pendingBrowserAuthorizationActive.current = projectedOverview.pendingBrowserAuthorization !== undefined
        setOverview(projectedOverview)
        setOverviewSnapshotRequestId(requestId)
        setAuthorizationSnapshotReady(true)
        setAuthorizationSnapshotPending(false)
        setOAuthRefreshUnavailable(false)
        setConnectionIssue(undefined)
      } catch (cause: unknown) {
        if (requestId !== overviewRequestId.current) return
        const remoteStatus = errorStatus(cause)
        if (remoteStatus === 410) {
          try {
            const nextStatus = await api.status()
            if (requestId !== overviewRequestId.current) return
            if (applyManagementStatus(nextStatus) !== 'connected') return
          } catch {
            // Preserve the original overview failure below.
          }
        }
        if (requestId !== overviewRequestId.current) return
        if (oauthPresentationActive.current || pendingBrowserAuthorizationActive.current) {
          setAuthorizationSnapshotReady(true)
          setAuthorizationSnapshotPending(false)
          setOAuthRefreshUnavailable(true)
          setConnectionIssue(undefined)
          setError(undefined)
          return
        }
        teamExpectedContextRef.current = undefined
        ownerExpectedContextRef.current = undefined
        memberExpectedContextRef.current = undefined
        ownerAuthorizationContextRef.current = undefined
        memberAuthorizationContextRef.current = undefined
        pendingBrowserAuthorizationActive.current = false
        setAuthorizationSnapshotReady(false)
        setOverview(undefined)
        setAuthorizationSnapshotPending(false)
        clearUsage()
        setConnectionIssue({
          kind: remoteStatus === 401 || remoteStatus === 404 ? 'invalid' : 'unavailable',
          detail: errorMessage(cause, t('requestFailed')),
        })
        setError(undefined)
        return
      }
      if (requestId !== overviewRequestId.current) return
      if (projectedOverview === undefined) return
      setError(undefined)
      await refreshUsage()
      return { status: nextStatus, overview: projectedOverview }
    } catch (cause: unknown) {
      if (requestId !== overviewRequestId.current) return
      setAuthorizationSnapshotPending(false)
      if (oauthPresentationActive.current || pendingBrowserAuthorizationActive.current) {
        setAuthorizationSnapshotReady(true)
        setOAuthRefreshUnavailable(true)
        setConnectionIssue(undefined)
        setError(undefined)
        return
      }
      teamExpectedContextRef.current = undefined
      ownerExpectedContextRef.current = undefined
      memberExpectedContextRef.current = undefined
      ownerAuthorizationContextRef.current = undefined
      memberAuthorizationContextRef.current = undefined
      setAuthorizationSnapshotReady(false)
      setError(errorMessage(cause, t('requestFailed')))
    } finally {
      if (requestId === overviewRequestId.current) setLoading(false)
    }
  }, [applyManagementStatus, clearUsage, refreshUsage, t])

  useEffect(() => { void refresh(true) }, [refresh])

  useEffect(() => {
    void refreshLocalProfiles()
    const timer = globalThis.setInterval(() => { void refreshLocalProfiles() }, USAGE_REFRESH_MS)
    return () => { globalThis.clearInterval(timer) }
  }, [refreshLocalProfiles])

  const hasAuthorizingAccount = overview?.contributions.some(account => account.status === 'authorizing') ?? false
  const shouldPollBrowserAuthorization = hasAuthorizingAccount || activeBrowserAuthorization !== undefined
  useEffect(() => {
    if (!shouldPollBrowserAuthorization) return
    let disposed = false
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined
    const poll = async () => {
      await refresh(false)
      if (!disposed) timer = globalThis.setTimeout(() => { void poll() }, AUTHORIZATION_POLL_MS)
    }
    timer = globalThis.setTimeout(() => { void poll() }, AUTHORIZATION_POLL_MS)
    return () => {
      disposed = true
      if (timer !== undefined) globalThis.clearTimeout(timer)
    }
  }, [refresh, shouldPollBrowserAuthorization])

  useEffect(() => {
    if (
      oauth === undefined
      || overview === undefined
      || overviewSnapshotRequestId <= oauthPresentedAfterRequestId.current
      || oauthTransitionLocked.current
    ) return
    const expectedContext = oauthExpectedContext.current
    const actualContext = createTeamExpectedContext(status, overview)
    const returnSelection = oauthReturnSelection.current
    if (!isSameTeamExpectedContext(expectedContext, actualContext)) {
      if (returnSelection !== undefined) setSelectedAccountId(returnSelection)
      clearOAuthPresentation()
      setTeamContextChanged(true)
      return
    }
    const account = overview.contributions.find(item => item.id === oauth.account.id)
    if (account?.status === 'authorizing') return
    if (account?.status === 'active') {
      setSelectedAccountId(contributionSelectionKey(account.id))
    } else if (returnSelection !== undefined) {
      setSelectedAccountId(returnSelection)
    }
    clearOAuthPresentation()
    if (account?.status !== 'active') {
      setError(browserAuthorizationFailureMessage(account?.lastError, t))
    }
  }, [clearOAuthPresentation, oauth, overview, overviewSnapshotRequestId, status, t])

  useEffect(() => {
    if (oauth !== undefined || overview === undefined || oauthTransitionLocked.current) return
    const actualContext = createTeamExpectedContext(status, overview)
    if (projectedBrowserAuthorization !== undefined) {
      if (actualContext !== undefined) {
        recoveredBrowserAuthorization.current = {
          ...projectedBrowserAuthorization,
          expectedContext: actualContext,
        }
      }
      return
    }
    const recovered = recoveredBrowserAuthorization.current
    if (recovered === undefined) return
    const account = overview.contributions.find(item => item.id === recovered.accountId)
    if (account?.status === 'authorizing') return
    recoveredBrowserAuthorization.current = undefined
    if (!isSameTeamExpectedContext(recovered.expectedContext, actualContext)) {
      setTeamContextChanged(true)
      return
    }
    if (account?.status === 'active') {
      setSelectedAccountId(contributionSelectionKey(account.id))
      return
    }
    setError(browserAuthorizationFailureMessage(account?.lastError, t))
  }, [oauth, overview, projectedBrowserAuthorization, status, t])

  useEffect(() => {
    if (overview === undefined) return
    const timer = globalThis.setInterval(() => { void refreshUsage() }, USAGE_REFRESH_MS)
    return () => { globalThis.clearInterval(timer) }
  }, [overview, refreshUsage])

  useEffect(() => {
    if (overview?.viewerRole !== 'owner') return
    const now = Date.now()
    const nextExpiry = overview.invites
      .filter(invite => invite.status === 'pending' && invite.expiresAt > now)
      .reduce<number | undefined>((nearest, invite) => nearest === undefined || invite.expiresAt < nearest ? invite.expiresAt : nearest, undefined)
    if (nextExpiry === undefined) return
    const delay = Math.min(nextExpiry - now + 1, 2_147_483_647)
    const timer = globalThis.setTimeout(() => { void refresh(false) }, delay)
    return () => { globalThis.clearTimeout(timer) }
  }, [overview, refresh])

  const run = useCallback(async (name: string, operation: () => Promise<void>) => {
    setBusy(name)
    setError(undefined)
    setTeamContextChanged(false)
    try {
      await operation()
    } catch (cause: unknown) {
      const status = errorStatus(cause)
      if (isTeamContextMismatch(cause)) {
        const snapshot = await refresh(false)
        if (snapshot !== undefined) {
          setTeamContextChanged(true)
          return
        }
        setError(t('teamContextChangedHint'))
        return
      }
      if (status === 410) {
        try {
          if (await refreshStatusOnly() !== 'connected') return
        } catch {
          // Show the original request error if status refresh is unavailable.
        }
      }
      if (status === 403 || status === 409) await refresh(false)
      if (cause instanceof Error && (
        cause.message.includes(TEAM_LOCAL_ACCOUNT_ALREADY_SHARED_CODE)
        || cause.message.includes(TEAM_BROWSER_AUTHORIZATION_ALREADY_PENDING_CODE)
      )) {
        setPendingLocalAuthorization(undefined)
      }
      setError(errorMessage(
        cause,
        t('requestFailed'),
        t('authorizationNetworkUnavailable'),
        t('authorizationFailed'),
        t('localAccountAlreadyShared'),
        t('browserAuthorizationAlreadyPending'),
      ))
    } finally {
      setBusy(undefined)
    }
  }, [refresh, refreshStatusOnly, t])

  const presentOAuth = useCallback((
    method: TeamOAuthMethod,
    busyName: string,
    request: () => Promise<TeamManagementOAuthResult>,
    expectedContext: TeamManagementExpectedContext,
    discardInitial: boolean,
    onPresented?: () => void,
  ): Promise<void> => {
    const remoteAuthorizationActive = overview?.contributions.some(account => account.status === 'authorizing') ?? false
    if (
      !mounted.current
      || oauth !== undefined
      || remoteAuthorizationActive
      || oauthPresentationActive.current
      || oauthStartLocked.current
      || oauthTransitionLocked.current
    ) return Promise.resolve()

    oauthStartLocked.current = true
    const epoch = ++oauthOperationEpoch.current
    oauthReturnSelection.current = selectedAccountId
    oauthExpectedContext.current = expectedContext
    let pendingPopup: AuthorizationPopupController | null = null
    if (method === 'browser') {
      try {
        pendingPopup = openAuthorizationPopupBridge()
      } catch {
        pendingPopup = null
      }
      if (pendingPopup === null) {
        oauthStartLocked.current = false
        clearOAuthPresentation()
        if (isCurrentOAuthOperation(epoch)) setError(t('browserPopupOpenFailed'))
        return Promise.resolve()
      }
      oauthPopup.current?.close()
      oauthPopup.current = pendingPopup
    }

    return run(busyName, async () => {
      try {
        const challenge = await request()
        if (!isCurrentOAuthOperation(epoch)) return
        oauthPresentationActive.current = true
        oauthPresentedAfterRequestId.current = overviewRequestId.current
        setOAuth(challenge)
        setOAuthDiscardInitial(discardInitial)
        setOAuthNavigationBlocked(false)
        onPresented?.()

        if (challenge.method === 'browser') {
          const navigated = pendingPopup !== null && await pendingPopup.navigate(challenge.authorizationUrl)
          if (!isCurrentOAuthOperation(epoch)) {
            pendingPopup?.close()
            return
          }
          if (!navigated) {
            pendingPopup?.close()
            if (oauthPopup.current === pendingPopup) oauthPopup.current = null
            setOAuthNavigationBlocked(true)
          } else if (pendingPopup?.window === null && oauthPopup.current === pendingPopup) {
            // The Codex in-app browser adopted the authorization tab. The Host
            // acknowledged navigation, so the provider flow no longer depends
            // on a WindowProxy owned by this settings view.
            oauthPopup.current = null
          }
        } else {
          pendingPopup?.close()
          if (oauthPopup.current === pendingPopup) oauthPopup.current = null
        }
        void refresh(false)
      } catch (cause: unknown) {
        if (isCurrentOAuthOperation(epoch) && pendingPopup !== null) {
          pendingPopup.close()
          if (oauthPopup.current === pendingPopup) oauthPopup.current = null
        }
        if (isCurrentOAuthOperation(epoch)) clearOAuthPresentation()
        throw cause
      }
    }).finally(() => {
      if (oauthOperationEpoch.current === epoch) oauthStartLocked.current = false
    })
  }, [clearOAuthPresentation, isCurrentOAuthOperation, oauth, overview, refresh, run, selectedAccountId, t])

  const startBrowserOAuth = useCallback((
    label: string,
    busyName: string,
    sourceLocalProfileId?: string,
    onPresented?: () => void,
    expectedContextOverride?: TeamManagementExpectedContext,
  ): Promise<void> => {
    const expectedContext = expectedContextOverride ?? teamExpectedContextRef.current
    if (expectedContext === undefined) return Promise.resolve()
    return presentOAuth(
      'browser',
      busyName,
      async () => sourceLocalProfileId === undefined
        ? await api.startOAuth(label.trim(), expectedContext, 'browser')
        : await api.startOAuth(label.trim(), expectedContext, 'browser', sourceLocalProfileId),
      expectedContext,
      true,
      onPresented,
    )
  }, [presentOAuth])

  const reauthorizeOAuth = useCallback((accountId: string, method: TeamOAuthMethod = 'browser'): Promise<void> => {
    const expectedContext = teamExpectedContextRef.current
    if (expectedContext === undefined) return Promise.resolve()
    return presentOAuth(
      method,
      `reauthorize-${accountId}`,
      async () => await api.reauthorizeOAuth(accountId, expectedContext, method),
      expectedContext,
      false,
    )
  }, [presentOAuth])

  const cancelPresentedOAuth = useCallback((
    accountId: string,
    expectedContext = oauthExpectedContext.current,
    discardInitial = oauthDiscardInitial,
    returnSelection = oauthReturnSelection.current,
  ): Promise<void> => {
    if (!mounted.current || oauthTransitionLocked.current) return Promise.resolve()
    if (expectedContext === undefined) return Promise.resolve()
    oauthTransitionLocked.current = true
    const epoch = ++oauthOperationEpoch.current
    oauthStartLocked.current = false
    return run(`oauth-cancel-${accountId}`, async () => {
      let cancelled: Awaited<ReturnType<typeof api.cancelOAuth>>
      try {
        cancelled = await api.cancelOAuth(accountId, expectedContext, discardInitial)
      } catch (cause: unknown) {
        if (!isTeamContextMismatch(cause)) throw cause
        const snapshot = await refresh(false)
        if (!isCurrentOAuthOperation(epoch)) return
        if (returnSelection !== undefined) setSelectedAccountId(returnSelection)
        clearOAuthPresentation()
        if (snapshot !== undefined) setTeamContextChanged(true)
        else setError(t('teamContextChangedHint'))
        return
      }
      if (!isCurrentOAuthOperation(epoch)) return
      const snapshot = await refresh(false)
      if (!isCurrentOAuthOperation(epoch)) return
      const refreshedAccount = snapshot?.overview.contributions.find(account => account.id === accountId)
      if (cancelled.account.status === 'active' || refreshedAccount?.status === 'active') {
        setSelectedAccountId(contributionSelectionKey(accountId))
      } else if (returnSelection !== undefined) {
        setSelectedAccountId(returnSelection)
      }
      if (snapshot === undefined || isSameTeamExpectedContext(
        expectedContext,
        createTeamExpectedContext(snapshot.status, snapshot.overview),
      )) {
        pendingBrowserAuthorizationActive.current = false
        setOverview(current => current === undefined
          ? current
          : reconcileCancelledBrowserAuthorization(current, refreshedAccount ?? cancelled.account))
      } else {
        setTeamContextChanged(true)
      }
      clearOAuthPresentation()
    }).finally(() => {
      if (oauthOperationEpoch.current === epoch) oauthTransitionLocked.current = false
    })
  }, [clearOAuthPresentation, isCurrentOAuthOperation, oauthDiscardInitial, refresh, run, t])

  const members = useMemo(() => new Map(overview?.members.map(member => [member.id, member]) ?? []), [overview])
  const currentMember = overview?.currentMember
  const acknowledgeDisplayNameMigration = useCallback(async () => {
    const notice = overview?.displayNameMigrationNotice
    const expectedContext = teamExpectedContextRef.current
    if (overview === undefined || notice === undefined || expectedContext === undefined) return
    const key = displayNameMigrationKey(overview, notice.migrationVersion)
    if (pendingDisplayNameMigrationAckKeys.current.has(key)) return

    pendingDisplayNameMigrationAckKeys.current.add(key)
    setDisplayNameMigrationAckStates(current => {
      const next = new Map(current)
      next.set(key, 'pending')
      return next
    })
    try {
      await api.acknowledgeDisplayNameMigration(notice.migrationVersion, expectedContext)
      acknowledgedDisplayNameMigrationKeys.current.add(key)
      setDisplayNameMigrationAckStates(current => {
        const next = new Map(current)
        next.delete(key)
        return next
      })
      setOverview(current => current === undefined
        ? current
        : hideAcknowledgedDisplayNameMigration(current, acknowledgedDisplayNameMigrationKeys.current))
    } catch {
      setDisplayNameMigrationAckStates(current => {
        const next = new Map(current)
        next.set(key, 'failed')
        return next
      })
    } finally {
      pendingDisplayNameMigrationAckKeys.current.delete(key)
    }
  }, [overview])
  const canManageTeam = overview?.viewerRole === 'owner'
  const canLeaveTeam = overview?.viewerRole === 'member' && currentMember !== undefined && canMemberLeaveTeam(currentMember.role)
  const getOwnerAuthorizationContext = useCallback(() => ownerAuthorizationContextRef.current, [])
  const getOwnerExpectedContext = useCallback(() => ownerExpectedContextRef.current, [])
  const normalizedInviteToken = inviteToken.trim()
  const inviteTokenInvalid = normalizedInviteToken !== '' && !TEAM_INVITE_TOKEN_PATTERN.test(normalizedInviteToken)

  const closeInviteReveal = useCallback(() => { setInviteRevealRequest(undefined) }, [])
  const handleInviteRevealFailure = useCallback((cause: unknown) => {
    const remoteStatus = errorStatus(cause)
    if (remoteStatus === 410) {
      void refreshStatusOnly().then(disposition => {
        if (disposition === 'connected') setError(errorMessage(cause, t('requestFailed')))
      }).catch(() => { setError(errorMessage(cause, t('requestFailed'))) })
      return
    }
    setError(errorMessage(cause, t('requestFailed')))
    if (remoteStatus === 403 || remoteStatus === 409) void refresh(false)
  }, [refresh, refreshStatusOnly, t])

  useEffect(() => {
    setInviteRevealRequest(current => current === undefined
      || current.authorizationContext === ownerAuthorizationContext
      ? current
      : undefined)
  }, [ownerAuthorizationContext])

  useEffect(() => {
    if (inviteResult === undefined || inviteResult.authorizationContext === ownerAuthorizationContext) return
    setInviteResult(undefined)
    setCopied(false)
  }, [inviteResult, ownerAuthorizationContext])

  useEffect(() => {
    if (!teamSettingsOpen) {
      setInviteRevealRequest(undefined)
      setMemberMenuId(undefined)
    }
  }, [teamSettingsOpen])

  useEffect(() => {
    if (teamSettingsOpen) workspaceBackRef.current?.focus()
  }, [teamSettingsOpen])

  useEffect(() => {
    if (teamSettingsOpen || !restoreTeamSettingsTriggerFocus.current) return
    restoreTeamSettingsTriggerFocus.current = false
    teamSettingsTriggerRef.current?.focus()
  }, [teamSettingsOpen])

  useEffect(() => {
    if (overview?.viewerRole !== 'owner' && workspaceView === 'invitations') {
      setWorkspaceView('members')
    }
  }, [overview?.viewerRole, workspaceView])

  const previewInvitation = () => {
    if (!TEAM_INVITE_TOKEN_PATTERN.test(normalizedInviteToken)) {
      setError(t('inviteTokenInvalid'))
      return Promise.resolve()
    }
    return run('invite-preview', async () => {
      const token = normalizedInviteToken
      const requestId = ++previewRequestId.current
      const preview = await api.previewInvite(token)
      if (requestId !== previewRequestId.current) return
      setInviteToken('')
      setInvitePreview(preview)
    })
  }

  const joinTeam = () => run('join', async () => {
    if (invitePreview === undefined) throw new Error('invitation must be previewed before joining')
    await api.join(invitePreview.joinHandle, displayName)
    setInviteToken('')
    setInvitePreview(undefined)
    previewRequestId.current += 1
    await refresh(false)
  })

  const activeDissolution = dissolution ?? status?.dissolution
  const activeConnectionTerminal = connectionTerminal ?? status?.connectionTerminal

  if (loading && status === undefined) {
    return (
      <main className={styles.page}>
        <div className={styles.loadingBlock}><span className={styles.spinner} />{t('loading')}</div>
      </main>
    )
  }

  if (status === undefined) {
    return (
      <main className={styles.page}>
        <Notice tone="error" title={t('requestFailed')} detail={error}>
          <Button variant="outline" size="sm" onClick={() => { void refresh(true) }}>{t('retry')}</Button>
        </Notice>
      </main>
    )
  }

  if (activeDissolution !== undefined) {
    if (activeDissolution.state === 'confirming') {
      return (
        <main className={styles.page}>
          {embedded ? null : <PageHeading t={t} />}
          <section className={styles.dissolutionTerminal} aria-labelledby="team-dissolution-confirming-title">
            <p className={styles.eyebrow}>{activeDissolution.teamName}</p>
            <h2 id="team-dissolution-confirming-title" className={styles.dissolutionTerminalTitle}>{t('dissolutionConfirmingTitle')}</h2>
            <p className={styles.dissolutionTerminalBody}>{t('dissolutionConfirmingBody')}</p>
            {error === undefined ? null : <Notice tone="error" title={t('requestFailed')} detail={error} />}
            <div className={styles.dissolutionTerminalActions}>
              <Button variant="primary" disabled={busy !== undefined} onClick={() => { void run('recover-dissolution', async () => {
                setDissolution(await api.recoverTeamDissolution())
              }) }}>
                {t('continueConfirmation')}
              </Button>
            </div>
          </section>
        </main>
      )
    }

    return (
      <main className={styles.page}>
        {embedded ? null : <PageHeading t={t} />}
        <section className={styles.dissolutionTerminal} aria-labelledby="team-dissolution-confirmed-title">
          {activeDissolution.teamName === undefined ? null : <p className={styles.eyebrow}>{activeDissolution.teamName}</p>}
          <h2 id="team-dissolution-confirmed-title" className={styles.dissolutionTerminalTitle}>{t('dissolutionTerminalTitle')}</h2>
          <p className={styles.dissolutionTerminalBody}>{t('dissolutionTerminalBody')}</p>
          <p className={styles.dissolutionCleanup} data-state={activeDissolution.localCleanup}>
            {t(activeDissolution.localCleanup === 'completed'
              ? 'dissolutionCleanupCompleted'
              : activeDissolution.localCleanup === 'retry_required'
                ? 'dissolutionCleanupRetryRequired'
                : 'dissolutionCleanupManualRequired')}
          </p>
          {error === undefined ? null : <Notice tone="error" title={t('requestFailed')} detail={error} />}
          <div className={styles.dissolutionTerminalActions}>
            <Button variant="primary" disabled={busy !== undefined} onClick={() => { void run('clear-dissolution', async () => {
              const result = await api.clearTeamDissolution()
              if ('cleared' in result) {
                setDissolution(undefined)
                await refresh(false)
              } else {
                setDissolution(result)
              }
            }) }}>
              {t(activeDissolution.localCleanup === 'completed'
                ? 'continueToJoin'
                : activeDissolution.localCleanup === 'retry_required'
                  ? 'retryCleanup'
                  : 'checkCleanup')}
            </Button>
          </div>
        </section>
      </main>
    )
  }

  if (activeConnectionTerminal !== undefined) {
    const titleKey = activeConnectionTerminal.code === 'member_removed'
      ? 'connectionTerminalMemberRemovedTitle'
      : activeConnectionTerminal.code === 'member_left'
        ? 'connectionTerminalMemberLeftTitle'
        : activeConnectionTerminal.code === 'team_dissolved'
          ? 'dissolutionTerminalTitle'
          : 'connectionTerminalDeviceRevokedTitle'
    const bodyKey = activeConnectionTerminal.code === 'member_removed'
      ? 'connectionTerminalMemberRemovedBody'
      : activeConnectionTerminal.code === 'member_left'
        ? 'connectionTerminalMemberLeftBody'
        : activeConnectionTerminal.code === 'team_dissolved'
          ? 'dissolutionTerminalBody'
          : 'connectionTerminalDeviceRevokedBody'
    return (
      <main className={styles.page}>
        {embedded ? null : <PageHeading t={t} />}
        <section className={styles.dissolutionTerminal} aria-labelledby="team-connection-terminal-title">
          <h2 id="team-connection-terminal-title" className={styles.dissolutionTerminalTitle}>{t(titleKey)}</h2>
          <p className={styles.dissolutionTerminalBody}>{t(bodyKey)}</p>
          <p className={styles.dissolutionCleanup} data-state={activeConnectionTerminal.localCleanup}>
            {t(activeConnectionTerminal.localCleanup === 'completed'
              ? 'connectionTerminalCleanupCompleted'
              : activeConnectionTerminal.localCleanup === 'retry_required'
                ? 'connectionTerminalCleanupRetryRequired'
                : 'connectionTerminalCleanupManualRequired')}
          </p>
          {error === undefined ? null : <Notice tone="error" title={t('requestFailed')} detail={error} />}
          <div className={styles.dissolutionTerminalActions}>
            <Button variant="primary" disabled={busy !== undefined} onClick={() => { void run('clear-connection-terminal', async () => {
              const result = await api.clearConnectionTerminal()
              if ('cleared' in result) {
                setConnectionTerminal(undefined)
                await refresh(false)
              } else {
                setConnectionTerminal(result)
              }
            }) }}>
              {t(activeConnectionTerminal.localCleanup === 'completed'
                ? 'continueToJoin'
                : activeConnectionTerminal.localCleanup === 'retry_required'
                  ? 'retryCleanup'
                  : 'checkCleanup')}
            </Button>
          </div>
        </section>
      </main>
    )
  }

  if (!status.enabled) {
    return (
      <main className={styles.page}>
        {embedded ? null : <PageHeading t={t} />}
        <Notice tone="warning" title={t('enabledRequired')} detail={t('enabledHint')} />
      </main>
    )
  }

  if (status.keyConfigured && overview === undefined) {
    if (loading && connectionIssue === undefined) {
      return (
        <main className={styles.page}>
          <div className={styles.loadingBlock}><span className={styles.spinner} />{t('loading')}</div>
        </main>
      )
    }
    const invalid = connectionIssue?.kind === 'invalid'
    return (
      <main className={styles.page}>
        {embedded ? null : <PageHeading t={t} />}
        <Notice
          tone={invalid ? 'error' : 'warning'}
          title={t(invalid ? 'teamAccessInvalidTitle' : 'teamAccessUnavailableTitle')}
          detail={connectionIssue?.detail ?? t(invalid ? 'teamAccessInvalidHint' : 'teamAccessUnavailableHint')}
        >
          <div className={styles.compactActions}>
            <Button variant="primary" size="sm" disabled={busy !== undefined} onClick={() => { void refresh(true) }}>{t('retry')}</Button>
            {invalid && status.keyWritable ? (
              <Button variant="ghost" size="sm" disabled={busy !== undefined} onClick={() => { void run('clear-invalid-key', async () => {
                await api.disconnect(false)
                setConnectionIssue(undefined)
                await refresh(true)
              }) }}>{t('clearLocalConnection')}</Button>
            ) : null}
          </div>
        </Notice>
      </main>
    )
  }

  if (!status.keyConfigured) {
    return (
      <main className={styles.page}>
        {embedded ? null : <PageHeading t={t} />}
        {error === undefined ? null : <Notice tone="error" title={t('requestFailed')} detail={error} />}
        <section className={styles.section}>
          <div className={styles.sectionCopy}>
            <h2 className={styles.sectionTitle}>{t('notConnected')}</h2>
            <p className={styles.hint}>{t('notConnectedHint')}</p>
          </div>
          {status.pendingJoinConfigured ? (
            <Notice tone="warning" title={t('pendingJoinTitle')} detail={t('pendingJoinHint')}>
              <div className={styles.compactActions}>
                <Button size="sm" variant="primary" disabled={busy !== undefined} onClick={() => { void run('recover-join', async () => {
                  try {
                    await api.recoverJoin()
                  } finally {
                    await refresh(false)
                  }
                }) }}>{busy === 'recover-join' ? t('working') : t('recoverJoin')}</Button>
                <Button size="sm" variant="ghost" disabled={busy !== undefined} onClick={() => { void run('discard-join', async () => {
                  await api.discardPendingJoin()
                  await refresh(false)
                }) }}>{t('discardPendingJoin')}</Button>
              </div>
            </Notice>
          ) : null}
          {status.pendingJoinConfigured ? null : status.keyWritable ? (
            <div className={styles.connectionGrid}>
              <div className={styles.panel}>
                <h3 className={styles.panelTitle}>{t('joinInvite')}</h3>
                <Field label={t('inviteToken')} {...inviteTokenInvalid ? { hint: t('inviteTokenInvalid') } : {}}>
                  <Input className={styles.input!} value={inviteToken} maxLength={512} autoComplete="off" spellCheck={false} placeholder={t('inviteTokenPlaceholder')} aria-invalid={inviteTokenInvalid || undefined} onChange={event => {
                    setInviteToken(event.target.value)
                    setInvitePreview(undefined)
                    previewRequestId.current += 1
                  }} />
                </Field>
                {invitePreview === undefined ? (
                  <div className={styles.actionRow}>
                    <Button variant="primary" disabled={busy !== undefined || !TEAM_INVITE_TOKEN_PATTERN.test(normalizedInviteToken)} onClick={() => { void previewInvitation() }}>
                      {busy === 'invite-preview' ? t('working') : t('previewInvitation')}
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className={styles.invitePreview} data-status={invitePreview.teamStatus} role="status" aria-live="polite">
                      <div>
                        <span className={styles.previewEyebrow}>{t('invitationVerified')}</span>
                        <h4 className={styles.previewTeamName}>{invitePreview.teamName}</h4>
                      </div>
                      <dl className={styles.previewFacts}>
                        <div><dt>{t('invitePurpose')}</dt><dd>{invitePreview.label}</dd></div>
                        <div><dt>{t('inviteValidity')}</dt><dd>{t('expiresAt', { time: formatTime(invitePreview.expiresAt) })}</dd></div>
                      </dl>
                      {invitePreview.teamStatus === 'paused' ? <p className={styles.warningText}>{t('invitationPaused')}</p> : null}
                    </div>
                    <div className={styles.routingRail} aria-label={t('joinAccessFlow')}>
                      <RouteNode number="1" label={t('accessInvite')} hint={t('accessInviteHint')} />
                      <RouteNode number="2" label={t('accessHost')} hint={t('accessHostHint')} current />
                      <RouteNode number="3" label={t('accessTeam')} hint={t('accessTeamHint')} />
                    </div>
                    <Field label={t('displayName')}>
                      <Input className={styles.input!} value={displayName} autoComplete="name" placeholder={t('displayNamePlaceholder')} onChange={event => { setDisplayName(event.target.value) }} />
                    </Field>
                    <div className={styles.actionRow}>
                      <Button variant="primary" disabled={busy !== undefined || displayName.length === 0 || invitePreview.teamStatus !== 'active'} onClick={() => { void joinTeam() }}>
                        {busy === 'join' ? t('working') : t('confirmJoin')}
                      </Button>
                    </div>
                  </>
                )}
              </div>
            </div>
          ) : <Notice tone="warning" title={t('readOnlyKey')} detail={status.keySource} />}
        </section>
      </main>
    )
  }

  // The configured branches above should already handle this state. Keep a
  // defensive fallback so a future status shape cannot render partial Team UI.
  if (overview === undefined) {
    return (
      <main className={styles.page}>
        {embedded ? null : <PageHeading t={t} />}
        <Notice tone="warning" title={t('teamAccessUnavailableTitle')} detail={t('teamAccessUnavailableHint')}>
          <Button variant="primary" size="sm" disabled={busy !== undefined} onClick={() => { void refresh(true) }}>{t('retry')}</Button>
        </Notice>
      </main>
    )
  }

  const team = overview.team
  const activeMembers = overview.members
    .filter(member => member.status === 'active')
    .map((member, index) => ({ member, index }))
    .sort((left, right) => {
      const leftIsOwner = left.member.role === 'owner'
      const rightIsOwner = right.member.role === 'owner'
      if (leftIsOwner !== rightIsOwner) return leftIsOwner ? -1 : 1
      return left.member.joinedAt - right.member.joinedAt || left.index - right.index
    })
    .map(({ member }) => member)
  const ownershipTransfer = overview.ownershipTransfer?.status === 'pending'
    ? overview.ownershipTransfer
    : undefined
  const ownershipTransferRequester = ownershipTransfer === undefined
    ? undefined
    : members.get(ownershipTransfer.requestedByMemberId)
  const ownershipTransferTarget = ownershipTransfer === undefined
    ? undefined
    : members.get(ownershipTransfer.targetMemberId)
  const currentMemberIsTransferRequester = ownershipTransfer !== undefined
    && canManageTeam
    && currentMember?.id === ownershipTransfer.requestedByMemberId
  const currentMemberIsTransferTarget = ownershipTransfer !== undefined
    && overview.viewerRole === 'member'
    && currentMember?.id === ownershipTransfer.targetMemberId
  const eligibleOwnershipTargets = canManageTeam && currentMember !== undefined && ownershipTransfer === undefined
    ? activeMembers.filter(member => canTransferTeamOwnership(currentMember, member))
    : []
  const selectedOwnershipTarget = eligibleOwnershipTargets.find(member => member.id === ownershipTransferTargetId)
  const pendingInvites = overview.viewerRole === 'owner'
    ? overview.invites.filter(invite => invite.status === 'pending' && invite.expiresAt > Date.now())
    : []
  const pendingInviteCount = pendingInvites.length
  const contributionGroups = groupTeamContributions(overview.contributions, overview.currentMember.id)
  const localTeamProfiles = localProfilesAvailableForTeam(
    localProfiles,
    overview.contributions,
    overview.currentMember.id,
  )
  const listedAccounts = [...contributionGroups.shared, ...contributionGroups.unshared]
  const teammateSharedAccounts = (overview.activeSharedAccounts ?? [])
    .filter(account => account.ownerMemberId !== overview.currentMember.id)
  const requestedLocalAccount = selectedAccountId?.startsWith('local:') === true
    ? localTeamProfiles.find(account => localSelectionKey(account.id) === selectedAccountId)
    : undefined
  const requestedContributionAccount = selectedAccountId?.startsWith('contribution:') === true
    ? listedAccounts.find(account => contributionSelectionKey(account.id) === selectedAccountId)
    : undefined
  const requestedSharedDirectoryAccount = selectedAccountId?.startsWith('shared-directory:') === true
    ? teammateSharedAccounts.find(account => sharedDirectorySelectionKey(account.id) === selectedAccountId)
    : undefined
  const selectedAccount: SelectedAccount | undefined = requestedLocalAccount !== undefined
    ? { kind: 'local', account: requestedLocalAccount }
    : requestedContributionAccount !== undefined
      ? { kind: 'contribution', account: requestedContributionAccount }
      : requestedSharedDirectoryAccount !== undefined
        ? { kind: 'shared-directory', account: requestedSharedDirectoryAccount }
        : contributionGroups.shared[0] !== undefined
          ? { kind: 'contribution', account: contributionGroups.shared[0] }
          : teammateSharedAccounts[0] !== undefined
            ? { kind: 'shared-directory', account: teammateSharedAccounts[0] }
            : localTeamProfiles[0] !== undefined
              ? { kind: 'local', account: localTeamProfiles[0] }
              : contributionGroups.unshared[0] === undefined
                ? undefined
                : { kind: 'contribution', account: contributionGroups.unshared[0] }

  const accountAliases = new Map([
    ...contributionGroups.shared.map(account => contributionSelectionKey(account.id)),
    ...teammateSharedAccounts.map(account => sharedDirectorySelectionKey(account.id)),
    ...localTeamProfiles.map(profile => localSelectionKey(profile.id)),
    ...contributionGroups.unshared.map(account => contributionSelectionKey(account.id)),
  ].map((key, index) => [key, t('accountAlias', { letter: accountAliasLetter(index) })]))

  const renderDisplayNameMigrationNotice = () => {
    const notice = overview.displayNameMigrationNotice
    if (notice === undefined) return null
    const key = displayNameMigrationKey(overview, notice.migrationVersion)
    const ackState = displayNameMigrationAckStates.get(key)
    return (
      <Notice
        tone="warning"
        title={t('displayNameMigrationNoticeTitle')}
        detail={t('displayNameMigrationNoticeBody', { displayName: overview.currentMember.displayName })}
        live="polite"
      >
        <div className={`${styles.compactActions} ${styles.noticeActions}`}>
          {ackState !== 'failed' ? null : (
            <p className={styles.errorText} role="alert">{t('displayNameMigrationAckFailed')}</p>
          )}
          <Button
            size="sm"
            variant="primary"
            disabled={ackState === 'pending' || teamExpectedContext === undefined}
            onClick={() => { void acknowledgeDisplayNameMigration() }}
          >
            {ackState === 'pending' ? t('working') : t('displayNameMigrationAck')}
          </Button>
        </div>
      </Notice>
    )
  }

  const renderAccountsPanel = () => {
    const contributorNameFor = (account: TeamManagementSharedAccountDirectoryEntry) =>
      members.get(account.ownerMemberId)?.displayName ?? t('member')

    const renderAccountDirectorySkeleton = () => (
      <section className={`${styles.directoryGroup} ${styles.accountDirectorySkeleton}`} aria-hidden="true">
        <div className={styles.directoryGroupHeader}>
          <span className={`${styles.skeletonBlock} ${styles.skeletonGroupLabel}`} />
          <span className={`${styles.skeletonBlock} ${styles.skeletonGroupCount}`} />
        </div>
        <div className={styles.accountNavList}>
          {[0, 1, 2].map(index => (
            <div className={styles.accountSkeletonRow} key={index}>
              <span className={`${styles.skeletonBlock} ${styles.skeletonDot}`} />
              <span className={styles.accountSkeletonCopy}>
                <span className={`${styles.skeletonBlock} ${styles.skeletonAccountLabel}`} />
                <span className={`${styles.skeletonBlock} ${styles.skeletonAccountOwner}`} />
              </span>
              <span className={`${styles.skeletonBlock} ${styles.skeletonAccountState}`} />
            </div>
          ))}
        </div>
      </section>
    )

    const renderAccountDetailSkeleton = () => (
      <div className={styles.accountDetailSkeleton} aria-hidden="true">
        <div className={styles.detailSkeletonHeading}>
          <span className={`${styles.skeletonBlock} ${styles.skeletonDetailTitle}`} />
          <span className={`${styles.skeletonBlock} ${styles.skeletonDot}`} />
          <span className={`${styles.skeletonBlock} ${styles.skeletonDetailStatus}`} />
        </div>
        <span className={`${styles.skeletonBlock} ${styles.skeletonDetailAction}`} />
        <span className={`${styles.skeletonBlock} ${styles.skeletonDetailCopyWide}`} />
        <span className={`${styles.skeletonBlock} ${styles.skeletonDetailCopyShort}`} />
        <div className={styles.detailSkeletonCapacity}>
          <span className={`${styles.skeletonBlock} ${styles.skeletonCapacityTitle}`} />
          <div className={styles.detailSkeletonQuota}>
            <span className={`${styles.skeletonBlock} ${styles.skeletonQuotaLabel}`} />
            <span className={`${styles.skeletonBlock} ${styles.skeletonQuotaValue}`} />
          </div>
          <span className={`${styles.skeletonBlock} ${styles.skeletonQuotaTrack}`} />
        </div>
      </div>
    )

    const renderLocalAccount = (profile: LocalCodexProfileSummary) => {
      const authorizationBusy = busy === `share-local-${profile.id}`
      const quotaHasError = profile.quotaError !== undefined
      const quotaIsStale = profile.remainingPercent !== undefined && quotaHasError
      const quotaIsLoading = profile.remainingPercent === undefined
        && localProfilesQuotaLoading
        && !quotaHasError
      return <article className={`${styles.accountCard} ${styles.prototypeDetail}`} key={`local:${profile.id}`}>
        <header className={styles.detailHeading}>
          <h2 className={styles.detailTitle}>{profile.label}</h2>
          <span className={styles.connectionStatus}>
            <StateDot state="done" />
            {t(profile.inUse ? 'localInUse' : 'localAvailable')}
          </span>
        </header>
        <section className={styles.teamActionPanel} aria-label={t('shareToTeam')}>
          <Button
            className={styles.primaryAccountAction}
            size="sm"
            variant="outline"
            disabled={busy !== undefined || teamExpectedContext === undefined}
            aria-busy={authorizationBusy}
            onClick={() => {
              if (teamAuthorizationContext === undefined || teamExpectedContext === undefined) return
              setPendingLocalAuthorization({
                id: profile.id,
                label: profile.label,
                authorizationContext: teamAuthorizationContext,
                expectedContext: teamExpectedContext,
              })
            }}
          >{authorizationBusy
              ? <><span className={styles.actionSpinner} aria-hidden="true" />{t('working')}</>
              : t('shareToTeam')}</Button>
          <p>
            {t('localAuthorizationCopy')} <strong>{t('localCredentialBoundary')}</strong>
          </p>
        </section>
        <section
          className={`${styles.prototypeSection} ${styles.capacityOverview}`}
          role="region"
          aria-label={t('capacityTitle')}
          aria-busy={quotaIsLoading}
          data-tone={quotaHasError ? 'warning' : undefined}
          data-stale={quotaIsStale ? 'true' : undefined}
        >
          <h3>{t('capacityTitle')}</h3>
          <div className={styles.capacityLine}>
            <span>{t('capacityCodex')}</span>
            <strong>{profile.remainingPercent === undefined
              ? quotaIsLoading
                ? <>
                    <span className={styles.screenReaderOnly} role="status" aria-live="polite">{t('loadingLocalQuota')}</span>
                    <span className={`${styles.skeletonBlock} ${styles.quotaValueSkeleton}`} aria-hidden="true" />
                  </>
                : t(quotaHasError ? 'capacityQuotaError' : 'capacityQuotaUnavailable')
              : `${profile.remainingPercent}%`}</strong>
          </div>
          <div
            className={styles.quotaTrack}
            data-loading={quotaIsLoading ? 'true' : undefined}
            data-error={quotaHasError ? 'true' : undefined}
            data-unavailable={profile.remainingPercent === undefined && !quotaIsLoading && !quotaHasError ? 'true' : undefined}
            role={profile.remainingPercent === undefined ? undefined : 'progressbar'}
            aria-label={profile.remainingPercent === undefined ? undefined : t('capacityCodex')}
            aria-valuenow={profile.remainingPercent}
            aria-valuemin={profile.remainingPercent === undefined ? undefined : 0}
            aria-valuemax={profile.remainingPercent === undefined ? undefined : 100}
          >
            {profile.remainingPercent === undefined
              ? quotaIsLoading
                ? <span className={styles.quotaTrackSkeleton} aria-hidden="true" />
                : null
              : <span style={{ width: `${profile.remainingPercent}%` }} />}
          </div>
          {quotaHasError
            ? <p className={styles.quotaWarning} role="status">{t(quotaIsStale ? 'capacityQuotaStaleHint' : 'capacityQuotaErrorHint')}</p>
            : null}
        </section>
        <footer className={styles.detailFooter}>
          <Button className={styles.detailFooterButton} variant="ghost" onClick={() => {
            setRecentUsageAccount({ id: profile.id, kind: 'local', label: profile.label })
          }}>{t('recentRequests')}</Button>
        </footer>
      </article>
    }

    const renderSharedDirectoryAccount = (account: TeamManagementSharedAccountDirectoryEntry) => {
      const contributor = contributorNameFor(account)
      const contributionLabel = t('contributedBy', { name: contributor })
      return (
        <article className={`${styles.accountCard} ${styles.prototypeDetail}`} data-mine="false" aria-label={account.label} key={account.id}>
          <header className={styles.detailHeading}>
            <h2 className={styles.detailTitle}>{account.label}</h2>
            <span className={styles.connectionStatus}>
              <StateDot state="done" />
              <span className={styles.statusText}>{contributionLabel} · {t('teamAvailable')}</span>
            </span>
          </header>
          <section className={styles.teamActionPanel} aria-label={t('sharedAccountReadonlyTitle')}>
            <p>{t('sharedAccountReadonlyHint')}</p>
          </section>
        </article>
      )
    }

    const renderContributionAccount = (account: TeamManagementContributionSummary) => {
      const accountUsage = usageProjection?.ownedAccounts?.find(item => item.accountId === account.id)
      const last24HoursAggregate = accountUsage?.last24Hours?.aggregate
      const capacityBucket = account.capacity?.buckets.find(bucket => bucket.id === 'codex')
        ?? account.capacity?.buckets.find(bucket => bucket.remainingPercent !== undefined)
      const remainingCapacity = capacityBucket?.remainingPercent === undefined
        ? t('capacityQuotaUnavailable')
        : `${capacityBucket.remainingPercent}%`
      const weeklyLimit = account.weeklySharedEstimatedApiCostLimitMicros == null
        ? '∞'
        : formatUsdMicros(account.weeklySharedEstimatedApiCostLimitMicros)
      const accountActionBusy = busy === `${account.status === 'active' ? 'revoke' : 'toggle'}-${account.id}`
      const contributionHint = account.status === 'active'
        ? undefined
        : account.status === 'paused'
          ? t('contributionPausedHint')
          : account.status === 'authorizing'
            ? t('contributionAuthorizingHint')
            : t('contributionReauthHint')
      const contributionStatus = account.status === 'active'
        ? `${t('localSignedIn')} · ${t('teamAvailable')}`
        : t(account.status)
      const openProtection = () => {
        setProtectionEdit({
          account,
          reserve: String(account.personalReservePercent),
          requestCap: account.maxSharedRequestsPerWindow === null ? '' : String(account.maxSharedRequestsPerWindow),
          weeklyLimitUsd: account.weeklySharedEstimatedApiCostLimitMicros == null
            ? ''
            : String(account.weeklySharedEstimatedApiCostLimitMicros / 1_000_000),
          models: account.allowedModels.join(', '),
        })
      }
      return (
        <article className={`${styles.accountCard} ${styles.prototypeDetail}`} data-mine="true" aria-label={account.label} key={account.id}>
          <header className={styles.detailHeading}>
            <div>
              <h2 className={styles.detailTitle}>{account.label}</h2>
            </div>
            <div className={styles.connectionStatus}>
              <StateDot state={account.status === 'active' ? 'done' : account.status === 'authorizing' ? 'ongoing' : account.status === 'paused' ? 'warning' : 'error'} />
              <span className={styles.statusText}>{contributionStatus}</span>
            </div>
          </header>
          <section className={`${styles.teamActionPanel} ${styles.accountActionBar}`} role="group" aria-label={t('accountActions')}>
            {account.status === 'reauth_required' ? (
              <Button className={styles.accountActionButton} size="sm" variant="primary" disabled={busy !== undefined} onClick={() => { void reauthorizeOAuth(account.id) }}>{t('reauthorize')}</Button>
            ) : account.status === 'authorizing' ? null : account.status === 'active' ? (
              <Button className={`${styles.accountActionButton} ${styles.stopSharingButton}`} size="sm" variant="outline" disabled={busy !== undefined} aria-busy={accountActionBusy} onClick={() => { void run(`revoke-${account.id}`, async () => {
                const expectedContext = teamExpectedContextRef.current
                if (expectedContext === undefined) return
                await api.revokeContribution(account.id, expectedContext)
                await refresh(false)
              }) }}>{accountActionBusy ? (
                <><span className={styles.actionSpinner} aria-hidden="true" />{t('stoppingContribution')}</>
              ) : t('revokeContribution')}</Button>
            ) : (
              <Button className={styles.accountActionButton} size="sm" variant="outline" disabled={busy !== undefined} aria-busy={accountActionBusy} onClick={() => { void run(`toggle-${account.id}`, async () => {
                const expectedContext = teamExpectedContextRef.current
                if (expectedContext === undefined) return
                await api.updateContribution(account.id, { status: 'active' }, expectedContext)
                await refresh(false)
              }) }}>{accountActionBusy ? (
                <><span className={styles.actionSpinner} aria-hidden="true" />{t('resumingContribution')}</>
              ) : t('resumeContribution')}</Button>
            )}
            {contributionHint === undefined ? null : <p>{contributionHint}</p>}
          </section>
          {usageUnavailable ? (
            <div className={styles.accountUsageWarning} role="alert">
              <span>{t('usageUnavailableTitle')}</span>
              <Button size="sm" variant="outline" disabled={usageLoading} onClick={() => { void refreshUsage() }}>{t('retry')}</Button>
            </div>
          ) : null}
          <section className={`${styles.prototypeSection} ${styles.compactSummary}`} role="region" aria-label={t('weeklySharingTitle')}>
            <h4 className={styles.compactSummaryTitle}>{t('weeklySharingTitle')}</h4>
            <dl className={styles.compactSummaryList}>
              <div>
                <dt>{t('weeklySharedAmount')}</dt>
                <dd className={styles.weeklyAmount}>
                  <span className={styles.weeklyLimitValue}>{account.weeklySharedEstimatedApiCostLimitMicros == null
                    ? t('limitNoLimit')
                    : t('limitAmount', { amount: weeklyLimit })}</span>
                  <button type="button" className={styles.inlineLimitButton} aria-label={t('editSharingLimit')} title={t('editSharingLimit')} disabled={busy !== undefined} onClick={openProtection}>
                    {t('edit')}
                  </button>
                </dd>
              </div>
              <div>
                <dt className={styles.estimateLabel}>
                  <span>{t('weeklyCapacityReference')}</span>
                  <button type="button" className={styles.estimateHelp} aria-label={t('amountEstimateHelpLabel')} title={t('amountEstimateHelp')}>?</button>
                </dt>
                <dd>{t('aboutAmount', { amount: formatUsdMicros(CODEX_WEEKLY_SHAREABLE_ESTIMATED_API_COST_REFERENCE_MICROS) })}</dd>
              </div>
              <div>
                <dt>{t('accountRemainingCapacity')}</dt>
                <dd>{remainingCapacity}</dd>
              </div>
            </dl>
          </section>
          <section className={`${styles.prototypeSection} ${styles.compactRecentUsage}`} role="region" aria-label={t('recentUsageRegionLabel')}>
            <header className={styles.compactRecentHeader}>
              <h4 className={styles.compactSummaryTitle}>{t('recentUsageTitle')}</h4>
              <Button className={styles.viewSevenDaysButton} size="sm" variant="outline" onClick={() => {
                setRecentUsageAccount({ id: account.id, kind: 'contribution', label: account.label })
              }}>{t('viewSevenDays')}</Button>
            </header>
            {last24HoursAggregate === undefined
              ? <p className={styles.compactRecentLine}>{t('recentUsageUnavailable')}</p>
              : <p className={styles.compactRecentLine}>
                  <strong>{t('requestCount', { count: last24HoursAggregate.requestCount })}</strong>
                  <span aria-hidden="true"> · </span>
                  <span>{t('tokenApiEquivalent')}</span>{' '}
                  <strong>{formatUsdMicros(last24HoursAggregate.estimatedCostUsdMicros)}</strong>
                </p>}
          </section>
        </article>
      )
    }

    const renderContributionNavigation = (account: TeamManagementContributionSummary) => {
      const navigationStatus = account.status === 'active' ? t('contributedByMe') : t(account.status)
      return (
        <button
          type="button"
          className={styles.accountNavItem}
          data-selected={selectedAccount?.kind === 'contribution' && selectedAccount.account.id === account.id}
          aria-pressed={selectedAccount?.kind === 'contribution' && selectedAccount.account.id === account.id}
          aria-label={`${account.label} · ${navigationStatus}`}
          onClick={() => { setSelectedAccountId(contributionSelectionKey(account.id)) }}
          key={account.id}
        >
          <StateDot state={account.status === 'active' ? 'done' : account.status === 'authorizing' ? 'ongoing' : account.status === 'paused' ? 'warning' : 'error'} />
          <span className={styles.accountNavCopy}>
            <span className={styles.accountNavLabel}>{accountAliases.get(contributionSelectionKey(account.id))}</span>
            <span className={styles.accountNavOwner}>{account.label}</span>
          </span>
          {account.status === 'active' ? (
            <Pill className={`${styles.accountNavStatus} ${styles.pill}`}>{navigationStatus}</Pill>
          ) : (
            <span className={styles.accountNavStatus}>{navigationStatus}</span>
          )}
        </button>
      )
    }

    const renderSharedDirectoryNavigation = (account: TeamManagementSharedAccountDirectoryEntry) => {
      const contributionLabel = t('contributedBy', { name: contributorNameFor(account) })
      const selected = selectedAccount?.kind === 'shared-directory' && selectedAccount.account.id === account.id
      return (
        <button
          type="button"
          className={styles.accountNavItem}
          data-selected={selected}
          aria-pressed={selected}
          aria-label={`${account.label} · ${contributionLabel}`}
          onClick={() => { setSelectedAccountId(sharedDirectorySelectionKey(account.id)) }}
          key={account.id}
        >
          <StateDot state="done" />
          <span className={styles.accountNavCopy}>
            <span className={styles.accountNavLabel}>{accountAliases.get(sharedDirectorySelectionKey(account.id))}</span>
            <span className={styles.accountNavOwner}>{account.label}</span>
          </span>
          <Pill className={`${styles.accountNavStatus} ${styles.pill}`}>{contributionLabel}</Pill>
        </button>
      )
    }

    const renderLocalNavigation = (profile: LocalCodexProfileSummary) => (
      <button
        type="button"
        className={styles.accountNavItem}
        data-selected={selectedAccount?.kind === 'local' && selectedAccount.account.id === profile.id}
        aria-pressed={selectedAccount?.kind === 'local' && selectedAccount.account.id === profile.id}
        aria-label={`${profile.label} · ${t('localSignedIn')} · ${t('localNotShared')}`}
        onClick={() => { setSelectedAccountId(localSelectionKey(profile.id)) }}
        key={profile.id}
      >
        <StateDot state="done" />
        <span className={styles.accountNavCopy}>
          <span className={styles.accountNavLabel}>{accountAliases.get(localSelectionKey(profile.id))}</span>
          <span className={styles.accountNavOwner}>{profile.label}</span>
        </span>
        <span className={styles.accountNavStatus}>{t('localNotShared')}</span>
      </button>
    )

    const sharedAccountCount = contributionGroups.shared.length + teammateSharedAccounts.length
    const accountCount = listedAccounts.length + teammateSharedAccounts.length + localTeamProfiles.length

    return (
      <section className={styles.accountWorkspace} role="region" aria-labelledby="team-accounts-title" aria-busy={localProfilesLoading}>
        <aside className={styles.accountDirectory}>
          <div className={styles.directoryHeader}>
            <h3 id="team-accounts-title" className={styles.directoryTitle}>
              {t('accountsLabel')}{localProfilesLoading
                ? <span className={`${styles.skeletonBlock} ${styles.directoryCountSkeleton}`} aria-hidden="true" />
                : <span className={styles.directoryTitleCount}>{t('accountsCount', { count: accountCount })}</span>}
            </h3>
            <Button className={styles.addAccountButton} size="sm" variant="outline" icon={<IconPlusOutline16 />} disabled={busy !== undefined || activeBrowserAuthorization !== undefined || oauth !== undefined || hasAuthorizingAccount} onClick={() => {
              setAccountLabel('')
              setAddAccountOpen(true)
            }}>{t('addAccount')}</Button>
            <p className={`${styles.hint} ${styles.directoryHint}`}>{t('accountDirectoryHint')}</p>
          </div>
          {sharedAccountCount === 0 ? null : <section className={styles.directoryGroup} role="region" aria-labelledby="team-shared-accounts-title">
            <div className={styles.directoryGroupHeader}>
              <h4 id="team-shared-accounts-title" className={styles.directoryGroupTitle}>{t('sharedAccounts')}</h4>
              <span>{sharedAccountCount}</span>
            </div>
            <div className={styles.accountNavList}>
              {contributionGroups.shared.map(renderContributionNavigation)}
              {teammateSharedAccounts.map(renderSharedDirectoryNavigation)}
            </div>
          </section>}
          {contributionGroups.unshared.length + localTeamProfiles.length === 0 ? null : <section className={styles.directoryGroup} role="region" aria-labelledby="team-unshared-accounts-title">
            <div className={styles.directoryGroupHeader}>
              <h4 id="team-unshared-accounts-title" className={styles.directoryGroupTitle}>{t('unsharedAccounts')}</h4>
              <span>{contributionGroups.unshared.length + localTeamProfiles.length}</span>
            </div>
            <div className={styles.accountNavList}>
              {localTeamProfiles.map(renderLocalNavigation)}
              {contributionGroups.unshared.map(renderContributionNavigation)}
            </div>
          </section>}
          {localProfilesLoading ? (
            <>
              <p className={styles.screenReaderOnly} role="status" aria-live="polite">{t('loadingLocalAccounts')}</p>
              {renderAccountDirectorySkeleton()}
            </>
          ) : null}
          {accountCount === 0 && !localProfilesLoading && localProfilesUnavailable
            ? <div className={styles.directoryState} role="alert">
                <strong>{t('localAccountsUnavailableTitle')}</strong>
                <span>{t('localAccountsUnavailableHint')}</span>
                <Button size="sm" variant="outline" onClick={() => { void refreshLocalProfiles() }}>{t('retry')}</Button>
              </div>
            : null}
        </aside>
        <div className={styles.accountDetail} role="region" aria-label={t('accountDetails')}>
          {activeBrowserAuthorization !== undefined
            ? <section className={styles.oauthInlinePanel} role="region" aria-labelledby="team-browser-authorization-title">
                <div className={styles.oauthInlineHeader}>
                  <div className={styles.oauthInlineStatus} role="status" aria-live="polite">
                    <span className={styles.actionSpinner} aria-hidden="true" />
                    <div>
                      <h2 id="team-browser-authorization-title">{t('browserAuthorizationTitle')}</h2>
                      <p>{t('browserAuthorizationHint')}</p>
                    </div>
                  </div>
                  <Button
                    className={styles.oauthCancelButton}
                    size="sm"
                    variant="ghost"
                    disabled={busy === `oauth-cancel-${activeBrowserAuthorization.accountId}`}
                    onClick={() => {
                      void cancelPresentedOAuth(
                        activeBrowserAuthorization.accountId,
                        activeBrowserAuthorization.expectedContext,
                        activeBrowserAuthorization.discardInitial,
                        activeBrowserAuthorization.returnSelection,
                      )
                    }}
                  >{t('cancelAuthorization')}</Button>
                </div>
                {oauthNavigationBlocked ? <p className={styles.oauthInlineWarning} role="alert">{t('browserPopupBlocked')}</p> : null}
                {oauthRefreshUnavailable ? <p className={styles.oauthInlineWarning} role="alert">{t('browserAuthorizationRefreshFailed')}</p> : null}
                <p className={styles.oauthInlineExpiry}>{t('expiresAt', { time: formatTime(activeBrowserAuthorization.expiresAt) })}</p>
              </section>
            : selectedAccount === undefined
            ? localProfilesLoading
              ? renderAccountDetailSkeleton()
              : <div className={styles.accountDetailEmpty}>
                  <strong>{t(localProfilesUnavailable ? 'localAccountsUnavailableTitle' : 'noLocalAccountsTitle')}</strong>
                  <p className={styles.empty}>{t(localProfilesUnavailable ? 'localAccountsUnavailableHint' : 'noLocalAccountsHint')}</p>
                </div>
            : selectedAccount.kind === 'local'
              ? renderLocalAccount(selectedAccount.account)
              : selectedAccount.kind === 'shared-directory'
                ? renderSharedDirectoryAccount(selectedAccount.account)
                : renderContributionAccount(selectedAccount.account)}
        </div>
      </section>
    )
  }

  return (
    <main className={styles.page}>
      {embedded ? null : <PageHeading t={t} />}
      {error === undefined || teamSettingsOpen ? null : <Notice tone="error" title={t('requestFailed')} detail={error} />}
      {!teamContextChanged || teamSettingsOpen ? null : (
        <Notice tone="warning" title={t('teamContextChangedTitle')} detail={t('teamContextChangedHint')} live="polite" />
      )}

      {teamSettingsOpen ? (
        <section className={styles.workspaceShell} role="region" aria-label={t('teamSettingsTitle')}>
          <aside className={styles.workspaceRail} aria-label={t('workspaceNavigation')}>
            <div className={styles.workspaceBrand}>
              <h2 className={styles.workspaceTitle}>{t('teamSettingsTitle')}</h2>
            </div>
            <nav className={styles.workspaceNavigation} aria-label={t('workspaceNavigation')}>
              <button type="button" aria-current={workspaceView === 'usage' ? 'page' : undefined} onClick={() => {
                setWorkspaceView('usage')
                setTeamMenuOpen(false)
                setMemberMenuId(undefined)
                setInviteRevealRequest(undefined)
              }}>{t('usageSectionTitle')}</button>
              <button type="button" aria-current={workspaceView === 'members' ? 'page' : undefined} onClick={() => {
                setWorkspaceView('members')
                setTeamMenuOpen(false)
                setMemberMenuId(undefined)
                setInviteRevealRequest(undefined)
              }}>{t('membersTitle')}</button>
              {overview.viewerRole === 'owner' ? (
                <button type="button" aria-current={workspaceView === 'invitations' ? 'page' : undefined} onClick={() => {
                  setWorkspaceView('invitations')
                  setTeamMenuOpen(false)
                  setMemberMenuId(undefined)
                  setInviteRevealRequest(undefined)
                }}>{t('invitationsTitle')}</button>
              ) : null}
            </nav>
            <button
              type="button"
              className={styles.workspaceBack}
              ref={workspaceBackRef}
              aria-label={t('backToTeam')}
              title={t('backToTeam')}
              onClick={() => {
                setTeamMenuOpen(false)
                setMemberMenuId(undefined)
                setInviteRevealRequest(undefined)
                restoreTeamSettingsTriggerFocus.current = true
                setTeamSettingsOpen(false)
              }}
            >
              <span aria-hidden="true">←</span>
            </button>
          </aside>
          <div className={styles.workspaceMain}>
            <header className={styles.workspaceHeader}>
              <div className={styles.workspaceHeaderCopy}>
                <div className={styles.workspaceIdentity}>
                  <h2 className={styles.workspaceTeamName}>{team.name}</h2>
                  <div className={styles.workspaceMeta}>
                    <span className={styles.workspaceStatus}><StateDot state={team.status === 'active' ? 'done' : 'warning'} />{team.status === 'active' ? t('teamActive') : t('teamPaused')}</span>
                    <span>{overview.viewerRole === 'owner' ? t('teamOwnerRole') : t('teamMemberRole')}</span>
                    <span>{t('membersCount', { count: activeMembers.length })}</span>
                  </div>
                </div>
              </div>

              <div className={styles.teamMenu}>
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={t('teamManagement')}
                  title={t('teamManagement')}
                  aria-haspopup="menu"
                  aria-expanded={teamMenuOpen}
                  data-team-settings-focus="team-menu"
                  disabled={busy !== undefined}
                  onClick={() => { setTeamMenuOpen(open => !open) }}
                ><span className={styles.teamMenuDots} aria-hidden="true">•••</span></Button>
                {teamMenuOpen ? (
                  <div className={styles.teamMenuPopover} role="menu" aria-label={t('teamManagement')}>
                    {canManageTeam ? (
                      <>
                        <span className={styles.teamMenuLabel}>{t('teamOperationGroup')}</span>
                        <button type="button" role="menuitem" onClick={() => {
                          if (ownerAuthorizationContext === undefined) return
                          setTeamMenuOpen(false)
                          setError(undefined)
                          teamSettingsReturnFocus.current = 'team-menu'
                          setTeamStatusConfirmation({
                            targetStatus: team.status === 'active' ? 'paused' : 'active',
                            expectedLifecycleRevision: team.lifecycleRevision,
                            teamName: team.name,
                            authorizationContext: ownerAuthorizationContext,
                          })
                        }}>{team.status === 'active' ? t('pauseTeam') : t('resumeTeam')}</button>
                        <span className={styles.teamMenuLabel}>{t('ownershipGroup')}</span>
                        <button type="button" role="menuitem" disabled={eligibleOwnershipTargets.length === 0 || ownershipTransfer !== undefined} onClick={() => {
                          if (ownerAuthorizationContext === undefined) return
                          setTeamMenuOpen(false)
                          setError(undefined)
                          setOwnershipTransferTargetId('')
                          teamSettingsReturnFocus.current = 'team-menu'
                          setOwnershipTransferAuthorizationContext(ownerAuthorizationContext)
                          setOwnershipTransferOpen(true)
                        }}>{t('transferOwnership')}</button>
                        <span className={styles.teamMenuLabel}>{t('teamLifecycleGroup')}</span>
                        <button type="button" role="menuitem" className={styles.teamMenuDanger} onClick={() => {
                          if (ownerAuthorizationContext === undefined) return
                          setTeamMenuOpen(false)
                          setError(undefined)
                          setDissolutionConfirmationName('')
                          teamSettingsReturnFocus.current = 'team-menu'
                          setDissolutionAuthorizationContext(ownerAuthorizationContext)
                          setDissolutionOpen(true)
                        }}>{t('dissolveTeam')}</button>
                        <p className={styles.teamMenuHint}>{t('ownerLeaveUnavailable')}</p>
                      </>
                    ) : (
                      <>
                        <span className={styles.teamMenuLabel}>{t('membershipGroup')}</span>
                        <button type="button" role="menuitem" className={styles.teamMenuDanger} disabled={!status.keyWritable || !canLeaveTeam} onClick={() => {
                          if (memberAuthorizationContext === undefined) return
                          setTeamMenuOpen(false)
                          teamSettingsReturnFocus.current = 'team-menu'
                          setLeaveAuthorizationContext(memberAuthorizationContext)
                          setLeaveOpen(true)
                        }}>{t('leaveTeam')}</button>
                      </>
                    )}
                  </div>
                ) : null}
              </div>
            </header>

            <div className={styles.workspaceBody}>

            {error === undefined ? null : <Notice tone="error" title={t('requestFailed')} detail={error} />}
            {!teamContextChanged ? null : (
              <Notice tone="warning" title={t('teamContextChangedTitle')} detail={t('teamContextChangedHint')} live="polite" />
            )}
            {renderDisplayNameMigrationNotice()}

          {currentMemberIsTransferRequester && ownershipTransfer !== undefined ? (
            <section className={styles.ownershipPanel} data-pending="true" aria-labelledby="team-ownership-title">
              <div className={styles.ownershipCopy}>
                <h3 id="team-ownership-title" className={styles.settingsCardTitle}>{t('ownershipTitle')}</h3>
                <p className={styles.ownershipMessage}>{t('ownershipTransferRequested', {
                  name: ownershipTransferTarget?.displayName ?? ownershipTransfer.targetMemberId,
                })}</p>
                <p className={styles.ownershipMeta}>{t('ownershipTransferExpires', { time: formatTime(ownershipTransfer.expiresAt) })}</p>
              </div>
              <div className={styles.ownershipActions}>
                <Button size="sm" variant="ghost" disabled={busy !== undefined || ownerExpectedContext === undefined} onClick={() => { void run('ownership-transfer-revoke', async () => {
                  const expectedContext = ownerExpectedContextRef.current
                  if (expectedContext === undefined) return
                  await api.revokeOwnershipTransfer(ownershipTransfer.id, expectedContext)
                  await refresh(false)
                }) }}>
                  {busy === 'ownership-transfer-revoke' ? t('working') : t('revokeOwnershipTransfer')}
                </Button>
              </div>
            </section>
          ) : currentMemberIsTransferTarget && ownershipTransfer !== undefined ? (
            <section className={styles.ownershipPanel} data-pending="true" aria-labelledby="team-ownership-title">
              <div className={styles.ownershipCopy}>
                <h3 id="team-ownership-title" className={styles.settingsCardTitle}>{t('ownershipTitle')}</h3>
                <p className={styles.ownershipMessage}>{t('ownershipTransferInvitation', {
                  name: ownershipTransferRequester?.displayName ?? ownershipTransfer.requestedByMemberId,
                })}</p>
                <p className={styles.hint}>{t('ownershipTransferInvitationHint')}</p>
                <p className={styles.ownershipMeta}>{t('ownershipTransferExpires', { time: formatTime(ownershipTransfer.expiresAt) })}</p>
              </div>
              <div className={styles.ownershipActions}>
                <Button size="sm" variant="primary" disabled={busy !== undefined || teamExpectedContext === undefined} onClick={() => { void run('ownership-transfer-accept', async () => {
                  const expectedContext = teamExpectedContextRef.current
                  if (expectedContext === undefined) return
                  await api.acceptOwnershipTransfer(ownershipTransfer.id, expectedContext)
                  await refresh(false)
                }) }}>
                  {busy === 'ownership-transfer-accept' ? t('working') : t('acceptOwnershipTransfer')}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy !== undefined || teamExpectedContext === undefined} onClick={() => { void run('ownership-transfer-reject', async () => {
                  const expectedContext = teamExpectedContextRef.current
                  if (expectedContext === undefined) return
                  await api.rejectOwnershipTransfer(ownershipTransfer.id, expectedContext)
                  await refresh(false)
                }) }}>
                  {busy === 'ownership-transfer-reject' ? t('working') : t('rejectOwnershipTransfer')}
                </Button>
              </div>
            </section>
          ) : null}

          {workspaceView === 'usage' ? (
            <TeamUsageSection
              loading={usageLoading}
              projection={usageProjection}
              unavailable={usageUnavailable}
              onRefresh={() => { void refresh(false) }}
              t={t}
            />
          ) : null}

          {workspaceView === 'members' ? (
            <section className={styles.workspaceSection} aria-labelledby="team-members-title">
              <div className={styles.workspaceSectionHeader}>
                <div>
                  <h3 id="team-members-title" className={styles.workspaceSectionTitle}>{t('membersTitle')}</h3>
                  <p className={styles.hint}>{t('membersIntro', { count: activeMembers.length })}</p>
                </div>
                {canManageTeam ? (
                  <Button size="sm" variant="primary" icon={<IconPlusOutline16 />} onClick={() => {
                    setWorkspaceView('invitations')
                  }}>{t('inviteFriend')}</Button>
                ) : null}
              </div>
              <div className={styles.memberList} role="list" aria-label={t('membersTitle')}>
                {activeMembers.map(member => (
                  <div className={styles.memberRow} role="listitem" key={member.id}>
                    <div className={styles.identity}>
                      <span className={styles.name}>{member.displayName}</span>
                    </div>
                    <div className={styles.compactActions}>
                      <Pill className={styles.pill}>
                        {member.role === 'owner' ? t('teamOwnerRole') : t('teamMemberRole')}
                        {member.id === currentMember?.id ? ` · ${t('currentUser')}` : ''}
                      </Pill>
                      {canManageTeam && currentMember !== undefined && canRemoveTeamMember(currentMember, member) ? (
                        <div className={styles.memberMenu}>
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={t('manageMember', { name: member.displayName })}
                            aria-haspopup="menu"
                            aria-expanded={memberMenuId === member.id}
                            data-team-settings-focus={`member-menu:${member.id}`}
                            disabled={busy !== undefined}
                            onClick={() => { setMemberMenuId(current => current === member.id ? undefined : member.id) }}
                          >···</Button>
                          {memberMenuId === member.id ? (
                            <div className={styles.memberMenuPopover} role="menu" aria-label={t('manageMember', { name: member.displayName })}>
                              <button type="button" role="menuitem" onClick={() => {
                                if (ownerAuthorizationContext === undefined) return
                                setMemberMenuId(undefined)
                                teamSettingsReturnFocus.current = `member-menu:${member.id}`
                                setRemoveMemberAuthorizationContext(ownerAuthorizationContext)
                                setRemoveMember(member)
                              }}>{t('removeMember')}</button>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {overview.viewerRole === 'owner' && workspaceView === 'invitations' ? <section className={styles.workspaceSection} aria-labelledby="team-invites-title">
              <div className={styles.workspaceSectionHeader}>
                <div>
                  <h3 id="team-invites-title" className={styles.workspaceSectionTitle}>{t('invitationsTitle')}</h3>
                  <p className={styles.hint}>{t('invitationsIntro')}</p>
                </div>
                <Button size="sm" variant="primary" icon={<IconPlusOutline16 />} data-team-settings-focus="invite" disabled={busy !== undefined || team.status !== 'active'} onClick={() => {
                  if (team.status !== 'active' || ownerAuthorizationContext === undefined) return
                  inviteCreationPresentationId.current += 1
                  teamSettingsReturnFocus.current = 'invite'
                  setInviteDraft({
                    expiresInMs: 7 * 86_400_000,
                    authorizationContext: ownerAuthorizationContext,
                  })
                }}>
                  {t('inviteFriend')}
                </Button>
              </div>
              {team.status === 'paused' ? <p className={styles.invitePauseNotice}>{t('invitesPausedHint')}</p> : null}
              {pendingInvites.length === 0 ? <p className={styles.settingsEmpty}>{t('noPendingInvites')}</p> : (
                <div className={styles.pendingInviteList}>
                  {pendingInvites.map(invite => (
                    <div className={styles.inviteRow} key={invite.id}>
                      <div className={styles.inviteIdentity}>
                        <span className={styles.name}>{invite.label}</span>
                        <span className={styles.meta}>{t('pendingInviteCreatedBy', {
                          name: members.get(invite.invitedByMemberId)?.displayName ?? invite.invitedByMemberId,
                          time: formatTime(invite.createdAt),
                        })}</span>
                        <span className={styles.meta}>{t('pendingInviteExpires', { time: formatTime(invite.expiresAt) })}</span>
                        {team.status === 'paused' ? <span className={styles.invitePausedState}>{t('invitePausedState')}</span> : null}
                      </div>
                      <div className={styles.inviteActions}>
                        {invite.revealable ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            data-team-settings-focus={`invite-reveal:${invite.id}`}
                            disabled={busy !== undefined || inviteRevealRequest !== undefined}
                            onClick={() => {
                              if (ownerAuthorizationContext === undefined) return
                              setError(undefined)
                              teamSettingsReturnFocus.current = `invite-reveal:${invite.id}`
                              setInviteRevealRequest({
                                inviteId: invite.id,
                                authorizationContext: ownerAuthorizationContext,
                              })
                            }}
                          >{t('revealInvite')}</Button>
                        ) : <span className={styles.inviteNotRevealable}>{t('inviteNotRevealable')}</span>}
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<IconTrashOutline16 />}
                          data-team-settings-focus={`invite-revoke:${invite.id}`}
                          disabled={busy !== undefined}
                          onClick={() => {
                            if (ownerAuthorizationContext === undefined) return
                            teamSettingsReturnFocus.current = `invite-revoke:${invite.id}`
                            setRevokeInviteAuthorizationContext(ownerAuthorizationContext)
                            setRevokeInvite(invite)
                          }}
                        >
                          {t('revokeInvite')}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section> : null}

            </div>
          </div>
        </section>
      ) : (
        <section className={styles.teamOverview} role="region" aria-label={t('teamPanelTitle')}>
          <header className={styles.teamBar}>
            <div className={styles.teamIdentity}>
              <StateDot state={team.status === 'active' ? 'done' : 'warning'} />
              <div>
                <h2 className={styles.teamName}>{team.name}</h2>
                <p className={styles.hint}>{t('membersCount', { count: activeMembers.length })}</p>
              </div>
            </div>
            <button
              ref={teamSettingsTriggerRef}
              type="button"
              className={styles.teamSettingsTrigger}
              onClick={() => {
                setWorkspaceView('usage')
                setTeamSettingsOpen(true)
              }}
            >{t('teamSettings')}</button>
          </header>
          {renderAccountsPanel()}
        </section>
      )}

      <Modal
        open={activePendingLocalAuthorization !== undefined}
        onClose={() => { if (busy === undefined) setPendingLocalAuthorization(undefined) }}
        title={t('localAuthorizationConfirmTitle', { label: activePendingLocalAuthorization?.label ?? '' })}
        closeLabel={t('close')}
        description={t('localAuthorizationConfirmHint')}
        footer={(
          <div className={styles.modalActions}>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== undefined}
              onClick={() => { setPendingLocalAuthorization(undefined) }}
            >{t('cancel')}</Button>
            <Button
              size="sm"
              variant="primary"
              disabled={busy !== undefined || authorizationSnapshotPending || activePendingLocalAuthorization === undefined}
              aria-busy={activePendingLocalAuthorization === undefined ? false : busy === `share-local-${activePendingLocalAuthorization.id}`}
              onClick={() => {
                const pending = activePendingLocalAuthorization
                if (
                  pending === undefined
                  || authorizationSnapshotPending
                  || pending.authorizationContext !== teamAuthorizationContext
                ) return
                void startBrowserOAuth(
                  pending.label,
                  `share-local-${pending.id}`,
                  pending.id,
                  () => { setPendingLocalAuthorization(undefined) },
                  pending.expectedContext,
                )
              }}
            >{activePendingLocalAuthorization !== undefined && busy === `share-local-${activePendingLocalAuthorization.id}`
                ? <><span className={styles.actionSpinner} aria-hidden="true" />{t('working')}</>
                : t('localAuthorizationConfirmAction')}</Button>
          </div>
        )}
      >
        <div className={styles.localAuthorizationConfirmation}>
          <p>{t('localAuthorizationConfirmBody', { team: team.name })}</p>
          <section className={styles.sharingQuotaConfirmation} role="region" aria-label={t('sharingQuotaConfirmation')}>
            <div className={styles.sharingQuotaMeter} aria-hidden="true">
              <span style={{ width: `${activePendingLocalProfile?.remainingPercent ?? 0}%` }} />
              <i style={{ left: `${DEFAULT_PERSONAL_RESERVE_PERCENT}%` }} />
            </div>
            <dl className={styles.sharingQuotaFacts}>
              <div>
                <dt>{t('sharingQuotaCurrent')}</dt>
                <dd>{activePendingLocalProfile?.remainingPercent === undefined
                  ? t('sharingQuotaUnavailable')
                  : `${activePendingLocalProfile.remainingPercent}%`}</dd>
              </div>
              <div>
                <dt>{t('sharingQuotaReserve')}</dt>
                <dd>{DEFAULT_PERSONAL_RESERVE_PERCENT}%</dd>
              </div>
              <div>
                <dt>{t('sharingQuotaWeeklyLimit')}</dt>
                <dd>{t('sharingQuotaNoWeeklyLimit')}</dd>
              </div>
            </dl>
            <p className={styles.sharingQuotaHint}>{t('sharingQuotaConfirmationHint', { reserve: DEFAULT_PERSONAL_RESERVE_PERCENT })}</p>
          </section>
          <p className={styles.localAuthorizationSafety}>
            <strong>{t('localCredentialBoundary')}</strong> {t('localAuthorizationConfirmSafety')}
          </p>
        </div>
      </Modal>

      <Modal
        open={addAccountOpen}
        onClose={() => { if (busy === undefined) setAddAccountOpen(false) }}
        title={t('addAccountTitle')}
        closeLabel={t('close')}
        description={t('addAccountHint')}
        footer={(
          <div className={styles.modalActions}>
            <Button size="sm" variant="ghost" disabled={busy !== undefined} onClick={() => { setAddAccountOpen(false) }}>{t('cancel')}</Button>
            <Button size="sm" variant="primary" disabled={busy !== undefined || accountLabel.trim() === ''} onClick={() => {
              void startBrowserOAuth(accountLabel, 'oauth-start', undefined, () => { setAddAccountOpen(false) })
            }}>{busy === 'oauth-start' ? t('working') : t('startAuthorization')}</Button>
          </div>
        )}
      >
        <label className={styles.field}>
          <span className={styles.label}>{t('accountLabel')}</span>
          <Input value={accountLabel} placeholder={t('accountLabelPlaceholder')} onChange={event => { setAccountLabel(event.target.value) }} />
        </label>
      </Modal>

      <Modal
        open={oauth?.method === 'device_code'}
        onClose={() => { if (busy === undefined && oauth?.method === 'device_code') void cancelPresentedOAuth(oauth.account.id) }}
        title={t('deviceTitle')}
        closeLabel={t('close')}
        description={t('deviceHint')}
        footer={(
          <div className={styles.modalActions}>
            <Button size="sm" variant="ghost" disabled={busy !== undefined} onClick={() => {
              if (oauth?.method === 'device_code') void cancelPresentedOAuth(oauth.account.id)
            }}>{t('cancelAuthorization')}</Button>
            {oauth?.method === 'device_code' ? <a href={oauth.verificationUrl} target="_blank" rel="noreferrer">{t('openProvider')}</a> : null}
            <Button size="sm" variant="primary" disabled={busy !== undefined} onClick={() => {
              if (oauth?.method === 'device_code') {
                void run(`oauth-check-${oauth.account.id}`, async () => { await refresh(false) })
              }
            }}>{t('checkAuthorization')}</Button>
          </div>
        )}
      >
        {oauth?.method !== 'device_code' ? null : (
          <div className={styles.panel}>
            <span className={styles.label}>{t('deviceCode')}</span>
            <strong>{oauth.userCode}</strong>
            <span className={styles.meta}>{t('expiresAt', { time: formatTime(oauth.expiresAt) })}</span>
          </div>
        )}
      </Modal>

      <Modal
        open={protectionEdit !== undefined}
        onClose={() => { if (busy === undefined) setProtectionEdit(undefined) }}
        title={t('editProtection')}
        closeLabel={t('close')}
        footer={(
          <div className={styles.modalActions}>
            <Button size="sm" variant="ghost" disabled={busy !== undefined} onClick={() => { setProtectionEdit(undefined) }}>{t('cancel')}</Button>
            <Button size="sm" variant="primary" disabled={busy !== undefined} aria-busy={busy?.startsWith('protection-') === true} onClick={() => {
              if (protectionEdit === undefined) return
              const result = parseContributionProtectionDraft(protectionEdit)
              if (!result.ok) {
                setError(t(result.field === 'reserve'
                  ? 'reserveValidation'
                  : result.field === 'requestCap'
                    ? 'requestCapValidation'
                    : result.field === 'weeklyLimitUsd'
                      ? 'weeklyLimitValidation'
                      : 'allowedModelsValidation'))
                return
              }
              void run(`protection-${protectionEdit.account.id}`, async () => {
                const expectedContext = teamExpectedContextRef.current
                if (expectedContext === undefined) return
                await api.updateContribution(protectionEdit.account.id, result.patch, expectedContext)
                setProtectionEdit(undefined)
                await refresh(false)
              })
            }}>{busy?.startsWith('protection-') === true
              ? <><span className={styles.actionSpinner} aria-hidden="true" />{t('savingContribution')}</>
              : t('save')}</Button>
          </div>
        )}
      >
        {protectionEdit === undefined ? null : (
          <div className={styles.connectionGrid}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="team-account-weekly-limit">{t('weeklyLimitLabel')}</label>
              <Input id="team-account-weekly-limit" value={protectionEdit.weeklyLimitUsd} placeholder={t('weeklyLimitPlaceholder')} onChange={event => { setProtectionEdit(current => current === undefined ? current : { ...current, weeklyLimitUsd: event.target.value }) }} />
              <span className={styles.hint}>{t('weeklyLimitHint')}</span>
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="team-account-reserve">{t('reserveLabel')}</label>
              <Input id="team-account-reserve" value={protectionEdit.reserve} onChange={event => { setProtectionEdit(current => current === undefined ? current : { ...current, reserve: event.target.value }) }} />
              <span className={styles.hint}>{t('reserveHint')}</span>
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="team-account-request-cap">{t('requestCapLabel')}</label>
              <Input id="team-account-request-cap" value={protectionEdit.requestCap} placeholder={t('requestCapPlaceholder')} onChange={event => { setProtectionEdit(current => current === undefined ? current : { ...current, requestCap: event.target.value }) }} />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="team-account-models">{t('allowedModelsLabel')}</label>
              <Input id="team-account-models" value={protectionEdit.models} placeholder={t('allowedModelsPlaceholder')} onChange={event => { setProtectionEdit(current => current === undefined ? current : { ...current, models: event.target.value }) }} />
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={recentUsageAccount !== undefined}
        onClose={() => { setRecentUsageAccount(undefined) }}
        title={recentUsageAccount === undefined ? t('recentRequests') : t('recentRequestsFor', { label: recentUsageAccount.label })}
        closeLabel={t('close')}
      >
        {recentUsageAccount === undefined ? null : (() => {
          const requests = recentUsageAccount.kind === 'contribution'
            ? usageProjection?.ownedAccounts?.find(item => item.accountId === recentUsageAccount.id)?.recentRequests ?? []
            : []
          return requests.length === 0
            ? <p className={styles.empty}>{t('noRecentRequests')}</p>
            : <div className={styles.recentRequestList}>{requests.map(request => (
              <div className={styles.recentRequest} key={request.id}>
                <div><strong>{request.model}</strong><span>{formatTime(request.startedAt)}</span></div>
                <div><span>{request.status}</span><span>{request.totalTokens ?? '—'} tokens</span></div>
              </div>
            ))}</div>
        })()}
      </Modal>

      <Modal
        open={activeTeamStatusConfirmation !== undefined}
        onClose={() => {
          if (busy === 'team-status') return
          setTeamStatusConfirmation(undefined)
          setTeamSettingsOpen(true)
        }}
        title={activeTeamStatusConfirmation === undefined
          ? t('pauseTeam')
          : t(activeTeamStatusConfirmation.targetStatus === 'paused' ? 'pauseTeamTitle' : 'resumeTeamTitle', { name: activeTeamStatusConfirmation.teamName })}
        closeLabel={t('close')}
        description={t(activeTeamStatusConfirmation?.targetStatus === 'paused' ? 'pauseTeamHint' : 'resumeTeamHint')}
        footer={(
          <div className={styles.modalActions}>
            <Button variant="ghost" disabled={busy === 'team-status'} onClick={() => {
              setTeamStatusConfirmation(undefined)
              setTeamSettingsOpen(true)
            }}>{t('cancel')}</Button>
            <Button variant="primary" disabled={busy !== undefined || activeTeamStatusConfirmation === undefined || ownerAuthorizationContext === undefined} onClick={() => {
              if (activeTeamStatusConfirmation === undefined || ownerAuthorizationContext === undefined) return
              if (ownerAuthorizationContextRef.current !== activeTeamStatusConfirmation.authorizationContext) return
              const expectedContext = ownerExpectedContextRef.current
              if (expectedContext === undefined) return
              const confirmation = activeTeamStatusConfirmation
              void run('team-status', async () => {
                await api.setTeamStatus(confirmation.targetStatus, confirmation.expectedLifecycleRevision, expectedContext)
                setTeamStatusConfirmation(undefined)
                await refresh(false)
              })
            }}>
              {busy === 'team-status'
                ? t('working')
                : t(activeTeamStatusConfirmation?.targetStatus === 'paused' ? 'confirmPauseTeam' : 'confirmResumeTeam')}
            </Button>
          </div>
        )}
      >
        {error === undefined ? null : <Notice tone="error" title={t('requestFailed')} detail={error} />}
        {activeTeamStatusConfirmation === undefined ? null : (
          <ul className={styles.teamStatusConsequences} data-team-dialog-focus="team-status" tabIndex={-1}>
            {activeTeamStatusConfirmation.targetStatus === 'paused' ? (
              <>
                <li>{t('pauseTeamRequestsEffect')}</li>
                <li>{t('pauseTeamInvitesEffect')}</li>
                <li>{t('pauseTeamDataEffect')}</li>
              </>
            ) : (
              <>
                <li>{t('resumeTeamRequestsEffect')}</li>
                <li>{t('resumeTeamSharingEffect')}</li>
              </>
            )}
          </ul>
        )}
      </Modal>

      <Modal
        open={activeDissolutionOpen}
        onClose={() => {
          if (busy === 'dissolve-team') return
          setDissolutionOpen(false)
          setDissolutionAuthorizationContext(undefined)
          setDissolutionConfirmationName('')
          setTeamSettingsOpen(true)
        }}
        title={t('dissolveTeamTitle', { name: team.name })}
        closeLabel={t('close')}
        description={t('dissolveTeamHint')}
        footer={(
          <div className={styles.modalActions}>
            <Button variant="ghost" disabled={busy === 'dissolve-team'} onClick={() => {
              setDissolutionOpen(false)
              setDissolutionAuthorizationContext(undefined)
              setDissolutionConfirmationName('')
              setTeamSettingsOpen(true)
            }}>{t('cancel')}</Button>
            <Button
              variant="primary"
              disabled={busy !== undefined || !activeDissolutionOpen || ownerAuthorizationContext === undefined || dissolutionConfirmationName !== team.name}
              onClick={() => {
                if (!activeDissolutionOpen || ownerAuthorizationContext === undefined) return
                if (dissolutionAuthorizationContext === undefined
                  || ownerAuthorizationContextRef.current !== dissolutionAuthorizationContext) return
                const expectedContext = ownerExpectedContextRef.current
                if (expectedContext === undefined) return
                const confirmationName = dissolutionConfirmationName
                const expectedLifecycleRevision = team.lifecycleRevision
                void run('dissolve-team', async () => {
                const result = await api.dissolveTeam({
                  confirmationName,
                  expectedLifecycleRevision,
                }, expectedContext)
                setDissolution(result)
                setDissolutionOpen(false)
                setDissolutionAuthorizationContext(undefined)
                setTeamSettingsOpen(false)
                })
              }}
            >{busy === 'dissolve-team' ? t('dissolvingTeam') : t('dissolveTeam')}</Button>
          </div>
        )}
      >
        {error === undefined ? null : <Notice tone="error" title={t('requestFailed')} detail={error} />}
        <div className={styles.dissolutionDialogBody} data-team-dialog-focus="dissolve" tabIndex={-1}>
          <ul className={styles.dissolutionConsequences}>
            <li>{t('dissolutionMembersConsequence')}</li>
            <li>{t('dissolutionInvitesConsequence')}</li>
            <li>{t('dissolutionDevicesConsequence')}</li>
            <li>{t('dissolutionAccountsConsequence')}</li>
          </ul>
          <Field label={t('dissolutionConfirmationLabel')}>
            <Input
              value={dissolutionConfirmationName}
              maxLength={512}
              autoComplete="off"
              spellCheck={false}
              disabled={busy === 'dissolve-team' || !activeDissolutionOpen}
              onChange={event => { setDissolutionConfirmationName(event.target.value) }}
            />
          </Field>
        </div>
      </Modal>

      <Modal
        open={activeInviteDraft !== undefined}
        onClose={closeInviteDraft}
        title={t('createInviteTitle')}
        closeLabel={t('close')}
        description={t('createInviteHint')}
        footer={(
          <div className={styles.modalActions}>
            <Button variant="ghost" onClick={closeInviteDraft}>{t('cancel')}</Button>
            <Button variant="primary" disabled={busy !== undefined || ownerAuthorizationContext === undefined || team.status !== 'active'} onClick={() => { if (activeInviteDraft !== undefined && ownerAuthorizationContext !== undefined && team.status === 'active') void run('invite', async () => {
              const authorizationContext = activeInviteDraft.authorizationContext
              if (ownerAuthorizationContextRef.current !== authorizationContext) return
              const expectedContext = ownerExpectedContextRef.current
              if (expectedContext === undefined) return
              const presentationId = ++inviteCreationPresentationId.current
              const result = await api.createInvite(t('inviteFriend'), activeInviteDraft.expiresInMs, expectedContext)
              if (inviteCreationPresentationId.current !== presentationId) {
                await refresh(false)
                return
              }
              setInviteDraft(undefined)
              const refreshed = await refresh(false)
              if (
                inviteCreationPresentationId.current !== presentationId
                || !documentAllowsInviteSecret()
                || createOwnerAuthorizationContext(refreshed?.status, refreshed?.overview) !== authorizationContext
              ) return
              setInviteResult({
                token: result.inviteToken,
                expiresAt: result.invite.expiresAt,
                authorizationContext,
              })
            }) }}>{busy === 'invite' ? t('working') : t('createInvite')}</Button>
          </div>
        )}
      >
        {activeInviteDraft === undefined ? null : (
          <div className={styles.modalBody}>
            {error === undefined ? null : <Notice tone="error" title={t('requestFailed')} detail={error} />}
            <Field label={t('inviteExpiry')}>
              <select aria-label={t('inviteExpiry')} className={styles.select} data-team-dialog-focus="invite" value={activeInviteDraft.expiresInMs} onChange={event => {
                setInviteDraft({ ...activeInviteDraft, expiresInMs: Number(event.target.value) })
              }}>
                <option value={86_400_000}>{t('inviteOneDay')}</option>
                <option value={7 * 86_400_000}>{t('inviteSevenDays')}</option>
                <option value={30 * 86_400_000}>{t('inviteThirtyDays')}</option>
              </select>
            </Field>
          </div>
        )}
      </Modal>

      {activeInviteRevealRequest === undefined ? null : (
        <InviteRevealModal
          inviteId={activeInviteRevealRequest.inviteId}
          authorizationContext={activeInviteRevealRequest.authorizationContext}
          getAuthorizationContext={getOwnerAuthorizationContext}
          getExpectedContext={getOwnerExpectedContext}
          t={t}
          onClose={closeInviteReveal}
          onFailure={handleInviteRevealFailure}
        />
      )}

      <Modal open={visibleInviteResult !== undefined} onClose={closeInviteResult} title={t('inviteCreated')} closeLabel={t('close')} {...visibleInviteResult === undefined ? {} : { description: t('inviteCreatedHint', { time: formatTime(visibleInviteResult.expiresAt) }) }} footer={(
        <Button variant="primary" onClick={closeInviteResult}>{t('close')}</Button>
      )}>
        {visibleInviteResult === undefined ? null : (
          <div className={styles.modalBody}>
            <p className={styles.dangerNote}>{t('inviteCredentialWarning')}</p>
            <div className={styles.secretValue}>
              <span className={styles.code} data-team-dialog-focus="invite-result" tabIndex={-1}>{visibleInviteResult.token}</span>
              <Button size="sm" variant="ghost" icon={<IconCopyOutline16 />} onClick={() => {
                void writeClipboard(visibleInviteResult.token).then(success => { if (success) setCopied(true) })
              }}>{copied ? t('copied') : t('copyInvite')}</Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={activeRevokeInvite !== undefined}
        onClose={() => {
          if (busy === 'invite-revoke') return
          setRevokeInvite(undefined)
          setRevokeInviteAuthorizationContext(undefined)
          setTeamSettingsOpen(true)
        }}
        title={activeRevokeInvite === undefined ? t('revokeInvite') : t('revokeInviteTitle', { label: activeRevokeInvite.label })}
        closeLabel={t('close')}
        description={t('revokeInviteHint')}
        footer={(
          <div className={styles.modalActions}>
            <Button variant="ghost" disabled={busy === 'invite-revoke'} onClick={() => {
              setRevokeInvite(undefined)
              setRevokeInviteAuthorizationContext(undefined)
              setTeamSettingsOpen(true)
            }}>{t('cancel')}</Button>
            <Button variant="primary" disabled={busy !== undefined || activeRevokeInvite === undefined || ownerAuthorizationContext === undefined} onClick={() => {
              if (activeRevokeInvite === undefined || ownerAuthorizationContext === undefined) return
              if (revokeInviteAuthorizationContext === undefined
                || ownerAuthorizationContextRef.current !== revokeInviteAuthorizationContext) return
              const expectedContext = ownerExpectedContextRef.current
              if (expectedContext === undefined) return
              const invitation = activeRevokeInvite
              void run('invite-revoke', async () => {
                await api.revokeInvite(invitation.id, expectedContext)
                setRevokeInvite(undefined)
                setRevokeInviteAuthorizationContext(undefined)
                await refresh(false)
              })
            }}>{busy === 'invite-revoke' ? t('working') : t('revokeInvite')}</Button>
          </div>
        )}
      >
        {error === undefined ? null : <Notice tone="error" title={t('requestFailed')} detail={error} />}
        <p className={styles.dangerNote} data-team-dialog-focus="invite-revoke" tabIndex={-1}>{t('revokeInviteWarning')}</p>
      </Modal>

      <Modal
        open={activeOwnershipTransferOpen}
        onClose={() => {
          if (busy === 'ownership-transfer-request') return
          setOwnershipTransferOpen(false)
          setOwnershipTransferAuthorizationContext(undefined)
          setOwnershipTransferTargetId('')
          setTeamSettingsOpen(true)
        }}
        title={selectedOwnershipTarget === undefined
          ? t('transferOwnership')
          : t('transferOwnershipTitle', { name: selectedOwnershipTarget.displayName })}
        closeLabel={t('close')}
        {...selectedOwnershipTarget === undefined ? {} : {
          description: t('transferOwnershipHint', { name: selectedOwnershipTarget.displayName }),
        }}
        footer={(
          <div className={styles.modalActions}>
            <Button variant="ghost" disabled={busy === 'ownership-transfer-request'} onClick={() => {
              setOwnershipTransferOpen(false)
              setOwnershipTransferAuthorizationContext(undefined)
              setOwnershipTransferTargetId('')
              setTeamSettingsOpen(true)
            }}>{t('cancel')}</Button>
            <Button variant="primary" disabled={busy !== undefined || !activeOwnershipTransferOpen || selectedOwnershipTarget === undefined || ownerAuthorizationContext === undefined} onClick={() => {
              if (!activeOwnershipTransferOpen || selectedOwnershipTarget === undefined || ownerAuthorizationContext === undefined) return
              if (ownershipTransferAuthorizationContext === undefined
                || ownerAuthorizationContextRef.current !== ownershipTransferAuthorizationContext) return
              const expectedContext = ownerExpectedContextRef.current
              if (expectedContext === undefined) return
              const target = selectedOwnershipTarget
              void run('ownership-transfer-request', async () => {
                await api.requestOwnershipTransfer(target.id, expectedContext)
                setOwnershipTransferOpen(false)
                setOwnershipTransferAuthorizationContext(undefined)
                setOwnershipTransferTargetId('')
                teamSettingsReturnFocus.current = undefined
                await refresh(false)
              })
            }}>{busy === 'ownership-transfer-request' ? t('working') : t('confirmTransferOwnership')}</Button>
          </div>
        )}
      >
        {error === undefined ? null : <Notice tone="error" title={t('requestFailed')} detail={error} />}
        <fieldset className={styles.ownershipTargetList} data-team-dialog-focus="transfer" tabIndex={-1}>
          <legend>{t('selectOwnershipSuccessor')}</legend>
          {eligibleOwnershipTargets.length === 0 ? (
            <p className={styles.ownershipMeta}>{t('noEligibleOwnershipTarget')}</p>
          ) : eligibleOwnershipTargets.map(member => (
            <label className={styles.ownershipTargetOption} key={member.id}>
              <input
                type="radio"
                name="ownership-transfer-target"
                value={member.id}
                checked={ownershipTransferTargetId === member.id}
                onChange={() => { setOwnershipTransferTargetId(member.id) }}
              />
              <span>{member.displayName}</span>
            </label>
          ))}
        </fieldset>
      </Modal>

      <Modal
        open={activeRemoveMember !== undefined}
        onClose={() => {
          if (busy?.startsWith('member-remove-') === true) return
          setRemoveMember(undefined)
          setRemoveMemberAuthorizationContext(undefined)
          setTeamSettingsOpen(true)
        }}
        title={activeRemoveMember === undefined ? t('removeMember') : t('removeMemberTitle', { name: activeRemoveMember.displayName })}
        closeLabel={t('close')}
        {...activeRemoveMember === undefined ? {} : { description: t('removeMemberHint', { name: activeRemoveMember.displayName }) }}
        footer={(
          <div className={styles.modalActions}>
            <Button variant="ghost" disabled={busy?.startsWith('member-remove-') === true} onClick={() => {
              setRemoveMember(undefined)
              setRemoveMemberAuthorizationContext(undefined)
              setTeamSettingsOpen(true)
            }}>{t('cancel')}</Button>
            <Button variant="primary" disabled={busy !== undefined || activeRemoveMember === undefined || ownerAuthorizationContext === undefined} onClick={() => {
              if (activeRemoveMember === undefined || ownerAuthorizationContext === undefined) return
              if (removeMemberAuthorizationContext === undefined
                || ownerAuthorizationContextRef.current !== removeMemberAuthorizationContext) return
              const expectedContext = ownerExpectedContextRef.current
              if (expectedContext === undefined) return
              const member = activeRemoveMember
              void run(`member-remove-${member.id}`, async () => {
                await api.removeMember(member.id, expectedContext)
                setRemoveMember(undefined)
                setRemoveMemberAuthorizationContext(undefined)
                teamSettingsReturnFocus.current = undefined
                await refresh(false)
              })
            }}>{busy?.startsWith('member-remove-') === true ? t('working') : t('confirmRemoveMember')}</Button>
          </div>
        )}
      >
        {error === undefined ? null : <Notice tone="error" title={t('requestFailed')} detail={error} />}
        <p className={styles.dangerNote} data-team-dialog-focus="remove" tabIndex={-1}>{t('removeMemberWarning')}</p>
      </Modal>

      <Modal open={activeLeaveOpen} onClose={() => { setLeaveOpen(false); setLeaveAuthorizationContext(undefined); setTeamSettingsOpen(true) }} title={t('leaveTeamTitle')} closeLabel={t('close')} description={t('leaveTeamHint')} footer={(
        <div className={styles.modalActions}>
          <Button variant="ghost" onClick={() => { setLeaveOpen(false); setLeaveAuthorizationContext(undefined); setTeamSettingsOpen(true) }}>{t('cancel')}</Button>
          <Button variant="primary" disabled={busy !== undefined || !activeLeaveOpen || memberAuthorizationContext === undefined || !status.keyWritable || !canLeaveTeam} onClick={() => {
            if (!activeLeaveOpen || leaveAuthorizationContext === undefined
              || memberAuthorizationContextRef.current !== leaveAuthorizationContext) return
            const expectedContext = memberExpectedContextRef.current
            if (expectedContext === undefined) return
            void run('leave-team', async () => {
            await api.leaveTeam(expectedContext)
            setLeaveOpen(false)
            setLeaveAuthorizationContext(undefined)
            teamSettingsReturnFocus.current = undefined
            await refresh(false)
            })
          }}>{t('confirmLeaveTeam')}</Button>
        </div>
      )}>
        {error === undefined ? null : <Notice tone="error" title={t('requestFailed')} detail={error} />}
        <p className={styles.dangerNote} data-team-dialog-focus="leave" tabIndex={-1}>{t('leaveTeamRevokeNote')}</p>
      </Modal>
    </main>
  )
}

function PageHeading({ t }: { t: TeamSettingsInjected['t'] }) {
  return (
    <header>
      <p className={styles.eyebrow}>DSH · CODEX</p>
      <h1 className={styles.title}>{t('title')}</h1>
      <p className={styles.intro}>{t('intro')}</p>
    </header>
  )
}

function Notice({ tone, title, detail, children, live }: {
  tone: 'success' | 'warning' | 'error'
  title: string
  detail?: string | undefined
  children?: React.ReactNode
  live?: 'polite' | 'assertive'
}) {
  return (
    <div className={styles.banner} data-tone={tone} role={tone === 'error' ? 'alert' : undefined}>
      <div aria-live={live} aria-atomic={live === undefined ? undefined : true}>
        <h2 className={styles.bannerTitle}>{title}</h2>
        {detail === undefined || detail === '' ? null : <p className={tone === 'error' ? styles.errorText : styles.body}>{detail}</p>}
      </div>
      {children}
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className={styles.field}>
      <span className={styles.label}>{label}</span>
      {children}
      {hint === undefined ? null : <span className={styles.hint}>{hint}</span>}
    </label>
  )
}

function RouteNode({ number, label, hint, current = false }: { number: string; label: string; hint: string; current?: boolean }) {
  return (
    <div className={styles.routeNode} {...current ? { 'aria-current': 'step' as const } : {}}>
      <span className={styles.routeMark}>{number}</span>
      <div>
        <div className={styles.routeLabel}>{label}</div>
        <div className={styles.routeHint}>{hint}</div>
      </div>
    </div>
  )
}

const USAGE_STATE_KEYS: Readonly<Record<TeamUsageState, TeamSettingsKey>> = {
  complete: 'usageStateComplete',
  partial: 'usageStatePartial',
  unpriced: 'usageStateUnpriced',
  unmeasured: 'usageStateUnmeasured',
  zero: 'usageStateZero',
}

function TeamUsageSection({ loading, projection, unavailable, onRefresh, t }: {
  loading: boolean
  projection: TeamManagementUsageResult | undefined
  unavailable: boolean
  onRefresh: () => void
  t: TeamSettingsInjected['t']
}) {
  return (
    <section className={styles.usageWorkspace} role="region" aria-labelledby="team-usage-title" aria-busy={loading}>
      <div className={styles.usageHeader}>
        <div>
          <h2 id="team-usage-title" className={styles.usageHeading}>{t('usageSectionTitle')}</h2>
          <p className={styles.hint}>{t('usageWindow24h')}</p>
        </div>
        {projection === undefined || unavailable ? null : (
          <Button
            className={styles.usageRefresh}
            size="sm"
            variant="ghost"
            icon={<IconRefreshOutline16 />}
            aria-label={t('refresh')}
            title={t('refresh')}
            disabled={loading}
            onClick={onRefresh}
          />
        )}
      </div>

      {unavailable ? (
        <div className={styles.usageUnavailable} role="alert">
          <span>{t('usageUnavailableTitle')}</span>
          <Button size="sm" variant="outline" disabled={loading} onClick={onRefresh}>{t('retry')}</Button>
        </div>
      ) : projection === undefined ? (
        <p className={styles.usageLoading} role="status">{t('loadingUsage')}</p>
      ) : (
        <div className={styles.usageCards} data-owner={projection.role === 'owner'}>
          {projection.role === 'owner' ? (
            <TeamUsageCard id="team-usage-total" title={t('teamUsage')} aggregate={projection.team} t={t} />
          ) : null}
          <TeamUsageCard id="team-usage-mine" title={t('myTeamUsage')} aggregate={projection.mine} t={t} />
        </div>
      )}
    </section>
  )
}

function TeamUsageCard({ id, title, aggregate, t }: {
  id: string
  title: string
  aggregate: TeamUsageAggregateInput
  t: TeamSettingsInjected['t']
}) {
  const usage = createTeamUsageViewModel(aggregate)
  const showStatus = usage.state !== 'complete' && usage.state !== 'zero'
  const showCoverage = usage.state !== 'complete' && usage.state !== 'zero'

  return (
    <section className={styles.usageCard} role="group" aria-labelledby={`${id}-title`} data-state={usage.state}>
      <div className={styles.usageCardHeader}>
        <h3 id={`${id}-title`} className={styles.usageCardTitle}>{title}</h3>
        {showStatus ? <span className={styles.usageStatus}>{t(USAGE_STATE_KEYS[usage.state])}</span> : null}
      </div>
      {showCoverage ? (
        <p className={styles.usageCoverage}>{t('usageCoverage', {
          tokens: usage.tokenCoverageText,
          priced: usage.pricedCoverageText,
        })}</p>
      ) : null}
      <dl className={styles.usageMetricGrid}>
        <div className={styles.usageMetric}>
          <dt>{t('usageEstimatedAmount')}</dt>
          <dd>{usage.estimatedCostText}</dd>
        </div>
        <div className={styles.usageMetric}>
          <dt>{t('usageTokens')}</dt>
          <dd>{usage.tokenCountText}</dd>
        </div>
        <div className={styles.usageMetric}>
          <dt>{t('usageRequests')}</dt>
          <dd>{usage.requestCountText}</dd>
        </div>
      </dl>
    </section>
  )
}
