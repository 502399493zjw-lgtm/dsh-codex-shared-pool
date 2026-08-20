import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

import { runTeamWebSmoke } from '../scripts/smoke-team-web.mjs'

const bootstrapToken = 'bootstrap-secret-for-team-web-smoke'
const apiKey = 'dsh_team_owner-secret-1234567890'
const inviteToken = 'dsh_invite_friend-secret-1234567890'
const baseUrl = 'http://127.0.0.1:3099/'

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
  it('ships a secret-free memory fixture and an explicit package command', async () => {
    const fixture = await readFile(new URL('./fixtures/team-web-smoke.patch.yml', import.meta.url), 'utf8')
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts?: Record<string, string>
    }

    expect(fixture).toMatch(/team:\s*\n\s*enabled:\s*true/u)
    expect(fixture).toMatch(/storage:\s*memory/u)
    expect(fixture).toMatch(/bootstrapTokenRef:\s*DSH_CODEX_SHARED_POOL_BOOTSTRAP_TOKEN/u)
    expect(fixture).toMatch(/teamClient:\s*\n\s*enabled:\s*true/u)
    expect(fixture).toMatch(/baseUrl:\s*http:\/\/127\.0\.0\.1:3099\/plugins\/dsh-codex-shared-pool\/team/u)
    expect(fixture).not.toMatch(/dsh_team_|dsh_invite_|bootstrap-secret|refresh_token|access_token/iu)
    expect(manifest.scripts?.['smoke:team-web']).toBe('node scripts/smoke-team-web.mjs --confirm-test-data')
  })

  it('bootstraps, connects, revokes an invite, rejects reuse, and removes the local key', async () => {
    const calls: Array<{ path: string, method: string, headers: Headers, body?: unknown }> = []
    let connected = false
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
          keyConfigured: connected,
          keyWritable: true,
          ...connected ? { keySource: 'profile' } : {},
          serverOrigin: url.origin,
        })
      }
      if (url.pathname.endsWith('/team/bootstrap')) {
        return json({ team, member: owner, apiKey }, 201)
      }
      if (url.pathname.endsWith('/team-client/connect')) {
        connected = true
        return json({ team, member: owner })
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
        connected = false
        return json({ disconnected: true, remoteRevoked: true })
      }
      return json({ error: 'unexpected request' }, 404)
    }

    await expect(runTeamWebSmoke({ fetch: fakeFetch, baseUrl, bootstrapToken })).resolves.toEqual({
      teamId: team.id,
      ownerMemberId: owner.id,
      inviteId: invite.id,
      cleanedUp: true,
    })

    expect(calls.map(call => `${call.method} ${call.path}`)).toEqual([
      'GET /plugins/dsh-codex-shared-pool/team-client/status',
      'POST /plugins/dsh-codex-shared-pool/team/bootstrap',
      'POST /plugins/dsh-codex-shared-pool/team-client/connect',
      'GET /plugins/dsh-codex-shared-pool/team-client/status',
      'GET /plugins/dsh-codex-shared-pool/team-client/overview',
      'POST /plugins/dsh-codex-shared-pool/team-client/invites',
      'GET /plugins/dsh-codex-shared-pool/team-client/overview',
      'POST /plugins/dsh-codex-shared-pool/team-client/invites/revoke',
      'POST /plugins/dsh-codex-shared-pool/team/join',
      'GET /plugins/dsh-codex-shared-pool/team-client/overview',
      'POST /plugins/dsh-codex-shared-pool/team-client/disconnect',
      'GET /plugins/dsh-codex-shared-pool/team-client/status',
    ])
    expect(calls[1]?.headers.get('x-dsh-bootstrap-token')).toBe(bootstrapToken)
    expect(calls[2]?.body).toEqual({ apiKey })
    expect(calls[8]?.body).toEqual({ inviteToken, displayName: 'Revoked Invite Probe' })
    expect(calls[10]?.body).toEqual({ revokeRemote: true })
  })

  it('never copies a secret-bearing HTTP response into a smoke-test error', async () => {
    const leaked = 'dsh_team_this-must-never-reach-the-error'
    const fakeFetch: typeof globalThis.fetch = async () => new Response(`provider failed with ${leaked}`, {
      status: 500,
      headers: { 'content-type': 'text/plain' },
    })

    await expect(runTeamWebSmoke({ fetch: fakeFetch, baseUrl, bootstrapToken }))
      .rejects.toThrowError(expect.not.stringContaining(leaked))
  })

  it('disconnects when a successful connect returns an invalid projection', async () => {
    const paths: string[] = []
    let connected = false
    const fakeFetch: typeof globalThis.fetch = async (input, init = {}) => {
      const path = new URL(String(input)).pathname
      paths.push(path)
      if (path.endsWith('/team-client/status')) {
        return json({ enabled: true, keyConfigured: connected, keyWritable: true, serverOrigin: new URL(baseUrl).origin })
      }
      if (path.endsWith('/team/bootstrap')) return json({ team, member: owner, apiKey }, 201)
      if (path.endsWith('/team-client/connect')) {
        connected = true
        return json({ team })
      }
      if (path.endsWith('/team-client/disconnect')) {
        expect(JSON.parse(String(init.body))).toEqual({ revokeRemote: true })
        connected = false
        return json({ disconnected: true, remoteRevoked: true })
      }
      return json({ error: 'unexpected request' }, 404)
    }

    await expect(runTeamWebSmoke({ fetch: fakeFetch, baseUrl, bootstrapToken }))
      .rejects.toThrow(/invalid Team connection/u)
    expect(paths).toContain('/plugins/dsh-codex-shared-pool/team-client/disconnect')
    expect(connected).toBe(false)
  })
})
