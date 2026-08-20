/** Invite-only Team capacity management inside the dsh Settings shell. */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Button,
  IconCopyOutline16,
  IconLinkOutline16,
  IconPauseOutline16,
  IconPlayOutline16,
  IconPlusOutline16,
  IconRefreshOutline16,
  IconTrashOutline16,
  Input,
  Modal,
  Pill,
  StateDot,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  TeamManagementOAuthResult,
  TeamManagementOverview,
  TeamManagementStatus,
} from '../../shared/team-management.ts'
import type {
  TeamContributionAccountSummary,
  TeamContributionCapacityBucketId,
  TeamContributionCapacityReason,
  TeamMemberSummary,
  TeamUsageEventSummary,
} from '../../team/types.ts'
import { createTeamManagementApi } from './api.ts'
import { en } from './locales.ts'
import type { TeamSettingsKey } from './locales.ts'
import {
  canMemberLeaveTeam,
  canRevokeTeamInvite,
  canTransferTeamOwnership,
  MAX_PERSONAL_RESERVE_PERCENT,
  MAX_SHARED_REQUESTS_PER_WINDOW,
  parseContributionProtectionDraft,
} from './team-settings-contract.ts'
import styles from './TeamSettings.module.css'

const api = createTeamManagementApi()
const AUTHORIZATION_POLL_MS = 2_000

export interface TeamSettingsInjected {
  t: (key: TeamSettingsKey, params?: Record<string, unknown>) => string
}

export type TeamSettingsProps = Partial<TeamSettingsInjected>

interface EditDraft {
  readonly account: TeamContributionAccountSummary
  readonly reserve: string
  readonly requestCap: string
  readonly models: string
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

function memberInitial(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? '?'
}

function contributionDot(status: TeamContributionAccountSummary['status']): StateDotState {
  switch (status) {
    case 'active': return 'done'
    case 'authorizing': return 'ongoing'
    case 'paused': return 'warning'
    case 'reauth_required':
    case 'revoked': return 'error'
  }
}

function usageDot(status: TeamUsageEventSummary['status']): StateDotState {
  switch (status) {
    case 'succeeded': return 'done'
    case 'in_progress': return 'ongoing'
    case 'cancelled': return 'warning'
    case 'failed': return 'error'
  }
}

const CAPACITY_REASON_KEYS: Readonly<Record<TeamContributionCapacityReason, TeamSettingsKey>> = {
  ready: 'capacityReady',
  provider_unavailable: 'capacityProviderUnavailable',
  quota_unavailable: 'capacityQuotaUnavailable',
  quota_exhausted: 'capacityQuotaExhausted',
  reserve_reached: 'capacityReserveReached',
  shared_concurrency_reached: 'capacityConcurrencyReached',
  request_cap_reset_unavailable: 'capacityResetUnavailable',
  request_cap_reached: 'capacityRequestCapReached',
  runtime_unavailable: 'capacityRuntimeUnavailable',
}

const CAPACITY_BUCKET_KEYS: Readonly<Record<TeamContributionCapacityBucketId, TeamSettingsKey>> = {
  codex: 'capacityCodex',
  codex_spark: 'capacitySpark',
}

function capacityDot(reason: TeamContributionCapacityReason): StateDotState {
  switch (reason) {
    case 'ready': return 'done'
    case 'reserve_reached':
    case 'shared_concurrency_reached':
    case 'request_cap_reached': return 'warning'
    case 'provider_unavailable':
    case 'quota_unavailable':
    case 'quota_exhausted':
    case 'request_cap_reset_unavailable':
    case 'runtime_unavailable': return 'error'
  }
}

export function TeamSettings({ t = fallbackTranslate }: TeamSettingsProps) {
  const [status, setStatus] = useState<TeamManagementStatus>()
  const [overview, setOverview] = useState<TeamManagementOverview>()
  const [usage, setUsage] = useState<readonly TeamUsageEventSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [displayName, setDisplayName] = useState('')
  const [inviteToken, setInviteToken] = useState('')
  const [teamKey, setTeamKey] = useState('')
  const [accountLabel, setAccountLabel] = useState('')
  const [inviteResult, setInviteResult] = useState<{ token: string; expiresAt: number }>()
  const [oauth, setOAuth] = useState<TeamManagementOAuthResult>()
  const [copied, setCopied] = useState<'invite' | 'device'>()
  const [edit, setEdit] = useState<EditDraft>()
  const [revoke, setRevoke] = useState<TeamContributionAccountSummary>()
  const [transfer, setTransfer] = useState<TeamMemberSummary>()
  const [disconnectOpen, setDisconnectOpen] = useState(false)
  const [leaveOpen, setLeaveOpen] = useState(false)

  const refresh = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true)
    try {
      const nextStatus = await api.status()
      setStatus(nextStatus)
      if (!nextStatus.enabled || !nextStatus.keyConfigured) {
        setOverview(undefined)
        setUsage([])
        setError(undefined)
        return
      }
      const [nextOverview, nextUsage] = await Promise.all([api.overview(), api.usage(50)])
      setOverview(nextOverview)
      setUsage(nextUsage.events)
      setError(undefined)
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : t('requestFailed'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => { void refresh(true) }, [refresh])

  const hasAuthorizingAccount = overview?.contributions.some(account => account.status === 'authorizing') ?? false
  useEffect(() => {
    if (!hasAuthorizingAccount) return
    const timer = globalThis.setInterval(() => { void refresh(false) }, AUTHORIZATION_POLL_MS)
    return () => { globalThis.clearInterval(timer) }
  }, [hasAuthorizingAccount, refresh])

  const run = useCallback(async (name: string, operation: () => Promise<void>) => {
    setBusy(name)
    setError(undefined)
    try {
      await operation()
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : t('requestFailed'))
    } finally {
      setBusy(undefined)
    }
  }, [t])

