import { useEffect, useRef, useState } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamManagementExpectedContext, TeamSavedConnection } from '../../shared/team-management.ts'
import type { TeamManagementApi } from './api.ts'
import type { TeamSettingsKey } from './locales.ts'
import { TeamFloatingMenu } from './TeamFloatingMenu.tsx'
import styles from './TeamSettings.module.css'

/** Only identity summaries reach this control. Host owns all credential transitions. */
export function TeamConnections({ api, t, expectedContext, disabled, teamName, memberName, prominent = false, onJoin, onCreate, onRecover, onChanged }: {
  api: TeamManagementApi
  t: (key: TeamSettingsKey, params?: Record<string, unknown>) => string
  expectedContext: TeamManagementExpectedContext | null
  disabled: boolean
  teamName?: string
  memberName?: string
  prominent?: boolean
  onJoin?: () => void
  onCreate: () => void
  onRecover?: () => void
  onChanged: () => Promise<void>
}) {
  const anchorRef = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)
  const [openedContext, setOpenedContext] = useState(expectedContext)
  const [loading, setLoading] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [connections, setConnections] = useState<readonly TeamSavedConnection[]>([])
  const [error, setError] = useState<string>()
  const requestGeneration = useRef(0)
  const contextKey = JSON.stringify(expectedContext)
  useEffect(() => {
    setOpen(false); setConnections([]); setLoading(false); setError(undefined)
    return () => { requestGeneration.current += 1 }
  }, [contextKey])
  const others = connections.filter(item => item.teamId !== expectedContext?.teamId || item.currentMemberId !== expectedContext?.currentMemberId)
  const loadConnections = async () => {
    const generation = ++requestGeneration.current
    setConnections([]); setLoading(true)
    try {
      const saved = await api.connections()
      if (generation === requestGeneration.current) setConnections(saved)
    } catch {
      if (generation === requestGeneration.current) setError(t('requestFailed'))
    } finally {
      if (generation === requestGeneration.current) setLoading(false)
    }
  }
  const show = async () => {
    if (open) { setOpen(false); return }
    setOpenedContext(expectedContext)
    setOpen(true); setError(undefined)
    await loadConnections()
  }
  const select = async (id: string) => {
    const generation = requestGeneration.current
    setSwitching(true); setError(undefined)
    try {
      await api.switchConnection(id, openedContext)
      setOpen(false)
      await onChanged()
    } catch {
      if (generation === requestGeneration.current) {
        setError(t('requestFailed'))
        // The Host may have removed an ended membership while attempting the switch.
        await loadConnections()
      }
    } finally { setSwitching(false) }
  }
  return <span ref={anchorRef} className={styles.teamSelector}>
    <button type="button" className={styles.teamSelectorTrigger} data-prominent={prominent} disabled={disabled || switching}
      aria-label={teamName ?? t('savedTeams')} title={teamName ?? t('savedTeams')} aria-haspopup="menu" aria-expanded={open} onClick={() => { void show() }}>
      <span className={styles.teamSelectorName}>{teamName ?? t('savedTeams')}</span><span className={styles.teamSelectorChevron} aria-hidden="true"><IconChevronDownOutline14 /></span>
    </button>
    {open ? <TeamFloatingMenu anchorRef={anchorRef} label={t('switchTeam')} className={styles.teamConnectionsMenu!} onClose={() => { if (!switching) setOpen(false) }}>
      {teamName === undefined ? null : <button type="button" role="menuitemradio" aria-checked="true" disabled>
        <span className={styles.savedTeamIdentity}><strong>{teamName}</strong><small>{memberName}</small></span><span aria-hidden="true">✓</span>
      </button>}
      {error === undefined ? null : <p className={styles.teamMenuHint} role="alert">{error}</p>}
      {loading ? <p className={styles.teamMenuHint} role="status">{t('loading')}</p> : others.map(item =>
        <button key={item.id} type="button" role="menuitemradio" aria-checked="false" aria-label={`${item.teamName} · ${item.memberName}`} disabled={disabled || switching} onClick={() => { void select(item.id) }}>
          <span className={styles.savedTeamIdentity}><strong>{item.teamName}</strong><small>{item.memberName}</small></span>
        </button>)}
      {onRecover === undefined ? null : <button type="button" role="menuitem" disabled={disabled || switching} onClick={() => { setOpen(false); onRecover() }}>{t('recoverOwner')}</button>}
      <div className={styles.teamConnectionsFooter}>
        {onJoin === undefined ? null : <button type="button" role="menuitem" disabled={disabled || switching} onClick={() => { setOpen(false); onJoin() }}>{t('joinTeamAction')}</button>}
        <button type="button" role="menuitem" disabled={disabled || switching} onClick={() => { setOpen(false); onCreate() }}>{t('createTeam')}</button>
      </div>
    </TeamFloatingMenu> : null}
  </span>
}
