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
  TeamManagementExpectedContext,
  TeamManagementStatus,
  TeamManagementUsageResult,
} from '../../shared/team-management.ts'
import { createTeamManagementApi } from './api.ts'
import { en } from './locales.ts'
import type { TeamSettingsKey } from './locales.ts'
import { createTeamUsageViewModel } from './team-usage-view-model.ts'
import type { TeamUsageAggregateInput, TeamUsageState } from './team-usage-view-model.ts'
import {
  canMemberLeaveTeam,
  canRemoveTeamMember,
  canTransferTeamOwnership,
  parseContributionProtectionDraft,
} from './team-settings-contract.ts'
import styles from './TeamSettings.module.css'

const api = createTeamManagementApi()
const USAGE_REFRESH_MS = 60_000
const INVITE_SECRET_VISIBLE_MS = 60_000
const TEAM_INVITE_TOKEN_PATTERN = /^dsh_invite_[A-Za-z0-9_-]{16,}$/u

export interface TeamSettingsInjected {
  t: (key: TeamSettingsKey, params?: Record<string, unknown>) => string
}

export interface TeamSettingsProps extends Partial<TeamSettingsInjected> {
  /** Suppress the standalone heading when rendered inside subscription-pool tabs. */
  readonly embedded?: boolean
}

interface InviteDraft {
  readonly label: string
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

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}

