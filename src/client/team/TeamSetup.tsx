import { useState } from 'react'
import { Button, Input, Modal, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamManagementConnectionResult, TeamManagementExpectedContext } from '../../shared/team-management.ts'
import type { TeamManagementApi } from './api.ts'
import type { TeamSettingsKey } from './locales.ts'
import styles from './TeamSettings.module.css'

type Translate = (key: TeamSettingsKey, params?: Record<string, unknown>) => string
export type TeamSetupMode = 'create' | 'recover'
const RECOVERY_CODE_PATTERN = /^dsh_recovery_[A-Za-z0-9_-]{43}$/u

export function TeamSetup({ api, t, mode, expectedContext, pending, disabled, onBack, onConnected, onRefresh }: {
  api: TeamManagementApi
  t: Translate
  mode: TeamSetupMode
  expectedContext: TeamManagementExpectedContext | null
  pending: boolean
  disabled: boolean
  onBack: () => void
  onConnected: (result: TeamManagementConnectionResult) => Promise<void>
  onRefresh: () => Promise<void>
}) {
  const [teamName, setTeamName] = useState('')
  const [ownerName, setOwnerName] = useState('')
  const [recoveryCode, setRecoveryCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const valid = mode === 'create' ? teamName.trim().length > 0 && ownerName.trim().length > 0 : RECOVERY_CODE_PATTERN.test(recoveryCode.trim())
  const submit = async () => {
    setBusy(true); setError(undefined)
    try {
      const result = pending ? await api.resumeTeamSetup() : mode === 'create'
        ? await api.createTeam(teamName.trim(), ownerName.trim(), expectedContext)
        : await api.recoverOwner(recoveryCode.trim(), expectedContext)
      setRecoveryCode('')
      await onConnected(result)
    } catch (failure) {
      setError(typeof failure === 'object' && failure !== null && 'status' in failure && failure.status === 404 ? t('teamSetupUnavailable') : t('teamSetupFailed'))
    } finally {
      setRecoveryCode('')
      await onRefresh()
      setBusy(false)
    }
  }
  return <section className={styles.teamSetup} aria-label={t(mode === 'create' ? 'createTeam' : 'recoverOwner')}>
    <div className={styles.sectionCopy}>
      <h2 className={styles.sectionTitle}>{t(pending ? 'pendingTeamSetupTitle' : mode === 'create' ? 'createTeam' : 'recoverOwner')}</h2>
      <p className={styles.hint}>{t(pending ? 'pendingTeamSetupHint' : mode === 'create' ? 'createTeamHint' : 'recoverOwnerHint')}</p>
    </div>
    {error === undefined ? null : <p className={styles.errorText} role="alert">{error}</p>}
    {pending ? null : mode === 'create' ? <>
      <label className={styles.field}><span className={styles.label}>{t('newTeamName')}</span>
        <Input className={styles.input!} value={teamName} maxLength={120} autoComplete="off" onChange={event => setTeamName(event.target.value)} />
      </label>
      <label className={styles.field}><span className={styles.label}>{t('ownerDisplayName')}</span>
        <Input className={styles.input!} value={ownerName} maxLength={120} autoComplete="nickname" onChange={event => setOwnerName(event.target.value)} />
      </label>
    </> : <label className={styles.field}><span className={styles.label}>{t('recoveryCode')}</span>
      <Input className={styles.input!} type="password" value={recoveryCode} autoComplete="off" spellCheck={false} maxLength={256} placeholder="dsh_recovery_…" onChange={event => setRecoveryCode(event.target.value)} />
    </label>}
    <div className={styles.actionRow}>
      <Button variant="primary" disabled={disabled || busy || (!pending && !valid)} onClick={() => { void submit() }}>{t(busy ? 'working' : pending ? 'resumeTeamSetup' : mode === 'create' ? 'createAndSwitch' : 'recoverAndSwitch')}</Button>
      {pending ? null : <Button variant="ghost" disabled={busy} onClick={onBack}>{t(expectedContext === null ? 'back' : 'returnToTeam')}</Button>}
    </div>
  </section>
}

export function TeamRecoveryCode({ api, t, expectedContext, onClose }: {
  api: TeamManagementApi
  t: Translate
  expectedContext: TeamManagementExpectedContext
  onClose: () => void
}) {
  const [recoveryCode, setRecoveryCode] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [copied, setCopied] = useState(false)
  return <Modal open className={styles.inviteDialog!} title={t('saveRecoveryCode')} description={t('saveRecoveryCodeHint')} closeLabel={t('close')} onClose={onClose} footer={
    <Button variant="ghost" onClick={onClose}>{t('close')}</Button>
  }>
    {error === undefined ? null : <p role="alert">{error}</p>}
    {recoveryCode === undefined ? <Button variant="primary" disabled={busy} onClick={() => {
      setBusy(true); setError(undefined)
      void api.exportRecoveryCode(expectedContext).then(result => setRecoveryCode(result.recoveryCode)).catch(() => setError(t('recoveryCodeUnavailable'))).finally(() => setBusy(false))
    }}>{t(busy ? 'working' : 'showRecoveryCode')}</Button> : <div className={styles.recoveryCodePanel}>
      <label className={styles.field}><span className={styles.label}>{t('recoveryCode')}</span><Input className={styles.input!} readOnly value={recoveryCode} autoComplete="off" spellCheck={false} /></label>
      <Button variant="primary" onClick={() => { void writeClipboard(recoveryCode).then(ok => setCopied(ok)) }}>{t(copied ? 'recoveryCodeCopied' : 'copyRecoveryCode')}</Button>
    </div>}
  </Modal>
}
