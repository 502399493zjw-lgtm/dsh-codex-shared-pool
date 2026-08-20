/**
 * The model-selection child seats are declared by the local DSH workspace
 * package.  They are intentionally repeated here because the published
 * rc.8 declaration currently omits that child-table merge, even though the
 * runtime still exposes these seats.  Keeping the declaration in the plugin
 * lets the standalone package compile against both the workspace and the
 * published DSH package without changing DSH itself.
 */
import type { SlotEntryDef } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * Published rc.8 does not provide an external Settings navigation service,
 * while compatible/newer shells may do so. Keep the narrow optional face local
 * so the standalone plugin can prefer it without requiring a private DSH path
 * or a core-package patch.
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    settingsNavigation: {
      openSection: (sectionId: string) => void
    }
  }
}

interface CodexModelMenuSelection {
  provider: string
  model: string
}

interface CodexModelTriggerPrefixOwner {
  selection: CodexModelMenuSelection | null
}

interface CodexModelMenuPreferenceOwner {
  selection: CodexModelMenuSelection | null
  interactionId: string
  close: (restoreFocus?: boolean) => void
  registerItem: (node: HTMLButtonElement | null) => void
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'conversation.input.model.trigger.prefix': SlotEntryDef & {
      kind: 'list'
      scope: 'session'
      owner: CodexModelTriggerPrefixOwner
    }
    'conversation.input.model.preference': SlotEntryDef & {
      kind: 'list'
      scope: 'session'
      owner: CodexModelMenuPreferenceOwner
    }
  }
}
