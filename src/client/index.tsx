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
import type { OpenAICodexSettingsInjected } from './OpenAICodexSettings.tsx'
import { CodexSubscriptionPoolSettings } from './CodexSubscriptionPoolSettings.tsx'
import type { CodexSubscriptionPoolSettingsInjected } from './CodexSubscriptionPoolSettings.tsx'
import { ImagegenToolView } from './ImagegenToolView.tsx'
import type { ImageLoader } from './ImagegenToolView.tsx'
import { CodexModelSelect } from './CodexModelSelect.tsx'
import { en, zh } from './locales.ts'
import type { OpenAICodexSettingsKey } from './locales.ts'
import { apply as applyCodexQuota } from './quota/index.ts'
import type { TeamSettingsInjected } from './team/TeamSettings.tsx'
import { en as teamEn, zh as teamZh } from './team/locales.ts'
import type { TeamSettingsKey } from './team/locales.ts'
import { CLIENT_INJECT } from './runtime-contract.ts'
import { CODEX_SETTINGS_SECTION_ID } from './settings-section-navigation.ts'

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
    id: CODEX_SETTINGS_SECTION_ID,
    order: 15,
    label: () => t('nav'),
    inject: (): CodexSubscriptionPoolSettingsInjected => ({ localT: t, teamT }),
  }, CodexSubscriptionPoolSettings))
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'imagegen',
    inject: (sessionId: SessionId): { loadImage: ImageLoader; t: OpenAICodexSettingsInjected['t'] } => ({
      loadImage: attachment => loadImage(sessionId, attachment),
      t,
    }),
  }, ImagegenToolView))
  const modelDirectories = ctx.modelDirectories
  // The shared Host entry augments Cordis with its own `sessions` service.
  // Narrow back to the browser runtime face at this browser-only boundary.
  const clientSessions = ctx.sessions as unknown as {
    subagentAddress(id: SessionId): unknown | undefined
  }
  ctx.slots.inject('conversation.input.model', () => ctx.slots.register({
    name: 'conversation.input.model',
    // Stock rc.8 declares one complete model affordance. A lower priority is
    // the supported shadowing mechanism for replacing that single occupant.
    priority: -10,
    locale: namespace,
    inject: (sessionId: SessionId) => {
      const directory = modelDirectories.directoryFor(sessionId)
      const available = clientSessions.subagentAddress(sessionId) === undefined
      return {
        available,
        directory: directory.store,
        load: () => {
          if (available) void directory.load().catch(() => undefined)
        },
        select: (selection: Parameters<typeof directory.select>[0]) => available
          ? directory.select(selection).then(() => true, () => false)
          : Promise.resolve(false),
      }
    },
  }, CodexModelSelect))
}
