import { describe, expect, it, vi } from 'vitest'
import {
  createTeamManagementApi,
  parseTeamManagementOAuthResult,
  parseTeamManagementOverview,
  parseTeamManagementStatus,
} from '../src/client/team/api.ts'
import {
  TEAM_MANAGEMENT_CAPABILITY_HEADER,
  TEAM_MANAGEMENT_CONTRIBUTION_UPDATE_PATH,
  TEAM_MANAGEMENT_DISPLAY_NAME_MIGRATION_ACK_PATH,
  TEAM_MANAGEMENT_INVITES_REVEAL_PATH,
  TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_ACCEPT_PATH,
  TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_REJECT_PATH,
  TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_REVOKE_PATH,
  TEAM_MANAGEMENT_SESSION_PATH,
} from '../src/shared/team-management.ts'

const MANAGEMENT_CAPABILITY = `dsh_tm_${'c'.repeat(43)}`
const EXPECTED_CONTEXT = {
  serverOrigin: 'https://team.example.test',
  teamId: 'team-1',
  currentMemberId: 'member-1',
}
const TEAM_DISSOLVE_PATH = '/plugins/dsh-codex-shared-pool/team-client/dissolve'
const TEAM_DISSOLUTION_RECOVER_PATH = '/plugins/dsh-codex-shared-pool/team-client/dissolution/recover'
const TEAM_DISSOLUTION_CLEAR_PATH = '/plugins/dsh-codex-shared-pool/team-client/dissolution/clear'
const TEAM_CONNECTION_TERMINAL_CLEAR_PATH = '/plugins/dsh-codex-shared-pool/team-client/connection-terminal/clear'

function confirmingDissolution() {
  return { state: 'confirming' as const, teamName: 'Friends', requestedAt: 1_800_000_000_000 }
}

function confirmedDissolution(localCleanup: 'completed' | 'retry_required' | 'manual_required' = 'completed') {
  return {
    state: 'confirmed' as const,
    teamName: 'Friends',
    dissolvedAt: 1_800_000_000_100,
    localCleanup,
  }
}

