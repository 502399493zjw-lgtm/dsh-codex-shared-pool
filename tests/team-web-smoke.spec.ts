import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

import { runTeamWebSmoke } from '../scripts/smoke-team-web.mjs'

const inviteToken = 'dsh_invite_friend-secret-1234567890'
const managementCapability = `dsh_tm_${'c'.repeat(43)}`
const baseUrl = 'http://127.0.0.1:3099/'
const managementPath = '/plugins/dsh-codex-shared-pool/team-client'

const team = {
  id: 'team-1',
  name: 'Team Web Smoke',
  status: 'active',
  createdAt: 1,
}

const owner = {
  id: 'member-1',
  teamId: team.id,
  displayName: 'Smoke Owner',
  role: 'owner',
  status: 'active',
  joinedAt: 1,
}

const invite = {
  id: 'invite-1',
  teamId: team.id,
  invitedByMemberId: owner.id,
  status: 'pending',
  expiresAt: 86_400_000,
  createdAt: 2,
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status })
}

describe('Team-enabled stock DSH Web smoke', () => {
  it('ships a secret-free durable two-stage fixture and an explicit package command', async () => {
    const fixture = await readFile(new URL('./fixtures/team-web-smoke.patch.yml', import.meta.url), 'utf8')
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts?: Record<string, string>
    }

    expect(fixture).toMatch(/team:\s*\n\s*enabled:\s*true/u)
    expect(fixture).toMatch(/storage:\s*postgres/u)
    expect(fixture).toMatch(/databaseUrlRef:\s*DSH_CODEX_SHARED_POOL_DATABASE_URL/u)
    expect(fixture).toMatch(/credentialMasterKeyRef:\s*DSH_CODEX_SHARED_POOL_CREDENTIAL_MASTER_KEY/u)
    expect(fixture).toMatch(/inviteTokenMasterKeyRef:\s*DSH_CODEX_SHARED_POOL_INVITE_MASTER_KEY/u)
    expect(fixture).toMatch(/bootstrapTokenRef:\s*DSH_CODEX_SHARED_POOL_BOOTSTRAP_TOKEN/u)
    expect(fixture).toMatch(/teamClient:\s*\n\s*enabled:\s*true/u)
    expect(fixture).toMatch(/baseUrl:\s*http:\/\/127\.0\.0\.1:3099\/plugins\/dsh-codex-shared-pool\/team/u)
    expect(fixture).not.toMatch(/dsh_team_|dsh_invite_|bootstrap-secret|refresh_token|access_token/iu)
    expect(manifest.scripts?.['smoke:team-web']).toBe('node scripts/smoke-team-web.mjs --confirm-test-data')
  })

  it('uses a preconfigured Host key, revokes an invite, rejects reuse, and removes the local key', async () => {
    const calls: Array<{ path: string, method: string, headers: Headers, body?: unknown }> = []
    let keyConfigured = true
    let revoked = false

    const fakeFetch: typeof globalThis.fetch = async (input, init = {}) => {
      const url = new URL(String(input))
      const method = init.method ?? 'GET'
      const headers = new Headers(init.headers)
      const body = init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown
      calls.push({ path: url.pathname, method, headers, body })

      if (url.pathname.endsWith('/team-client/status')) {
        return json({
          enabled: true,
          keyConfigured,
          keyWritable: true,
          pendingJoinConfigured: false,
          ...keyConfigured ? { keySource: 'profile' } : {},
          serverOrigin: url.origin,
        })
      }
      if (url.pathname.endsWith('/team-client/session')) {
        return json({ capability: managementCapability, expiresAt: Date.now() + 60_000 })
      }
      if (url.pathname.endsWith('/team-client/overview')) {
        return json({
          team,
          currentMember: owner,
          members: [{ ...owner, canReceiveOwnership: false }],
          invites: revoked ? [] : calls.some(call => call.path.endsWith('/team-client/invites')) ? [invite] : [],
          contributions: [],
        })
      }
      if (url.pathname.endsWith('/team-client/invites/revoke')) {
        revoked = true
        return json({ invite: { ...invite, status: 'revoked' } })
      }
      if (url.pathname.endsWith('/team-client/invites')) {
        return json({ invite, inviteToken }, 201)
      }
      if (url.pathname.endsWith('/team/join')) {
        return json({ error: 'invite is invalid or expired' }, 404)
      }
      if (url.pathname.endsWith('/team-client/disconnect')) {
        keyConfigured = false
        return json({ disconnected: true, remoteRevoked: true })
      }
      return json({ error: 'unexpected request' }, 404)
    }

    await expect(runTeamWebSmoke({ fetch: fakeFetch, baseUrl })).resolves.toEqual({
      teamId: team.id,
      ownerMemberId: owner.id,
      inviteId: invite.id,
      cleanedUp: true,
    })

    expect(calls.map(call => `${call.method} ${call.path}`)).toEqual([
      'GET /plugins/dsh-codex-shared-pool/team-client/status',
      'GET /plugins/dsh-codex-shared-pool/team-client/overview',
      'POST /plugins/dsh-codex-shared-pool/team-client/session',
      'POST /plugins/dsh-codex-shared-pool/team-client/invites',
      'GET /plugins/dsh-codex-shared-pool/team-client/overview',
      'POST /plugins/dsh-codex-shared-pool/team-client/invites/revoke',
      'POST /plugins/dsh-codex-shared-pool/team/join',
      'GET /plugins/dsh-codex-shared-pool/team-client/overview',
      'POST /plugins/dsh-codex-shared-pool/team-client/disconnect',
      'GET /plugins/dsh-codex-shared-pool/team-client/status',
    ])
    expect(calls[2]?.body).toEqual({})
    expect(calls[3]?.body).toEqual({
      label: 'Team Web Smoke invitation',
      expiresInMs: 86_400_000,
    })
    expect(calls[6]?.body).toEqual({ inviteToken, displayName: 'Revoked Invite Probe' })
    expect(calls[8]?.body).toEqual({ revokeRemote: true })

    const managementCalls = calls.filter(call => call.path.startsWith(`${managementPath}/`))
    for (const call of managementCalls) {
      expect(call.headers.get('origin')).toBe(new URL(baseUrl).origin)
      expect(call.headers.get('sec-fetch-site')).toBe('same-origin')
      expect(JSON.stringify(call.body ?? null)).not.toMatch(/dsh_team_/u)
      expect([...call.headers.values()].join('\n')).not.toMatch(/dsh_team_/u)
    }
    const sessionCall = managementCalls.find(call => call.path.endsWith('/session'))
    expect(sessionCall?.headers.get('x-dsh-team-management-capability')).toBeNull()
    const protectedWrites = managementCalls.filter(call => call.method === 'POST' && !call.path.endsWith('/session'))
    expect(protectedWrites).toHaveLength(3)
    for (const call of protectedWrites) {
      expect(call.headers.get('x-dsh-team-management-capability')).toBe(managementCapability)
    }
    expect(calls.some(call => call.path.endsWith('/team-client/connect'))).toBe(false)
    expect(calls.some(call => call.path.endsWith('/team/bootstrap'))).toBe(false)
  })

  it('never copies a secret-bearing HTTP response into a smoke-test error', async () => {
    const leaked = 'dsh_team_this-must-never-reach-the-error'
    const fakeFetch: typeof globalThis.fetch = async () => new Response(`provider failed with ${leaked}`, {
      status: 500,
      headers: { 'content-type': 'text/plain' },
    })

    await expect(runTeamWebSmoke({ fetch: fakeFetch, baseUrl }))
      .rejects.toThrowError(expect.not.stringContaining(leaked))
  })

  it('disconnects the preconfigured key when the initial overview is invalid', async () => {
    const paths: string[] = []
    let keyConfigured = true
    const fakeFetch: typeof globalThis.fetch = async (input, init = {}) => {
      const path = new URL(String(input)).pathname
      paths.push(path)
      if (path.endsWith('/team-client/status')) {
        return json({
          enabled: true,
          keyConfigured,
          keyWritable: true,
          pendingJoinConfigured: false,
          serverOrigin: new URL(baseUrl).origin,
        })
      }
      if (path.endsWith('/team-client/overview')) return json({ team })
      if (path.endsWith('/team-client/session')) {
        return json({ capability: managementCapability, expiresAt: Date.now() + 60_000 })
      }
      if (path.endsWith('/team-client/disconnect')) {
        expect(JSON.parse(String(init.body))).toEqual({ revokeRemote: true })
        expect(new Headers(init.headers).get('x-dsh-team-management-capability')).toBe(managementCapability)
        keyConfigured = false
        return json({ disconnected: true, remoteRevoked: true })
      }
      return json({ error: 'unexpected request' }, 404)
    }

    await expect(runTeamWebSmoke({ fetch: fakeFetch, baseUrl }))
      .rejects.toThrow(/invalid Team management overview/u)
    expect(paths).toContain('/plugins/dsh-codex-shared-pool/team-client/disconnect')
    expect(keyConfigured).toBe(false)
  })
})
