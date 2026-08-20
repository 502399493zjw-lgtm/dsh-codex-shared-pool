import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerTeamManagementRoutes } from '../src/team/management-routes.ts'
import {
  TEAM_MANAGEMENT_CONNECT_PATH,
  TEAM_MANAGEMENT_DISCONNECT_PATH,
  TEAM_MANAGEMENT_INVITES_PATH,
  TEAM_MANAGEMENT_INVITES_REVOKE_PATH,
  TEAM_MANAGEMENT_JOIN_PATH,
  TEAM_MANAGEMENT_LEAVE_PATH,
  TEAM_MANAGEMENT_OVERVIEW_PATH,
  TEAM_MANAGEMENT_OAUTH_REAUTHORIZE_PATH,
  TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_PATH,
  TEAM_MANAGEMENT_STATUS_PATH,
} from '../src/shared/team-management.ts'
import type { TeamClientConfig } from '../src/team/client.ts'

interface CapturedRoute {
  path: string
  handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>
  disposed: boolean
}

class FakeCredentials {
  value: string | undefined
  writable = true
  readonly sets: Array<{ ref: CredentialRef; value: string }> = []
  readonly unsets: CredentialRef[] = []

  resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return Promise.resolve(this.value === undefined ? undefined : { value: this.value, source: 'test' })
  }

  describe(_ref: CredentialRef): Promise<CredentialInfo> {
    return Promise.resolve({ configured: this.value !== undefined, source: this.value === undefined ? undefined : 'test', writable: this.writable })
  }

  set(ref: CredentialRef, value: string): Promise<void> {
    this.sets.push({ ref, value })
    this.value = value
    return Promise.resolve()
  }

  unset(ref: CredentialRef): Promise<void> {
    this.unsets.push(ref)
    this.value = undefined
    return Promise.resolve()
  }
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function setup(
  config: TeamClientConfig,
  credentials = new FakeCredentials(),
  fetch = vi.fn<typeof globalThis.fetch>(),
): { routes: CapturedRoute[]; credentials: FakeCredentials; fetch: typeof fetch } {
  const routes: CapturedRoute[] = []
  const fake = {
    webServer: {
      register(route: { path: string; handler(req: IncomingMessage, res: ServerResponse): void | Promise<void> }) {
        const captured: CapturedRoute = { ...route, disposed: false }
        routes.push(captured)
        return () => { captured.disposed = true }
      },
    },
    effect(effect: () => (() => void | Promise<void>)) {
      const cleanup = effect()
      cleanups.push(async () => { await cleanup() })
    },
  } as unknown as Context
  registerTeamManagementRoutes(fake, config, credentials, { fetch })
  return { routes, credentials, fetch }
}

function request(
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
  remoteAddress = '127.0.0.1',
): IncomingMessage {
  const payload = body === undefined ? '' : JSON.stringify(body)
  const stream = Readable.from(payload === '' ? [] : [Buffer.from(payload)]) as unknown as IncomingMessage
  Object.assign(stream, {
    method,
    headers: {
      host: '127.0.0.1:31415',
      ...body === undefined ? {} : { 'content-type': 'application/json' },
      ...headers,
    },
    socket: { remoteAddress },
  })
  return stream
}

async function response(
  handler: CapturedRoute['handler'],
  req: IncomingMessage,
): Promise<{ status: number; headers: Record<string, string>; body: Record<string, unknown> }> {
  let status = 0
  let headers: Record<string, string> = {}
  let text = ''
  const res = {
    writeHead(code: number, values: Record<string, string>) { status = code; headers = values },
    end(value?: string) { text = value ?? '' },
  } as unknown as ServerResponse
  await handler(req, res)
  return { status, headers, body: JSON.parse(text) as Record<string, unknown> }
}

function route(routes: CapturedRoute[], path: string): CapturedRoute {
  const match = routes.find(candidate => candidate.path === path)
  if (match === undefined) throw new Error(`route missing: ${path}`)
  return match
}

