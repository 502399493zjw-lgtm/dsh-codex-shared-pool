/** Plugin-owned OpenAI Codex account page inside the dsh Settings shell. */

import { useCallback, useEffect, useRef, useState } from 'react'
import { SubscriptionEstimate, subscriptionEstimateLabels } from './SubscriptionEstimate.tsx'
import { subscriptionFromUsage } from '../shared/subscription.ts'
import type { CSSProperties } from 'react'
import {
  Button,
  IconChevronDownOutline14,
  IconGlobeOutline14,
  IconPlusOutline16,
  IconTrashOutline16,
  Input,
  Modal,
  StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  ImageToolPreferences,
  LocalRoutingEventSummary,
  LocalRoutingEventsResult,
  LocalRoutingReason,
  LocalRoutingStatus,
  OpenAICodexAuthorizationFailure,
  OpenAICodexCancelLoginResult,
  OpenAICodexConnectionStatus,
  OpenAICodexLoginChallenge,
  OpenAICodexProfilesStatus,
  OpenAICodexUsage,
  ResponseApiPreferences,
} from '../shared/types.ts'
import type { OpenAICodexSettingsKey } from './locales.ts'
import {
  openAuthorizationPopupBridge,
  watchAuthorizationPopupClose,
} from './authorization-popup.ts'
import type { AuthorizationPopupController } from './authorization-popup.ts'
import {
  loadResponsePreferences,
  updateResponsePreferences,
} from './response-preferences.ts'
import {
  parseProfileLabelDraft,
  renameOpenAICodexProfile,
} from './profile-management.ts'
import { observeCodexQuotaProfiles } from './quota/invalidation.ts'
import { withDeadline } from '../with-deadline.ts'

const STATUS_PATH = '/plugins/dsh-openai-codex/profiles'
const DIRECTORY_PATH = '/plugins/dsh-openai-codex/profiles/directory'
const LOGIN_PATH = '/plugins/dsh-openai-codex/profiles/login'
const CANCEL_LOGIN_PATH = '/plugins/dsh-openai-codex/profiles/login/cancel'
const PRIORITY_PATH = '/plugins/dsh-openai-codex/profiles/priority'
const REMOVE_PATH = '/plugins/dsh-openai-codex/profiles/remove'
const IMAGE_TOOLS_PATH = '/plugins/dsh-openai-codex/image-tools'
const NETWORK_PATH = '/plugins/dsh-openai-codex/network'
const ROUTING_EVENTS_PATH = '/plugins/dsh-openai-codex/routing-events'
const POLL_INTERVAL_MS = 1_000
const ROUTING_POLL_INTERVAL_MS = 2_000
const USAGE_POLL_INTERVAL_MS = 60_000

type AccountStatus =
  | { status: 'loading' }
  | { status: 'signing-in' }
  | { status: 'ready'; profiles: AccountProfile[] }
  | { status: 'error'; message: string }

interface AccountProfile {
  id: string
  label: string
  createdAt: number
  updatedAt: number
  usage: OpenAICodexUsage
  connectionStatus?: OpenAICodexConnectionStatus
  quotaLoading?: boolean
  inUse?: boolean
  quotaError?: string
}

type RemoteAccountStatus = OpenAICodexProfilesStatus<AccountProfile>
type DirectoryStatus = OpenAICodexProfilesStatus<Pick<AccountProfile, 'id' | 'label' | 'createdAt' | 'updatedAt' | 'inUse'>>

function ConnectionDot({ status }: { status: OpenAICodexConnectionStatus | undefined }) {
  return status === undefined
    ? <span aria-hidden="true" style={{ width: 9, height: 9, borderRadius: '50%', background: 'var(--dsw-alias-label-tertiary)', display: 'inline-block' }} />
    : <StateDot state={status === 'reauth-required' ? 'error' : 'done'} size={9} />
}

interface OutboundNetworkStatus {
  enabled: boolean
  httpProxy: boolean
  httpsProxy: boolean
  noProxy: boolean
}

/** Dependencies injected by the browser plugin entry. */
export interface OpenAICodexSettingsInjected {
  /** Localized page copy. */
  t: (key: OpenAICodexSettingsKey, params?: Record<string, unknown>) => string
}

/** Props delivered by the settings slot renderer. */
export interface OpenAICodexSettingsProps extends Partial<OpenAICodexSettingsInjected> {
  /** Suppress the child heading when rendered inside the subscription-pool tabs. */
  readonly embedded?: boolean
}

const pageStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 18, width: '100%', minWidth: 0, maxWidth: 960, containerType: 'inline-size' }
const titleStyle: CSSProperties = { margin: 0, fontSize: 20, lineHeight: '28px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
const bodyStyle: CSSProperties = { margin: 0, fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-secondary)' }
const badgeStyle: CSSProperties = { padding: '2px 8px', borderRadius: 999, background: 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #3964fe) 14%, transparent)', color: 'var(--dsw-alias-state-business-primary, #3964fe)', fontSize: 12, fontWeight: 600 }
const errorStyle: CSSProperties = { ...bodyStyle, color: 'var(--dsw-alias-state-error-primary)' }
const quotaListStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 22 }
const quotaGroupStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10 }
const quotaTitleStyle: CSSProperties = { margin: 0, fontSize: 15, lineHeight: '22px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
const quotaLabelStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' }
const progressTrackStyle: CSSProperties = { height: 8, overflow: 'hidden', borderRadius: 999, background: 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.08))' }
const toggleTrackStyle: CSSProperties = { position: 'relative', width: 40, height: 22, flex: '0 0 auto', marginTop: 1, padding: 0, border: 0, borderRadius: 999, cursor: 'pointer', transition: 'background 120ms ease' }

