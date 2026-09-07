import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { describe, expect, it, vi } from 'vitest'
import {
  createTeamCodexBearer,
  DEFAULT_TEAM_CLIENT_API_KEY_REF,
  resolveTeamClientApiKey,
  resolveTeamClientBaseUrl,
  resolveTeamClientConfig,
  resolveOptionalTeamClientApiKey,
  TeamClientConfigSchema,
  teamClientResponsesUrl,
  unwrapTeamCodexBearer,
} from '../src/team/client.ts'
import { TEAM_PATH_PREFIX } from '../src/team/types.ts'

describe('Team client Host runtime', () => {
  it('offers cloud onboarding for an omitted configuration even after schema parsing', () => {
    for (const input of [undefined, {}, TeamClientConfigSchema({})]) {
      const effective = resolveTeamClientConfig(input)
      expect(effective).toMatchObject({ automatic: true, config: {
        enabled: true,
        baseUrl: `https://47.84.77.193${TEAM_PATH_PREFIX}`,
      } })
      expect(effective.config.apiKeyRef).toMatch(/^DSH_CODEX_SHARED_POOL_CLOUD_[A-F0-9]+_API_KEY$/u)
      expect(effective.config.apiKeyRef).not.toBe(String(DEFAULT_TEAM_CLIENT_API_KEY_REF))
    }
  })

  it.each([
    { enabled: false },
    { enabled: true, baseUrl: `https://selfhost.example${TEAM_PATH_PREFIX}` },
    { baseUrl: `http://127.0.0.1:3080${TEAM_PATH_PREFIX}` },
    { apiKeyRef: 'CUSTOM_TEAM_KEY' },
    { enabled: true },
  ])('preserves explicit client configuration %j', input => {
    const parsed = TeamClientConfigSchema(input)
    expect(resolveTeamClientConfig(parsed)).toEqual({ config: parsed, automatic: false })
  })

  it('does not make a Team Host into a cloud client unless explicitly configured', () => {
    expect(resolveTeamClientConfig(undefined, true)).toEqual({ config: { enabled: false }, automatic: false })
    const explicit = { enabled: true, baseUrl: `https://selfhost.example${TEAM_PATH_PREFIX}` }
    expect(resolveTeamClientConfig(explicit, true)).toEqual({ config: explicit, automatic: false })
  })

  it('never resolves a legacy unscoped key for implicit cloud onboarding', async () => {
    const effective = resolveTeamClientConfig()
    const resolve = vi.fn(async (ref: CredentialRef) => String(ref) === String(DEFAULT_TEAM_CLIENT_API_KEY_REF)
      ? { value: 'dsh_team_legacy-key-1234567890', source: 'test' }
      : undefined)
    await expect(resolveOptionalTeamClientApiKey(effective.config, { resolve })).resolves.toBeUndefined()
    expect(resolve).toHaveBeenCalledExactlyOnceWith(effective.config.apiKeyRef)
  })

  it('automatically uses only the scoped credential and reads it again after connection changes', async () => {
    const effective = resolveTeamClientConfig()
    let value: string | undefined
    const resolve = vi.fn(async () => value === undefined ? undefined : { value, source: 'test' })
    await expect(resolveOptionalTeamClientApiKey(effective.config, { resolve })).resolves.toBeUndefined()
    value = 'dsh_team_cloud-key-1234567890'
    expect(unwrapTeamCodexBearer((await resolveOptionalTeamClientApiKey(effective.config, { resolve }))!)).toBe(value)
    value = undefined
    await expect(resolveOptionalTeamClientApiKey(effective.config, { resolve })).resolves.toBeUndefined()
    expect(resolve).toHaveBeenCalledTimes(3)
  })

  it.each(['', ' ', 'short', 'dsh_team_bad whitespace'])('rejects a present invalid credential instead of selecting local (%j)', async value => {
    await expect(resolveOptionalTeamClientApiKey(resolveTeamClientConfig().config, {
      resolve: async () => ({ value, source: 'test' }),
    })).rejects.toThrow(/invalid/u)
  })

  it('propagates credential service failures rather than treating them as an absent cloud membership', async () => {
    await expect(resolveOptionalTeamClientApiKey(resolveTeamClientConfig().config, {
      resolve: async () => { throw new Error('credential service unavailable') },
    })).rejects.toThrow('credential service unavailable')
  })

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
