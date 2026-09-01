import { describe, expect, it } from 'vitest'
import { safeTeamErrorMessage, safeTeamOAuthErrorMessage } from '../src/team/safe-message.ts'
import {
  TEAM_AUTHORIZATION_FAILED_CODE,
  TEAM_AUTHORIZATION_NETWORK_UNAVAILABLE_CODE,
} from '../src/shared/team-management.ts'

describe('Team error-message redaction', () => {
  it.each([
    ['Authorization: Bearer opaque-provider-token', 'opaque-provider-token'],
    ['api_key=provider-api-secret', 'provider-api-secret'],
    ['api-key: provider-api-secret', 'provider-api-secret'],
    ['client_secret=provider-client-secret', 'provider-client-secret'],
    ['client-secret: provider-client-secret', 'provider-client-secret'],
    ['id_token=provider-id-secret', 'provider-id-secret'],
    ['"refresh_token":"provider-refresh-secret"', 'provider-refresh-secret'],
    ["'access-token':'provider-access-secret'", 'provider-access-secret'],
    ['dsh_team_team-secret-1234567890', 'dsh_team_team-secret-1234567890'],
    ['dsh_invite_invite-secret-1234567890', 'dsh_invite_invite-secret-1234567890'],
    ['eyJheader.eyJpayload.signature', 'eyJheader.eyJpayload.signature'],
  ])('redacts %s', (message, secret) => {
    const safe = safeTeamErrorMessage(new Error(`upstream failed: ${message}`))

    expect(safe).toContain('[redacted')
    expect(safe).not.toContain(secret)
  })

  it('preserves benign diagnostics and enforces the requested length limit', () => {
    expect(safeTeamErrorMessage(new Error('API key required'))).toBe('API key required')
    expect(safeTeamErrorMessage('x'.repeat(80), 32)).toBe('x'.repeat(32))
  })

  it('uses a closed OAuth error vocabulary while preserving Host lifecycle outcomes', () => {
    expect(safeTeamOAuthErrorMessage(new Error('provider refused this device request')))
      .toBe(TEAM_AUTHORIZATION_FAILED_CODE)
    expect(safeTeamOAuthErrorMessage(new Error('fetch failed: ECONNRESET')))
      .toBe(TEAM_AUTHORIZATION_NETWORK_UNAVAILABLE_CODE)
    expect(safeTeamOAuthErrorMessage(new Error('OpenAI Codex contribution authorization cancelled')))
      .toBe('authorization cancelled')
    expect(safeTeamOAuthErrorMessage('authorization was interrupted; authorize this account again'))
      .toBe('authorization was interrupted; authorize this account again')
  })
})