function PreferenceToggle({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean
  disabled: boolean
  label: string
  onChange: (value: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      style={{
        ...toggleTrackStyle,
        opacity: disabled ? 0.55 : 1,
        background: checked ? 'var(--dsw-alias-state-business-primary, #3964fe)' : 'var(--dsw-alias-bg-layer-2, #c8ccd2)',
      }}
      onClick={() => { onChange(!checked) }}
    >
      <span style={{
        position: 'absolute',
        top: 3,
        left: checked ? 21 : 3,
        width: 16,
        height: 16,
        borderRadius: '50%',
        background: 'white',
        boxShadow: '0 1px 3px rgba(0, 0, 0, 0.25)',
        transition: 'left 120ms ease',
      }} />
    </button>
  )
}

function progressFillStyle(percent: number): CSSProperties {
  return {
    width: `${Math.max(0, Math.min(100, percent))}%`,
    height: '100%',
    borderRadius: 'inherit',
    background: 'var(--dsw-alias-state-business-primary, #3964fe)',
  }
}

function windowLabel(seconds: number, t: OpenAICodexSettingsInjected['t']): string {
  if (seconds === 5 * 60 * 60) return t('fiveHourLimit')
  if (seconds === 7 * 24 * 60 * 60) return t('weeklyLimit')
  const hours = seconds / (60 * 60)
  return Number.isInteger(hours) ? t('hourLimit', { count: hours }) : t('usageWindow')
}

function formatPercent(percent: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(percent)
}

function routingReasonKey(reason: LocalRoutingReason): OpenAICodexSettingsKey {
  switch (reason) {
    case 'priority': return 'routingReasonPriority'
    case 'quota_fallback': return 'routingReasonQuotaFallback'
    case 'quota_unknown': return 'routingReasonQuotaUnknown'
    case 'all_exhausted': return 'routingReasonAllExhausted'
    case 'concurrent_binding': return 'routingReasonConcurrentBinding'
  }
}

function routingStatusKey(status: LocalRoutingStatus): OpenAICodexSettingsKey {
  switch (status) {
    case 'in_progress': return 'routingStatusInProgress'
    case 'succeeded': return 'routingStatusSucceeded'
    case 'failed': return 'routingStatusFailed'
    case 'cancelled': return 'routingStatusCancelled'
  }
}

function routingDotState(status: LocalRoutingStatus): 'ongoing' | 'done' | 'error' {
  if (status === 'in_progress') return 'ongoing'
  if (status === 'succeeded') return 'done'
  return 'error'
}

function QuotaBar({
  label,
  percent,
  detail,
  t,
}: {
  label: string
  percent: number
  detail?: string
  t: OpenAICodexSettingsInjected['t']
}) {
  const display = formatPercent(percent)
  return (
    <div style={quotaGroupStyle}>
      <div style={quotaLabelStyle}>
        <span>{label}</span>
        <span>{t('percentRemaining', { percent: display })}</span>
      </div>
      <div
        style={progressTrackStyle}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={t('percentRemaining', { percent: display })}
      >
        <div style={progressFillStyle(percent)} />
      </div>
      {detail === undefined ? null : <p style={bodyStyle}>{detail}</p>}
    </div>
  )
}

function UsageLimits({ usage, quotaError, loading = false, t }: {
  usage: OpenAICodexUsage
  quotaError?: string
  loading?: boolean
  t: OpenAICodexSettingsInjected['t']
}) {
  const hasData = usage.rateLimits.length > 0 || usage.credits !== undefined || usage.individualLimit !== undefined
  return (
    <div style={quotaListStyle}>
      <div style={quotaGroupStyle}>
        <h3 style={quotaTitleStyle}>{t('usageLimits')}</h3>
        <SubscriptionEstimate subscription={subscriptionFromUsage(usage)} labels={subscriptionEstimateLabels(t)} style={{ marginBlock: 0 }} />
      </div>
      {usage.rateLimits.map(limit => (
        <div key={limit.id} style={quotaGroupStyle}>
          <h4 style={quotaTitleStyle}>{limit.name ?? limit.id}</h4>
          {limit.windows.map(window => (
            <QuotaBar
              key={window.windowSeconds}
              label={windowLabel(window.windowSeconds, t)}
              percent={window.remainingPercent}
              t={t}
            />
          ))}
        </div>
      ))}
      {usage.individualLimit === undefined ? null : (
        <QuotaBar
          label={t('monthlyLimit')}
          percent={usage.individualLimit.remainingPercent}
          detail={t('exactRemaining', {
            remaining: usage.individualLimit.remaining,
            limit: usage.individualLimit.limit,
          })}
          t={t}
        />
      )}
      {usage.credits === undefined ? null : (
        <div style={quotaLabelStyle}>
          <span>{t('credits')}</span>
          <span>{usage.credits.unlimited
            ? t('unlimited')
            : usage.credits.balance === undefined ? t('available') : usage.credits.balance}</span>
        </div>
      )}
      {!loading && !hasData && quotaError === undefined ? <p style={bodyStyle}>{t('quotaUnavailable')}</p> : null}
      {quotaError === undefined ? null : <p style={errorStyle}>{t('quotaUnavailable')}</p>}
    </div>
  )
}

async function jsonRequest<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { accept: 'application/json', ...body === undefined ? {} : { 'content-type': 'application/json' } },
    credentials: 'same-origin',
    ...signal === undefined ? {} : { signal },
    ...body === undefined ? {} : { body: JSON.stringify(body) },
  })
  const value: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const message = typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'string'
      ? value.error
      : `HTTP ${response.status}`
    throw new Error(message)
  }
  return value as T
}

function authorizationFailureMessage(
  reason: OpenAICodexAuthorizationFailure,
  t: OpenAICodexSettingsInjected['t'],
): string {
  return reason === 'authorization-timed-out'
    ? t('authorizationTimedOut')
    : t('authorizationFailed')
}

type AccountDialog = 'rename' | 'remove'

