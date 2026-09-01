import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { describe, expect, it, vi } from 'vitest'
import {
  createTeamCodexBearer,
  DEFAULT_TEAM_CLIENT_API_KEY_REF,
  resolveTeamClientApiKey,
  resolveTeamClientBaseUrl,
  teamClientResponsesUrl,
  unwrapTeamCodexBearer,
} from '../src/team/client.ts'
import { TEAM_PATH_PREFIX } from '../src/team/types.ts'

describe('Team client Host runtime', () => {
  it('accepts an HTTPS Team base URL and derives the Codex-native data-plane endpoint', () => {
    const baseUrl = resolveTeamClientBaseUrl(`https://pool.example.test${TEAM_PATH_PREFIX}/`)
    expect(baseUrl).toBe(`https://pool.example.test${TEAM_PATH_PREFIX}`)
    expect(teamClientResponsesUrl(baseUrl)).toBe(`https://pool.example.test${TEAM_PATH_PREFIX}/codex/responses`)
  })

  it('allows plain HTTP only for loopback development and rejects credential-leaking or ambiguous URLs', () => {
    expect(resolveTeamClientBaseUrl(`http://127.0.0.1:3000${TEAM_PATH_PREFIX}`))
      .toBe(`http://127.0.0.1:3000${TEAM_PATH_PREFIX}`)
    expect(() => resolveTeamClientBaseUrl(`http://pool.example.test${TEAM_PATH_PREFIX}`)).toThrow(/HTTPS/u)
    expect(() => resolveTeamClientBaseUrl(`https://user:secret@pool.example.test${TEAM_PATH_PREFIX}`)).toThrow(/credentials/u)
    expect(() => resolveTeamClientBaseUrl('https://pool.example.test/v1')).toThrow(/Team base URL/u)
  })

  it('re-resolves the Host credential per request and wraps it for the Codex provider without changing its bearer authority', async () => {
    const resolve = vi.fn(async (ref: CredentialRef) => ({ value: 'dsh_team_member-secret-1234567890', source: `test:${ref}` }))
    const first = await resolveTeamClientApiKey({}, { resolve })
    const second = await resolveTeamClientApiKey({}, { resolve })

    expect(resolve).toHaveBeenNthCalledWith(1, DEFAULT_TEAM_CLIENT_API_KEY_REF)
    expect(resolve).toHaveBeenNthCalledWith(2, DEFAULT_TEAM_CLIENT_API_KEY_REF)
    expect(first).not.toContain('dsh_team_member-secret-1234567890')
    expect(first.split('.')).toHaveLength(3)
    expect(unwrapTeamCodexBearer(first)).toBe('dsh_team_member-secret-1234567890')
    expect(second).toBe(first)
  })

  it('fails closed when the Team key reference is not configured', async () => {
    await expect(resolveTeamClientApiKey({ apiKeyRef: 'CUSTOM_TEAM_KEY' }, {
      resolve: async () => undefined,
    })).rejects.toThrow(/CUSTOM_TEAM_KEY.*not configured/u)
  })

  it('does not unwrap arbitrary JWTs as Team credentials', () => {
    const arbitrary = [
      Buffer.from('{"alg":"none"}').toString('base64url'),
      Buffer.from('{"https://api.openai.com/auth":{"chatgpt_account_id":"dsh-team-client"}}').toString('base64url'),
      Buffer.from('dsh_team_stolen').toString('base64url'),
    ].join('.')
    expect(unwrapTeamCodexBearer(arbitrary)).toBeUndefined()
    expect(unwrapTeamCodexBearer(createTeamCodexBearer('dsh_team_valid-secret-123456')))
      .toBe('dsh_team_valid-secret-123456')
  })
})