  const members = useMemo(() => new Map(overview?.members.map(member => [member.id, member]) ?? []), [overview])
  const currentMember = overview?.currentMember
  const canManageTeam = currentMember?.role === 'owner' || currentMember?.role === 'admin'
  const canLeaveTeam = currentMember === undefined ? false : canMemberLeaveTeam(currentMember.role)

  const joinTeam = () => run('join', async () => {
    await api.join(inviteToken.trim(), displayName.trim())
    setInviteToken('')
    await refresh(false)
  })

  const connectTeam = () => run('connect', async () => {
    await api.connect(teamKey.trim())
    setTeamKey('')
    await refresh(false)
  })

  const startOAuth = () => run('oauth-start', async () => {
    const challenge = await api.startOAuth(accountLabel.trim())
    setAccountLabel('')
    setOAuth(challenge)
    await refresh(false)
  })

  const reauthorizeOAuth = (accountId: string) => run(`oauth-reauthorize-${accountId}`, async () => {
    const challenge = await api.reauthorizeOAuth(accountId)
    setOAuth(challenge)
    await refresh(false)
  })

  const copyValue = (kind: 'invite' | 'device', value: string) => run(`copy-${kind}`, async () => {
    if (await writeClipboard(value)) setCopied(kind)
  })

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

  if (!status.enabled) {
    return (
      <main className={styles.page}>
        <PageHeading t={t} />
        <Notice tone="warning" title={t('enabledRequired')} detail={t('enabledHint')} />
      </main>
    )
  }

  if (!status.keyConfigured || overview === undefined) {
    return (
      <main className={styles.page}>
        <PageHeading t={t} />
        {error === undefined ? null : <Notice tone="error" title={t('requestFailed')} detail={error} />}
        <section className={styles.section}>
          <div className={styles.sectionCopy}>
            <h2 className={styles.sectionTitle}>{t('notConnected')}</h2>
            <p className={styles.hint}>{t('notConnectedHint')}</p>
          </div>
          {status.keyWritable ? (
            <div className={styles.connectionGrid}>
              <div className={styles.panel}>
                <h3 className={styles.panelTitle}>{t('joinInvite')}</h3>
                <Field label={t('displayName')}>
                  <Input className={styles.input!} value={displayName} maxLength={80} autoComplete="name" placeholder={t('displayNamePlaceholder')} onChange={event => { setDisplayName(event.target.value) }} />
                </Field>
                <Field label={t('inviteToken')}>
                  <Input className={styles.input!} value={inviteToken} maxLength={512} autoComplete="off" spellCheck={false} placeholder={t('inviteTokenPlaceholder')} onChange={event => { setInviteToken(event.target.value) }} />
                </Field>
                <div className={styles.actionRow}>
                  <Button variant="primary" disabled={busy !== undefined || displayName.trim() === '' || inviteToken.trim() === ''} onClick={() => { void joinTeam() }}>
                    {busy === 'join' ? t('working') : t('join')}
                  </Button>
                </div>
              </div>
              <div className={styles.panel}>
                <h3 className={styles.panelTitle}>{t('existingKey')}</h3>
                <p className={styles.hint}>{t('existingKeyHint')}</p>
                <Field label={t('teamKey')}>
                  <Input className={styles.input!} type="password" value={teamKey} maxLength={512} autoComplete="off" spellCheck={false} onChange={event => { setTeamKey(event.target.value) }} />
                </Field>
                <div className={styles.actionRow}>
                  <Button variant="outline" disabled={busy !== undefined || teamKey.trim() === ''} onClick={() => { void connectTeam() }}>
                    {busy === 'connect' ? t('working') : t('connect')}
                  </Button>
                </div>
              </div>
            </div>
          ) : <Notice tone="warning" title={t('readOnlyKey')} detail={status.keySource} />}
        </section>
      </main>
    )
  }