function errorStatus(cause: unknown): number | undefined {
  if (typeof cause !== 'object' || cause === null || !('status' in cause)) return undefined
  return typeof cause.status === 'number' ? cause.status : undefined
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
      setError(errorMessage(cause, t('requestFailed')))
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
  const overviewRequestId = useRef(0)
  const usageRequestId = useRef(0)
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
  const [oauth, setOAuth] = useState<TeamManagementOAuthResult>()
  const [protectionEdit, setProtectionEdit] = useState<ContributionProtectionEdit>()
  const [recentUsageAccount, setRecentUsageAccount] = useState<TeamManagementContributionSummary>()
  const [teamMenuOpen, setTeamMenuOpen] = useState(false)
  const teamSettingsTriggerRef = useRef<HTMLButtonElement>(null)
  const restoreTeamSettingsTriggerFocus = useRef(false)
  const inviteCreationPresentationId = useRef(0)
  const teamExpectedContextRef = useRef<TeamManagementExpectedContext | undefined>(undefined)
  const ownerExpectedContextRef = useRef<TeamManagementExpectedContext | undefined>(undefined)
  const memberExpectedContextRef = useRef<TeamManagementExpectedContext | undefined>(undefined)
  const ownerAuthorizationContextRef = useRef<string | undefined>(undefined)
  const memberAuthorizationContextRef = useRef<string | undefined>(undefined)
  const teamSettingsReturnFocus = useRef<string | undefined>(undefined)
  const teamExpectedContext = authorizationSnapshotReady
    ? createTeamExpectedContext(status, overview)
    : undefined
  const ownerExpectedContext = overview?.viewerRole === 'owner' ? teamExpectedContext : undefined
  const memberExpectedContext = overview?.viewerRole === 'member' ? teamExpectedContext : undefined
  const ownerAuthorizationContext = authorizationSnapshotReady
    ? createOwnerAuthorizationContext(status, overview)
    : undefined
  const memberAuthorizationContext = authorizationSnapshotReady
    ? createMemberAuthorizationContext(status, overview)
    : undefined
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
    teamExpectedContextRef.current = teamExpectedContext
  }, [teamExpectedContext])

  useEffect(() => {
    ownerExpectedContextRef.current = ownerExpectedContext
  }, [ownerExpectedContext])

  useEffect(() => {
    memberExpectedContextRef.current = memberExpectedContext
  }, [memberExpectedContext])

  useEffect(() => {
    ownerAuthorizationContextRef.current = ownerAuthorizationContext
  }, [ownerAuthorizationContext])

  useEffect(() => {
    memberAuthorizationContextRef.current = memberAuthorizationContext
  }, [memberAuthorizationContext])

  useEffect(() => {
    if (!authorizationSnapshotPending && inviteDraft !== undefined && activeInviteDraft === undefined) closeInviteDraft()
  }, [activeInviteDraft, authorizationSnapshotPending, closeInviteDraft, inviteDraft])

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
    teamExpectedContextRef.current = undefined
    ownerExpectedContextRef.current = undefined
    memberExpectedContextRef.current = undefined
    ownerAuthorizationContextRef.current = undefined
    memberAuthorizationContextRef.current = undefined
    setAuthorizationSnapshotReady(false)
    setAuthorizationSnapshotPending(false)
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
  }, [clearUsage])

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
    teamExpectedContextRef.current = undefined
    ownerExpectedContextRef.current = undefined
    memberExpectedContextRef.current = undefined
    ownerAuthorizationContextRef.current = undefined
    memberAuthorizationContextRef.current = undefined
    setAuthorizationSnapshotReady(false)
    setAuthorizationSnapshotPending(true)
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
    teamExpectedContextRef.current = undefined
    ownerExpectedContextRef.current = undefined
    memberExpectedContextRef.current = undefined
    ownerAuthorizationContextRef.current = undefined
    memberAuthorizationContextRef.current = undefined
    setAuthorizationSnapshotReady(false)
    setAuthorizationSnapshotPending(true)
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
        setOverview(projectedOverview)
        setAuthorizationSnapshotReady(true)
        setAuthorizationSnapshotPending(false)
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
      setError(errorMessage(cause, t('requestFailed')))
    } finally {
      if (requestId === overviewRequestId.current) setLoading(false)
    }
  }, [applyManagementStatus, clearUsage, refreshUsage, t])

  useEffect(() => { void refresh(true) }, [refresh])

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
    try {
      await operation()
    } catch (cause: unknown) {
      const status = errorStatus(cause)
      if (status === 410) {
        try {
          if (await refreshStatusOnly() !== 'connected') return
        } catch {
          // Show the original request error if status refresh is unavailable.
        }
      }
      if (status === 403 || status === 409) await refresh(false)
      setError(errorMessage(cause, t('requestFailed')))
    } finally {
      setBusy(undefined)
    }
  }, [refresh, refreshStatusOnly, t])

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
  const ownedContributions = overview.contributions.filter(account => account.ownerMemberId === overview.currentMember.id)

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

  const renderAccountsPanel = () => (
    <section className={styles.teamAccounts} role="region" aria-labelledby="team-accounts-title">
      <div className={styles.workspaceSectionHeader}>
        <div>
          <h3 id="team-accounts-title" className={styles.workspaceSectionTitle}>{t('accountsNavigation')}</h3>
          <p className={styles.hint}>{t('accountDirectoryHint')}</p>
        </div>
        <Button size="sm" variant="primary" icon={<IconPlusOutline16 />} onClick={() => {
          setAccountLabel('')
          setAddAccountOpen(true)
        }}>{t('addAccount')}</Button>
      </div>
      {ownedContributions.length === 0 ? (
        <p className={styles.empty}>{t('noUnsharedAccounts')}</p>
      ) : (
        <div className={styles.accountList} role="list" aria-label={t('accountsTitle', { count: ownedContributions.length })}>
          {ownedContributions.map(account => {
            const accountUsage = usageProjection?.ownedAccounts?.find(item => item.accountId === account.id)
            const accountToggleBusy = busy === `toggle-${account.id}`
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
              <article className={styles.accountCard} data-mine="true" role="listitem" key={account.id}>
                <div className={styles.accountHeader}>
                  <div>
                    <h4 className={styles.accountLabel}>{account.label}</h4>
                    <span className={styles.statusText}>{t(account.status)}</span>
                  </div>
                  <Pill>{t('myAccount')}</Pill>
                </div>
                <div className={styles.accountFacts}>
                  <span className={styles.weeklyAmount}>
                    {t('weeklyAmount', { used: formatUsdMicros(accountUsage?.aggregate.estimatedCostUsdMicros) })}
                    {account.weeklySharedEstimatedApiCostLimitMicros == null ? null : <> / {formatUsdMicros(account.weeklySharedEstimatedApiCostLimitMicros)}</>}
                    <button type="button" className={styles.inlineEdit} disabled={busy !== undefined} onClick={openProtection}>{t('edit')}</button>
                  </span>
                  <span>{t('recentSevenDays', {
                    requests: accountUsage?.aggregate.requestCount ?? 0,
                    tokens: accountUsage?.aggregate.totalTokens ?? '0',
                  })}</span>
                  <span>{t('reserve', { percent: account.personalReservePercent })}</span>
                  <span>{account.maxSharedRequestsPerWindow === null
                    ? t('noRequestCap')
                    : t('requestCap', { count: account.maxSharedRequestsPerWindow })}</span>
                  <span>{account.maxSharedConcurrency === 1
                    ? t('concurrency', { count: account.maxSharedConcurrency })
                    : t('concurrencyPlural', { count: account.maxSharedConcurrency })}</span>
                </div>
                {account.status === 'revoked' ? null : (
                  <div className={styles.compactActions}>
                    <Button size="sm" variant="outline" disabled={busy !== undefined} onClick={openProtection}>{t('editProtection')}</Button>
                    <Button size="sm" variant="ghost" onClick={() => { setRecentUsageAccount(account) }}>{t('recentRequests')}</Button>
                    {account.status === 'reauth_required' ? (
                      <Button size="sm" variant="primary" disabled={busy !== undefined} onClick={() => { void run(`reauthorize-${account.id}`, async () => {
                        const expectedContext = teamExpectedContextRef.current
                        if (expectedContext === undefined) return
                        setOAuth(await api.reauthorizeOAuth(account.id, expectedContext))
                        await refresh(false)
                      }) }}>{t('reauthorize')}</Button>
                    ) : account.status === 'authorizing' ? null : (
                      <Button size="sm" variant="ghost" disabled={busy !== undefined} aria-busy={accountToggleBusy} onClick={() => { void run(`toggle-${account.id}`, async () => {
                        const expectedContext = teamExpectedContextRef.current
                        if (expectedContext === undefined) return
                        await api.updateContribution(account.id, { status: account.status === 'paused' ? 'active' : 'paused' }, expectedContext)
                        await refresh(false)
                      }) }}>{accountToggleBusy ? (
                        <><span className={styles.actionSpinner} aria-hidden="true" />{t(account.status === 'paused' ? 'resumingContribution' : 'stoppingContribution')}</>
                      ) : t(account.status === 'paused' ? 'resumeContribution' : 'pauseContribution')}</Button>
                    )}
                  </div>
                )}
              </article>
            )
          })}
        </div>
      )}
    </section>
  )

  return (
    <main className={styles.page}>
      {embedded ? null : <PageHeading t={t} />}
      {error === undefined || teamSettingsOpen ? null : <Notice tone="error" title={t('requestFailed')} detail={error} />}

      {teamSettingsOpen ? (
        <section className={styles.workspaceShell} role="region" aria-label={t('teamSettingsTitle')}>
          <aside className={styles.workspaceRail} aria-label={t('workspaceNavigation')}>
            <div className={styles.workspaceBrand}>
              <p className={styles.workspaceKicker}>{t('workspaceKicker')}</p>
              <h2 className={styles.workspaceTitle}>{t('workspaceTitle')}</h2>
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
          </aside>
          <div className={styles.workspaceMain}>
            <header className={styles.workspaceHeader}>
              <div className={styles.workspaceHeaderCopy}>
                <button
                  type="button"
                  className={styles.workspaceBack}
                  onClick={() => {
                    setTeamMenuOpen(false)
                    setMemberMenuId(undefined)
                    setInviteRevealRequest(undefined)
                    restoreTeamSettingsTriggerFocus.current = true
                    setTeamSettingsOpen(false)
                  }}
                >
                  <span aria-hidden="true">←</span> {t('backToTeam')}
                </button>
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
                    label: '',
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
        <section className={styles.teamPanel} role="region" aria-label={t('teamPanelTitle')}>
          <header className={styles.teamContext}>
            <div className={styles.teamContextCopy}>
              <p className={styles.workspaceBreadcrumb}>{t('workspaceBreadcrumb')}</p>
              <h2 className={styles.teamContextTitle}>{team.name}</h2>
              <div className={styles.workspaceMeta}>
                <span className={styles.workspaceStatus}><StateDot state={team.status === 'active' ? 'done' : 'warning'} />{team.status === 'active' ? t('teamActive') : t('teamPaused')}</span>
                <span>{overview.viewerRole === 'owner' ? t('teamOwnerRole') : t('teamMemberRole')}</span>
                <span>{t('membersCount', { count: activeMembers.length })}</span>
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
        open={addAccountOpen}
        onClose={() => { if (busy === undefined) setAddAccountOpen(false) }}
        title={t('addAccountTitle')}
        closeLabel={t('close')}
        description={t('addAccountHint')}
        footer={(
          <div className={styles.modalActions}>
            <Button size="sm" variant="ghost" disabled={busy !== undefined} onClick={() => { setAddAccountOpen(false) }}>{t('cancel')}</Button>
            <Button size="sm" variant="primary" disabled={busy !== undefined || accountLabel.trim() === ''} onClick={() => { void run('oauth-start', async () => {
              const expectedContext = teamExpectedContextRef.current
              if (expectedContext === undefined) return
              const result = await api.startOAuth(accountLabel.trim(), expectedContext)
              setAddAccountOpen(false)
              setOAuth(result)
              await refresh(false)
            }) }}>{busy === 'oauth-start' ? t('working') : t('startAuthorization')}</Button>
          </div>
        )}
      >
        <label className={styles.field}>
          <span className={styles.label}>{t('accountLabel')}</span>
          <Input value={accountLabel} placeholder={t('accountLabelPlaceholder')} onChange={event => { setAccountLabel(event.target.value) }} />
        </label>
      </Modal>

      <Modal
        open={oauth !== undefined}
        onClose={() => { if (busy === undefined) setOAuth(undefined) }}
        title={t('deviceTitle')}
        closeLabel={t('close')}
        description={t('deviceHint')}
        footer={(
          <div className={styles.modalActions}>
            <Button size="sm" variant="ghost" disabled={busy !== undefined} onClick={() => { void run('oauth-cancel', async () => {
              if (oauth === undefined) return
              const expectedContext = teamExpectedContextRef.current
              if (expectedContext === undefined) return
              await api.cancelOAuth(oauth.account.id, expectedContext)
              setOAuth(undefined)
              await refresh(false)
            }) }}>{t('cancelAuthorization')}</Button>
            {oauth === undefined ? null : <a href={oauth.verificationUrl} target="_blank" rel="noreferrer">{t('openProvider')}</a>}
            <Button size="sm" variant="primary" disabled={busy !== undefined} onClick={() => { setOAuth(undefined); void refresh(false) }}>{t('checkAuthorization')}</Button>
          </div>
        )}
      >
        {oauth === undefined ? null : (
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
          const requests = usageProjection?.ownedAccounts?.find(item => item.accountId === recentUsageAccount.id)?.recentRequests ?? []
          return requests.length === 0
            ? <p className={styles.empty}>{t('noRecentRequests')}</p>
            : <div className={styles.recentRequestList}>{requests.map(request => (
              <div className={styles.recentRequest} key={request.id}>
                <div><strong>{request.model}</strong><span>{formatTime(request.startedAt)}</span></div>
                <div><span>{request.status}</span><span>{request.totalTokens ?? '—'} tokens</span><span>{formatUsdMicros(request.estimatedCostUsdMicros)}</span></div>
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
            <Button variant="primary" disabled={busy !== undefined || ownerAuthorizationContext === undefined || team.status !== 'active' || activeInviteDraft?.label.trim() === ''} onClick={() => { if (activeInviteDraft !== undefined && ownerAuthorizationContext !== undefined && team.status === 'active') void run('invite', async () => {
              const authorizationContext = activeInviteDraft.authorizationContext
              if (ownerAuthorizationContextRef.current !== authorizationContext) return
              const expectedContext = ownerExpectedContextRef.current
              if (expectedContext === undefined) return
              const presentationId = ++inviteCreationPresentationId.current
              const result = await api.createInvite(activeInviteDraft.label.trim(), activeInviteDraft.expiresInMs, expectedContext)
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
            <Field label={t('inviteLabel')} hint={t('inviteLabelHint')}>
              <Input aria-label={t('inviteLabel')} data-team-dialog-focus="invite" value={activeInviteDraft.label} maxLength={120} placeholder={t('inviteLabelPlaceholder')} onChange={event => {
                setInviteDraft({ ...activeInviteDraft, label: event.target.value })
              }} />
            </Field>
            <Field label={t('inviteExpiry')}>
              <select aria-label={t('inviteExpiry')} className={styles.select} value={activeInviteDraft.expiresInMs} onChange={event => {
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
          <Button size="sm" variant="ghost" icon={<IconRefreshOutline16 />} disabled={loading} onClick={onRefresh}>
            {t('refresh')}
          </Button>
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
  const showStatus = usage.state !== 'complete'
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
