/** Browser-side bridge for opening one page in the stock DSH Settings shell. */

/** Stable id registered by this plugin's account-management settings page. */
export const CODEX_SETTINGS_SECTION_ID = 'openai-codex'
/** The pinned rc.8 shell exposes nav rows only through their rendered labels. */
export const CODEX_SETTINGS_SECTION_LABEL = 'OpenAI Codex'

const SETTINGS_SHELL_WAIT_MS = 1_000
const SETTINGS_TRIGGER_SELECTOR = 'button[aria-haspopup="dialog"][aria-expanded]'
const SETTINGS_DIALOG_SELECTOR = '[role="dialog"][aria-modal="true"]'
const SETTINGS_NAV_BUTTON_SELECTOR = 'nav button[type="button"]'

/** Optional navigation face available in DSH variants newer than the rc.8 shell. */
export interface SettingsNavigationFace {
  openSection: (sectionId: string) => void
}

function normalizeLabel(value: string | null): string {
  return value?.replace(/\s+/g, ' ').trim() ?? ''
}

function selectRenderedSection(domDocument: Document, sectionLabel: string): boolean {
  const dialogs = domDocument.querySelectorAll<HTMLElement>(SETTINGS_DIALOG_SELECTOR)
  const dialog = dialogs.item(dialogs.length - 1)
  if (dialog === null) return false
  const normalizedLabel = normalizeLabel(sectionLabel)
  const button = [...dialog.querySelectorAll<HTMLButtonElement>(SETTINGS_NAV_BUTTON_SELECTOR)]
    .find(candidate => normalizeLabel(candidate.textContent) === normalizedLabel)
  if (button === undefined) return false
  button.click()
  return true
}

/**
 * Open a Settings section through a public navigation service when present.
 *
 * Published DSH rc.8 keeps its Settings open/active state inside the shell
 * component and provides no navigation service. Its documented shell still
 * renders an accessible dialog trigger and nav buttons, so the compatibility
 * path drives those semantics without depending on generated CSS class names.
 */
export function openSettingsSection(
  sectionId: string,
  sectionLabel: string,
  navigation?: SettingsNavigationFace,
  domDocument: Document | undefined = typeof document === 'undefined' ? undefined : document,
): void {
  if (navigation !== undefined) {
    navigation.openSection(sectionId)
    return
  }
  if (domDocument === undefined || selectRenderedSection(domDocument, sectionLabel)) return

  const trigger = domDocument.querySelector<HTMLButtonElement>(SETTINGS_TRIGGER_SELECTOR)
  if (trigger === null) return
  const observedRoot = domDocument.body
  const Observer = domDocument.defaultView?.MutationObserver
  let observer: MutationObserver | undefined
  let timeout: number | undefined
  const stop = (): void => {
    observer?.disconnect()
    if (timeout !== undefined) domDocument.defaultView?.clearTimeout(timeout)
  }
  if (observedRoot !== null && Observer !== undefined) {
    observer = new Observer(() => {
      if (selectRenderedSection(domDocument, sectionLabel)) stop()
    })
    observer.observe(observedRoot, { childList: true, subtree: true })
    timeout = domDocument.defaultView?.setTimeout(stop, SETTINGS_SHELL_WAIT_MS)
  }

  trigger.click()
  if (selectRenderedSection(domDocument, sectionLabel)) stop()
}