  const team = overview.team
  const pendingInvites = overview.invites.filter(invite => invite.status === 'pending')
  const pendingInviteCount = pendingInvites.length

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>{team.name}</p>
          <h1 className={styles.title}>{t('title')}</h1>
          <p className={styles.intro}>{t('connectedAs', { name: currentMember?.displayName ?? '' })}</p>
        </div>
        <div className={styles.headerActions}>
          <Button size="sm" variant="ghost" icon={<IconRefreshOutline16 />} disabled={busy !== undefined} onClick={() => { void refresh(false) }}>{t('refresh')}</Button>
          <Button size="sm" variant="ghost" onClick={() => { setDisconnectOpen(true) }}>{t('disconnect')}</Button>
          <Button size="sm" variant="ghost" disabled={busy !== undefined || !status.keyWritable || !canLeaveTeam} onClick={() => { setLeaveOpen(true) }}>{t('leaveTeam')}</Button>
        </div>
      </header>

      {error === undefined ? null : <Notice tone="error" title={t('requestFailed')} detail={error} />}
      <Notice
        tone={team.status === 'active' ? 'success' : 'warning'}
        title={team.status === 'active' ? t('teamActive') : t('teamPaused')}
        detail={`${currentMember === undefined ? '' : t(currentMember.role)}${status.serverOrigin === undefined ? '' : ` · ${status.serverOrigin}`}`}
      >
        {canManageTeam ? (
          <Button
            size="sm"
            variant="outline"
            icon={team.status === 'active' ? <IconPauseOutline16 /> : <IconPlayOutline16 />}
            disabled={busy !== undefined}
            onClick={() => { void run('team-status', async () => {
              await api.setTeamStatus(team.status === 'active' ? 'paused' : 'active')
              await refresh(false)
            }) }}
          >
            {team.status === 'active' ? t('pauseTeam') : t('resumeTeam')}
          </Button>
        ) : null}
      </Notice>

      <section className={styles.section} aria-labelledby="team-routing-title">
        <h2 id="team-routing-title" className={styles.sectionTitle}>{t('routingTitle')}</h2>
        <div className={styles.routingRail}>
          <RouteNode number="1" label={t('routingOwn')} hint={t('routingOwnHint')} />
          <RouteNode number="2" label={t('routingTeam')} hint={t('routingTeamHint')} />
          <RouteNode number="3" label={t('routingUnavailable')} hint={t('routingUnavailableHint')} />
        </div>
      </section>

