import { describe, expect, it } from 'vitest'

const TEAM_BASE_URL = 'http://127.0.0.1:3080/plugins/dsh-codex-shared-pool/team'
const TEAM_INTERNAL_BASE_URL = 'http://127.0.0.1:3081/plugins/dsh-codex-shared-pool/team'
const EXPECTED_OUTPUT = 'DSH team live smoke ok'

describe('two-contributor live Team routing smoke', () => {
  it('requires explicit confirmation before creating live test data', async () => {
    const { runLiveTeamRoutingSmoke } = await import('../deploy/host/smoke-live-team-routing.mjs')

    await expect(runLiveTeamRoutingSmoke({
      confirmed: false,
      fetch: async () => { throw new Error('fetch must not run') },
      bootstrapToken: 'bootstrap-secret-for-two-contributor-smoke',
      onChallenge: async () => undefined,
    })).rejects.toThrow('explicit two-contributor disposable-test confirmation')
  })

  it('accepts only the explicit Team-paused capacity reason as the no-forwarding proof', async () => {
    const { validatePausedTeamRejection } = await import('../deploy/host/smoke-live-team-routing.mjs')

    await expect(validatePausedTeamRejection(Response.json({
      error: 'no Team capacity is available',
      code: 'TEAM_CAPACITY_UNAVAILABLE',
      reasons: ['team_paused'],
    }, { status: 429 }), [])).resolves.toBeUndefined()
    await expect(validatePausedTeamRejection(Response.json({
      error: 'no Team capacity is available',
      code: 'TEAM_CAPACITY_UNAVAILABLE',
      reasons: ['reserve_reached'],
    }, { status: 429 }), [])).rejects.toThrow('team_paused')
  })

  it('proves own -> paused -> shared -> sticky -> Team-paused without returning secrets', async () => {
    const { runLiveTeamRoutingSmoke } = await import('../deploy/host/smoke-live-team-routing.mjs')
    const bootstrapToken = 'bootstrap-secret-for-two-contributor-smoke'
    const ownerKey = 'dsh_team_owner-live-secret-1234567890'
    const friendKey = 'dsh_team_friend-live-secret-1234567890'
    const inviteToken = 'dsh_invite_two-live-secret-1234567890'
    const calls: Array<{ url: string, init: RequestInit }> = []
    const challenges: unknown[] = []
    const usageEvents: Array<Record<string, unknown>> = []
    let providerRequests = 0
    let teamPaused = false

    const contribution = (member: 'owner' | 'friend', status = 'active') => ({
      id: `account-${member}`,
      teamId: 'team-live',
      ownerMemberId: `member-${member}`,
      label: member === 'owner' ? 'Live contribution A' : 'Live contribution B',
      status,
      personalReservePercent: 10,
      maxSharedRequestsPerWindow: null,
      dailySharedCreditLimit: null,
      maxSharedConcurrency: 1,
      allowedModels: [],
      createdAt: 3,
      updatedAt: 3,
    })
    const auth = (init: RequestInit) => (init.headers as Record<string, string> | undefined)?.authorization
    const sse = () => new Response([
      `data: {"type":"response.output_text.delta","delta":"${EXPECTED_OUTPUT}"}`,
      'data: {"type":"response.completed","response":{"status":"completed"}}',
      '',
    ].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } })

    const fakeFetch: typeof globalThis.fetch = async (input, init = {}) => {
      const url = String(input)
      calls.push({ url, init })
      if (url === `${TEAM_INTERNAL_BASE_URL}/bootstrap`) {
        expect((init.headers as Record<string, string>)['x-dsh-bootstrap-token']).toBe(bootstrapToken)
        expect(JSON.parse(String(init.body))).toEqual({
          teamName: 'Live Team routing smoke two-live-test',
          ownerName: 'Live Member A',
        })
        return Response.json({
          team: { id: 'team-live', name: 'Live Team routing smoke two-live-test', status: 'active', createdAt: 1 },
          member: {
            id: 'member-owner', teamId: 'team-live', displayName: 'Live Member A', role: 'owner', status: 'active', joinedAt: 1,
          },
          apiKey: ownerKey,
        }, { status: 201 })
      }
      if (url === `${TEAM_BASE_URL}/invites`) {
        expect(auth(init)).toBe(`Bearer ${ownerKey}`)
        return Response.json({
          invite: {
            id: 'invite-live', teamId: 'team-live', invitedByMemberId: 'member-owner', status: 'pending', expiresAt: 60_000, createdAt: 1,
          },
          inviteToken,
        }, { status: 201 })
      }
      if (url === `${TEAM_BASE_URL}/join`) {
        expect(JSON.parse(String(init.body))).toEqual({ inviteToken, displayName: 'Live Member B' })
        return Response.json({
          team: { id: 'team-live', name: 'Live Team routing smoke two-live-test', status: 'active', createdAt: 1 },
          member: {
            id: 'member-friend', teamId: 'team-live', displayName: 'Live Member B', role: 'member', status: 'active', joinedAt: 2,
          },
          apiKey: friendKey,
        }, { status: 201 })
      }
      if (url === `${TEAM_BASE_URL}/contributions/oauth/start`) {
        const owner = auth(init) === `Bearer ${ownerKey}` ? 'owner' : 'friend'
        expect(auth(init)).toBe(`Bearer ${owner === 'owner' ? ownerKey : friendKey}`)
        expect(JSON.parse(String(init.body))).toEqual({
          label: owner === 'owner' ? 'Live contribution A' : 'Live contribution B',
        })
        return Response.json({
          account: contribution(owner, 'authorizing'),
          method: 'device_code',
          verificationUrl: 'https://auth.openai.example/device',
          userCode: owner === 'owner' ? 'CODE-A' : 'CODE-B',
          expiresAt: 60_000,
        }, { status: 201 })
      }
      if (url === `${TEAM_BASE_URL}/overview`) {
        const member = auth(init) === `Bearer ${ownerKey}` ? 'owner' : 'friend'
        return Response.json({
          team: { id: 'team-live', name: 'Live Team routing smoke two-live-test', status: teamPaused ? 'paused' : 'active', createdAt: 1 },
          currentMember: {
            id: `member-${member}`, teamId: 'team-live', displayName: member === 'owner' ? 'Live Member A' : 'Live Member B',
            role: member === 'owner' ? 'owner' : 'member', status: 'active', joinedAt: member === 'owner' ? 1 : 2,
          },
          members: [],
          invites: [],
          apiKeys: [],
          contributions: [contribution('owner'), contribution('friend', providerRequests > 0 ? 'paused' : 'active')],
        })
      }
      if (url === `${TEAM_BASE_URL}/usage`) {
        expect(auth(init)).toBe(`Bearer ${friendKey}`)
        return Response.json({
          events: usageEvents,
          aggregates: {
            generatedAt: 86_400_000,
            last24HoursStartedAt: 0,
            last7DaysStartedAt: 0,
            accountTotals24Hours: [],
            memberDaily7Days: [],
          },
        })
      }
      if (url === `${TEAM_BASE_URL}/responses`) {
        expect(auth(init)).toBe(`Bearer ${friendKey}`)
        const headers = init.headers as Record<string, string>
        const body = JSON.parse(String(init.body))
        expect(body).toEqual({
          model: 'gpt-5.4',
          input: `Reply with exactly: ${EXPECTED_OUTPUT}`,
          stream: true,
          store: false,
        })
        if (teamPaused) {
          return Response.json({
            error: 'no Team capacity is available',
            code: 'TEAM_CAPACITY_UNAVAILABLE',
            reasons: ['team_paused'],
          }, { status: 429 })
        }
        providerRequests += 1
        const own = providerRequests === 1
        expect(headers['session-id']).toBe(own ? 'two-live-test-own' : 'two-live-test-shared')
        const startedAt = 100 + providerRequests * 10
        usageEvents.unshift({
          id: `usage-${providerRequests}`,
          teamId: 'team-live',
          consumerMemberId: 'member-friend',
          upstreamOwnerMemberId: own ? 'member-friend' : 'member-owner',
          upstreamAccountId: own ? 'account-friend' : 'account-owner',
          model: 'gpt-5.4',
          unit: 'request',
          status: 'succeeded',
          startedAt,
          finishedAt: startedAt + 1,
        })
        return sse()
      }
      if (url === `${TEAM_BASE_URL}/contributions/update`) {
        expect(auth(init)).toBe(`Bearer ${friendKey}`)
        expect(JSON.parse(String(init.body))).toEqual({ accountId: 'account-friend', status: 'paused' })
        return Response.json({ account: contribution('friend', 'paused') })
      }
      if (url === `${TEAM_BASE_URL}/status`) {
        expect(auth(init)).toBe(`Bearer ${ownerKey}`)
        teamPaused = true
        return Response.json({ team: { id: 'team-live', status: 'paused' } })
      }
      if (url === `${TEAM_BASE_URL}/contributions/revoke`) {
        const owner = auth(init) === `Bearer ${ownerKey}` ? 'owner' : 'friend'
        expect(JSON.parse(String(init.body))).toEqual({ accountId: `account-${owner}` })
        return Response.json({ account: contribution(owner, 'revoked') })
      }
      if (url === `${TEAM_BASE_URL}/members/leave`) {
        expect(auth(init)).toBe(`Bearer ${friendKey}`)
        return Response.json({ member: { id: 'member-friend', status: 'removed' }, contributions: [] })
      }
      if (url === `${TEAM_BASE_URL}/keys/current/revoke`) {
        expect(auth(init)).toBe(`Bearer ${ownerKey}`)
        return Response.json({ ok: true })
      }
      throw new Error(`unexpected live Team routing URL: ${url}`)
    }

    const result = await runLiveTeamRoutingSmoke({
      confirmed: true,
      fetch: fakeFetch,
      bootstrapToken,
      runId: 'two-live-test',
      onChallenge: challenge => { challenges.push(challenge) },
      wait: async () => undefined,
      now: () => 1_000,
    })

    expect(result).toEqual({
      teamId: 'team-live',
      consumerMemberId: 'member-friend',
      ownAccountId: 'account-friend',
      sharedAccountId: 'account-owner',
      usageEventIds: ['usage-1', 'usage-2', 'usage-3'],
      model: 'gpt-5.4',
      providerRequestCount: 3,
      rejectedRequestCount: 1,
      flow: ['own', 'shared', 'shared'],
    })
    expect(challenges).toEqual([
      { contributor: 'A', verificationUrl: 'https://auth.openai.example/device', userCode: 'CODE-A', expiresAt: 60_000 },
      { contributor: 'B', verificationUrl: 'https://auth.openai.example/device', userCode: 'CODE-B', expiresAt: 60_000 },
    ])
    expect(providerRequests).toBe(3)
    expect(JSON.stringify(result)).not.toContain(bootstrapToken)
    expect(JSON.stringify(result)).not.toContain(ownerKey)
    expect(JSON.stringify(result)).not.toContain(friendKey)
    expect(JSON.stringify(result)).not.toContain(inviteToken)

    const responseSessions = calls
      .filter(call => call.url.endsWith('/responses'))
      .map(call => (call.init.headers as Record<string, string>)['session-id'])
    expect(responseSessions).toEqual([
      'two-live-test-own',
      'two-live-test-shared',
      'two-live-test-shared',
      'two-live-test-rejected',
    ])
    expect(calls.slice(-5).map(call => call.url)).toEqual([
      `${TEAM_BASE_URL}/status`,
      `${TEAM_BASE_URL}/contributions/revoke`,
      `${TEAM_BASE_URL}/contributions/revoke`,
      `${TEAM_BASE_URL}/members/leave`,
      `${TEAM_BASE_URL}/keys/current/revoke`,
    ])
  })
})
