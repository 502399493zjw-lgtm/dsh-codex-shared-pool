/** Codex account-pool quota contribution for the sidebar footer. */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  CodexQuotaFooter,
  type CodexQuotaFooterFace,
} from './CodexQuotaFooter.tsx'
import { CODEX_QUOTA_PATH, type CodexQuotaReadFace } from './useCodexQuota.ts'
import { en, zh, type CodexQuotaLocaleKey } from './locales.ts'
import { QUOTA_CLIENT_INJECT } from '../runtime-contract.ts'
import {
  CODEX_SETTINGS_SECTION_ID,
  CODEX_SETTINGS_SECTION_LABEL,
  openSettingsSection,
} from '../settings-section-navigation.ts'

export type {
  CodexQuotaFooterFace,
  CodexQuotaFooterProps,
} from './CodexQuotaFooter.tsx'
export type { CodexQuotaLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Codex account and quota copy. */
    'codex.quota': CodexQuotaLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'codex.quota'

/** Services required by the sidebar registration and generated Remote face. */
export const inject = [...QUOTA_CLIENT_INJECT]

/** Register the quota block before every existing sidebar footer action. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-codex-shared-pool: quota dictionaries')

  const read: CodexQuotaReadFace['read'] = async () => {
    const response = await fetch(CODEX_QUOTA_PATH, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`codex quota request failed with HTTP ${response.status}`)
    const value: unknown = await response.json()
    if (typeof value !== 'object' || value === null) throw new Error('codex quota returned malformed data')
    return value as Awaited<ReturnType<CodexQuotaReadFace['read']>>
  }
  const settingsNavigation = ctx.get('settingsNavigation')

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'codex-quota',
    order: -1000,
    locale: NS,
    inject: (): CodexQuotaFooterFace => ({
      read,
      openSettings: () => {
        openSettingsSection(
          CODEX_SETTINGS_SECTION_ID,
          CODEX_SETTINGS_SECTION_LABEL,
          settingsNavigation,
        )
      },
    }),
  }, CodexQuotaFooter))
}
