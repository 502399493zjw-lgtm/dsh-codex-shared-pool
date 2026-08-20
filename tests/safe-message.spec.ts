import { describe, expect, it } from 'vitest'
import { safeExternalErrorMessage } from '../src/safe-message.ts'

describe('external error-message redaction', () => {
  it.each([
    ['Authorization: Bearer opaque-provider-token', 'opaque-provider-token'],
    ['authorization: Basic opaque-basic-credential', 'opaque-basic-credential'],
    ['Authorization: ApiKey opaque-provider-token', 'opaque-provider-token'],
    ['api_key=provider-api-secret', 'provider-api-secret'],
    ['api-key: provider-api-secret', 'provider-api-secret'],
    ['client_secret=provider-client-secret', 'provider-client-secret'],
    ['client-secret: provider-client-secret', 'provider-client-secret'],
    ['id_token=provider-id-secret', 'provider-id-secret'],
    ['"refresh_token":"provider-refresh-secret"', 'provider-refresh-secret'],
    ["'access-token':'provider-access-secret'", 'provider-access-secret'],
    ['password=database-password', 'database-password'],
    ['Cookie: session=provider-cookie', 'provider-cookie'],
    ['Cookie: session=first-cookie; refresh=second-cookie', 'second-cookie'],
    ['Set-Cookie: session=provider-cookie; HttpOnly', 'provider-cookie'],
    ['postgres://pooler:database-password@db.example/team', 'database-password'],
    ['dsh_team_team-secret-1234567890', 'dsh_team_team-secret-1234567890'],
    ['dsh_invite_invite-secret-1234567890', 'dsh_invite_invite-secret-1234567890'],
    ['eyJheader.eyJpayload.signature', 'eyJheader.eyJpayload.signature'],
  ])('redacts %s', (message, secret) => {
    const safe = safeExternalErrorMessage(new Error(`upstream failed: ${message}`))

    expect(safe).toContain('[redacted')
    expect(safe).not.toContain(secret)
  })

  it('preserves benign diagnostics and enforces the requested length limit', () => {
    expect(safeExternalErrorMessage(new Error('API key required'))).toBe('API key required')
    expect(safeExternalErrorMessage('x'.repeat(80), 32)).toBe('x'.repeat(32))
  })
})
