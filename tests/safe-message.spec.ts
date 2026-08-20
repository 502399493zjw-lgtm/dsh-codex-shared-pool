import { describe, expect, it } from 'vitest'
import { safeExternalErrorMessage } from '../src/safe-message.ts'

describe('external error-message redaction', () => {
  it.each([
    ['Authorization: Bearer fake-token', 'fake-token'],
    ['authorization: Basic test-basic-credential', 'test-basic-credential'],
    ['Authorization: ApiKey test-provider-token', 'test-provider-token'],
    ['api_key=test-provider-secret', 'test-provider-secret'],
    ['api-key: test-provider-secret', 'test-provider-secret'],
    ['client_secret=test-client-secret', 'test-client-secret'],
    ['client-secret: test-client-secret', 'test-client-secret'],
    ['id_token=test-id-secret', 'test-id-secret'],
    ['"refresh_token":"test-refresh-secret"', 'test-refresh-secret'],
    ["'access-token':'test-access-secret'", 'test-access-secret'],
    ['password=test-database-password', 'test-database-password'],
    ['Cookie: session=test-provider-cookie', 'test-provider-cookie'],
    ['Cookie: session=test-first-cookie; refresh=test-second-cookie', 'test-second-cookie'],
    ['Set-Cookie: session=test-provider-cookie; HttpOnly', 'test-provider-cookie'],
    ['https://pooler:test-database-password@db.example/pool', 'test-database-password'],
    ['dsh_example_secret-1234567890', 'dsh_example_secret-1234567890'],
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
