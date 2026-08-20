import { describe, expect, it, vi } from 'vitest'
import {
  createTeamManagementApi,
  parseTeamManagementOAuthResult,
  parseTeamManagementOverview,
  parseTeamManagementStatus,
} from '../src/client/team/api.ts'

function contribution() {
  return {
    id: 'account-1',
    teamId: 'team-1',
    ownerMemberId: 'member-1',
    label: 'Personal Codex',
    status: 'active',
    personalReservePercent: 20,
    maxSharedRequestsPerWindow: null,
    maxSharedConcurrency: 1,
    allowedModels: ['gpt-5-codex'],
    createdAt: 1,
    updatedAt: 2,
    refreshToken: 'must-not-survive',
  }
}

function overview() {
  return {
    team: { id: 'team-1', name: 'Friends', status: 'active', createdAt: 1, databasePassword: 'secret' },
    currentMember: { id: 'member-1', teamId: 'team-1', displayName: 'Edison', role: 'owner', status: 'active', joinedAt: 1 },
    members: [{
      id: 'member-1', teamId: 'team-1', displayName: 'Edison', role: 'owner', status: 'active', joinedAt: 1,
      canReceiveOwnership: false,
    }],
    invites: [],
    contributions: [contribution()],
    apiKeys: [{ tokenHash: 'must-not-survive' }],
  }
}

