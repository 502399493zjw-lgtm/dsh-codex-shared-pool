import { useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamManagementExpectedContext, TeamSavedConnection } from '../../shared/team-management.ts'
import type { TeamManagementApi } from './api.ts'
import type { TeamSettingsKey } from './locales.ts'
import styles from './TeamSettings.module.css'

/** Only identity summaries reach this control. Host owns all credential transitions. */
export function TeamConnections({ api, t, expectedContext, disabled, onJoin, onChanged }: {
  api: TeamManagementApi
  t: (key: TeamSettingsKey, params?: Record<string, unknown>) => string
  expectedContext: TeamManagementExpectedContext | null
  disabled: boolean
  onJoin?: () => void
  onChanged: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [openedContext, setOpenedContext] = useState(expectedContext)
  const [loading, setLoading] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [connections, setConnections] = useState<readonly TeamSavedConnection[]>([])
  const [error, setError] = useState<string>()
  const others = connections.filter(item => item.teamId !== expectedContext?.teamId || item.currentMemberId !== expectedContext?.currentMemberId)
  const show = async () => {
    setOpenedContext(expectedContext)
    setOpen(true); setLoading(true); setError(undefined)
    try { setConnections(await api.connections()) }
    catch { setError(t('requestFailed')) }
    finally { setLoading(false) }
  }
  const select = async (id: string) => {
    setSwitching(true); setError(undefined)
    try {
      await api.switchConnection(id, openedContext)
      setOpen(false)
      await onChanged()
    } catch {
      setError(t('requestFailed'))
    } finally { setSwitching(false) }
  }
  return <>
    <div className={styles.compactActions}>
      <Button variant="ghost" disabled={disabled || switching} onClick={() => { void show() }}>{t('switchTeam')}</Button>
      {onJoin === undefined ? null : <Button variant="ghost" disabled={disabled || switching} onClick={onJoin}>{t('joinOtherTeam')}</Button>}
    </div>
    <Modal open={open} title={t('switchTeam')} description={t('switchTeamHint')} closeLabel={t('close')}
      onClose={() => { if (!switching) setOpen(false) }}>
      {error === undefined ? null : <p role="alert">{error}</p>}
      {loading ? <p role="status">{t('loading')}</p> : <section aria-label={t('savedTeams')}>
        {others.length === 0 ? <p>{t('noSavedTeams')}</p> : others.map(item =>
          <div key={item.id} className={styles.actionRow}>
            <Button variant="ghost" disabled={disabled || switching} onClick={() => { void select(item.id) }}>{item.teamName} · {item.memberName}</Button>
          </div>)}
      </section>}
    </Modal>
  </>
}
