/** Lightning mark shown before the active model while Codex Fast mode is on. */

import { useEffect, useSyncExternalStore } from 'react'
import { Zap } from 'lucide-react'
import { supportsCodexFastMode } from '../shared/model-capabilities.ts'
import {
  loadResponsePreferences,
  responsePreferencesSnapshot,
  subscribeResponsePreferences,
} from './response-preferences.ts'

interface ModelTriggerPrefixOwner {
  selection: { provider: string; model: string } | null
  title?: string
}

/** Pure visibility rule shared with the state test. */
export function shouldShowFastModeBolt(
  selection: ModelTriggerPrefixOwner['selection'],
  useFastMode: boolean,
): boolean {
  return useFastMode
    && selection?.provider === 'openai-codex'
    && supportsCodexFastMode(selection.model)
}

/** Provider-owned prefix contribution for the model trigger. */
export function FastModeTriggerIcon({ selection, title = 'Fast' }: ModelTriggerPrefixOwner) {
  const preferences = useSyncExternalStore(
    subscribeResponsePreferences,
    responsePreferencesSnapshot,
  )
  const supported = selection?.provider === 'openai-codex'
    && supportsCodexFastMode(selection.model)

  useEffect(() => {
    if (supported) void loadResponsePreferences().catch(() => undefined)
  }, [supported])

  if (!shouldShowFastModeBolt(selection, preferences?.useFastMode ?? false)) return null

  return (
    <span
      data-dsh-codex-fast-mode="true"
      title={title}
      aria-hidden="true"
      style={{ display: 'inline-grid', placeItems: 'center', flex: '0 0 16px' }}
    >
      <Zap size={16} strokeWidth={2.25} fill="currentColor" />
    </span>
  )
}