describe('Team management browser API', () => {
  it('projects runtime responses to the browser-safe contract', () => {
    const parsed = parseTeamManagementOverview(overview())

    expect(parsed.team).toEqual({ id: 'team-1', name: 'Friends', status: 'active', createdAt: 1 })
    expect(parsed.contributions[0]).not.toHaveProperty('refreshToken')
    expect(parsed).not.toHaveProperty('apiKeys')
    expect(JSON.stringify(parsed)).not.toContain('must-not-survive')
  })

  it('keeps validated live capacity only on the current member contribution', () => {
    const capacity = {
      sharedInFlight: 1,
      buckets: [{
        id: 'codex',
        reason: 'reserve_reached',
        remainingPercent: 20,
        resetAt: 10_000,
        sharedRequestsUsed: 3,
        accessToken: 'must-not-survive',
      }],
    }
    const parsed = parseTeamManagementOverview({
      ...overview(),
      contributions: [
        { ...contribution(), capacity },
        { ...contribution(), id: 'account-2', ownerMemberId: 'member-2', capacity },
      ],
    })

    expect(parsed.contributions[0]?.capacity).toEqual({
      sharedInFlight: 1,
      buckets: [{
        id: 'codex', reason: 'reserve_reached', remainingPercent: 20, resetAt: 10_000, sharedRequestsUsed: 3,
      }],
    })
    expect(parsed.contributions[1]).not.toHaveProperty('capacity')
    expect(JSON.stringify(parsed)).not.toContain('must-not-survive')
  })

  it('rejects an unknown live-capacity reason', () => {
    expect(() => parseTeamManagementOverview({
      ...overview(),
      contributions: [{
        ...contribution(),
        capacity: { sharedInFlight: 0, buckets: [{ id: 'codex', reason: 'secret_reason' }] },
      }],
    })).toThrow(/reason/u)
  })

  it('requires the Host-owned ownership eligibility projection for every member', () => {
    expect(parseTeamManagementOverview(overview()).members[0]?.canReceiveOwnership).toBe(false)
    expect(() => parseTeamManagementOverview({
      ...overview(),
      members: [{ ...overview().members[0], canReceiveOwnership: 'yes' }],
    })).toThrow(/canReceiveOwnership/u)
  })

  it('rejects malformed status and OAuth challenges', () => {
    expect(() => parseTeamManagementStatus({ enabled: true, keyConfigured: 'yes', keyWritable: true }))
      .toThrow(/keyConfigured/u)
    expect(() => parseTeamManagementOAuthResult({
      account: contribution(),
      method: 'browser',
      verificationUrl: 'http://evil.example.test',
      userCode: 'x',
      expiresAt: 2,
    })).toThrow(/OAuth method/u)
  })

  it('uses only same-origin JSON requests and validates the returned payload', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      enabled: true,
      keyConfigured: false,
      keyWritable: true,
      serverOrigin: 'https://team.example.test',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const api = createTeamManagementApi(fetchMock)

    await expect(api.status()).resolves.toMatchObject({ enabled: true, keyConfigured: false })
    expect(fetchMock).toHaveBeenCalledWith(
      '/plugins/dsh-codex-shared-pool/team-client/status',
      expect.objectContaining({ credentials: 'same-origin', cache: 'no-store', redirect: 'error' }),
    )
  })

  it('preserves the browser receiver for the default window fetch', async () => {
    const browserFetch = vi.fn(async function (this: unknown) {
      if (this !== globalThis) throw new TypeError('Illegal invocation')
      return new Response(JSON.stringify({
        enabled: true,
        keyConfigured: false,
        keyWritable: true,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    vi.stubGlobal('fetch', browserFetch)
    try {
      await expect(createTeamManagementApi().status()).resolves.toMatchObject({ enabled: true })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('uses the Host contract milliseconds field when creating an invite', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      invite: {
        id: 'invite-1',
        teamId: 'team-1',
        invitedByMemberId: 'member-1',
        status: 'pending',
        expiresAt: Date.now() + 3_600_000,
        createdAt: Date.now(),
      },
      inviteToken: 'dsh_invite_secret',
    }), { status: 201, headers: { 'content-type': 'application/json' } }))
    const api = createTeamManagementApi(fetchMock)

    await api.createInvite(3_600_000)

    expect(fetchMock).toHaveBeenCalledWith(
      '/plugins/dsh-codex-shared-pool/team-client/invites',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ expiresInMs: 3_600_000 }),
      }),
    )
  })

  it('posts an invite id to the local revocation route', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      invite: {
        id: 'invite-1', teamId: 'team-1', invitedByMemberId: 'member-1', status: 'revoked', expiresAt: 5, createdAt: 3,
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const api = createTeamManagementApi(fetchMock)

    await expect(api.revokeInvite('invite-1')).resolves.toMatchObject({ invite: { id: 'invite-1', status: 'revoked' } })
    expect(fetchMock).toHaveBeenCalledWith(
      '/plugins/dsh-codex-shared-pool/team-client/invites/revoke',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ inviteId: 'invite-1' }) }),
    )
  })

  it('posts an existing account id to the local reauthorization route', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      account: { ...contribution(), status: 'authorizing' },
      method: 'device_code', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH', expiresAt: 2,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const api = createTeamManagementApi(fetchMock)

    await expect(api.reauthorizeOAuth('account-1')).resolves.toMatchObject({ account: { id: 'account-1' }, method: 'device_code' })
    expect(fetchMock).toHaveBeenCalledWith(
      '/plugins/dsh-codex-shared-pool/team-client/contributions/oauth/reauthorize',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ accountId: 'account-1' }) }),
    )
  })

  it('posts an empty request to leave the Team and validates the removed member', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      member: { ...overview().currentMember, role: 'member', status: 'removed', apiKey: 'must-not-survive' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const api = createTeamManagementApi(fetchMock)

    const result = await api.leaveTeam()

    expect(result).toEqual({ member: { ...overview().currentMember, role: 'member', status: 'removed' } })
    expect(JSON.stringify(result)).not.toContain('must-not-survive')
    expect(fetchMock).toHaveBeenCalledWith(
      '/plugins/dsh-codex-shared-pool/team-client/leave',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({}) }),
    )
  })

  it('posts an ownership target and keeps only the validated member summaries', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      formerOwner: { ...overview().currentMember, role: 'admin', apiKey: 'must-not-survive' },
      owner: {
        ...overview().currentMember,
        id: 'member-2',
        displayName: 'Friend',
        role: 'owner',
        refreshToken: 'must-not-survive',
      },
      token: 'must-not-survive',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const api = createTeamManagementApi(fetchMock)

    const result = await api.transferOwnership('member-2')

    expect(result).toEqual({
      formerOwner: { ...overview().currentMember, role: 'admin' },
      owner: { ...overview().currentMember, id: 'member-2', displayName: 'Friend', role: 'owner' },
    })
    expect(JSON.stringify(result)).not.toContain('must-not-survive')
    expect(fetchMock).toHaveBeenCalledWith(
      '/plugins/dsh-codex-shared-pool/team-client/ownership/transfer',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ targetMemberId: 'member-2' }) }),
    )
  })

  it('rejects a malformed ownership role swap', async () => {
    const api = createTeamManagementApi(async () => new Response(JSON.stringify({
      formerOwner: { ...overview().currentMember, role: 'owner' },
      owner: { ...overview().currentMember, id: 'member-2', role: 'member' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    await expect(api.transferOwnership('member-2')).rejects.toThrow(/ownership transfer/iu)
  })

  it('rejects a departure response that did not remove the member', async () => {
    const api = createTeamManagementApi(async () => new Response(JSON.stringify({
      member: overview().currentMember,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    await expect(api.leaveTeam()).rejects.toThrow('departure member is invalid')
  })

  it('never falls back to an unvalidated error response', async () => {
    const api = createTeamManagementApi(async () => new Response(JSON.stringify({ error: 42, token: 'secret' }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    }))

    await expect(api.status()).rejects.toThrow('Team management request failed (502)')
  })
})
