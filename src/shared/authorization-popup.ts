export const OPENAI_CODEX_AUTHORIZATION_POPUP_PATH = '/plugins/dsh-openai-codex/auth/popup'
export const OPENAI_CODEX_AUTHORIZATION_POPUP_SESSION_PATH = '/plugins/dsh-openai-codex/auth/popup/session'
export const OPENAI_CODEX_AUTHORIZATION_POPUP_ATTEMPT_BYTES = 32
export const OPENAI_CODEX_AUTHORIZATION_POPUP_ATTEMPT_HEX_LENGTH =
  OPENAI_CODEX_AUTHORIZATION_POPUP_ATTEMPT_BYTES * 2
export const OPENAI_CODEX_AUTHORIZATION_POPUP_SESSION_TTL_MS = 2 * 60 * 1_000

/** Validate the 256-bit lowercase hexadecimal token shared by the client and Host. */
export function isOpenAICodexAuthorizationPopupAttemptToken(value: string): boolean {
  return value.length === OPENAI_CODEX_AUTHORIZATION_POPUP_ATTEMPT_HEX_LENGTH
    && /^[a-f0-9]+$/.test(value)
}

/** Allow the bridge to navigate only to the provider endpoint used by Codex OAuth. */
export function isOpenAICodexAuthorizationUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.origin === 'https://auth.openai.com'
      && url.pathname === '/oauth/authorize'
      && url.username === ''
      && url.password === ''
      && url.port === ''
      && url.hash === ''
  } catch {
    return false
  }
}