/** OpenAI Codex account status, global allocation priority, and OAuth actions. */
export function OpenAICodexSettings({ t, embedded = false }: OpenAICodexSettingsProps) {
  if (t === undefined) throw new Error('OpenAI Codex settings requires its translation function')
  const [status, setStatus] = useState<AccountStatus>({ status: 'loading' })
  const [busy, setBusy] = useState(false)
  const [selectedProfileId, setSelectedProfileId] = useState<string>()
  const [priorityError, setPriorityError] = useState<string>()
  const [dialog, setDialog] = useState<AccountDialog>()
  const [renameLabel, setRenameLabel] = useState('')
  const [dialogError, setDialogError] = useState<string>()
  const [routingOpen, setRoutingOpen] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [imageTools, setImageTools] = useState<ImageToolPreferences | undefined>()
  const [imageToolsBusy, setImageToolsBusy] = useState(false)
  const [imageToolsError, setImageToolsError] = useState<string | undefined>()
  const [responseApi, setResponseApi] = useState<ResponseApiPreferences | undefined>()
  const [responseApiBusy, setResponseApiBusy] = useState(false)
  const [responseApiError, setResponseApiError] = useState<string | undefined>()
  const [network, setNetwork] = useState<OutboundNetworkStatus | undefined>()
  const [networkError, setNetworkError] = useState(false)
  const [routingEvents, setRoutingEvents] = useState<readonly LocalRoutingEventSummary[]>([])
  const [routingEventsError, setRoutingEventsError] = useState(false)
  const [signInNotice, setSignInNotice] = useState<string>()
  const [signInCancelling, setSignInCancelling] = useState(false)
  const popupWatchRef = useRef<(() => void) | undefined>(undefined)
  const loginPopupRef = useRef<AuthorizationPopupController | null>(null)
  const loginOperationRef = useRef<object | undefined>(undefined)
  const quotaProfilesRevisionRef = useRef<string | undefined>(undefined)
  const latestRoutingEventIdRef = useRef<string | null | undefined>(undefined)
  const refreshControllerRef = useRef<AbortController | undefined>(undefined)

  const refresh = useCallback(async () => {
    refreshControllerRef.current?.abort()
    const controller = new AbortController()
    refreshControllerRef.current = controller
    try {
      const next = await withDeadline(signal => jsonRequest<DirectoryStatus>(DIRECTORY_PATH, 'GET', undefined, signal), 5_000, controller.signal)
      if (controller.signal.aborted) return
      if (next.status === 'ready') {
        setStatus(previous => ({ status: 'ready', profiles: next.profiles.map(profile => {
          const old = previous.status === 'ready' ? previous.profiles.find(item => item.id === profile.id) : undefined
          return { ...old, ...profile, usage: old?.usage ?? { rateLimits: [] }, quotaLoading: true }
        }) }))
        if (next.profiles.length > 0) {
          void withDeadline(signal => jsonRequest<RemoteAccountStatus>(STATUS_PATH, 'GET', undefined, signal), 20_000, controller.signal)
            .then(quota => {
              if (controller.signal.aborted) return
              if (quota.status !== 'ready') throw new Error('Quota unavailable')
              setStatus(current => current.status !== 'ready' ? current : ({
                status: 'ready',
                profiles: current.profiles.map(profile => {
                  const result = quota.profiles.find(item => item.id === profile.id)
                  const { connectionStatus: _health, quotaError: _error, ...metadata } = profile
                  return result === undefined
                    ? { ...profile, quotaLoading: false, quotaError: t('quotaUnavailable') }
                    : { ...metadata, usage: result.usage,
                        ...result.connectionStatus === undefined ? {} : { connectionStatus: result.connectionStatus },
                        ...result.quotaError === undefined ? {} : { quotaError: result.quotaError }, quotaLoading: false }
                }),
              }))
            }).catch(() => {
              if (controller.signal.aborted) return
              setStatus(current => current.status !== 'ready' ? current : ({
                status: 'ready', profiles: current.profiles.map(profile => ({
                  ...profile, quotaLoading: false, quotaError: t('quotaUnavailable'),
                })),
              }))
            })
        }
        return next
      }
      setStatus(next.status === 'error'
        ? { status: 'error', message: authorizationFailureMessage(next.reason, t) }
        : next)
      return next
    } catch (error: unknown) {
      if (controller.signal.aborted) return
      setStatus({ status: 'error', message: error instanceof Error ? error.message : t('requestFailed') })
    }
  }, [t])

  const refreshRoutingEvents = useCallback(async () => {
    try {
      const result = await jsonRequest<LocalRoutingEventsResult>(ROUTING_EVENTS_PATH)
      const newestId = result.events[0]?.id ?? null
      const shouldRefreshProfiles = latestRoutingEventIdRef.current !== undefined
        && latestRoutingEventIdRef.current !== newestId
      latestRoutingEventIdRef.current = newestId
      setRoutingEvents(result.events)
      setRoutingEventsError(false)
      if (shouldRefreshProfiles) void refresh()
    } catch {
      setRoutingEventsError(true)
    }
  }, [refresh])

  const stopPopupWatch = useCallback(() => {
    popupWatchRef.current?.()
    popupWatchRef.current = undefined
  }, [])

  const cancelSignIn = useCallback(async () => {
    stopPopupWatch()
    loginPopupRef.current?.close()
    loginPopupRef.current = null
    loginOperationRef.current = undefined
    setBusy(false)
    setSignInCancelling(true)
    try {
      const result = await jsonRequest<OpenAICodexCancelLoginResult>(CANCEL_LOGIN_PATH, 'POST')
      if (result.cancelled) setSignInNotice(t('signInCancelled'))
      await refresh()
    } catch (error: unknown) {
      setStatus({ status: 'error', message: error instanceof Error ? error.message : t('requestFailed') })
    } finally {
      setSignInCancelling(false)
    }
  }, [refresh, stopPopupWatch, t])

  useEffect(() => {
    void refresh()
    return () => { refreshControllerRef.current?.abort() }
  }, [refresh])
  useEffect(() => () => {
    const loginWasActive = loginOperationRef.current !== undefined
    loginOperationRef.current = undefined
    stopPopupWatch()
    loginPopupRef.current?.close()
    loginPopupRef.current = null
    if (loginWasActive) {
      void fetch(CANCEL_LOGIN_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true,
      })
    }
  }, [stopPopupWatch])
  useEffect(() => {
    void jsonRequest<ImageToolPreferences>(IMAGE_TOOLS_PATH).then(
      (value) => { setImageTools(value); setImageToolsError(undefined) },
      () => { setImageToolsError(t('imageToolSettingsFailed')) },
    )
  }, [t])
  useEffect(() => {
    void loadResponsePreferences().then(
      (value) => { setResponseApi(value); setResponseApiError(undefined) },
      () => { setResponseApiError(t('responseApiSettingsFailed')) },
    )
  }, [t])
  useEffect(() => {
    void jsonRequest<OutboundNetworkStatus>(NETWORK_PATH).then(
      (value) => { setNetwork(value); setNetworkError(false) },
      () => { setNetworkError(true) },
    )
  }, [])
  useEffect(() => {
    const interval = status.status === 'signing-in'
      ? POLL_INTERVAL_MS
      : status.status === 'ready' && status.profiles.length > 0 ? USAGE_POLL_INTERVAL_MS : undefined
    if (interval === undefined) return
    const timer = window.setInterval(() => { void refresh() }, interval)
    return () => { window.clearInterval(timer) }
  }, [refresh, status.status])
  useEffect(() => {
    if (status.status !== 'ready' || status.profiles.length === 0) {
      latestRoutingEventIdRef.current = undefined
      setRoutingEvents([])
      setRoutingEventsError(false)
      return
    }
    void refreshRoutingEvents()
    const timer = window.setInterval(() => { void refreshRoutingEvents() }, ROUTING_POLL_INTERVAL_MS)
    return () => { window.clearInterval(timer) }
  }, [refreshRoutingEvents, status])

  useEffect(() => {
    if (status.status !== 'signing-in' && popupWatchRef.current !== undefined) {
      loginOperationRef.current = undefined
      stopPopupWatch()
      loginPopupRef.current?.close()
      loginPopupRef.current = null
    }
  }, [status.status, stopPopupWatch])

  useEffect(() => {
    if (status.status !== 'ready') return
    setSelectedProfileId((current) => {
      if (current !== undefined && status.profiles.some(profile => profile.id === current)) return current
      return status.profiles[0]?.id
    })
  }, [status])

  useEffect(() => {
    if (status.status !== 'ready') return
    quotaProfilesRevisionRef.current = observeCodexQuotaProfiles(
      quotaProfilesRevisionRef.current,
      status.profiles,
    )
  }, [status])

  const profiles = status.status === 'ready' ? status.profiles : []
  const selectedProfile = profiles.find(profile => profile.id === selectedProfileId)
    ?? profiles[0]
  const priorityProfile = profiles[0]

  const signIn = async (): Promise<void> => {
    stopPopupWatch()
    setSignInNotice(undefined)
    const popup = openAuthorizationPopupBridge()
    loginPopupRef.current = popup
    setBusy(true)
    setStatus({ status: 'signing-in' })
    const operation = {}
    loginOperationRef.current = operation
    try {
      const challenge = await jsonRequest<OpenAICodexLoginChallenge>(LOGIN_PATH, 'POST')
      if (loginOperationRef.current !== operation) {
        popup?.close()
        if (loginPopupRef.current === popup) loginPopupRef.current = null
        return
      }
      if (popup === null) {
        loginOperationRef.current = undefined
        loginPopupRef.current = null
        await jsonRequest(CANCEL_LOGIN_PATH, 'POST')
        setBusy(false)
        setStatus({ status: 'error', message: t('popupBlocked') })
        return
      }
      if (!(await popup.navigate(challenge.url))) {
        loginOperationRef.current = undefined
        popup.close()
        if (loginPopupRef.current === popup) loginPopupRef.current = null
        await jsonRequest(CANCEL_LOGIN_PATH, 'POST')
        setBusy(false)
        setStatus({ status: 'error', message: t('popupBlocked') })
        return
      }
      if (popup.window === null) {
        // The in-app browser adopted the tab. Once the Host acknowledges its
        // redirect, the provider flow is independent of this settings view.
        if (loginOperationRef.current === operation) loginOperationRef.current = undefined
        if (loginPopupRef.current === popup) loginPopupRef.current = null
        setBusy(false)
      } else {
        popupWatchRef.current = watchAuthorizationPopupClose(popup.window, () => {
          popupWatchRef.current = undefined
          if (loginPopupRef.current === popup) loginPopupRef.current = null
          void cancelSignIn()
        })
      }
    } catch (error: unknown) {
      const loginWasActive = loginOperationRef.current === operation
      if (loginWasActive) loginOperationRef.current = undefined
      stopPopupWatch()
      popup?.close()
      if (loginPopupRef.current === popup) loginPopupRef.current = null
      if (loginWasActive) {
        await jsonRequest(CANCEL_LOGIN_PATH, 'POST').catch(() => undefined)
        const message = error instanceof Error
          && (error.message === 'authorization-failed' || error.message === 'authorization-timed-out')
          ? authorizationFailureMessage(error.message, t)
          : error instanceof Error ? error.message : t('requestFailed')
        setStatus({ status: 'error', message })
        setBusy(false)
      }
    } finally {
      if (loginOperationRef.current === operation) setBusy(false)
    }
  }

  const prioritizeProfile = async (profileId: string): Promise<void> => {
    setBusy(true)
    setPriorityError(undefined)
    try {
      await jsonRequest<{ ok: true }>(PRIORITY_PATH, 'POST', { profileId })
      const nextStatus = await refresh()
      if (nextStatus?.status !== 'ready' || nextStatus.profiles[0]?.id !== profileId) {
        throw new Error(t('profilePriorityFailed'))
      }
    } catch {
      setPriorityError(t('profilePriorityFailed'))
    } finally {
      setBusy(false)
    }
  }

  const renameProfile = async (profile: AccountProfile): Promise<void> => {
    const parsed = parseProfileLabelDraft(renameLabel)
    if (!parsed.ok) {
      setDialogError(t('profileLabelRequired'))
      return
    }
    setBusy(true)
    setDialogError(undefined)
    try {
      await renameOpenAICodexProfile(jsonRequest, profile.id, parsed.label)
      await refresh()
      setDialog(undefined)
      setRenameLabel('')
    } catch (error: unknown) {
      setDialogError(error instanceof Error ? error.message : t('requestFailed'))
    } finally {
      setBusy(false)
    }
  }

  const removeProfile = async (profile: AccountProfile): Promise<void> => {
    setBusy(true)
    try {
      await jsonRequest<{ ok: true }>(REMOVE_PATH, 'POST', { profileId: profile.id })
      await refresh()
      setDialog(undefined)
    } catch (error: unknown) {
      setStatus({ status: 'error', message: error instanceof Error ? error.message : t('requestFailed') })
    } finally {
      setBusy(false)
    }
  }

  const updateImageTool = async (patch: Partial<ImageToolPreferences>): Promise<void> => {
    setImageToolsBusy(true)
    setImageToolsError(undefined)
    try {
      setImageTools(await jsonRequest<ImageToolPreferences>(IMAGE_TOOLS_PATH, 'POST', patch))
    } catch {
      setImageToolsError(t('imageToolSettingsFailed'))
    } finally {
      setImageToolsBusy(false)
    }
  }

  const updateResponseApi = async (patch: Partial<ResponseApiPreferences>): Promise<void> => {
    setResponseApiBusy(true)
    setResponseApiError(undefined)
    try {
      setResponseApi(await updateResponsePreferences(patch))
    } catch {
      setResponseApiError(t('responseApiSettingsFailed'))
    } finally {
      setResponseApiBusy(false)
    }
  }

  const label = status.status === 'loading'
    ? t('loadingAccount')
    : status.status === 'signing-in'
      ? t('signingIn')
      : status.status === 'error'
        ? t('requestFailed')
        : status.profiles.length === 0 ? t('signedOut') : t('profileCount', { count: status.profiles.length })

  const networkLabel = networkError
    ? t('networkStatusUnavailable')
    : network === undefined
      ? t('networkLoading')
      : network.enabled ? t('environmentProxy') : t('directNetwork')

  const closeDialog = (): void => {
    if (busy) return
    setDialog(undefined)
    setRenameLabel('')
    setDialogError(undefined)
  }

  return (
    <section
      className="dsh-codex-settings"
      style={pageStyle}
      {...embedded ? { 'aria-label': t('localTab') } : { 'aria-labelledby': 'openai-codex-settings-title' }}
    >
      <style>{`
        .dsh-codex-settings, .dsh-codex-settings * { box-sizing: border-box; }
        .dsh-codex-settings button, .dsh-codex-settings input, .dsh-codex-settings select { font: inherit; }
        .dsh-codex-settings button:focus-visible,
        .dsh-codex-settings input:focus-visible,
        .dsh-codex-settings select:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #3964fe); outline-offset: 2px; }
        .dsh-codex-workspace { display: grid; grid-template-columns: minmax(180px, 0.8fr) minmax(0, 1.45fr); overflow: hidden; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; background: var(--dsw-alias-bg-module-platform); }
        .dsh-codex-profile-list { display: flex; flex-direction: column; min-width: 0; padding: 20px; border-right: 1px solid var(--dsw-alias-border-l2); }
        .dsh-codex-list-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; min-width: 0; }
        .dsh-codex-list-heading h3 { min-width: 0; margin: 0; overflow-wrap: anywhere; color: var(--dsw-alias-label-primary); font-size: 16px; line-height: 24px; font-weight: 600; }
        .dsh-codex-list-heading h3 span { color: var(--dsw-alias-label-tertiary); font-weight: 500; }
        .dsh-codex-add-account { min-height: 32px; padding: 5px 10px; border-radius: 8px; max-width: 100%; min-width: 0; flex: 0 1 auto; }
        .dsh-codex-add-account-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .dsh-codex-profile-items { display: flex; flex-direction: column; gap: 8px; margin-top: 18px; }
        .dsh-codex-profile-item { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 10px; width: 100%; min-height: 52px; padding: 10px 12px; border: 1px solid transparent; border-radius: 10px; color: var(--dsw-alias-label-secondary); text-align: left; background: transparent; cursor: pointer; }
        .dsh-codex-profile-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
        .dsh-codex-profile-item[data-selected='true'] { border-color: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-label-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent); }
        .dsh-codex-profile-identity { display: flex; flex-direction: column; min-width: 0; gap: 1px; }
        .dsh-codex-profile-alias { color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 18px; font-weight: 600; }
        .dsh-codex-profile-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 500; }
        .dsh-codex-profile-badges { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 5px; }
        .dsh-codex-profile-detail { display: flex; flex-direction: column; min-width: 0; padding: 20px 24px 0; }
        .dsh-codex-detail-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; min-width: 0; }
        .dsh-codex-detail-title { min-width: 0; margin: 0; overflow-wrap: anywhere; color: var(--dsw-alias-label-primary); font-size: 20px; line-height: 28px; font-weight: 600; }
        .dsh-codex-account-status { display: inline-flex; align-items: center; flex-wrap: wrap; min-width: 0; gap: 7px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; font-weight: 500; }
        .dsh-codex-account-status[data-state='error'] { color: var(--dsw-alias-state-error-primary); }
        .dsh-codex-default { margin-top: 18px; }
        .dsh-codex-default-action { min-height: 34px; padding: 6px 14px; border-radius: 8px; min-width: 112px; justify-content: center; }
        .dsh-codex-default p { margin: 8px 0 0; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }
        .dsh-codex-default p[role='alert'] { color: var(--dsw-alias-state-error-primary); }
        .dsh-codex-quota { margin-top: 20px; padding: 20px 0 24px; border-top: 1px solid var(--dsw-alias-border-l2); }
        .dsh-codex-detail-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 16px 0; margin-top: auto; border-top: 1px solid var(--dsw-alias-border-l2); }
        .dsh-codex-detail-actions button { display: inline-flex; align-items: center; justify-content: center; min-width: 0; gap: 6px; min-height: 36px; padding: 7px 14px; overflow-wrap: anywhere; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; font-size: 13px; font-weight: 500; line-height: 20px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.04)); cursor: pointer; }
        .dsh-codex-detail-actions button:disabled { opacity: 0.45; cursor: not-allowed; }
        .dsh-codex-detail-actions button:not(:disabled):hover { background: var(--dsw-alias-interactive-bg-hover); }
        .dsh-codex-detail-actions button:not(:disabled):active { background: color-mix(in srgb, currentColor 14%, transparent); }
        .dsh-codex-detail-actions button svg { flex-shrink: 0; }
        .dsh-codex-detail-actions .danger { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 38%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); }
        .dsh-codex-detail-actions .danger:not(:disabled):hover { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent); }
        .dsh-codex-detail-actions .danger:not(:disabled):active { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 20%, transparent); }
        .dsh-codex-dialog-field { display: flex; flex-direction: column; gap: 8px; width: 100%; min-width: 0; }
        .dsh-codex-dialog-field > span { color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; font-weight: 500; }
        .dsh-codex-dialog-error { margin: 10px 0 0; color: var(--dsw-alias-state-error-primary); font-size: 13px; line-height: 20px; }
        .dsh-codex-empty { display: grid; place-items: center; min-height: 360px; padding: 32px; color: var(--dsw-alias-label-secondary); text-align: center; }
        .dsh-codex-empty-status { display: inline-flex; align-items: center; justify-content: center; gap: 9px; }
        .dsh-codex-cancel-auth { margin-top: 16px; }
        @container (max-width: 460px) {
          .dsh-codex-workspace { grid-template-columns: minmax(0, 1fr); }
          .dsh-codex-profile-list { border-right: 0; border-bottom: 1px solid var(--dsw-alias-border-l2); }
          .dsh-codex-profile-detail { padding-right: 18px; padding-left: 18px; }
          .dsh-codex-empty { min-height: 280px; }
        }
        .dsh-codex-routing { overflow: hidden; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; background: var(--dsw-alias-bg-module-platform); }
        .dsh-codex-routing-trigger { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; min-height: 54px; padding: 15px 20px; border: 0; color: var(--dsw-alias-label-secondary); text-align: left; background: transparent; cursor: pointer; }
        .dsh-codex-routing-trigger:hover { background: var(--dsw-alias-interactive-bg-hover); }
        .dsh-codex-routing-trigger strong { min-width: 0; overflow: hidden; color: var(--dsw-alias-label-primary); font-size: 15px; line-height: 22px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
        .dsh-codex-routing-chevron { flex: 0 0 auto; transition: transform 160ms ease; }
        .dsh-codex-routing[data-open='false'] .dsh-codex-routing-chevron { transform: rotate(-90deg); }
        .dsh-codex-routing-content { border-top: 1px solid var(--dsw-alias-border-l2); }
        .dsh-codex-routing-description { margin: 0; padding: 14px 20px; overflow-wrap: anywhere; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }
        .dsh-codex-routing-list { display: flex; flex-direction: column; margin: 0; padding: 0; border-top: 1px solid var(--dsw-alias-border-l2); list-style: none; }
        .dsh-codex-routing-item { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: 10px; padding: 14px 20px; }
        .dsh-codex-routing-item + .dsh-codex-routing-item { border-top: 1px solid var(--dsw-alias-border-l2); }
        .dsh-codex-routing-item > :first-child { margin-top: 5px; }
        .dsh-codex-routing-body { display: flex; flex-direction: column; min-width: 0; gap: 4px; }
        .dsh-codex-routing-primary, .dsh-codex-routing-meta { display: flex; align-items: baseline; flex-wrap: wrap; min-width: 0; gap: 8px 12px; }
        .dsh-codex-routing-primary strong { color: var(--dsw-alias-label-primary); font-size: 14px; line-height: 20px; font-weight: 600; }
        .dsh-codex-routing-primary span { min-width: 0; overflow-wrap: anywhere; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }
        .dsh-codex-routing-meta { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
        .dsh-codex-routing-empty { margin: 0; padding: 16px 20px; border-top: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }
        .dsh-codex-routing-empty[role='alert'] { color: var(--dsw-alias-state-error-primary); }
        .dsh-codex-advanced { overflow: hidden; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; background: var(--dsw-alias-bg-module-platform); }
        .dsh-codex-advanced-trigger { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 14px; width: 100%; min-height: 82px; padding: 18px 20px; border: 0; color: var(--dsw-alias-label-secondary); text-align: left; background: transparent; cursor: pointer; }
        .dsh-codex-advanced-trigger:hover { background: var(--dsw-alias-interactive-bg-hover); }
        .dsh-codex-advanced-trigger > span { display: flex; flex-direction: column; min-width: 0; gap: 3px; }
        .dsh-codex-advanced-trigger strong { color: var(--dsw-alias-label-primary); font-size: 15px; line-height: 22px; font-weight: 600; }
        .dsh-codex-advanced-trigger small { overflow-wrap: anywhere; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }
        .dsh-codex-advanced-chevron { transition: transform 160ms ease; }
        .dsh-codex-advanced[data-open='false'] .dsh-codex-advanced-chevron { transform: rotate(-90deg); }
        .dsh-codex-advanced-content { margin: 0 20px; border-top: 1px solid var(--dsw-alias-border-l2); }
        .dsh-codex-advanced-group { padding: 22px 0; }
        .dsh-codex-advanced-group + .dsh-codex-advanced-group { border-top: 1px solid var(--dsw-alias-border-l2); }
        .dsh-codex-group-heading { display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; min-width: 0; gap: 20px; }
        .dsh-codex-group-heading > div { min-width: 0; }
        .dsh-codex-group-heading h3 { margin: 0; color: var(--dsw-alias-label-primary); font-size: 15px; line-height: 22px; font-weight: 600; }
        .dsh-codex-group-heading p, .dsh-codex-preference-row p, .dsh-codex-restart { margin: 4px 0 0; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }
        .dsh-codex-network-badges { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 14px; }
        .dsh-codex-preference-list { margin-top: 14px; overflow: hidden; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
        .dsh-codex-preference-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: flex-start; gap: 24px; padding: 16px; }
        .dsh-codex-preference-row > div { min-width: 0; overflow-wrap: anywhere; }
        .dsh-codex-preference-row + .dsh-codex-preference-row { border-top: 1px solid var(--dsw-alias-border-l2); }
        .dsh-codex-preference-row strong { color: var(--dsw-alias-label-primary); font-size: 14px; line-height: 20px; font-weight: 600; }
        .dsh-codex-danger-button { border-color: var(--dsw-alias-state-error-primary) !important; background: var(--dsw-alias-state-error-primary) !important; color: white !important; }
        .dsh-codex-danger-button:hover:not(:disabled) { filter: brightness(1.08); }
        @media (prefers-reduced-motion: reduce) {
          .dsh-codex-settings *, .dsh-codex-settings *::before, .dsh-codex-settings *::after { transition: none !important; }
        }
      `}</style>
      {embedded ? null : <div>
        <h2 id="openai-codex-settings-title" style={titleStyle}>{t('title')}</h2>
        <p style={{ ...bodyStyle, marginTop: 6 }}>{t('intro')}</p>
      </div>}

      <div className="dsh-codex-workspace">
        <aside className="dsh-codex-profile-list" aria-label={t('accountList')}>
          <div className="dsh-codex-list-heading">
            <h3>{t('accounts')} <span>({profiles.length})</span></h3>
            <Button
              className="dsh-codex-add-account"
              variant="outline"
              size="sm"
              icon={<IconPlusOutline16 />}
              disabled={busy || status.status === 'signing-in'}
              onClick={() => { void signIn() }}
            >
              <span className="dsh-codex-add-account-label">{t('addAccount')}</span>
            </Button>
          </div>
          <div className="dsh-codex-profile-items">
            {profiles.map((profile, index) => (
              <button
                key={profile.id}
                type="button"
                className="dsh-codex-profile-item"
                data-selected={profile.id === selectedProfile?.id}
                aria-current={profile.id === selectedProfile?.id ? 'true' : undefined}
                onClick={() => {
                  setSelectedProfileId(profile.id)
                  setPriorityError(undefined)
                }}
              >
                <ConnectionDot status={profile.connectionStatus} />
                <span className="dsh-codex-profile-identity">
                  <span className="dsh-codex-profile-alias">{t('priorityPosition', { rank: index + 1 })}</span>
                  <span className="dsh-codex-profile-name">{profile.label}</span>
                </span>
                <span className="dsh-codex-profile-badges">
                  {profile.id === priorityProfile?.id ? <span style={badgeStyle}>{t('profileInUse')}</span> : null}
                </span>
              </button>
            ))}
          </div>
        </aside>

        {selectedProfile === undefined ? (
          <div className="dsh-codex-empty">
            <div>
              <div className="dsh-codex-empty-status" role="status">
                {status.status === 'ready' ? null : <StateDot state={status.status === 'error' ? 'error' : 'ongoing'} size={9} />}
                <strong style={{ color: 'var(--dsw-alias-label-primary)' }}>{label}</strong>
              </div>
              {status.status === 'error'
                ? <><p style={{ ...errorStyle, marginTop: 6 }}>{status.message}</p>
                    <Button variant="outline" size="sm" onClick={() => { setStatus({ status: 'loading' }); void refresh() }}>{t('retry')}</Button></>
                : status.status === 'ready'
                  ? <p style={{ ...bodyStyle, marginTop: 6 }}>{signInNotice ?? t('emptyAccountHint')}</p>
                  : status.status === 'signing-in'
                    ? (
                        <Button
                          className="dsh-codex-cancel-auth"
                          variant="outline"
                          size="sm"
                          disabled={signInCancelling}
                          onClick={() => { void cancelSignIn() }}
                        >
                          {signInCancelling ? t('cancellingAuthorization') : t('cancelAuthorization')}
                        </Button>
                      )
                    : null}
            </div>
          </div>
        ) : (
          <section className="dsh-codex-profile-detail" aria-label={selectedProfile.label}>
            <div className="dsh-codex-detail-heading">
              <h3 className="dsh-codex-detail-title">{selectedProfile.label}</h3>
              <span
                className="dsh-codex-account-status"
                data-state={selectedProfile.connectionStatus === undefined ? 'idle' : selectedProfile.connectionStatus === 'reauth-required' ? 'error' : 'done'}
                role="status"
                {...selectedProfile.connectionStatus === 'reauth-required' && selectedProfile.quotaError !== undefined
                  ? { title: selectedProfile.quotaError }
                  : {}}
              >
                <ConnectionDot status={selectedProfile.connectionStatus} />
                {selectedProfile.connectionStatus === undefined ? t('accountConnectionUnknown') : selectedProfile.connectionStatus === 'reauth-required'
                  ? t('accountConnectionUnavailable')
                  : t('accountConnected')}
              </span>
            </div>
            <div className="dsh-codex-default">
              <Button
                className="dsh-codex-default-action"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => { void prioritizeProfile(selectedProfile.id) }}
              >
                {t('setPriorityProfile')}
              </Button>
              {priorityError === undefined ? null : <p role="alert">{priorityError}</p>}
            </div>
            <div className="dsh-codex-quota">
              {selectedProfile.quotaLoading ? <p style={bodyStyle}>{t('loadingQuota')}</p> : null}
              <UsageLimits
                loading={selectedProfile.quotaLoading ?? false}
                usage={selectedProfile.usage}
                {...selectedProfile.quotaError === undefined ? {} : { quotaError: selectedProfile.quotaError }}
                t={t}
              />
            </div>
            <div className="dsh-codex-detail-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setRenameLabel(selectedProfile.label)
                  setDialogError(undefined)
                  setDialog('rename')
                }}
              >
                {t('renameProfile')}
              </button>
              <button type="button" className="danger" disabled={busy} onClick={() => { setDialog('remove') }}>
                <IconTrashOutline16 />
                {t('removeAccount')}
              </button>
            </div>
          </section>
        )}
      </div>

      {profiles.length === 0 ? null : <section className="dsh-codex-routing" data-open={routingOpen} aria-labelledby="dsh-codex-routing-title">
        <button
          type="button"
          className="dsh-codex-routing-trigger"
          aria-expanded={routingOpen}
          aria-controls="dsh-codex-routing-content"
          onClick={() => { setRoutingOpen(open => !open) }}
        >
          <strong id="dsh-codex-routing-title">{t('recentRequests')}</strong>
          <IconChevronDownOutline14 className="dsh-codex-routing-chevron" />
        </button>
        {routingOpen ? <div id="dsh-codex-routing-content" className="dsh-codex-routing-content">
          <p className="dsh-codex-routing-description">{t('requestAttemptsOnly')}</p>
          {routingEventsError ? (
            <p className="dsh-codex-routing-empty" role="alert">{t('routingEventsUnavailable')}</p>
          ) : routingEvents.length === 0 ? (
            <p className="dsh-codex-routing-empty">{t('noRecentRequests')}</p>
          ) : (
            <ul className="dsh-codex-routing-list">
              {routingEvents.slice(0, 3).map(event => {
                const selectedAccount = t('accountAlias', { alias: event.profileAlias })
                const accountRoute = event.previousProfileAlias === undefined
                  ? selectedAccount
                  : `${t('accountAlias', { alias: event.previousProfileAlias })} → ${selectedAccount}`
                return (
                  <li className="dsh-codex-routing-item" key={event.id}>
                    <StateDot state={routingDotState(event.status)} size={9} />
                    <div className="dsh-codex-routing-body">
                      <div className="dsh-codex-routing-primary">
                        <strong>{accountRoute}</strong>
                        <span>{event.model}</span>
                      </div>
                      <div className="dsh-codex-routing-meta">
                        <span>{t(routingReasonKey(event.reason))}</span>
                        <span>{t(routingStatusKey(event.status))}</span>
                        <span>{t('oneRequest')}</span>
                        <time dateTime={new Date(event.startedAt).toISOString()}>
                          {new Date(event.finishedAt ?? event.startedAt).toLocaleTimeString()}
                        </time>
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div> : null}
      </section>}

      <section className="dsh-codex-advanced" data-open={advancedOpen}>
        <button type="button" className="dsh-codex-advanced-trigger" aria-expanded={advancedOpen} onClick={() => { setAdvancedOpen(open => !open) }}>
          <IconGlobeOutline14 size={20} />
          <span>
            <strong>{t('advancedSettings')}</strong>
            <small>{t('advancedSettingsSummary')}</small>
          </span>
          <IconChevronDownOutline14 className="dsh-codex-advanced-chevron" />
        </button>
        {advancedOpen ? (
          <div className="dsh-codex-advanced-content">
            <section className="dsh-codex-advanced-group" aria-labelledby="dsh-codex-network-title">
              <div className="dsh-codex-group-heading">
                <div>
                  <h3 id="dsh-codex-network-title">{t('outboundNetwork')}</h3>
                  <p>{t('outboundNetworkIntro')}</p>
                </div>
                <span style={badgeStyle}>{networkLabel}</span>
              </div>
              {network?.enabled === true ? (
                <div className="dsh-codex-network-badges" aria-label={t('networkOptionsEnabled')}>
                  {network.httpProxy ? <span style={badgeStyle}>{t('httpProxyConfigured')}</span> : null}
                  {network.httpsProxy ? <span style={badgeStyle}>{t('httpsProxyConfigured')}</span> : null}
                  {network.noProxy ? <span style={badgeStyle}>{t('noProxyConfigured')}</span> : null}
                </div>
              ) : null}
              <p className="dsh-codex-restart">{t('networkRestartHint')}</p>
            </section>

            <section className="dsh-codex-advanced-group" aria-labelledby="dsh-codex-image-title">
              <div className="dsh-codex-group-heading">
                <div>
                  <h3 id="dsh-codex-image-title">{t('imageTools')}</h3>
                  <p>{t('imageToolsIntro')}</p>
                </div>
              </div>
              <div className="dsh-codex-preference-list">
                <div className="dsh-codex-preference-row">
                  <div>
                    <strong>{t('modifyReadImage')}</strong>
                    <p>{t('modifyReadImageHint')}</p>
                  </div>
                  <PreferenceToggle
                    label={t('modifyReadImage')}
                    disabled={imageTools === undefined || imageToolsBusy}
                    checked={imageTools?.modifyReadImage ?? false}
                    onChange={(checked) => { void updateImageTool({ modifyReadImage: checked }) }}
                  />
                </div>
              </div>
              {imageToolsError === undefined ? null : <p style={{ ...errorStyle, marginTop: 10 }}>{imageToolsError}</p>}
            </section>

            <section className="dsh-codex-advanced-group" aria-labelledby="dsh-codex-conversation-title">
              <div className="dsh-codex-group-heading">
                <div>
                  <h3 id="dsh-codex-conversation-title">{t('responseApi')}</h3>
                  <p>{t('responseApiIntro')}</p>
                </div>
              </div>
              <div className="dsh-codex-preference-list">
                <div className="dsh-codex-preference-row">
                  <div>
                    <strong>{t('webSocketContextReuse')}</strong>
                    <p>{t('webSocketContextReuseHint')}</p>
                  </div>
                  <PreferenceToggle
                    label={t('webSocketContextReuse')}
                    disabled={responseApi === undefined || responseApiBusy}
                    checked={responseApi?.useWebSocketContextReuse ?? false}
                    onChange={(checked) => { void updateResponseApi({ useWebSocketContextReuse: checked }) }}
                  />
                </div>
                <div className="dsh-codex-preference-row">
                  <div>
                    <strong>{t('nativeCompaction')}</strong>
                    <p>{t('nativeCompactionHint')}</p>
                  </div>
                  <PreferenceToggle
                    label={t('nativeCompaction')}
                    disabled={responseApi === undefined || responseApiBusy}
                    checked={responseApi?.useNativeCompaction ?? false}
                    onChange={(checked) => { void updateResponseApi({ useNativeCompaction: checked }) }}
                  />
                </div>
              </div>
              {responseApiError === undefined ? null : <p style={{ ...errorStyle, marginTop: 10 }}>{responseApiError}</p>}
            </section>
          </div>
        ) : null}
      </section>

      <Modal
        open={dialog === 'rename' && selectedProfile !== undefined}
        onClose={closeDialog}
        title={t('renameAccountTitle')}
        closeLabel={t('closeDialog')}
        description={t('renameAccountDescription')}
        footer={(
          <>
            <Button variant="ghost" disabled={busy} onClick={closeDialog}>{t('cancel')}</Button>
            <Button
              variant="primary"
              disabled={busy || selectedProfile === undefined || renameLabel.trim() === selectedProfile.label}
              onClick={() => { if (selectedProfile !== undefined) void renameProfile(selectedProfile) }}
            >
              {busy ? t('working') : t('save')}
            </Button>
          </>
        )}
      >
        <label className="dsh-codex-dialog-field">
          <span>{t('profileLabel')}</span>
          <Input
            autoFocus
            maxLength={80}
            value={renameLabel}
            aria-label={t('renameProfilePrompt')}
            placeholder={t('profileLabelPlaceholder')}
            onChange={event => {
              setRenameLabel(event.target.value)
              setDialogError(undefined)
            }}
            onKeyDown={event => {
              if (event.key === 'Enter' && selectedProfile !== undefined && !busy) {
                event.preventDefault()
                void renameProfile(selectedProfile)
              }
            }}
          />
        </label>
        {dialogError === undefined ? null : <p className="dsh-codex-dialog-error" role="alert">{dialogError}</p>}
      </Modal>

      <Modal
        open={dialog === 'remove' && selectedProfile !== undefined}
        onClose={closeDialog}
        title={selectedProfile === undefined ? t('removeAccount') : t('removeAccountTitle', { label: selectedProfile.label })}
        closeLabel={t('closeDialog')}
        description={t('removeAccountDescription')}
        footer={(
          <>
            <Button variant="ghost" disabled={busy} onClick={closeDialog}>{t('cancel')}</Button>
            <Button
              variant="primary"
              className="dsh-codex-danger-button"
              disabled={busy || selectedProfile === undefined}
              onClick={() => { if (selectedProfile !== undefined) void removeProfile(selectedProfile) }}
            >
              {busy ? t('working') : t('confirmRemove')}
            </Button>
          </>
        )}
      />
    </section>
  )
}