function withManagementSession(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>,
  capability = MANAGEMENT_CAPABILITY,
) {
  return vi.fn<typeof fetch>(async (input, init) => {
    if (String(input) === TEAM_MANAGEMENT_SESSION_PATH) {
      return new Response(JSON.stringify({ capability, expiresAt: Date.now() + 60_000 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return handler(input, init)
  })
}

function contribution() {
  return {
    id: 'account-1',
    teamId: 'team-1',
    ownerMemberId: 'member-1',
    label: 'Personal Codex',
    status: 'active',
    personalReservePercent: 20,
    maxSharedRequestsPerWindow: null,
    dailySharedCreditLimit: null,
    maxSharedConcurrency: 1,
    allowedModels: ['gpt-5-codex'],
    createdAt: 1,
    updatedAt: 2,
    refreshToken: 'must-not-survive',
  }
}

function overview() {
  return {
    viewerRole: 'owner',
    team: {
      id: 'team-1', name: 'Friends', status: 'active', lifecycleRevision: 7, createdAt: 1,
      databasePassword: 'secret',
    },
    currentMember: { id: 'member-1', teamId: 'team-1', displayName: 'Edison', role: 'owner', status: 'active', joinedAt: 1 },
    members: [{
      id: 'member-1', teamId: 'team-1', displayName: 'Edison', role: 'owner', status: 'active', joinedAt: 1,
      canReceiveOwnership: false,
    }],
    invites: [],
    contributions: [contribution()],
    activeSharedAccounts: [{
      id: 'account-2', label: 'Friend Codex', ownerMemberId: 'member-2', status: 'active',
    }],
    apiKeys: [{ tokenHash: 'must-not-survive' }],
  }
}

function ownershipTransfer(status: 'pending' | 'accepted' | 'rejected' | 'revoked' | 'expired' | 'canceled' = 'pending') {
  return {
    id: 'transfer-1',
    teamId: 'team-1',
    requestedByMemberId: 'member-1',
    targetMemberId: 'member-2',
    status,
    createdAt: 1_800_000_000_000,
    expiresAt: 1_800_086_400_000,
    ...(status === 'pending' ? {} : { resolvedAt: 1_800_000_000_500 }),
  }
}

describe('Team management browser API', () => {
  it('projects runtime responses to the browser-safe contract', () => {
    const parsed = parseTeamManagementOverview(overview())

    expect(parsed.team).toEqual({
      id: 'team-1', name: 'Friends', status: 'active', lifecycleRevision: 7, createdAt: 1,
    })
    expect(parsed.contributions[0]).not.toHaveProperty('refreshToken')
    expect(parsed.contributions[0]).not.toHaveProperty('dailySharedCreditLimit')
    expect(parsed.activeSharedAccounts).toEqual([{
      id: 'account-2', label: 'Friend Codex', ownerMemberId: 'member-2', status: 'active',
    }])
    expect(parsed).not.toHaveProperty('apiKeys')
    expect(JSON.stringify(parsed)).not.toContain('must-not-survive')
  })

  it('treats the pre-directory overview shape as an empty shared-account directory', () => {
    const legacy = { ...overview() }
    delete (legacy as Partial<ReturnType<typeof overview>>).activeSharedAccounts

    expect(parseTeamManagementOverview(legacy).activeSharedAccounts).toEqual([])
  })

  it('preserves a strict browser-safe pending authorization projection', () => {
    const parsed = parseTeamManagementOverview({
      ...overview(),
      contributions: [{ ...contribution(), status: 'authorizing' }],
      pendingBrowserAuthorization: {
        accountId: 'account-1',
        method: 'browser',
        expiresAt: 60_000,
        discardInitial: true,
      },
    })

    expect(parsed.pendingBrowserAuthorization).toEqual({
      accountId: 'account-1',
      method: 'browser',
      expiresAt: 60_000,
      discardInitial: true,
    })
  })

  it('rejects secret-bearing pending browser authorization projections', () => {
    expect(() => parseTeamManagementOverview({
      ...overview(),
      contributions: [{ ...contribution(), status: 'authorizing' }],
      pendingBrowserAuthorization: {
        accountId: 'account-1',
        method: 'browser',
        expiresAt: 60_000,
        discardInitial: true,
        refreshToken: 'must-not-cross-the-browser-boundary',
      },
    })).toThrow(/pending browser authorization|refreshToken|unexpected/iu)
  })

  it.each([
    { accountId: 1, method: 'browser', expiresAt: 60_000, discardInitial: true },
    { accountId: 'account-1', method: 'device_code', expiresAt: 60_000, discardInitial: true },
    { accountId: 'account-1', method: 'browser', expiresAt: 'soon', discardInitial: true },
    { accountId: 'account-1', method: 'browser', expiresAt: 1.5, discardInitial: true },
    { accountId: 'account-1', method: 'browser', expiresAt: 60_000, discardInitial: 'yes' },
  ])('rejects malformed pending browser authorization fields', pendingBrowserAuthorization => {
    expect(() => parseTeamManagementOverview({
      ...overview(),
      contributions: [{ ...contribution(), status: 'authorizing' }],
      pendingBrowserAuthorization,
    })).toThrow(/accountId|method|expiresAt|discardInitial|pending browser authorization/iu)
  })

  it.each([
    { contributions: [{ ...contribution(), status: 'active' }], accountId: 'account-1' },
    { contributions: [{ ...contribution(), status: 'authorizing' }], accountId: 'account-other' },
  ])('rejects pending browser authorization without its authorizing account', ({ contributions, accountId }) => {
    expect(() => parseTeamManagementOverview({
      ...overview(),
      contributions,
      pendingBrowserAuthorization: {
        accountId,
        method: 'browser',
        expiresAt: 60_000,
        discardInitial: false,
      },
    })).toThrow(/pending browser authorization|authorizing account/iu)
  })

  it('rejects private fields in the active shared-account directory', () => {
    expect(() => parseTeamManagementOverview({
      ...overview(),
      activeSharedAccounts: [{
        id: 'account-2', label: 'Friend Codex', ownerMemberId: 'member-2', status: 'active',
        personalReservePercent: 20,
      }],
    })).toThrow(/shared.account|unexpected/iu)
  })

  it('accepts only a positive safe migration version in the current member notice', () => {
    const parsed = parseTeamManagementOverview({
      ...overview(),
      displayNameMigrationNotice: {
        migrationVersion: 20,
      },
    })

    expect(parsed.displayNameMigrationNotice).toEqual({
      migrationVersion: 20,
    })
    expect(() => parseTeamManagementOverview({
      ...overview(),
      displayNameMigrationNotice: {
        migrationVersion: 20,
        previousDisplayName: 'must-not-cross',
      },
    })).toThrow(/migration notice|unexpected/iu)
    for (const migrationVersion of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parseTeamManagementOverview({
        ...overview(),
        displayNameMigrationNotice: { migrationVersion },
      })).toThrow(/migrationVersion|migration notice/iu)
    }
  })

  it('keeps owner-only invitations out of a member-shaped document', () => {
    const parsed = parseTeamManagementOverview({
      ...overview(),
      viewerRole: 'member',
      currentMember: {
        ...overview().currentMember,
        role: 'member',
      },
      invites: [{
        id: 'invite-1', teamId: 'team-1', invitedByMemberId: 'member-1', label: 'Private',
        status: 'pending', revealable: true, expiresAt: 10, createdAt: 2,
      }],
    })

    expect(parsed.viewerRole).toBe('member')
    expect(parsed).not.toHaveProperty('invites')
  })

  it('requires and preserves the Host-owned invitation revealability projection for Owners', () => {
    const pendingInvite = {
      id: 'invite-1', teamId: 'team-1', invitedByMemberId: 'member-1', label: 'Private',
      status: 'pending', revealable: false, expiresAt: 10, createdAt: 2,
    }

    expect(parseTeamManagementOverview({ ...overview(), invites: [pendingInvite] }))
      .toMatchObject({ invites: [{ id: 'invite-1', revealable: false }] })
    expect(() => parseTeamManagementOverview({
      ...overview(),
      invites: [{ ...pendingInvite, revealable: undefined }],
    })).toThrow(/revealable/u)
  })

  it('normalizes a legacy Admin projection to the only public non-owner role', () => {
    const parsed = parseTeamManagementOverview({
      ...overview(),
      viewerRole: 'member',
      currentMember: { ...overview().currentMember, role: 'admin' },
      members: [{ ...overview().members[0], role: 'admin' }],
    })

    expect(parsed.currentMember.role).toBe('member')
    expect(parsed.members[0]?.role).toBe('member')
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
    expect(parsed.contributions).toHaveLength(1)
    expect(JSON.stringify(parsed)).not.toContain('must-not-survive')
  })

  it.each([
    [{ planType: 'pro', weeklyEstimatedUsd: 99999, accessToken: 'must-not-survive' }, { planType: 'pro', weeklyEstimatedUsd: 2100 }],
    [{ planType: 'future-plan' }, { planType: 'unknown' }],
    [undefined, undefined],
    [{ planType: 123 }, undefined],
  ])('preserves only validated subscription metadata from capacity', (subscription, expected) => {
    const parsed = parseTeamManagementOverview({
      ...overview(),
      contributions: [{ ...contribution(), capacity: { buckets: [{
        id: 'codex', reason: 'ready', remainingPercent: 50, subscription,
      }] } }],
    })
    expect(parsed.contributions[0]?.capacity?.buckets[0]?.subscription).toEqual(expected)
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

  it('rejects an ownership transfer projected from another Team', () => {
    expect(() => parseTeamManagementOverview({
      ...overview(),
      ownershipTransfer: {
        ...ownershipTransfer(),
        teamId: 'team-other',
      },
    })).toThrow(/ownership transfer/iu)
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
    })).toThrow(/authorizationUrl/u)
  })

  it('accepts the browser OAuth projection without exposing handoff material', () => {
    const parsed = parseTeamManagementOAuthResult({
      account: { ...contribution(), status: 'authorizing' },
      method: 'browser',
      authorizationUrl: 'https://auth.openai.com/oauth/authorize?client_id=codex_cli',
      expiresAt: 60_000,
      serverPublicKey: 'must-not-survive',
      ciphertext: 'must-not-survive',
    })

    expect(parsed).toEqual({
      account: expect.objectContaining({ id: 'account-1', status: 'authorizing' }),
      method: 'browser',
      authorizationUrl: 'https://auth.openai.com/oauth/authorize?client_id=codex_cli',
      expiresAt: 60_000,
    })
    expect(JSON.stringify(parsed)).not.toContain('must-not-survive')
  })

  it.each([
    confirmingDissolution(),
    confirmedDissolution('completed'),
    confirmedDissolution('retry_required'),
    confirmedDissolution('manual_required'),
  ])('keeps only a strict secret-free $state dissolution projection in status', dissolution => {
    const parsed = parseTeamManagementStatus({
      enabled: true,
      keyConfigured: true,
      keyWritable: true,
      pendingJoinConfigured: false,
      dissolution,
    })

    expect(parsed).toEqual({
      enabled: true,
      keyConfigured: true,
      keyWritable: true,
      pendingJoinConfigured: false,
      dissolution,
    })
    expect(JSON.stringify(parsed)).not.toMatch(/operationId|recoverySecret|apiKey/iu)
  })

  it('accepts a coarse confirmed dissolution without Team metadata', () => {
    const dissolution = { state: 'confirmed' as const, localCleanup: 'completed' as const }

    expect(parseTeamManagementStatus({
      enabled: true,
      keyConfigured: false,
      keyWritable: true,
      pendingJoinConfigured: false,
      dissolution,
    })).toEqual({
      enabled: true,
      keyConfigured: false,
      keyWritable: true,
      pendingJoinConfigured: false,
      dissolution,
    })

    expect(() => parseTeamManagementStatus({
      enabled: true,
      keyConfigured: false,
      keyWritable: true,
      pendingJoinConfigured: false,
      dissolution: { ...dissolution, teamName: 'Friends' },
    })).toThrow(/dissolution|dissolvedAt|unexpected/iu)
  })

  it.each(['member_removed', 'member_left', 'team_dissolved', 'device_revoked'] as const)(
    'accepts only the secret-free %s connection-terminal projection',
    code => {
      const connectionTerminal = { code, localCleanup: 'completed' as const }
      const parsed = parseTeamManagementStatus({
        enabled: true,
        keyConfigured: false,
        keyWritable: true,
        pendingJoinConfigured: false,
        connectionTerminal,
      })

      expect(parsed).toEqual({
        enabled: true,
        keyConfigured: false,
        keyWritable: true,
        pendingJoinConfigured: false,
        connectionTerminal,
      })
      expect(JSON.stringify(parsed)).not.toMatch(/teamId|memberId|keyId|apiKey|operationId|recoverySecret/iu)
      expect(() => parseTeamManagementStatus({
        enabled: true,
        keyConfigured: false,
        keyWritable: true,
        pendingJoinConfigured: false,
        connectionTerminal: { ...connectionTerminal, teamName: 'Friends' },
      })).toThrow(/connection terminal|teamName|unexpected/iu)
    },
  )

  it('rejects secret-bearing or over-broad dissolution projections', () => {
    expect(() => parseTeamManagementStatus({
      enabled: true,
      keyConfigured: true,
      keyWritable: true,
      pendingJoinConfigured: false,
      apiKey: 'must-not-cross-the-browser-boundary',
    })).toThrow(/status|apiKey|unexpected/iu)

    expect(() => parseTeamManagementStatus({
      enabled: true,
      keyConfigured: true,
      keyWritable: true,
      pendingJoinConfigured: false,
      dissolution: {
        ...confirmedDissolution(),
        operationId: '00000000-0000-4000-8000-000000000001',
        recoverySecret: 'must-not-cross-the-browser-boundary',
      },
    })).toThrow(/dissolution|operationId|recoverySecret|unexpected/iu)

    expect(() => parseTeamManagementStatus({
      enabled: true,
      keyConfigured: true,
      keyWritable: true,
      pendingJoinConfigured: false,
      dissolution: { ...confirmedDissolution(), localCleanup: 'cleanup_retry_required' },
    })).toThrow(/localCleanup/iu)
  })

  it('uses only same-origin JSON requests and validates the returned payload', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      enabled: true,
      keyConfigured: false,
      keyWritable: true,
      pendingJoinConfigured: false,
      serverOrigin: 'https://team.example.test',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const api = createTeamManagementApi(fetchMock)

    await expect(api.status()).resolves.toMatchObject({ enabled: true, keyConfigured: false })
    expect(fetchMock).toHaveBeenCalledWith(
      '/plugins/dsh-codex-shared-pool/team-client/status',
      expect.objectContaining({ credentials: 'same-origin', cache: 'no-store', redirect: 'error' }),
    )
  })

  it('keeps only the validated role-shaped aggregate in browser usage state', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      role: 'member',
      window: { startedAt: 113_600_000, endedAt: 200_000_000 },
      currency: 'USD',
      mine: {
        requestCount: 2,
        tokenMeasuredRequestCount: 1,
        pricedRequestCount: 0,
        totalTokens: '8750',
        estimatedCostUsdMicros: null,
      },
      ownedAccounts: [{
        accountId: 'account-1',
        window: { startedAt: 0, endedAt: 200_000_000 },
        aggregate: {
          requestCount: 3, tokenMeasuredRequestCount: 2, pricedRequestCount: 2,
          totalTokens: '12000', estimatedCostUsdMicros: '157500',
        },
        currentUtcWeek: {
          window: { startedAt: 100_000_000, endedAt: 200_000_000 },
          resetAt: 300_000_000,
          aggregate: {
            requestCount: 2, tokenMeasuredRequestCount: 2, pricedRequestCount: 2,
            totalTokens: '9000', estimatedCostUsdMicros: '125000',
          },
          credential: 'must-not-survive',
        },
        last24Hours: {
          window: { startedAt: 113_600_000, endedAt: 200_000_000 },
          aggregate: {
            requestCount: 1, tokenMeasuredRequestCount: 1, pricedRequestCount: 1,
            totalTokens: '3000', estimatedCostUsdMicros: '32500',
          },
          prompt: 'must-not-survive',
        },
        recentRequests: [],
        refreshToken: 'must-not-survive',
      }],
      team: { requestCount: 999, accessToken: 'must-not-survive' },
      events: [{ consumerMemberId: 'member-2', prompt: 'must-not-survive' }],
      refreshToken: 'must-not-survive',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const api = createTeamManagementApi(fetchMock)

    const result = await api.usage()

    expect(result).toEqual({
      role: 'member',
      window: { startedAt: 113_600_000, endedAt: 200_000_000 },
      currency: 'USD',
      mine: {
        requestCount: 2, tokenMeasuredRequestCount: 1, pricedRequestCount: 0,
        totalTokens: '8750', estimatedCostUsdMicros: null,
      },
      ownedAccounts: [{
        accountId: 'account-1',
        window: { startedAt: 0, endedAt: 200_000_000 },
        aggregate: {
          requestCount: 3, tokenMeasuredRequestCount: 2, pricedRequestCount: 2,
          totalTokens: '12000', estimatedCostUsdMicros: '157500',
        },
        currentUtcWeek: {
          window: { startedAt: 100_000_000, endedAt: 200_000_000 },
          resetAt: 300_000_000,
          aggregate: {
            requestCount: 2, tokenMeasuredRequestCount: 2, pricedRequestCount: 2,
            totalTokens: '9000', estimatedCostUsdMicros: '125000',
          },
        },
        last24Hours: {
          window: { startedAt: 113_600_000, endedAt: 200_000_000 },
          aggregate: {
            requestCount: 1, tokenMeasuredRequestCount: 1, pricedRequestCount: 1,
            totalTokens: '3000', estimatedCostUsdMicros: '32500',
          },
        },
        recentRequests: [],
      }],
    })
    expect(JSON.stringify(result)).not.toContain('must-not-survive')
    expect(result).not.toHaveProperty('team')
    expect(result).not.toHaveProperty('events')
  })

  it('rejects usage aggregates whose measured count exceeds request count', async () => {
    const api = createTeamManagementApi(async () => new Response(JSON.stringify({
      role: 'member',
      window: { startedAt: 0, endedAt: 10 },
      currency: 'USD',
      mine: {
        requestCount: 1,
        tokenMeasuredRequestCount: 2,
        pricedRequestCount: 0,
        totalTokens: '3',
        estimatedCostUsdMicros: null,
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    await expect(api.usage()).rejects.toThrow(/tokenMeasuredRequestCount/u)
  })

  it('preserves the browser receiver for the default window fetch', async () => {
    const browserFetch = vi.fn(async function (this: unknown) {
      if (this !== globalThis) throw new TypeError('Illegal invocation')
      return new Response(JSON.stringify({
        enabled: true,
        keyConfigured: false,
        keyWritable: true,
        pendingJoinConfigured: false,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    vi.stubGlobal('fetch', browserFetch)
    try {
      await expect(createTeamManagementApi().status()).resolves.toMatchObject({ enabled: true })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('joins with the opaque local handle returned by invite preview', async () => {
    const joinHandle = `dsh_join_${'a'.repeat(43)}`
    const protectedFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        teamName: 'Friends',
        label: 'Weekend collaboration',
        expiresAt: Date.now() + 3_600_000,
        teamStatus: 'active',
        joinHandle,
        inviteToken: 'must-not-survive',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        team: overview().team,
        member: overview().currentMember,
      }), { status: 201, headers: { 'content-type': 'application/json' } }))
    const fetchMock = withManagementSession((input, init) => protectedFetch(input, init))
    const api = createTeamManagementApi(fetchMock)

    const preview = await api.previewInvite('dsh_invite_secret-1234567890')

    expect(preview).toEqual({
      teamName: 'Friends',
      label: 'Weekend collaboration',
      expiresAt: expect.any(Number),
      teamStatus: 'active',
      joinHandle,
    })
    expect(preview).not.toHaveProperty('inviteToken')

    await api.join(preview.joinHandle, 'Edison')

    expect(fetchMock).toHaveBeenLastCalledWith(
      '/plugins/dsh-codex-shared-pool/team-client/join',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ [TEAM_MANAGEMENT_CAPABILITY_HEADER]: MANAGEMENT_CAPABILITY }),
        body: JSON.stringify({ joinHandle, displayName: 'Edison' }),
      }),
    )
    expect(fetchMock.mock.calls.filter(([path]) => String(path) === TEAM_MANAGEMENT_SESSION_PATH)).toHaveLength(1)
  })

  it('bootstraps an in-memory Host capability before a protected write', async () => {
    const capability = MANAGEMENT_CAPABILITY
    const joinHandle = `dsh_join_${'a'.repeat(43)}`
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        capability,
        expiresAt: Date.now() + 60_000,
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        team: overview().team,
        member: overview().currentMember,
      }), { status: 201, headers: { 'content-type': 'application/json' } }))
    const api = createTeamManagementApi(fetchMock)

    await api.join(joinHandle, 'Edison')

    expect(fetchMock).toHaveBeenNthCalledWith(1,
      TEAM_MANAGEMENT_SESSION_PATH,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({}) }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(2,
      '/plugins/dsh-codex-shared-pool/team-client/join',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ [TEAM_MANAGEMENT_CAPABILITY_HEADER]: capability }),
      }),
    )
  })

  it('caches one unexpired capability across protected writes', async () => {
    const joinHandle = `dsh_join_${'a'.repeat(43)}`
    const fetchMock = withManagementSession(async () => new Response(JSON.stringify({
      team: overview().team,
      member: overview().currentMember,
    }), { status: 201, headers: { 'content-type': 'application/json' } }))
    const api = createTeamManagementApi(fetchMock)

    await api.join(joinHandle, 'Edison')
    await api.join(joinHandle, 'Edison again')

    const sessionCalls = fetchMock.mock.calls.filter(([path]) => String(path) === TEAM_MANAGEMENT_SESSION_PATH)
    const joinCalls = fetchMock.mock.calls.filter(([path]) => String(path).endsWith('/join'))
    expect(sessionCalls).toHaveLength(1)
    expect(joinCalls).toHaveLength(2)
    expect(joinCalls[0]?.[1]?.headers).toEqual(expect.objectContaining({
      [TEAM_MANAGEMENT_CAPABILITY_HEADER]: MANAGEMENT_CAPABILITY,
    }))
    expect(joinCalls[1]?.[1]?.headers).toEqual(expect.objectContaining({
      [TEAM_MANAGEMENT_CAPABILITY_HEADER]: MANAGEMENT_CAPABILITY,
    }))
  })

  it('reissues the capability once and retries one protected write after a stable 403', async () => {
    const firstCapability = `dsh_tm_${'a'.repeat(43)}`
    const replacementCapability = `dsh_tm_${'b'.repeat(43)}`
    const joinHandle = `dsh_join_${'j'.repeat(43)}`
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        capability: firstCapability,
        expiresAt: Date.now() + 60_000,
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { code: 'team_management_forbidden' },
      }), { status: 403, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        capability: replacementCapability,
        expiresAt: Date.now() + 60_000,
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        team: overview().team,
        member: overview().currentMember,
      }), { status: 201, headers: { 'content-type': 'application/json' } }))
    const api = createTeamManagementApi(fetchMock)

    await expect(api.join(joinHandle, 'Edison')).resolves.toMatchObject({ team: { id: 'team-1' } })

    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(fetchMock).toHaveBeenNthCalledWith(1, TEAM_MANAGEMENT_SESSION_PATH, expect.any(Object))
    expect(fetchMock).toHaveBeenNthCalledWith(2, expect.stringMatching(/\/join$/u), expect.objectContaining({
      headers: expect.objectContaining({ [TEAM_MANAGEMENT_CAPABILITY_HEADER]: firstCapability }),
    }))
    expect(fetchMock).toHaveBeenNthCalledWith(3, TEAM_MANAGEMENT_SESSION_PATH, expect.any(Object))
    expect(fetchMock).toHaveBeenNthCalledWith(4, expect.stringMatching(/\/join$/u), expect.objectContaining({
      headers: expect.objectContaining({ [TEAM_MANAGEMENT_CAPABILITY_HEADER]: replacementCapability }),
    }))
  })

  it('does not expose a raw Team key connection method to the Browser', () => {
    const api = createTeamManagementApi(vi.fn<typeof fetch>())

    expect('connect' in api).toBe(false)
    expect('updateMemberRole' in api).toBe(false)
  })

  it('serializes contribution updates from an explicit Browser allow-list', async () => {
    let requestBody: Record<string, unknown> | undefined
    const fetchMock = withManagementSession(async (input, init) => {
      expect(String(input)).toBe(TEAM_MANAGEMENT_CONTRIBUTION_UPDATE_PATH)
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({
        account: { ...contribution(), status: 'paused', personalReservePercent: 35 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const api = createTeamManagementApi(fetchMock)
    const unsafePatch = {
      status: 'paused' as const,
      personalReservePercent: 35,
      weeklySharedEstimatedApiCostLimitMicros: 1_500_000,
      allowedModels: ['gpt-5-codex'],
      dailySharedCreditLimit: 424_242,
      futureHostOnlyField: 'must-not-cross',
    } as Parameters<typeof api.updateContribution>[1] & Record<string, unknown>

    await expect(api.updateContribution('account-1', unsafePatch, EXPECTED_CONTEXT)).resolves.toMatchObject({
      account: { id: 'account-1', status: 'paused', personalReservePercent: 35 },
    })
    expect(requestBody).toEqual({
      accountId: 'account-1',
      expectedContext: EXPECTED_CONTEXT,
      status: 'paused',
      personalReservePercent: 35,
      weeklySharedEstimatedApiCostLimitMicros: 1_500_000,
      allowedModels: ['gpt-5-codex'],
    })
  })

  it('acknowledges the display-name migration through one protected version-bound write', async () => {
    const fetchMock = withManagementSession(async () => new Response(JSON.stringify({
      migrationVersion: 20,
      acknowledged: true,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const api = createTeamManagementApi(fetchMock)

    await expect(api.acknowledgeDisplayNameMigration(20, EXPECTED_CONTEXT)).resolves.toEqual({
      migrationVersion: 20,
      acknowledged: true,
    })
    expect(fetchMock).toHaveBeenCalledWith(
      TEAM_MANAGEMENT_DISPLAY_NAME_MIGRATION_ACK_PATH,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ [TEAM_MANAGEMENT_CAPABILITY_HEADER]: MANAGEMENT_CAPABILITY }),
        body: JSON.stringify({ migrationVersion: 20, expectedContext: EXPECTED_CONTEXT }),
      }),
    )
  })

  it('rejects a display-name migration acknowledgement that is stale, false, or over-broad', async () => {
    for (const responseBody of [
      { migrationVersion: 21, acknowledged: true },
      { migrationVersion: 20, acknowledged: false },
      { migrationVersion: 20, acknowledged: true, memberId: 'must-not-cross' },
    ]) {
      const api = createTeamManagementApi(withManagementSession(async () => new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })))

      await expect(api.acknowledgeDisplayNameMigration(20, EXPECTED_CONTEXT))
        .rejects.toThrow(/acknowledgement|unexpected|match/iu)
    }
  })

  it('uses the Host contract milliseconds field when creating an invite', async () => {
    const fetchMock = withManagementSession(async () => new Response(JSON.stringify({
      invite: {
        id: 'invite-1',
        teamId: 'team-1',
        invitedByMemberId: 'member-1',
        label: 'Short-lived collaboration',
        status: 'pending',
        revealable: true,
        expiresAt: Date.now() + 3_600_000,
        createdAt: Date.now(),
      },
      inviteToken: 'dsh_invite_secret',
    }), { status: 201, headers: { 'content-type': 'application/json' } }))
    const api = createTeamManagementApi(fetchMock)

    await api.createInvite('Short-lived collaboration', 3_600_000, EXPECTED_CONTEXT)

    expect(fetchMock).toHaveBeenCalledWith(
      '/plugins/dsh-codex-shared-pool/team-client/invites',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ [TEAM_MANAGEMENT_CAPABILITY_HEADER]: MANAGEMENT_CAPABILITY }),
        body: JSON.stringify({
          label: 'Short-lived collaboration',
          expiresInMs: 3_600_000,
          expectedContext: EXPECTED_CONTEXT,
        }),
      }),
    )
  })

  it('reveals one invitation through the protected no-store management path', async () => {
    const fetchMock = withManagementSession(async () => new Response(JSON.stringify({
      inviteId: 'invite-1',
      inviteToken: 'dsh_invite_revealed-secret-1234567890',
      expiresAt: Date.now() + 3_600_000,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const api = createTeamManagementApi(fetchMock)

    await expect(api.revealInvite('invite-1', EXPECTED_CONTEXT)).resolves.toMatchObject({
      inviteId: 'invite-1',
      inviteToken: 'dsh_invite_revealed-secret-1234567890',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      TEAM_MANAGEMENT_INVITES_REVEAL_PATH,
      expect.objectContaining({
        method: 'POST',
        cache: 'no-store',
        headers: expect.objectContaining({ [TEAM_MANAGEMENT_CAPABILITY_HEADER]: MANAGEMENT_CAPABILITY }),
        body: JSON.stringify({ inviteId: 'invite-1', expectedContext: EXPECTED_CONTEXT }),
      }),
    )
  })

  it('rejects a reveal response for a different invitation', async () => {
    const fetchMock = withManagementSession(async () => new Response(JSON.stringify({
      inviteId: 'invite-other',
      inviteToken: 'dsh_invite_revealed-secret-1234567890',
      expiresAt: Date.now() + 3_600_000,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    await expect(createTeamManagementApi(fetchMock).revealInvite('invite-1', EXPECTED_CONTEXT))
      .rejects.toThrow(/inviteId/u)
  })

  it('posts an invite id to the local revocation route', async () => {
    const fetchMock = withManagementSession(async () => new Response(JSON.stringify({
      invite: {
        id: 'invite-1', teamId: 'team-1', invitedByMemberId: 'member-1', label: 'Weekend', status: 'revoked', revealable: false, expiresAt: 5, createdAt: 3,
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const api = createTeamManagementApi(fetchMock)

    await expect(api.revokeInvite('invite-1', EXPECTED_CONTEXT)).resolves.toMatchObject({
      invite: { id: 'invite-1', status: 'revoked' },
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/plugins/dsh-codex-shared-pool/team-client/invites/revoke',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ [TEAM_MANAGEMENT_CAPABILITY_HEADER]: MANAGEMENT_CAPABILITY }),
        body: JSON.stringify({ inviteId: 'invite-1', expectedContext: EXPECTED_CONTEXT }),
      }),
    )
  })

  it('uses browser OAuth by default and preserves an explicit local-account source', async () => {
    const fetchMock = withManagementSession(async () => new Response(JSON.stringify({
      account: { ...contribution(), status: 'authorizing' },
      method: 'browser', authorizationUrl: 'https://auth.openai.com/oauth/authorize?client_id=codex_cli', expiresAt: 2,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const api = createTeamManagementApi(fetchMock)

    await expect(api.reauthorizeOAuth('account-1', EXPECTED_CONTEXT)).resolves.toMatchObject({
      account: { id: 'account-1' }, method: 'browser',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/plugins/dsh-codex-shared-pool/team-client/contributions/oauth/reauthorize',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ [TEAM_MANAGEMENT_CAPABILITY_HEADER]: MANAGEMENT_CAPABILITY }),
        body: JSON.stringify({ accountId: 'account-1', expectedContext: EXPECTED_CONTEXT, method: 'browser' }),
      }),
    )

    await api.startOAuth('Local Codex', EXPECTED_CONTEXT, 'browser', 'local-profile-1')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/plugins/dsh-codex-shared-pool/team-client/contributions/oauth/start',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ [TEAM_MANAGEMENT_CAPABILITY_HEADER]: MANAGEMENT_CAPABILITY }),
        body: JSON.stringify({
          label: 'Local Codex',
          expectedContext: EXPECTED_CONTEXT,
          method: 'browser',
          sourceLocalProfileId: 'local-profile-1',
        }),
      }),
    )
  })

  it('posts an empty request to leave the Team and validates the removed member', async () => {
    const fetchMock = withManagementSession(async () => new Response(JSON.stringify({
      member: { ...overview().currentMember, role: 'member', status: 'removed', apiKey: 'must-not-survive' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const api = createTeamManagementApi(fetchMock)

    const result = await api.leaveTeam(EXPECTED_CONTEXT)

    expect(result).toEqual({ member: { ...overview().currentMember, role: 'member', status: 'removed' } })
    expect(JSON.stringify(result)).not.toContain('must-not-survive')
    expect(fetchMock).toHaveBeenCalledWith(
      '/plugins/dsh-codex-shared-pool/team-client/leave',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ [TEAM_MANAGEMENT_CAPABILITY_HEADER]: MANAGEMENT_CAPABILITY }),
        body: JSON.stringify({ expectedContext: EXPECTED_CONTEXT }),
      }),
    )
  })

  it('posts only the Team-name confirmation and expected lifecycle revision when dissolving', async () => {
    const fetchMock = withManagementSession(async () => new Response(JSON.stringify(confirmingDissolution()), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    }))
    const api = createTeamManagementApi(fetchMock)
    const input = {
      confirmationName: 'Friends',
      expectedLifecycleRevision: 7,
      operationId: 'must-not-be-accepted-from-the-browser',
      recoverySecret: 'must-not-cross-the-browser-boundary',
    } as { confirmationName: string; expectedLifecycleRevision: number }

    await expect(api.dissolveTeam(input, EXPECTED_CONTEXT)).resolves.toEqual(confirmingDissolution())
    expect(fetchMock).toHaveBeenCalledWith(
      TEAM_DISSOLVE_PATH,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ [TEAM_MANAGEMENT_CAPABILITY_HEADER]: MANAGEMENT_CAPABILITY }),
        body: JSON.stringify({
          confirmationName: 'Friends',
          expectedLifecycleRevision: 7,
          expectedContext: EXPECTED_CONTEXT,
        }),
      }),
    )
    const requestText = JSON.stringify(fetchMock.mock.calls)
    expect(requestText).not.toContain('must-not-be-accepted-from-the-browser')
    expect(requestText).not.toContain('must-not-cross-the-browser-boundary')
  })

  it('binds pause and resume writes to the lifecycle revision visible in the Browser', async () => {
    const fetchMock = withManagementSession(async () => new Response(JSON.stringify({
      team: { ...overview().team, status: 'paused', lifecycleRevision: 8 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const api = createTeamManagementApi(fetchMock)

    await expect(api.setTeamStatus('paused', 7, EXPECTED_CONTEXT)).resolves.toMatchObject({
      team: { status: 'paused', lifecycleRevision: 8 },
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/plugins/dsh-codex-shared-pool/team-client/team-status',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          status: 'paused', expectedLifecycleRevision: 7, expectedContext: EXPECTED_CONTEXT,
        }),
      }),
    )
  })

  it('recovers and clears dissolution state with strict empty protected requests', async () => {
    const recovered = confirmedDissolution('retry_required')
    const cleared = confirmedDissolution('completed')
    const fetchMock = withManagementSession(async input => new Response(JSON.stringify(
      String(input) === TEAM_DISSOLUTION_RECOVER_PATH ? recovered : cleared,
    ), { status: 200, headers: { 'content-type': 'application/json' } }))
    const api = createTeamManagementApi(fetchMock)

    await expect(api.recoverTeamDissolution()).resolves.toEqual(recovered)
    await expect(api.clearTeamDissolution()).resolves.toEqual(cleared)

    expect(fetchMock).toHaveBeenCalledWith(
      TEAM_DISSOLUTION_RECOVER_PATH,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ [TEAM_MANAGEMENT_CAPABILITY_HEADER]: MANAGEMENT_CAPABILITY }),
        body: JSON.stringify({}),
      }),
    )
    expect(fetchMock).toHaveBeenCalledWith(
      TEAM_DISSOLUTION_CLEAR_PATH,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ [TEAM_MANAGEMENT_CAPABILITY_HEADER]: MANAGEMENT_CAPABILITY }),
        body: JSON.stringify({}),
      }),
    )
  })

  it('accepts an exact cleared acknowledgement when dismissing a completed dissolution terminal', async () => {
    const fetchMock = withManagementSession(async () => new Response(JSON.stringify({ cleared: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const api = createTeamManagementApi(fetchMock)

    await expect(api.clearTeamDissolution()).resolves.toEqual({ cleared: true })
  })

  it('clears a connection terminal with a strict empty protected request', async () => {
    const terminal = { code: 'member_removed' as const, localCleanup: 'completed' as const }
    const fetchMock = withManagementSession(async () => new Response(JSON.stringify(terminal), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    const api = createTeamManagementApi(fetchMock)

    await expect(api.clearConnectionTerminal()).resolves.toEqual(terminal)
    expect(fetchMock).toHaveBeenCalledWith(
      TEAM_CONNECTION_TERMINAL_CLEAR_PATH,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ [TEAM_MANAGEMENT_CAPABILITY_HEADER]: MANAGEMENT_CAPABILITY }),
        body: JSON.stringify({}),
      }),
    )
  })

  it('rejects Host dissolution payloads that could expose operation or credential secrets', async () => {
    const api = createTeamManagementApi(withManagementSession(async () => new Response(JSON.stringify({
      ...confirmedDissolution(),
      operationId: '00000000-0000-4000-8000-000000000001',
      recoverySecret: 'must-not-cross-the-browser-boundary',
      apiKey: 'dsh_team_must-not-cross-the-browser-boundary',
    }), { status: 200, headers: { 'content-type': 'application/json' } })))

    await expect(api.recoverTeamDissolution())
      .rejects.toThrow(/dissolution|operationId|recoverySecret|apiKey|unexpected/iu)
  })

  it('creates a pending ownership transfer without swapping roles', async () => {
    const fetchMock = withManagementSession(async () => new Response(JSON.stringify({
      ...ownershipTransfer(),
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const api = createTeamManagementApi(fetchMock)

    const result = await api.requestOwnershipTransfer('member-2', EXPECTED_CONTEXT)

    expect(result).toEqual(ownershipTransfer())
    expect(fetchMock).toHaveBeenCalledWith(
      '/plugins/dsh-codex-shared-pool/team-client/ownership/transfer',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ [TEAM_MANAGEMENT_CAPABILITY_HEADER]: MANAGEMENT_CAPABILITY }),
        body: JSON.stringify({ targetMemberId: 'member-2', expectedContext: EXPECTED_CONTEXT }),
      }),
    )
  })

  it('accepts, rejects, or revokes a pending ownership transfer through distinct exact routes', async () => {
    const fetchMock = withManagementSession(async input => {
      const path = String(input)
      if (path === TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_ACCEPT_PATH) {
        return new Response(JSON.stringify({
          transfer: ownershipTransfer('accepted'),
          formerOwner: { ...overview().currentMember, role: 'member' },
          owner: { ...overview().currentMember, id: 'member-2', displayName: 'Friend', role: 'owner' },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (path === TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_REJECT_PATH) {
        return new Response(JSON.stringify(ownershipTransfer('rejected')), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (path === TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_REVOKE_PATH) {
        return new Response(JSON.stringify(ownershipTransfer('revoked')), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`unexpected path ${path}`)
    })
    const api = createTeamManagementApi(fetchMock)

    await expect(api.acceptOwnershipTransfer('transfer-1', EXPECTED_CONTEXT)).resolves.toMatchObject({
      transfer: { status: 'accepted' }, formerOwner: { role: 'member' }, owner: { role: 'owner' },
    })
    await expect(api.rejectOwnershipTransfer('transfer-1', EXPECTED_CONTEXT)).resolves.toMatchObject({ status: 'rejected' })
    await expect(api.revokeOwnershipTransfer('transfer-1', EXPECTED_CONTEXT)).resolves.toMatchObject({ status: 'revoked' })

    for (const path of [
      TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_ACCEPT_PATH,
      TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_REJECT_PATH,
      TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_REVOKE_PATH,
    ]) {
      expect(fetchMock).toHaveBeenCalledWith(path, expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ transferId: 'transfer-1', expectedContext: EXPECTED_CONTEXT }),
      }))
    }
  })

  it('rejects malformed ownership-transfer state and secret-bearing extras', async () => {
    const api = createTeamManagementApi(withManagementSession(async () => new Response(JSON.stringify({
      ...ownershipTransfer(),
      recoverySecret: 'must-not-cross',
    }), { status: 200, headers: { 'content-type': 'application/json' } })))

    await expect(api.requestOwnershipTransfer('member-2', EXPECTED_CONTEXT))
      .rejects.toThrow(/ownership transfer|unexpected/iu)
  })

  it('rejects a departure response that did not remove the member', async () => {
    const api = createTeamManagementApi(withManagementSession(async () => new Response(JSON.stringify({
      member: overview().currentMember,
    }), { status: 200, headers: { 'content-type': 'application/json' } })))

    await expect(api.leaveTeam(EXPECTED_CONTEXT)).rejects.toThrow('departure member is invalid')
  })

  it('never falls back to an unvalidated error response', async () => {
    const api = createTeamManagementApi(async () => new Response(JSON.stringify({ error: 42, token: 'secret' }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    }))

    await expect(api.status()).rejects.toThrow('Team management request failed (502)')
  })

  it('preserves the HTTP status on validated management errors', async () => {
    const api = createTeamManagementApi(async () => new Response(JSON.stringify({ error: 'Team API key is revoked' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }))

    const error = await api.overview().catch((cause: unknown) => cause)

    expect(error).toMatchObject({
      name: 'TeamManagementRequestError',
      status: 401,
      message: 'Team API key is revoked',
    })
  })
})

it('projects saved identities and sends capability-protected context when switching', async () => {
  const identity = { id: 'saved-1', teamId: 'team-1', teamName: 'Friends', currentMemberId: 'member-1', memberName: 'Edison' }
  const fetchMock = withManagementSession(async input => String(input).endsWith('/connections')
    ? Response.json({ connections: [{ ...identity, apiKey: 'must-not-survive' }] })
    : Response.json({ team: overview().team, member: overview().currentMember }))
  const api = createTeamManagementApi(fetchMock)
  expect(await api.connections()).toEqual([identity])
  await api.switchConnection(identity.id, EXPECTED_CONTEXT)
  expect(fetchMock).toHaveBeenLastCalledWith('/plugins/dsh-codex-shared-pool/team-client/connections/switch', expect.objectContaining({
    method: 'POST', headers: expect.objectContaining({ [TEAM_MANAGEMENT_CAPABILITY_HEADER]: MANAGEMENT_CAPABILITY }),
    body: JSON.stringify({ connectionId: identity.id, expectedContext: EXPECTED_CONTEXT }),
  }))
})

it('uses protected same-origin setup actions and exports only a validated recovery code on demand', async () => {
  const recoveryCode = `dsh_recovery_${'r'.repeat(43)}`
  const fetchMock = withManagementSession(async input => String(input).endsWith('/recovery-code/export')
    ? Response.json({ recoveryCode })
    : Response.json({ team: overview().team, member: overview().currentMember, apiKey: 'must-not-survive' }))
  const api = createTeamManagementApi(fetchMock)
  const result = await api.createTeam('New Team', 'Edison', null)
  expect(JSON.stringify(result)).not.toContain('must-not-survive')
  expect(fetchMock).toHaveBeenLastCalledWith('/plugins/dsh-codex-shared-pool/team-client/create', expect.objectContaining({
    method: 'POST', headers: expect.objectContaining({ [TEAM_MANAGEMENT_CAPABILITY_HEADER]: MANAGEMENT_CAPABILITY }),
    body: JSON.stringify({ teamName: 'New Team', ownerName: 'Edison', expectedContext: null }),
  }))
  await api.recoverOwner(recoveryCode, EXPECTED_CONTEXT)
  expect(fetchMock).toHaveBeenLastCalledWith('/plugins/dsh-codex-shared-pool/team-client/recover-owner', expect.objectContaining({
    body: JSON.stringify({ recoveryCode, expectedContext: EXPECTED_CONTEXT }),
  }))
  await api.resumeTeamSetup()
  expect(await api.exportRecoveryCode(EXPECTED_CONTEXT)).toEqual({ recoveryCode })
  expect(parseTeamManagementStatus({ enabled: true, keyConfigured: true, keyWritable: true, pendingJoinConfigured: false, pendingTeamSetup: 'create' }).pendingTeamSetup).toBe('create')
  expect(() => parseTeamManagementStatus({ enabled: true, keyConfigured: false, keyWritable: true, pendingJoinConfigured: false, pendingTeamSetup: 'unknown' })).toThrow()
})

it.each([{ recoveryCode: 'invalid' }, { recoveryCode: `dsh_recovery_${'r'.repeat(43)}`, apiKey: 'secret' }])('rejects malformed recovery exports', async value => {
  const api = createTeamManagementApi(withManagementSession(async () => Response.json(value)))
  await expect(api.exportRecoveryCode(EXPECTED_CONTEXT)).rejects.toThrow()
})