      <section className={styles.section} aria-labelledby="team-members-title">
        <div className={styles.sectionHeader}>
          <div>
            <h2 id="team-members-title" className={styles.sectionTitle}>{t('membersTitle')}</h2>
            <p className={styles.hint}>{t('membersCount', { count: overview.members.length })}{pendingInviteCount === 0 ? '' : ` · ${t('pendingInvites', { count: pendingInviteCount })}`}</p>
            {currentMember?.role === 'owner' ? <p className={styles.hint}>{t('ownerLeaveUnavailable')}</p> : null}
          </div>
          {canManageTeam ? (
            <Button size="sm" variant="outline" icon={<IconPlusOutline16 />} disabled={busy !== undefined} onClick={() => { void run('invite', async () => {
              const result = await api.createInvite()
              setInviteResult({ token: result.inviteToken, expiresAt: result.invite.expiresAt })
              await refresh(false)
            }) }}>
              {busy === 'invite' ? t('working') : t('inviteFriend')}
            </Button>
          ) : null}
        </div>
        <div className={styles.memberList}>
          {overview.members.filter(member => member.status !== 'removed').map(member => (
            <div className={styles.memberRow} key={member.id}>
              <div className={styles.identity}>
                <span className={styles.avatar}>{memberInitial(member.displayName)}</span>
                <span className={styles.name}>{member.displayName}</span>
              </div>
              <div className={styles.compactActions}>
                <Pill className={styles.pill}>{t(member.role)}</Pill>
                {currentMember !== undefined && canTransferTeamOwnership(currentMember, member) ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== undefined}
                    onClick={() => { setTransfer(member) }}
                  >
                    {t('transferOwnership')}
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
        {!canManageTeam || currentMember === undefined || pendingInvites.length === 0 ? null : (
          <div className={styles.pendingInviteList}>
            <h3 className={styles.panelTitle}>{t('pendingInvitesTitle')}</h3>
            {pendingInvites.map((invite, index) => (
              <div className={styles.memberRow} key={invite.id}>
                <div className={styles.inviteIdentity}>
                  <span className={styles.name}>{t('pendingInviteLabel', { number: index + 1 })}</span>
                  <span className={styles.meta}>{t('pendingInviteExpires', { time: formatTime(invite.expiresAt) })}</span>
                </div>
                {canRevokeTeamInvite(currentMember.role, invite.status) ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<IconTrashOutline16 />}
                    disabled={busy !== undefined}
                    onClick={() => { void run(`invite-revoke-${invite.id}`, async () => {
                      await api.revokeInvite(invite.id)
                      await refresh(false)
                    }) }}
                  >
                    {busy === `invite-revoke-${invite.id}` ? t('working') : t('revokeInvite')}
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className={styles.section} aria-labelledby="team-contributions-title">
        <div className={styles.sectionHeader}>
          <div className={styles.sectionCopy}>
            <h2 id="team-contributions-title" className={styles.sectionTitle}>{t('contributionsTitle')}</h2>
            <p className={styles.hint}>{t('contributionsIntro')}</p>
          </div>
          <div className={styles.actionRow}>
            <Input value={accountLabel} maxLength={80} placeholder={t('accountLabelPlaceholder')} aria-label={t('accountLabel')} onChange={event => { setAccountLabel(event.target.value) }} />
            <Button size="sm" variant="primary" icon={<IconPlusOutline16 />} disabled={busy !== undefined || accountLabel.trim() === ''} onClick={() => { void startOAuth() }}>
              {busy === 'oauth-start' ? t('working') : t('addContribution')}
            </Button>
          </div>
        </div>
        {overview.contributions.length === 0 ? <p className={styles.empty}>{t('noContributions')}</p> : (
          <div className={styles.accountList}>
            {overview.contributions.map(account => {
              const mine = account.ownerMemberId === currentMember?.id
              const owner = members.get(account.ownerMemberId)?.displayName ?? account.ownerMemberId
              return (
                <article className={styles.accountCard} data-mine={mine} key={account.id}>
                  <div className={styles.accountHeader}>
                    <div>
                      <div className={styles.accountTop}>
                        <h3 className={styles.accountLabel}>{account.label}</h3>
                        {mine ? <Pill className={styles.pill} active>{t('myAccount')}</Pill> : null}
                      </div>
                      <div className={styles.statusLine}>
                        <StateDot state={contributionDot(account.status)} />
                        <span className={styles.statusText}>{t(account.status)}</span>
                        <span className={styles.meta}>{mine ? '' : t('sharedBy', { name: owner })}</span>
                      </div>
                    </div>
                    {mine && account.status !== 'revoked' ? (
                      <div className={styles.compactActions}>
                        {account.status === 'authorizing' ? (
                          <Button size="sm" variant="ghost" disabled={busy !== undefined} onClick={() => { void run(`cancel-${account.id}`, async () => {
                            await api.cancelOAuth(account.id)
                            setOAuth(undefined)
                            await refresh(false)
                          }) }}>{t('cancelAuthorization')}</Button>
                        ) : (
                          <>
                            {account.status === 'reauth_required' ? (
                              <Button size="sm" variant="primary" disabled={busy !== undefined} onClick={() => { void reauthorizeOAuth(account.id) }}>
                                {t('reauthorize')}
                              </Button>
                            ) : (
                              <Button size="sm" variant="ghost" disabled={busy !== undefined} onClick={() => { void run(`toggle-${account.id}`, async () => {
                                await api.updateContribution(account.id, { status: account.status === 'paused' ? 'active' : 'paused' })
                                await refresh(false)
                              }) }}>{account.status === 'paused' ? t('resumeContribution') : t('pauseContribution')}</Button>
                            )}
                            <Button size="sm" variant="ghost" onClick={() => { setEdit({
                              account,
                              reserve: String(account.personalReservePercent),
                              requestCap: account.maxSharedRequestsPerWindow === null ? '' : String(account.maxSharedRequestsPerWindow),
                              models: account.allowedModels.join(', '),
                            }) }}>{t('editProtection')}</Button>
                            <Button size="sm" variant="ghost" icon={<IconTrashOutline16 />} onClick={() => { setRevoke(account) }}>{t('revokeContribution')}</Button>
                          </>
                        )}
                      </div>
                    ) : null}
                  </div>
                  <div className={styles.accountFacts}>
                    <span>{t('reserve', { percent: account.personalReservePercent })}</span>
                    <span>{account.maxSharedRequestsPerWindow === null ? t('noRequestCap') : t('requestCap', { count: account.maxSharedRequestsPerWindow })}</span>
                    <span>{t(account.maxSharedConcurrency === 1 ? 'concurrency' : 'concurrencyPlural', { count: account.maxSharedConcurrency })}</span>
                    <span>{account.allowedModels.length === 0 ? t('allModels') : account.allowedModels.join(', ')}</span>
                  </div>
                  {mine && account.capacity !== undefined ? (
                    <div className={styles.capacityPanel}>
                      <div className={styles.capacityHeader}>
                        <span className={styles.capacityTitle}>{t('capacityTitle')}</span>
                        {account.capacity.sharedInFlight === undefined ? null : (
                          <span className={styles.capacityMeta}>{t('capacityInFlight', { count: account.capacity.sharedInFlight })}</span>
                        )}
                      </div>
                      <div className={styles.capacityList}>
                        {account.capacity.buckets.map(bucket => (
                          <div className={styles.capacityRow} key={bucket.id}>
                            <StateDot state={capacityDot(bucket.reason)} />
                            <span className={styles.capacityBucket}>{t(CAPACITY_BUCKET_KEYS[bucket.id])}</span>
                            <span className={styles.capacityReason}>{t(CAPACITY_REASON_KEYS[bucket.reason])}</span>
                            {bucket.remainingPercent === undefined ? null : (
                              <span className={styles.capacityMeta}>{t('capacityRemaining', { percent: bucket.remainingPercent })}</span>
                            )}
                            {bucket.sharedRequestsUsed === undefined || account.maxSharedRequestsPerWindow === null ? null : (
                              <span className={styles.capacityMeta}>{t('capacityRequestsUsed', {
                                count: bucket.sharedRequestsUsed,
                                cap: account.maxSharedRequestsPerWindow,
                              })}</span>
                            )}
                            {bucket.resetAt === undefined ? null : (
                              <span className={styles.capacityMeta}>{t('capacityResetAt', { time: formatTime(bucket.resetAt) })}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {account.lastError === undefined ? null : <p className={styles.accountError}>{account.lastError}</p>}
                </article>
              )
            })}
          </div>
        )}
        <p className={styles.hint}>{t('upstreamRevokeNote')}</p>
      </section>

      <section className={styles.section} aria-labelledby="team-usage-title">
        <div className={styles.sectionCopy}>
          <h2 id="team-usage-title" className={styles.sectionTitle}>{t('usageTitle')}</h2>
          <p className={styles.hint}>{t('usageIntro')}</p>
        </div>
        {usage.length === 0 ? <p className={styles.empty}>{t('usageEmpty')}</p> : (
          <div className={styles.usageList}>
            {usage.slice(0, 20).map(event => {
              const consumer = members.get(event.consumerMemberId)?.displayName ?? event.consumerMemberId
              const owner = members.get(event.upstreamOwnerMemberId)?.displayName ?? event.upstreamOwnerMemberId
              return (
                <div className={styles.usageRow} key={event.id}>
                  <StateDot state={usageDot(event.status)} />
                  <div className={styles.usageDetail}>
                    <div className={styles.name}>{t('consumedBy', { consumer, owner })}</div>
                    <div className={styles.usageModel}>{event.model} · {t(event.status)}</div>
                  </div>
                  <time className={styles.usageTime} dateTime={new Date(event.startedAt).toISOString()}>{formatTime(event.startedAt)}</time>
                </div>
              )
            })}
          </div>
        )}
      </section>

      <Modal open={inviteResult !== undefined} onClose={() => { setInviteResult(undefined); setCopied(undefined) }} title={t('inviteCreated')} closeLabel={t('close')} {...inviteResult === undefined ? {} : { description: t('inviteCreatedHint', { time: formatTime(inviteResult.expiresAt) }) }} footer={(
        <Button variant="primary" onClick={() => { setInviteResult(undefined); setCopied(undefined) }}>{t('close')}</Button>
      )}>
        {inviteResult === undefined ? null : (
          <div className={styles.secretValue}>
            <span className={styles.code}>{inviteResult.token}</span>
            <Button size="sm" variant="ghost" icon={<IconCopyOutline16 />} onClick={() => { void copyValue('invite', inviteResult.token) }}>{copied === 'invite' ? t('copied') : t('copy')}</Button>
          </div>
        )}
      </Modal>

      <Modal open={oauth !== undefined} onClose={() => { setOAuth(undefined); setCopied(undefined) }} title={t('deviceTitle')} closeLabel={t('close')} description={t('deviceHint')} footer={(
        <div className={styles.modalActions}>
          <Button variant="outline" icon={<IconRefreshOutline16 />} onClick={() => { void refresh(false) }}>{t('checkAuthorization')}</Button>
          <Button variant="primary" icon={<IconLinkOutline16 />} onClick={() => { if (oauth !== undefined) window.open(oauth.verificationUrl, '_blank', 'noopener,noreferrer') }}>{t('openProvider')}</Button>
        </div>
      )}>
        {oauth === undefined ? null : (
          <div className={styles.modalBody}>
            <span className={styles.label}>{t('deviceCode')}</span>
            <div className={styles.deviceCode}>
              <span className={styles.code}>{oauth.userCode}</span>
              <Button size="sm" variant="ghost" icon={<IconCopyOutline16 />} onClick={() => { void copyValue('device', oauth.userCode) }}>{copied === 'device' ? t('copied') : t('copy')}</Button>
            </div>
            <p className={styles.hint}>{t('expiresAt', { time: formatTime(oauth.expiresAt) })}</p>
          </div>
        )}
      </Modal>

      <Modal open={edit !== undefined} onClose={() => { setEdit(undefined) }} title={t('editProtection')} closeLabel={t('close')} footer={(
        <div className={styles.modalActions}>
          <Button variant="ghost" onClick={() => { setEdit(undefined) }}>{t('cancel')}</Button>
          <Button variant="primary" disabled={busy !== undefined} onClick={() => { if (edit !== undefined) void run(`edit-${edit.account.id}`, async () => {
            const result = parseContributionProtectionDraft(edit)
            if (!result.ok) {
              const message: TeamSettingsKey = result.field === 'reserve'
                ? 'reserveValidation'
                : result.field === 'requestCap'
                  ? 'requestCapValidation'
                  : 'allowedModelsValidation'
              throw new Error(t(message))
            }
            await api.updateContribution(edit.account.id, result.patch)
            setEdit(undefined)
            await refresh(false)
          }) }}>{busy?.startsWith('edit-') === true ? t('working') : t('save')}</Button>
        </div>
      )}>
        {edit === undefined ? null : (
          <div className={styles.modalBody}>
            <Field label={t('reserveLabel')} hint={t('reserveHint')}>
              <Input type="number" min={0} max={MAX_PERSONAL_RESERVE_PERCENT} step={1} value={edit.reserve} onChange={event => { setEdit({ ...edit, reserve: event.target.value }) }} />
            </Field>
            <Field label={t('requestCapLabel')}>
              <Input type="number" min={1} max={MAX_SHARED_REQUESTS_PER_WINDOW} step={1} value={edit.requestCap} placeholder={t('requestCapPlaceholder')} onChange={event => { setEdit({ ...edit, requestCap: event.target.value }) }} />
            </Field>
            <Field label={t('allowedModelsLabel')}>
              <Input value={edit.models} placeholder={t('allowedModelsPlaceholder')} onChange={event => { setEdit({ ...edit, models: event.target.value }) }} />
            </Field>
          </div>
        )}
      </Modal>

      <Modal open={revoke !== undefined} onClose={() => { setRevoke(undefined) }} title={revoke === undefined ? t('revokeContribution') : t('revokeTitle', { label: revoke.label })} closeLabel={t('close')} description={t('revokeHint')} footer={(
        <div className={styles.modalActions}>
          <Button variant="ghost" onClick={() => { setRevoke(undefined) }}>{t('cancel')}</Button>
          <Button variant="primary" disabled={busy !== undefined} onClick={() => { if (revoke !== undefined) void run(`revoke-${revoke.id}`, async () => {
            await api.revokeContribution(revoke.id)
            setRevoke(undefined)
            await refresh(false)
          }) }}>{t('confirmRevoke')}</Button>
        </div>
      )} />

      <Modal open={disconnectOpen} onClose={() => { setDisconnectOpen(false) }} title={t('disconnectTitle')} closeLabel={t('close')} description={t('disconnectHint')} footer={(
        <div className={styles.modalActions}>
          <Button variant="ghost" disabled={busy !== undefined || !status.keyWritable} onClick={() => { void run('disconnect-local', async () => {
            await api.disconnect(false)
            setDisconnectOpen(false)
            await refresh(false)
          }) }}>{t('disconnectLocal')}</Button>
          <Button variant="primary" disabled={busy !== undefined || !status.keyWritable} onClick={() => { void run('disconnect-remote', async () => {
            await api.disconnect(true)
            setDisconnectOpen(false)
            await refresh(false)
          }) }}>{t('disconnectRemote')}</Button>
        </div>
      )}>
        <p className={styles.dangerNote}>{t('disconnectLocalHint')}</p>
      </Modal>

      <Modal
        open={transfer !== undefined}
        onClose={() => { setTransfer(undefined) }}
        title={transfer === undefined ? t('transferOwnership') : t('transferOwnershipTitle', { name: transfer.displayName })}
        closeLabel={t('close')}
        description={t('transferOwnershipHint', { name: transfer?.displayName ?? '' })}
        footer={(
          <div className={styles.modalActions}>
            <Button variant="ghost" onClick={() => { setTransfer(undefined) }}>{t('cancel')}</Button>
            <Button variant="primary" disabled={busy !== undefined} onClick={() => { if (transfer !== undefined) void run('transfer-ownership', async () => {
              await api.transferOwnership(transfer.id)
              setTransfer(undefined)
              await refresh(false)
            }) }}>{busy === 'transfer-ownership' ? t('working') : t('confirmTransferOwnership')}</Button>
          </div>
        )}
      >
        <p className={styles.dangerNote}>{t('transferOwnershipWarning')}</p>
      </Modal>

      <Modal open={leaveOpen} onClose={() => { setLeaveOpen(false) }} title={t('leaveTeamTitle')} closeLabel={t('close')} description={t('leaveTeamHint')} footer={(
        <div className={styles.modalActions}>
          <Button variant="ghost" onClick={() => { setLeaveOpen(false) }}>{t('cancel')}</Button>
          <Button variant="primary" disabled={busy !== undefined || !status.keyWritable || !canLeaveTeam} onClick={() => { void run('leave-team', async () => {
            await api.leaveTeam()
            setLeaveOpen(false)
            await refresh(false)
          }) }}>{t('confirmLeaveTeam')}</Button>
        </div>
      )}>
        <p className={styles.dangerNote}>{t('leaveTeamRevokeNote')}</p>
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

function Notice({ tone, title, detail, children }: {
  tone: 'success' | 'warning' | 'error'
  title: string
  detail?: string | undefined
  children?: React.ReactNode
}) {
  return (
    <div className={styles.banner} data-tone={tone} role={tone === 'error' ? 'alert' : undefined}>
      <div>
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

function RouteNode({ number, label, hint }: { number: string; label: string; hint: string }) {
  return (
    <div className={styles.routeNode}>
      <span className={styles.routeMark}>{number}</span>
      <div>
        <div className={styles.routeLabel}>{label}</div>
        <div className={styles.routeHint}>{hint}</div>
      </div>
    </div>
  )
}