function team() {
  return { id: 'team-1', name: 'Friends', status: 'active', createdAt: 1 }
}

function member() {
  return { id: 'member-1', teamId: 'team-1', displayName: 'Edison', role: 'owner', status: 'active', joinedAt: 2 }
}

function contribution(lastError?: string) {
  return {
    id: 'account-1',
    teamId: 'team-1',
    ownerMemberId: 'member-1',
    label: 'Owner Codex',
    status: 'reauth_required',
    personalReservePercent: 20,
    maxSharedRequestsPerWindow: null,
    maxSharedConcurrency: 1,
    allowedModels: [],
    createdAt: 3,
    updatedAt: 4,
    ...lastError === undefined ? {} : { lastError },
  }
}

function overview(extra: Record<string, unknown> = {}) {
  return {
    team: team(),
    currentMember: member(),
    members: [member()],
    invites: [],
    apiKeys: [{
      id: 'key-1', teamId: 'team-1', memberId: 'member-1', label: 'owner', prefix: 'dsh_team_owner', createdAt: 1,
      tokenHash: 'must-not-cross',
    }],
    contributions: [],
    ...extra,
  }
}

describe('local Team management routes', () => {
  it('reports disabled configuration without exposing a key reference and rejects cross-site requests', async () => {
    const { routes } = setup({ enabled: false })
    const status = route(routes, TEAM_MANAGEMENT_STATUS_PATH)
    const normal = await response(status.handler, request('GET'))
    expect(normal).toEqual(expect.objectContaining({
      status: 200,
      body: { enabled: false, keyConfigured: false, keyWritable: false },
    }))
    expect(JSON.stringify(normal.body)).not.toMatch(/apiKey|credential|ref/iu)
    expect(normal.headers).toMatchObject({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })

    await expect(response(status.handler, request('GET', undefined, {
      origin: 'https://evil.example',
      'sec-fetch-site': 'cross-site',
    }))).resolves.toMatchObject({ status: 403 })
  })

  it('resolves the Team key per operation and projects a secret-free overview', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(overview({
      refresh_token: 'remote-secret',
      prompt: 'private prompt',
    })), { status: 200, headers: { 'content-type': 'application/json' } }))
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch)

    const result = await response(route(routes, TEAM_MANAGEMENT_OVERVIEW_PATH).handler, request('GET'))
    expect(result.status, JSON.stringify(result.body)).toBe(200)
    expect(result.body).toMatchObject({ team: { name: 'Friends' }, currentMember: { displayName: 'Edison' } })
    expect(JSON.stringify(result.body)).not.toMatch(/remote-secret|private prompt|tokenHash|apiKeys/iu)
    expect(fetch).toHaveBeenCalledWith(
      'https://pool.example/plugins/dsh-codex-shared-pool/team/overview',
      expect.objectContaining({ headers: expect.objectContaining({ authorization: `Bearer ${credentials.value}` }), redirect: 'error' }),
    )
  })

  it('projects live capacity only for contributions owned by the current member', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_owner-secret-1234567890'
    const liveCapacity = {
      sharedInFlight: 1,
      buckets: [{
        id: 'codex',
        reason: 'request_cap_reached',
        remainingPercent: 72,
        resetAt: 10_000,
        sharedRequestsUsed: 5,
        access_token: 'must-not-cross',
      }],
      refreshToken: 'must-not-cross',
    }
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(overview({
      contributions: [
        { ...contribution(), status: 'active', capacity: liveCapacity },
        {
          ...contribution(), id: 'account-2', ownerMemberId: 'member-2', status: 'active',
          capacity: liveCapacity,
        },
      ],
    })), { status: 200, headers: { 'content-type': 'application/json' } }))
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch)

    const result = await response(route(routes, TEAM_MANAGEMENT_OVERVIEW_PATH).handler, request('GET'))

    expect(result.status, JSON.stringify(result.body)).toBe(200)
    const contributions = result.body.contributions as Array<Record<string, unknown>>
    expect(contributions[0]?.capacity).toEqual({
      sharedInFlight: 1,
      buckets: [{
        id: 'codex', reason: 'request_cap_reached', remainingPercent: 72, resetAt: 10_000, sharedRequestsUsed: 5,
      }],
    })
    expect(contributions[1]).not.toHaveProperty('capacity')
    expect(JSON.stringify(result.body)).not.toContain('must-not-cross')
  })

  it('projects ownership eligibility only for active teammates with a live Team key', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_owner-secret-1234567890'
    const current = member()
    const eligible = { ...member(), id: 'member-2', displayName: 'Eligible', role: 'admin' }
    const revoked = { ...member(), id: 'member-3', displayName: 'Revoked key', role: 'member' }
    const keyless = { ...member(), id: 'member-4', displayName: 'No key', role: 'member' }
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(overview({
      currentMember: current,
      members: [current, eligible, revoked, keyless],
      apiKeys: [
        { id: 'key-owner', teamId: 'team-1', memberId: current.id, label: 'owner', prefix: 'dsh_team_owner', createdAt: 1 },
        { id: 'key-eligible', teamId: 'team-1', memberId: eligible.id, label: 'member', prefix: 'dsh_team_member', createdAt: 1 },
        { id: 'key-revoked', teamId: 'team-1', memberId: revoked.id, label: 'old', prefix: 'dsh_team_old', createdAt: 1, revokedAt: 2 },
      ],
    })), { status: 200, headers: { 'content-type': 'application/json' } }))
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch)

    const result = await response(route(routes, TEAM_MANAGEMENT_OVERVIEW_PATH).handler, request('GET'))

    expect(result.status, JSON.stringify(result.body)).toBe(200)
    expect(result.body.members).toEqual([
      { ...current, canReceiveOwnership: false },
      { ...eligible, canReceiveOwnership: true },
      { ...revoked, canReceiveOwnership: false },
      { ...keyless, canReceiveOwnership: false },
    ])
    expect(JSON.stringify(result.body)).not.toMatch(/apiKeys|key-eligible|dsh_team_member/iu)
  })

  it('redacts credential material from remote contribution diagnostics before Browser projection', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const remoteDiagnostic = [
      'Authorization: Bearer opaque-provider-token',
      'api_key=provider-api-secret',
      'client_secret=provider-client-secret',
      'id_token=provider-id-secret',
      'dsh_invite_invite-secret-1234567890',
    ].join(' ')
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(overview({
      contributions: [contribution(remoteDiagnostic)],
    })), { status: 200, headers: { 'content-type': 'application/json' } }))
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch)

    const result = await response(route(routes, TEAM_MANAGEMENT_OVERVIEW_PATH).handler, request('GET'))

    expect(result.status, JSON.stringify(result.body)).toBe(200)
    const serialized = JSON.stringify(result.body)
    expect(serialized).toContain('[redacted')
    expect(serialized).not.toMatch(/opaque-provider-token|provider-api-secret|provider-client-secret|provider-id-secret|dsh_invite_/u)
  })

  it('forwards owner reauthorization through the same-origin management route', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      account: { ...contribution(), status: 'authorizing', lastError: undefined },
      method: 'device_code',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-EFGH',
      expiresAt: Date.now() + 900_000,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch)

    const result = await response(route(routes, TEAM_MANAGEMENT_OAUTH_REAUTHORIZE_PATH).handler, request('POST', { accountId: 'account-1' }))

    expect(result).toMatchObject({ status: 200, body: { account: { id: 'account-1', status: 'authorizing' }, method: 'device_code' } })
    expect(fetch).toHaveBeenCalledWith(
      'https://pool.example/plugins/dsh-codex-shared-pool/team/contributions/oauth/reauthorize',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ accountId: 'account-1' }) }),
    )
  })

  it('accepts an invite and stores the one-time member key without returning it to the Browser', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      team: team(),
      member: member(),
      apiKey: 'dsh_team_joined-secret-1234567890',
    }), { status: 201, headers: { 'content-type': 'application/json' } }))
    const { routes, credentials } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, new FakeCredentials(), fetch)

    const result = await response(route(routes, TEAM_MANAGEMENT_JOIN_PATH).handler, request('POST', {
      inviteToken: 'dsh_invite_secret-1234567890',
      displayName: 'Edison',
    }))
    expect(result.status).toBe(201)
    expect(result.body).toEqual({ team: team(), member: member() })
    expect(JSON.stringify(result.body)).not.toMatch(/dsh_team|dsh_invite/iu)
    expect(credentials.sets).toHaveLength(1)
    expect(credentials.sets[0]?.value).toBe('dsh_team_joined-secret-1234567890')
    expect(fetch).toHaveBeenCalledWith(
      'https://pool.example/plugins/dsh-codex-shared-pool/team/join',
      expect.objectContaining({ headers: expect.not.objectContaining({ authorization: expect.anything() }) }),
    )
  })

  it('validates an existing key through the Host before storing it', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(overview()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const { routes, credentials } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, new FakeCredentials(), fetch)
    const apiKey = 'dsh_team_existing-secret-1234567890'

    const result = await response(route(routes, TEAM_MANAGEMENT_CONNECT_PATH).handler, request('POST', { apiKey }))
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ team: team(), member: member() })
    expect(credentials.value).toBe(apiKey)
    expect(JSON.stringify(result.body)).not.toContain(apiKey)
  })

  it('returns a newly-created invite token intentionally, while keeping the Team key Host-only', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      invite: {
        id: 'invite-1', teamId: 'team-1', invitedByMemberId: 'member-1', status: 'pending', expiresAt: 5, createdAt: 3,
      },
      inviteToken: 'dsh_invite_share-this-once-1234567890',
      internal: 'drop-me',
    }), { status: 201, headers: { 'content-type': 'application/json' } }))
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch)

    const result = await response(route(routes, TEAM_MANAGEMENT_INVITES_PATH).handler, request('POST', { expiresInMs: 86_400_000 }))
    expect(result.status).toBe(201)
    expect(result.body.inviteToken).toBe('dsh_invite_share-this-once-1234567890')
    expect(result.body).not.toHaveProperty('internal')
    expect(JSON.stringify(result.body)).not.toContain(String(credentials.value))
  })

  it('proxies invite revocation without exposing the Host-owned Team key', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      invite: {
        id: 'invite-1', teamId: 'team-1', invitedByMemberId: 'member-1', status: 'revoked', expiresAt: 5, createdAt: 3,
      },
      internal: 'drop-me',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch)

    const result = await response(route(routes, TEAM_MANAGEMENT_INVITES_REVOKE_PATH).handler, request('POST', { inviteId: 'invite-1' }))

    expect(result).toMatchObject({ status: 200, body: { invite: { id: 'invite-1', status: 'revoked' } } })
    expect(result.body).not.toHaveProperty('internal')
    expect(JSON.stringify(result.body)).not.toContain(String(credentials.value))
    expect(fetch).toHaveBeenCalledWith(
      'https://pool.example/plugins/dsh-codex-shared-pool/team/invites/revoke',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ inviteId: 'invite-1' }) }),
    )
  })

  it('can revoke the current remote key before removing the local credential', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch)

    const result = await response(route(routes, TEAM_MANAGEMENT_DISCONNECT_PATH).handler, request('POST', { revokeRemote: true }))
    expect(result).toMatchObject({ status: 200, body: { disconnected: true, remoteRevoked: true } })
    expect(credentials.unsets).toHaveLength(1)
    expect(fetch).toHaveBeenCalledWith(
      'https://pool.example/plugins/dsh-codex-shared-pool/team/keys/current/revoke',
      expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer dsh_team_member-secret-1234567890' }) }),
    )
  })

  it('leaves the remote Team before removing the local credential', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      member: { ...member(), role: 'member', status: 'removed' },
      contributions: [{ ...contribution(), status: 'revoked', refreshToken: 'must-not-cross' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch)

    const result = await response(route(routes, TEAM_MANAGEMENT_LEAVE_PATH).handler, request('POST', {}))

    expect(result).toMatchObject({ status: 200, body: { member: { role: 'member', status: 'removed' } } })
    expect(result.body).not.toHaveProperty('contributions')
    expect(JSON.stringify(result.body)).not.toContain('must-not-cross')
    expect(fetch).toHaveBeenCalledWith(
      'https://pool.example/plugins/dsh-codex-shared-pool/team/members/leave',
      expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ authorization: 'Bearer dsh_team_member-secret-1234567890' }) }),
    )
    expect(credentials.value).toBeUndefined()
    expect(credentials.unsets).toHaveLength(1)
  })

  it('projects an ownership transfer without exposing remote key material', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_owner-secret-1234567890'
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      formerOwner: { ...member(), role: 'admin', apiKey: 'must-not-cross' },
      owner: {
        ...member(), id: 'member-2', displayName: 'Friend', role: 'owner', refreshToken: 'must-not-cross',
      },
      apiKeys: [{ token: 'must-not-cross' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch)

    const result = await response(
      route(routes, TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_PATH).handler,
      request('POST', { targetMemberId: 'member-2' }),
    )

    expect(result).toMatchObject({
      status: 200,
      body: { formerOwner: { id: 'member-1', role: 'admin' }, owner: { id: 'member-2', role: 'owner' } },
    })
    expect(JSON.stringify(result.body)).not.toContain('must-not-cross')
    expect(fetch).toHaveBeenCalledWith(
      'https://pool.example/plugins/dsh-codex-shared-pool/team/ownership/transfer',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ targetMemberId: 'member-2' }),
        headers: expect.objectContaining({ authorization: 'Bearer dsh_team_owner-secret-1234567890' }),
      }),
    )
    expect(credentials.value).toBe('dsh_team_owner-secret-1234567890')
    expect(credentials.unsets).toHaveLength(0)
  })

  it('rejects malformed local and remote ownership transfers', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_owner-secret-1234567890'
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      formerOwner: { ...member(), role: 'owner' },
      owner: { ...member(), id: 'member-2', role: 'member' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch)
    const transfer = route(routes, TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_PATH)

    await expect(response(transfer.handler, request('POST', { targetMemberId: 'member-2', unknown: true })))
      .resolves.toMatchObject({ status: 400 })
    await expect(response(transfer.handler, request('POST', { targetMemberId: 'member-2' })))
      .resolves.toMatchObject({ status: 502 })
  })

  it('retains the local key when remote Team departure fails', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_owner-secret-1234567890'
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      error: 'Team owner cannot leave before ownership transfer is available',
    }), { status: 409, headers: { 'content-type': 'application/json' } }))
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch)

    const result = await response(route(routes, TEAM_MANAGEMENT_LEAVE_PATH).handler, request('POST', {}))

    expect(result.status).not.toBe(200)
    expect(credentials.value).toBe('dsh_team_owner-secret-1234567890')
    expect(credentials.unsets).toHaveLength(0)
  })

  it('retains the local key when the remote response does not prove departure', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      member: member(),
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch)

    const result = await response(route(routes, TEAM_MANAGEMENT_LEAVE_PATH).handler, request('POST', {}))

    expect(result.status).not.toBe(200)
    expect(credentials.value).toBe('dsh_team_member-secret-1234567890')
    expect(credentials.unsets).toHaveLength(0)
  })

  it('disposes all local proxy routes', async () => {
    const { routes } = setup({ enabled: false })
    expect(routes.length).toBeGreaterThan(5)
    await cleanups[0]!()
    expect(routes.every(candidate => candidate.disposed)).toBe(true)
    cleanups.shift()
  })
})
