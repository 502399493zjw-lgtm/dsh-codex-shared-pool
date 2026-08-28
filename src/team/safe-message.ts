import { safeExternalErrorMessage } from '../safe-message.ts'
import {
  TEAM_AUTHORIZATION_FAILED_CODE,
  TEAM_AUTHORIZATION_NETWORK_UNAVAILABLE_CODE,
} from '../shared/team-management.ts'

/** Browser-safe, 240-character Team status projection. */
export function safeTeamErrorMessage(error: unknown, maxLength = 240): string {
  return safeExternalErrorMessage(error, maxLength)
}

/**
 * Collapse upstream OAuth connectivity failures to a stable, secret-free code.
 *
 * This helper is intentionally limited to the contribution OAuth boundary. It
 * must not turn unrelated Team failures into a misleading network diagnosis.
 */
export function safeTeamOAuthErrorMessage(error: unknown): string {
  const diagnostic = safeExternalErrorMessage(error, 1_024)
  if (diagnostic === TEAM_AUTHORIZATION_NETWORK_UNAVAILABLE_CODE
    || diagnostic === TEAM_AUTHORIZATION_FAILED_CODE) return diagnostic

  // These are Host-authored lifecycle outcomes, not upstream diagnostics.
  if (/^(?:openai codex contribution )?authorization cancelled$/iu.test(diagnostic)) {
    return 'authorization cancelled'
  }
  if (diagnostic === 'authorization was interrupted; authorize this account again') return diagnostic

  const isUnsupportedRegion = (
    /device code request failed with status 403/iu.test(diagnostic)
    && /country,\s*region,\s*or\s*territory not supported/iu.test(diagnostic)
  )
  const isNetworkFailure = /(?:fetch failed|econnrefused|econnreset|etimedout|enotfound|enetunreach|eai_again|und_err|socket hang up)/iu.test(diagnostic)

  return isUnsupportedRegion || isNetworkFailure
    ? TEAM_AUTHORIZATION_NETWORK_UNAVAILABLE_CODE
    : TEAM_AUTHORIZATION_FAILED_CODE
}
