/** Browser half: OpenAI Codex account management inside dsh Settings. */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionBinding } from '@deepseek-ai/dsh-client-runtime/client'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './compat-slots.d.ts'
import { OpenAICodexSettings } from './OpenAICodexSettings.tsx'
import type { OpenAICodexSettingsInjected } from './OpenAICodexSettings.tsx'
import { ImagegenToolView } from './ImagegenToolView.tsx'
import type { ImageLoader } from './ImagegenToolView.tsx'
import { FastModeModelPreference } from './FastModeModelPreference.tsx'
import { FastModeTriggerIcon } from './FastModeTriggerIcon.tsx'
import { en, zh } from './locales.ts'
import type { OpenAICodexSettingsKey } from './locales.ts'
import { apply as applyCodexQuota } from './quota/index.ts'
import { TeamSettings } from './team/TeamSettings.tsx'
import type { TeamSettingsInjected } from './team/TeamSettings.tsx'
import { en as teamEn, zh as teamZh } from './team/locales.ts'
import type { TeamSettingsKey } from './team/locales.ts'
import { CLIENT_INJECT } from './runtime-contract.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** OpenAI Codex account page copy. */
    'settings.openai-codex': OpenAICodexSettingsKey
    /** Invite-only Team capacity page copy. */
    'settings.codex-team': TeamSettingsKey
  }
}

/** Stable browser-plugin name. */
export const name = 'dsh-codex-shared-pool-client'
/** Client services required by the settings contribution. */
export const inject = [...CLIENT_INJECT]

/** Register account copy and the OpenAI Codex settings page. */
export function apply(ctx: ClientContext): void {
  applyCodexQuota(ctx)
  const namespace = 'settings.openai-codex'
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-openai-codex: settings copy')
  const t = ctx.locale.bind(namespace) as OpenAICodexSettingsInjected['t']
  const teamNamespace = 'settings.codex-team'
  ctx.effect(() => ctx.locale.register(teamNamespace, { zh: teamZh, en: teamEn }), 'dsh-codex-team: settings copy')
  const teamT = ctx.locale.bind(teamNamespace) as TeamSettingsInjected['t']
  const imageUrls = new Map<string, Promise<string>>()
  const createdUrls = new Set<string>()
  const loadImage = (sessionId: SessionId, attachment: ImageAttachmentRef): Promise<string> => {
    const key = `${sessionId}:${attachment.attachmentId}`
    const cached = imageUrls.get(key)
    if (cached !== undefined) return cached
    // This browser entry shares a source package with the Host plugin, whose
    // Cordis `sessions` declaration is a different service. Narrow back to the
    // client runtime face at the browser-only boundary.
    const sessions = ctx.sessions as unknown as { binding(id: SessionId): SessionBinding | undefined }
    const session = sessions.binding(sessionId)?.session
    if (session === undefined) return Promise.reject(new Error(`unknown session ${sessionId}`))
    const pending = session.readAttachment(attachment.attachmentId).then((result: Awaited<ReturnType<SessionBinding['session']['readAttachment']>>) => {
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      const bytes = Uint8Array.from(result.value.data)
      const url = URL.createObjectURL(new Blob([bytes.buffer], { type: result.value.attachment.mediaType }))
      createdUrls.add(url)
      return url
    }).catch((error: unknown) => {
      imageUrls.delete(key)
      throw error
    })
    imageUrls.set(key, pending)
    return pending
  }
  ctx.effect(() => () => {
    for (const url of createdUrls) URL.revokeObjectURL(url)
    createdUrls.clear()
    imageUrls.clear()
  }, 'dsh-openai-codex: release image URLs')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'openai-codex',
    order: 15,
    label: () => t('nav'),
    inject: (): OpenAICodexSettingsInjected => ({ t }),
  }, OpenAICodexSettings))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'codex-team',
    order: 16,
    label: () => teamT('nav'),
    inject: (): TeamSettingsInjected => ({ t: teamT }),
  }, TeamSettings))
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'imagegen',
    inject: (sessionId: SessionId): { loadImage: ImageLoader; t: OpenAICodexSettingsInjected['t'] } => ({
      loadImage: attachment => loadImage(sessionId, attachment),
      t,
    }),
  }, ImagegenToolView))
  ctx.slots.inject('conversation.input.model.preference', () => ctx.slots.register({
    name: 'conversation.input.model.preference',
    id: 'openai-codex-speed',
    order: 10,
    locale: namespace,
  }, FastModeModelPreference))
  ctx.slots.inject('conversation.input.model.trigger.prefix', () => ctx.slots.register({
    name: 'conversation.input.model.trigger.prefix',
    id: 'openai-codex-fast-mode-bolt',
    order: 10,
  }, FastModeTriggerIcon))
}
