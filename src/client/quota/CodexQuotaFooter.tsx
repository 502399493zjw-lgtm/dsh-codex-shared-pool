import type {
  InjectFace,
  PropsLocale,
  PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronRightOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  CODEX_QUOTA_POLL_INTERVAL_MS,
  type CodexQuotaReadFace,
  useCodexQuota,
} from './useCodexQuota.ts'
import css from './CodexQuotaFooter.module.css'

export { CODEX_QUOTA_POLL_INTERVAL_MS }

/** Private callbacks supplied by the Codex quota browser plugin. */
export interface CodexQuotaFooterFace extends CodexQuotaReadFace {
  /** Open this plugin's account-management page in Settings. */
  readonly openSettings: () => void
}

/** Props composed by the sidebar footer-action slot. */
export type CodexQuotaFooterProps =
  PropsRuntime<'sidebar.footer.action'>
  & InjectFace<CodexQuotaFooterFace>
  & PropsLocale<'codex.quota'>

/**
 * Format one reset instant as `M月D HH:mm` in the browser's local time zone.
 *
 * @param epochMs Reset instant in Unix epoch milliseconds.
 * @returns Reset month and day without padding, followed by zero-padded 24-hour time.
 */
export function formatCodexResetTime(epochMs: number): string {
  const resetAt = new Date(epochMs)
  const month = resetAt.getMonth() + 1
  const day = resetAt.getDate()
  const hour = String(resetAt.getHours()).padStart(2, '0')
  const minute = String(resetAt.getMinutes()).padStart(2, '0')
  return `${month}月${day} ${hour}:${minute}`
}

/** Render active-account identity and quota directly above sidebar bottom actions. */
export function CodexQuotaFooter({ wide, read, openSettings, t }: CodexQuotaFooterProps) {
  const { snapshot, unavailable } = useCodexQuota(read)

  if (!wide) return null
  if (snapshot === undefined || snapshot.currentAccountName === null
    || snapshot.currentRemainingPercent === null) {
    return (
      <section className={css.root} aria-label={t('aria')}>
        <div className={css.primary}>
          <div className={css.status} aria-live="polite">
            {unavailable ? t('unavailable') : t('loading')}
          </div>
          <button type="button" className={css.open} aria-label={t('open')} onClick={openSettings}>
            <IconChevronRightOutline14 size={16} />
          </button>
        </div>
        {snapshot !== undefined && (
          <div className={css.pool} aria-live="polite">
            {t('pool')} {snapshot.poolAccountCount} {t('accounts')}
            {snapshot.poolRemainingPercent !== null && (
              <>
                <span className={css.separator} aria-hidden> · </span>
                <span>{t('totalRemaining')} </span>
                <span>{snapshot.poolRemainingPercent}%</span>
              </>
            )}
          </div>
        )}
      </section>
    )
  }

  return (
    <section className={css.root} aria-label={t('aria')}>
      <div className={css.primary}>
        <div className={css.accountLine} aria-live="polite">
          <span className={css.accountLabel}>{t('account')}</span>
          <span className={css.account}>{snapshot.currentAccountName}</span>
        </div>
        <button type="button" className={css.open} aria-label={t('open')} onClick={openSettings}>
          <IconChevronRightOutline14 size={16} />
        </button>
      </div>
      <div className={css.current} aria-live="polite">
        <span>{t('remaining')} </span>
        <span className={css.quota}>{snapshot.currentRemainingPercent}%</span>
        <span className={css.separator} aria-hidden> · </span>
        <span>
          {snapshot.currentResetsAt === null
            ? t('resetUnknown')
            : t('resetAt', { time: formatCodexResetTime(snapshot.currentResetsAt) })}
        </span>
      </div>
      <div className={css.pool}>
        {t('pool')} {snapshot.poolAccountCount} {t('accounts')}
        <span className={css.separator} aria-hidden> · </span>
        <span>{t('totalRemaining')} </span>
        {snapshot.poolRemainingPercent === null
          ? <span>—</span>
          : <span>{snapshot.poolRemainingPercent}%</span>}
      </div>
    </section>
  )
}
