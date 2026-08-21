/** Published-DSH declarations kept at the plugin's narrow compile boundary. */
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

interface CodexModelSeatOwner {
  locked: boolean
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Stock rc.8's documented single model-select seat. */
    'conversation.input.model': SlotEntryDef & {
      kind: 'single'
      scope: 'session'
      owner: CodexModelSeatOwner
    }
  }
}
