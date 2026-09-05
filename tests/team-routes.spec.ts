import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerTeamRoutes } from '../src/team/routes.ts'
import {
  TEAM_MEMBERS_LEAVE_PATH as PUBLIC_TEAM_MEMBERS_LEAVE_PATH,
  TEAM_OWNERSHIP_TRANSFER_PATH as PUBLIC_TEAM_OWNERSHIP_TRANSFER_PATH,
  type TeamMemberDepartureResult,
  type TeamOwnershipTransferResult,
} from '../src/team/index.ts'
import {
  TEAM_BOOTSTRAP_PATH,
  TEAM_CREATE_PATH,
  TEAM_RECOVER_OWNER_PATH,
  TEAM_CONTRIBUTION_OAUTH_CANCEL_PATH,
  TEAM_CONTRIBUTION_OAUTH_HANDOFF_COMPLETE_PATH,
  TEAM_CONTRIBUTION_OAUTH_REAUTHORIZE_PATH,
  TEAM_CONTRIBUTION_OAUTH_START_PATH,
  TEAM_CONTRIBUTION_PROVIDER_ACCOUNT_MATCHES_PATH,
  TEAM_CONTRIBUTIONS_PATH,
  TEAM_CONNECTION_TERMINAL_PATH,
  TEAM_CURRENT_KEY_REVOKE_PATH,
  TEAM_DISSOLVE_ACK_PATH,
  TEAM_DISSOLVE_PATH,
  TEAM_DISSOLVE_RESULT_PATH,
  TEAM_DISPLAY_NAME_MIGRATION_ACK_PATH,
  TEAM_INVITES_PATH,
  TEAM_INVITES_REVEAL_PATH,
  TEAM_INVITES_REVOKE_PATH,
  TEAM_JOIN_PATH,
  TEAM_MEMBERS_LEAVE_PATH,
  TEAM_OWNERSHIP_TRANSFER_ACCEPT_PATH,
  TEAM_OWNERSHIP_TRANSFER_PATH,
  TEAM_OWNERSHIP_TRANSFER_REJECT_PATH,
  TEAM_OWNERSHIP_TRANSFER_REVOKE_PATH,
  TEAM_OVERVIEW_PATH,
  TEAM_STATUS_PATH,
  TEAM_USAGE_PATH,
  type TeamDissolutionResult,
  type TeamOAuthMethod,
} from '../src/team/types.ts'
import {
  MemoryTeamStore,
  TEAM_DISSOLUTION_RECOVERY_RATE_LIMIT_MAX_ATTEMPTS,
  TEAM_DISSOLUTION_RECOVERY_RATE_LIMIT_WINDOW_MS,
  TEAM_INVITE_REVEAL_RATE_LIMIT_MAX_ATTEMPTS,
  TEAM_INVITE_REVEAL_RATE_LIMIT_WINDOW_MS,
} from '../src/team/store.ts'
import { TeamService } from '../src/team/service.ts'
import type { TeamCredentialBroker, TeamCredentialRef } from '../src/team/credentials.ts'
import type { TeamCredentialHandoffEnvelope } from '../src/team/oauth-handoff.ts'
import { TEAM_AUTHORIZATION_FAILED_CODE } from '../src/shared/team-management.ts'

class FakeCredentialBroker implements TeamCredentialBroker {
  readonly started: Array<{ ref: TeamCredentialRef; method: TeamOAuthMethod }> = []
  readonly restarted: Array<{ ref: TeamCredentialRef; method: TeamOAuthMethod }> = []
  readonly completed: Array<{ ref: TeamCredentialRef; envelope: TeamCredentialHandoffEnvelope }> = []
  readonly matched: Array<{ ref: TeamCredentialRef; providerAccountId: string }> = []
  startOAuth(ref: TeamCredentialRef, method: TeamOAuthMethod = 'device_code'): ReturnType<TeamCredentialBroker['startOAuth']> {
    this.started.push({ ref, method })
    if (method === 'browser') {
      return Promise.resolve({
        method: 'browser_handoff',
        handoff: {
          version: 1,
          sessionId: 'handoff-session',
          serverPublicKey: 'server-public-key',
          expiresAt: 1_800_000,
        },
      })
    }
    return Promise.resolve({
      method: 'device_code',
      verificationUrl: 'https://auth.example.test/codex/device',
      userCode: 'ABCD-EFGH',
      expiresAt: 1_800_000,
    })
  }
  restartOAuth(ref: TeamCredentialRef, method: TeamOAuthMethod = 'device_code'): ReturnType<TeamCredentialBroker['startOAuth']> {
    this.restarted.push({ ref, method })
    return this.startOAuth(ref, method)
  }
  completeOAuthHandoff(ref: TeamCredentialRef, envelope: TeamCredentialHandoffEnvelope): Promise<{ status: 'active'; accountLabel: string }> {
    this.completed.push({ ref, envelope })
    return Promise.resolve({ status: 'active', accountLabel: 'Owner Codex' })
  }
  cancelOAuth(): Promise<void> { return Promise.resolve() }
  inspectAuthorization(): Promise<{ status: 'active' }> { return Promise.resolve({ status: 'active' }) }
  matchesProviderAccount(ref: TeamCredentialRef, providerAccountId: string): Promise<boolean> {
    this.matched.push({ ref, providerAccountId })
    return Promise.resolve(providerAccountId === 'provider-account-private-sentinel')
  }
  readUsage(): Promise<{ rateLimits: [] }> { return Promise.resolve({ rateLimits: [] }) }
  forwardResponses(): Promise<Response> { return Promise.resolve(new Response(null, { status: 204 })) }
  revoke(): Promise<void> { return Promise.resolve() }
  dispose(): Promise<void> { return Promise.resolve() }
}

interface CapturedRoute {
  path: string
  handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>
  disposed: boolean
}

const cleanups: Array<() => Promise<void>> = []

const TEST_ONLY_RECOVERY_SECRET = 'test-only-team-dissolution-recovery-secret-not-for-production'
const TEST_ONLY_RECOVERY_SECRET_HASH = createHash('sha256').update(TEST_ONLY_RECOVERY_SECRET).digest('hex')
const STATUS_PAUSE_OPERATION_ID = '10000000-0000-4000-8000-000000000001'
const STATUS_RESUME_OPERATION_ID = '10000000-0000-4000-8000-000000000002'
const STATUS_STALE_OPERATION_ID = '10000000-0000-4000-8000-000000000003'
const DISSOLUTION_OPERATION_ID = '20000000-0000-4000-8000-000000000001'
const DISSOLUTION_STALE_OPERATION_ID = '20000000-0000-4000-8000-000000000002'
const UNKNOWN_DISSOLUTION_OPERATION_ID = '20000000-0000-4000-8000-000000000099'

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function setup(
  broker: TeamCredentialBroker = new FakeCredentialBroker(),
  resolveBootstrapToken: () => Promise<string | undefined> = async () => 'bootstrap-secret-1234',
  store: MemoryTeamStore = new MemoryTeamStore(),
): CapturedRoute[] {
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
  registerTeamRoutes(fake, new TeamService({ store, broker }), {
    resolveBootstrapToken,
  })
  return routes
}

function request(
  method: string,
  body: unknown,
  headers: Record<string, string> = {},
  remoteAddress = '127.0.0.1',
): IncomingMessage {
  const payload = body === undefined ? '' : JSON.stringify(body)
  const stream = Readable.from(payload === '' ? [] : [Buffer.from(payload)]) as unknown as IncomingMessage
  Object.assign(stream, {
    method,
    headers: { host: '127.0.0.1', ...headers },
    socket: { remoteAddress },
  })
  return stream
}

async function response(
  handler: CapturedRoute['handler'],
  req: IncomingMessage,
  capturedHeaders?: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  let status = 0
  let text = ''
  const res = {
    writeHead(code: number, headers?: Record<string, string>) {
      status = code
      if (capturedHeaders !== undefined && headers !== undefined) Object.assign(capturedHeaders, headers)
    },
    end(value?: string) { text = value ?? '' },
  } as unknown as ServerResponse
  await handler(req, res)
  return { status, body: JSON.parse(text) as Record<string, unknown> }
}

async function dissolvedStoreFixture(now = 456_000): Promise<{
  store: MemoryTeamStore
  ownerKey: string
  result: TeamDissolutionResult
}> {
  const store = new MemoryTeamStore({ now: () => now })
  const bootstrap = await store.bootstrap('Friends', 'Owner')
  const ownerAuth = await store.authenticateApiKey(bootstrap.apiKey)
  if (ownerAuth === undefined) throw new Error('Owner fixture authentication failed')
  const result = await store.dissolveTeam(ownerAuth, {
    operationId: DISSOLUTION_OPERATION_ID,
    expectedLifecycleRevision: 1,
    confirmationName: 'Friends',
    recoverySecretHash: TEST_ONLY_RECOVERY_SECRET_HASH,
  })
  return { store, ownerKey: bootstrap.apiKey, result }
}

describe('Team control-plane routes', () => {
  it('publishes the member departure contract from the Team package entry', () => {
    const departure: TeamMemberDepartureResult = {
      member: {
        id: 'member-1',
        teamId: 'team-1',
        displayName: 'Friend',
        role: 'member',
        status: 'removed',
        createdAt: 1,
        updatedAt: 2,
      },
      contributions: [],
    }

    expect(PUBLIC_TEAM_MEMBERS_LEAVE_PATH).toBe(TEAM_MEMBERS_LEAVE_PATH)
    expect(departure.member.status).toBe('removed')
  })

  it('publishes the ownership-transfer contract from the Team package entry', () => {
    const transferred: TeamOwnershipTransferResult = {
      transfer: {
        id: 'transfer-1',
        teamId: 'team-1',
        requestedByMemberId: 'member-1',
        targetMemberId: 'member-2',
        status: 'accepted',
        createdAt: 1,
        expiresAt: 86_400_001,
        resolvedAt: 2,
      },
      formerOwner: {
        id: 'member-1', teamId: 'team-1', displayName: 'Former Owner', role: 'member', status: 'active', joinedAt: 1,
      },
      owner: {
        id: 'member-2', teamId: 'team-1', displayName: 'New Owner', role: 'owner', status: 'active', joinedAt: 2,
      },
    }

    expect(PUBLIC_TEAM_OWNERSHIP_TRANSFER_PATH).toBe(TEAM_OWNERSHIP_TRANSFER_PATH)
    expect(transferred).toMatchObject({ formerOwner: { role: 'member' }, owner: { role: 'owner' } })
  })

  it('does not register the retired generic member-role mutation route', () => {
    const routes = setup()

    expect(routes.some(route => route.path === '/plugins/dsh-codex-shared-pool/team/members/role')).toBe(false)
  })

  it('requires local bootstrap plus JSON and never echoes the bootstrap secret', async () => {
    const routes = setup()
    const bootstrap = routes.find(route => route.path === TEAM_BOOTSTRAP_PATH)
    if (bootstrap === undefined) throw new Error('bootstrap route missing')

    await expect(response(bootstrap.handler, request('POST', { teamName: 'Friends', ownerName: 'Owner' }, {
      'content-type': 'application/json',
      'x-dsh-bootstrap-token': 'bootstrap-secret-1234',
    }, '10.0.0.1'))).resolves.toMatchObject({ status: 403 })

    const result = await response(bootstrap.handler, request('POST', { teamName: 'Friends', ownerName: 'Owner' }, {
      'content-type': 'application/json',
      'x-dsh-bootstrap-token': 'bootstrap-secret-1234',
    }))
    expect(result.status).toBe(201)
    expect(result.body.apiKey).toMatch(/^dsh_team_/u)
    expect(JSON.stringify(result.body)).not.toContain('bootstrap-secret-1234')
  })

  it('passes the bootstrap owner name unmodified to the fixed Unicode display-name boundary', async () => {
    const routes = setup()
    const bootstrap = routes.find(route => route.path === TEAM_BOOTSTRAP_PATH)
    if (bootstrap === undefined) throw new Error('bootstrap route missing')

    const result = await response(bootstrap.handler, request('POST', {
      teamName: 'Friends',
      ownerName: '\tOwner\n',
    }, {
      'content-type': 'application/json',
      'x-dsh-bootstrap-token': 'bootstrap-secret-1234',
    }))

    expect(result.status).toBe(400)
  })

  it('resolves the bootstrap credential for each operation so rotation is immediate', async () => {
    let secret = 'bootstrap-secret-1234'
    const routes = setup(new FakeCredentialBroker(), async () => secret)
    const bootstrap = routes.find(route => route.path === TEAM_BOOTSTRAP_PATH)
    if (bootstrap === undefined) throw new Error('bootstrap route missing')

    secret = 'rotated-bootstrap-secret-5678'
    await expect(response(bootstrap.handler, request('POST', { teamName: 'Friends', ownerName: 'Owner' }, {
      'content-type': 'application/json',
      'x-dsh-bootstrap-token': 'bootstrap-secret-1234',
    }))).resolves.toMatchObject({ status: 403 })
    await expect(response(bootstrap.handler, request('POST', { teamName: 'Friends', ownerName: 'Owner' }, {
      'content-type': 'application/json',
      'x-dsh-bootstrap-token': secret,
    }))).resolves.toMatchObject({ status: 201 })
  })

  it('returns a role-shaped overview without sibling invites, keys, or contributions', async () => {
    const store = new MemoryTeamStore()
    const routes = setup(new FakeCredentialBroker(), async () => 'bootstrap-secret-1234', store)
    const bootstrap = routes.find(route => route.path === TEAM_BOOTSTRAP_PATH)
    const overview = routes.find(route => route.path === TEAM_OVERVIEW_PATH)
    const invites = routes.find(route => route.path === TEAM_INVITES_PATH)
    const join = routes.find(route => route.path === TEAM_JOIN_PATH)
    const start = routes.find(route => route.path === TEAM_CONTRIBUTION_OAUTH_START_PATH)
    if (bootstrap === undefined || overview === undefined || invites === undefined || join === undefined || start === undefined) {
      throw new Error('Team routes missing')
    }
    const result = await response(bootstrap.handler, request('POST', { teamName: 'Friends', ownerName: 'Owner' }, {
      'content-type': 'application/json',
      'x-dsh-bootstrap-token': 'bootstrap-secret-1234',
    }))
    const ownerKey = String(result.body.apiKey)
    const ownerStarted = await response(start.handler, request('POST', { label: 'Owner Codex' }, {
      'content-type': 'application/json', authorization: `Bearer ${ownerKey}`,
    }))
    await response(start.handler, request('POST', { label: 'Owner setup in progress' }, {
      'content-type': 'application/json', authorization: `Bearer ${ownerKey}`,
    }))
    const invited = await response(invites.handler, request('POST', { label: 'Product designer' }, {
      'content-type': 'application/json', authorization: `Bearer ${ownerKey}`,
    }))
    const joined = await response(join.handler, request('POST', {
      inviteToken: invited.body.inviteToken, displayName: 'Friend',
    }, { 'content-type': 'application/json' }))
    const memberKey = String(joined.body.apiKey)
    const memberId = String((joined.body.member as Record<string, unknown>).id)
    const memberStarted = await response(start.handler, request('POST', { label: 'Friend Codex' }, {
      'content-type': 'application/json', authorization: `Bearer ${memberKey}`,
    }))
    const ownerAccount = ownerStarted.body.account as Record<string, unknown>
    const memberAccount = memberStarted.body.account as Record<string, unknown>
    await store.setContributionAccountStatus(String(ownerAccount.teamId), String(ownerAccount.id), 'active')
    await store.setContributionAccountStatus(String(memberAccount.teamId), String(memberAccount.id), 'active')

    await expect(response(overview.handler, request('GET', undefined, {}))).resolves.toMatchObject({ status: 401 })
    const ownerView = await response(overview.handler, request('GET', undefined, {
      authorization: `Bearer ${ownerKey}`,
    }, '10.0.0.2'))
    expect(ownerView).toMatchObject({
      status: 200,
      body: {
        viewerRole: 'owner',
        team: { name: 'Friends', status: 'active' },
        invites: [],
        contributions: [{ label: 'Owner Codex' }, { label: 'Owner setup in progress', status: 'authorizing' }],
        activeSharedAccounts: [
          { id: ownerAccount.id, label: 'Owner Codex', status: 'active' },
          { id: memberAccount.id, label: 'Friend Codex', ownerMemberId: memberId, status: 'active' },
        ],
      },
    })
    expect(ownerView.body).not.toHaveProperty('apiKeys')
    expect(ownerView.body.contributions).toHaveLength(2)
    expect(JSON.stringify(ownerView.body.contributions)).not.toContain('Friend Codex')

    const memberView = await response(overview.handler, request('GET', undefined, {
      authorization: `Bearer ${memberKey}`,
    }))
    expect(memberView).toMatchObject({
      status: 200,
      body: {
        viewerRole: 'member',
        currentMember: { id: memberId, role: 'member' },
        contributions: [{ label: 'Friend Codex', ownerMemberId: memberId }],
        activeSharedAccounts: [
          { id: ownerAccount.id, label: 'Owner Codex', status: 'active' },
          { id: memberAccount.id, label: 'Friend Codex', ownerMemberId: memberId, status: 'active' },
        ],
      },
    })
    expect(memberView.body).not.toHaveProperty('invites')
    expect(memberView.body).not.toHaveProperty('apiKeys')
    expect(memberView.body.contributions).toHaveLength(1)
    for (const item of ownerView.body.activeSharedAccounts as Array<Record<string, unknown>>) {
      expect(Object.keys(item).sort()).toEqual(['id', 'label', 'ownerMemberId', 'status'])
    }
    expect(memberView.body.activeSharedAccounts).toEqual(ownerView.body.activeSharedAccounts)
    const detailedView = await response(overview.handler, request('GET', undefined, {
      authorization: `Bearer ${memberKey}`, 'x-dsh-team-shared-details': '1',
    }))
    expect(detailedView).toMatchObject({ status: 200, body: { activeSharedAccounts: [
      { id: ownerAccount.id, sharing: { personalReservePercent: expect.any(Number) }, capacity: { buckets: expect.any(Array) } },
      { id: memberAccount.id, sharing: { personalReservePercent: expect.any(Number) }, capacity: { buckets: expect.any(Array) } },
    ] } })

    expect(JSON.stringify([ownerView.body, memberView.body])).not.toContain(ownerKey)
  })

  it('projects and acknowledges only the authenticated member display-name migration notice', async () => {
    const store = new MemoryTeamStore()
    const routes = setup(new FakeCredentialBroker(), async () => 'bootstrap-secret-1234', store)
    const bootstrap = routes.find(route => route.path === TEAM_BOOTSTRAP_PATH)
    const overviewRoute = routes.find(route => route.path === TEAM_OVERVIEW_PATH)
    const acknowledge = routes.find(route => route.path === TEAM_DISPLAY_NAME_MIGRATION_ACK_PATH)
    if (bootstrap === undefined || overviewRoute === undefined || acknowledge === undefined) {
      throw new Error('Team display-name migration routes missing')
    }
    const boot = await response(bootstrap.handler, request('POST', { teamName: 'Friends', ownerName: 'Owner' }, {
      'content-type': 'application/json', 'x-dsh-bootstrap-token': 'bootstrap-secret-1234',
    }))
    const apiKey = String(boot.body.apiKey)
    const originalOverview = store.overview.bind(store)
    const overBroadNotice = {
      migrationVersion: 20,
      previousDisplayName: 'Previous Owner',
      repairReason: 'normalized',
    }
    vi.spyOn(store, 'overview').mockImplementation(async auth => ({
      ...await originalOverview(auth),
      displayNameMigrationNotice: overBroadNotice,
    }))
    const acknowledgeSpy = vi.spyOn(store, 'acknowledgeDisplayNameMigration').mockResolvedValue({
      migrationVersion: 20,
      acknowledged: true,
    })

    const projected = await response(overviewRoute.handler, request('GET', undefined, {
      authorization: `Bearer ${apiKey}`,
    }))
    expect(projected).toMatchObject({
      status: 200,
      body: { displayNameMigrationNotice: { migrationVersion: 20 } },
    })
    expect(projected.body.displayNameMigrationNotice).toEqual({ migrationVersion: 20 })

    await expect(response(acknowledge.handler, request('POST', {}, {}))).resolves.toMatchObject({ status: 401 })
    for (const body of [
      {},
      { migrationVersion: 20, extra: true },
      { migrationVersion: 0 },
      { migrationVersion: -1 },
      { migrationVersion: 1.5 },
      { migrationVersion: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      await expect(response(acknowledge.handler, request('POST', body, {
        'content-type': 'application/json', authorization: `Bearer ${apiKey}`,
      }))).resolves.toMatchObject({ status: 400 })
    }
    expect(acknowledgeSpy).not.toHaveBeenCalled()

    const result = await response(acknowledge.handler, request('POST', { migrationVersion: 20 }, {
      'content-type': 'application/json', authorization: `Bearer ${apiKey}`,
    }))
    expect(result).toMatchObject({ status: 200, body: { migrationVersion: 20, acknowledged: true } })
    expect(acknowledgeSpy).toHaveBeenCalledWith(expect.objectContaining({ role: 'owner' }), 20)
  })

  it('preserves the raw join display name so fixed-Unicode controls cannot be trimmed away', async () => {
    const store = new MemoryTeamStore()
    const routes = setup(new FakeCredentialBroker(), async () => 'bootstrap-secret-1234', store)
    const bootstrap = routes.find(route => route.path === TEAM_BOOTSTRAP_PATH)
    const invites = routes.find(route => route.path === TEAM_INVITES_PATH)
    const join = routes.find(route => route.path === TEAM_JOIN_PATH)
    if (bootstrap === undefined || invites === undefined || join === undefined) throw new Error('Team join routes missing')

    const boot = await response(bootstrap.handler, request('POST', { teamName: 'Friends', ownerName: 'Owner' }, {
      'content-type': 'application/json', 'x-dsh-bootstrap-token': 'bootstrap-secret-1234',
    }))
    const invited = await response(invites.handler, request('POST', { label: 'Member' }, {
      'content-type': 'application/json', authorization: `Bearer ${String(boot.body.apiKey)}`,
    }))

    const rejected = await response(join.handler, request('POST', {
      inviteToken: invited.body.inviteToken,
      displayName: '\tMember\n',
    }, { 'content-type': 'application/json' }))

    expect(rejected).toMatchObject({ status: 400, body: { error: expect.stringMatching(/Control/iu) } })
    await expect(response(join.handler, request('POST', {
      inviteToken: invited.body.inviteToken,
      displayName: '\u3000Member\u3000',
    }, { 'content-type': 'application/json' }))).resolves.toMatchObject({
      status: 201,
      body: { member: { displayName: 'Member' } },
    })
  })

  it('revokes a pending invite through an authenticated exact route', async () => {
    const routes = setup()
    const bootstrap = routes.find(route => route.path === TEAM_BOOTSTRAP_PATH)
    const invites = routes.find(route => route.path === TEAM_INVITES_PATH)
    const revoke = routes.find(route => route.path === TEAM_INVITES_REVOKE_PATH)
    const join = routes.find(route => route.path === TEAM_JOIN_PATH)
    if (bootstrap === undefined || invites === undefined || revoke === undefined || join === undefined) {
      throw new Error('Team invite routes missing')
    }
    const boot = await response(bootstrap.handler, request('POST', { teamName: 'Friends', ownerName: 'Owner' }, {
      'content-type': 'application/json', 'x-dsh-bootstrap-token': 'bootstrap-secret-1234',
    }))
    const ownerKey = String(boot.body.apiKey)
    const created = await response(invites.handler, request('POST', {}, {
      'content-type': 'application/json', authorization: `Bearer ${ownerKey}`,
    }))
    const invite = created.body.invite as Record<string, unknown>

    await expect(response(revoke.handler, request('POST', { inviteId: invite.id }, {
      'content-type': 'application/json',
    }))).resolves.toMatchObject({ status: 401 })
    const revoked = await response(revoke.handler, request('POST', { inviteId: invite.id }, {
      'content-type': 'application/json', authorization: `Bearer ${ownerKey}`,
    }))
    expect(revoked).toMatchObject({ status: 200, body: { invite: { id: invite.id, status: 'revoked' } } })
    expect(JSON.stringify(revoked.body)).not.toMatch(/dsh_invite_/u)
    await expect(response(join.handler, request('POST', {
      inviteToken: created.body.inviteToken, displayName: 'Outsider',
    }, { 'content-type': 'application/json' }))).resolves.toMatchObject({ status: 404 })
  })

  it('reveals exactly one valid invitation only to its current owner', async () => {
    const routes = setup()
    const bootstrap = routes.find(route => route.path === TEAM_BOOTSTRAP_PATH)
    const invites = routes.find(route => route.path === TEAM_INVITES_PATH)
    const reveal = routes.find(route => route.path === TEAM_INVITES_REVEAL_PATH)
    if (bootstrap === undefined || invites === undefined || reveal === undefined) {
      throw new Error('Team invite reveal route missing')
    }
    const boot = await response(bootstrap.handler, request('POST', { teamName: 'Friends', ownerName: 'Owner' }, {
      'content-type': 'application/json', 'x-dsh-bootstrap-token': 'bootstrap-secret-1234',
    }))
    const ownerKey = String(boot.body.apiKey)
    const created = await response(invites.handler, request('POST', { label: 'Product designer' }, {
      'content-type': 'application/json', authorization: `Bearer ${ownerKey}`,
    }))
    const invite = created.body.invite as Record<string, unknown>

    await expect(response(reveal.handler, request('POST', { inviteId: invite.id }, {
      'content-type': 'application/json',
    }))).resolves.toEqual({ status: 403, body: { error: 'forbidden' } })
    await expect(response(reveal.handler, request('POST', { inviteId: invite.id, extra: true }, {
      'content-type': 'application/json', authorization: `Bearer ${ownerKey}`,
    }))).resolves.toMatchObject({ status: 400 })
    await expect(response(reveal.handler, request('POST', { inviteId: 'unknown-invite' }, {
      'content-type': 'application/json', authorization: `Bearer ${ownerKey}`,
    }))).resolves.toEqual({
      status: 404,
      body: { error: 'invite is no longer available' },
    })

    const revealed = await response(reveal.handler, request('POST', { inviteId: invite.id }, {
      'content-type': 'application/json', authorization: `Bearer ${ownerKey}`,
    }))
    expect(revealed).toEqual({
      status: 200,
      body: {
        inviteId: invite.id,
        inviteToken: created.body.inviteToken,
        expiresAt: invite.expiresAt,
      },
    })
  })

  it('checks Owner authorization before invite lookup and returns a secret-free 429 with Retry-After', async () => {
    let now = 240_000
    const store = new MemoryTeamStore({ now: () => now })
    const revealSpy = vi.spyOn(store, 'revealInvite')
    const routes = setup(new FakeCredentialBroker(), async () => 'bootstrap-secret-1234', store)
    const bootstrap = routes.find(route => route.path === TEAM_BOOTSTRAP_PATH)
    const invites = routes.find(route => route.path === TEAM_INVITES_PATH)
    const join = routes.find(route => route.path === TEAM_JOIN_PATH)
    const reveal = routes.find(route => route.path === TEAM_INVITES_REVEAL_PATH)
    if (bootstrap === undefined || invites === undefined || join === undefined || reveal === undefined) {
      throw new Error('Team invite routes missing')
    }
    const boot = await response(bootstrap.handler, request('POST', { teamName: 'Friends', ownerName: 'Owner' }, {
      'content-type': 'application/json', 'x-dsh-bootstrap-token': 'bootstrap-secret-1234',
    }))
    const ownerKey = String(boot.body.apiKey)
    const target = await response(invites.handler, request('POST', { label: 'Target' }, {
      'content-type': 'application/json', authorization: `Bearer ${ownerKey}`,
    }))
    const memberInvite = await response(invites.handler, request('POST', { label: 'Member' }, {
      'content-type': 'application/json', authorization: `Bearer ${ownerKey}`,
    }))
    const joined = await response(join.handler, request('POST', {
      inviteToken: memberInvite.body.inviteToken,
      displayName: 'Member',
    }, { 'content-type': 'application/json' }))
    const memberKey = String(joined.body.apiKey)
    const targetInvite = target.body.invite as Record<string, unknown>

    await expect(response(reveal.handler, request('POST', { inviteId: targetInvite.id }, {
      'content-type': 'application/json',
    }))).resolves.toEqual({ status: 403, body: { error: 'forbidden' } })
    await expect(response(reveal.handler, request('POST', { inviteId: 'unknown-invite' }, {
      'content-type': 'application/json', authorization: `Bearer ${memberKey}`,
    }))).resolves.toEqual({ status: 403, body: { error: 'forbidden' } })
    expect(revealSpy).not.toHaveBeenCalled()

    for (let attempt = 0; attempt < TEAM_INVITE_REVEAL_RATE_LIMIT_MAX_ATTEMPTS; attempt += 1) {
      await expect(response(reveal.handler, request('POST', { inviteId: targetInvite.id }, {
        'content-type': 'application/json', authorization: `Bearer ${ownerKey}`,
      }))).resolves.toMatchObject({ status: 200 })
    }
    const headers: Record<string, string> = {}
    const limited = await response(reveal.handler, request('POST', { inviteId: targetInvite.id }, {
      'content-type': 'application/json', authorization: `Bearer ${ownerKey}`,
    }), headers)
    expect(limited).toEqual({
      status: 429,
      body: { error: 'Team invitation reveal rate limit exceeded' },
    })
    expect(headers['retry-after']).toBe(String(TEAM_INVITE_REVEAL_RATE_LIMIT_WINDOW_MS / 1_000))
    expect(JSON.stringify(limited)).not.toContain(String(targetInvite.id))
    expect(JSON.stringify(limited)).not.toContain(String(target.body.inviteToken))

    now += TEAM_INVITE_REVEAL_RATE_LIMIT_WINDOW_MS
    await expect(response(reveal.handler, request('POST', { inviteId: targetInvite.id }, {
      'content-type': 'application/json', authorization: `Bearer ${ownerKey}`,
    }))).resolves.toMatchObject({ status: 200 })
  })

  it('starts a contribution OAuth challenge without returning credentials', async () => {
    const broker = new FakeCredentialBroker()
    const routes = setup(broker)
    const bootstrap = routes.find(route => route.path === TEAM_BOOTSTRAP_PATH)
    const start = routes.find(route => route.path === TEAM_CONTRIBUTION_OAUTH_START_PATH)
    const list = routes.find(route => route.path === TEAM_CONTRIBUTIONS_PATH)
    if (bootstrap === undefined || start === undefined || list === undefined) throw new Error('contribution routes missing')
    const result = await response(bootstrap.handler, request('POST', { teamName: 'Friends', ownerName: 'Owner' }, {
      'content-type': 'application/json',
      'x-dsh-bootstrap-token': 'bootstrap-secret-1234',
    }))
    const key = String(result.body.apiKey)
    const started = await response(start.handler, request('POST', { label: 'Owner Codex' }, {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
    }))
    expect(started.status).toBe(201)
    expect(started.body).toMatchObject({
      method: 'device_code',
      verificationUrl: 'https://auth.example.test/codex/device',
      userCode: 'ABCD-EFGH',
      expiresAt: 1_800_000,
    })
    expect(JSON.stringify(started.body)).not.toMatch(/access|refresh|token/iu)

    const accounts = await response(list.handler, request('GET', undefined, { authorization: `Bearer ${key}` }))
    expect(accounts.status).toBe(200)
    expect(accounts.body.currentMemberId).toBe(result.body.member && (result.body.member as Record<string, unknown>).id)
    expect(accounts.body.accounts).toMatchObject([{ label: 'Owner Codex', status: 'authorizing' }])
    expect(broker.started).toHaveLength(1)
  })

  it('returns only owned contribution ids that exactly match a Host-supplied provider account', async () => {
    const broker = new FakeCredentialBroker()
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const owned = await store.createContributionAccount(owner, 'Owner Codex')
    await store.setContributionAccountStatus(owner.teamId, owned.id, 'active')
    const revoked = await store.createContributionAccount(owner, 'Revoked Owner Codex')
    await store.setContributionAccountStatus(owner.teamId, revoked.id, 'revoked')
    const invite = await store.createInvite(owner, 60_000)
    const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
    const friend = await store.authenticateApiKey(joined.apiKey)
    if (friend === undefined) throw new Error('friend key should authenticate')
    const foreign = await store.createContributionAccount(friend, 'Friend Codex')
    await store.setContributionAccountStatus(friend.teamId, foreign.id, 'active')
    const routes = setup(broker, async () => 'bootstrap-secret-1234', store)
    const match = routes.find(route => route.path === TEAM_CONTRIBUTION_PROVIDER_ACCOUNT_MATCHES_PATH)
    if (match === undefined) throw new Error('provider-account match route missing')
    const authorization = {
      'content-type': 'application/json',
      authorization: `Bearer ${boot.apiKey}`,
    }

    const result = await response(match.handler, request('POST', {
      providerAccountId: 'provider-account-private-sentinel',
    }, authorization))

    expect(result).toEqual({ status: 200, body: { accountIds: [owned.id] } })
    expect(broker.matched).toEqual([{
      ref: { teamId: owner.teamId, accountId: owned.id },
      providerAccountId: 'provider-account-private-sentinel',
    }])
    expect(broker.matched.some(match => match.ref.accountId === revoked.id)).toBe(false)
    expect(JSON.stringify(result.body)).not.toContain('provider-account-private-sentinel')

    await expect(response(match.handler, request('POST', {
      providerAccountId: 'provider-account-private-sentinel',
      access: 'must-not-be-accepted',
    }, authorization))).resolves.toMatchObject({ status: 400 })
    expect(broker.matched).toHaveLength(1)
  })

  it('reauthorizes an existing contribution without creating a second account', async () => {
    const broker = new FakeCredentialBroker()
    const routes = setup(broker)
    const bootstrap = routes.find(route => route.path === TEAM_BOOTSTRAP_PATH)
    const start = routes.find(route => route.path === TEAM_CONTRIBUTION_OAUTH_START_PATH)
    const cancel = routes.find(route => route.path === TEAM_CONTRIBUTION_OAUTH_CANCEL_PATH)
    const reauthorize = routes.find(route => route.path === TEAM_CONTRIBUTION_OAUTH_REAUTHORIZE_PATH)
    const list = routes.find(route => route.path === TEAM_CONTRIBUTIONS_PATH)
    if (bootstrap === undefined || start === undefined || cancel === undefined || reauthorize === undefined || list === undefined) {
      throw new Error('contribution OAuth routes missing')
    }
    const boot = await response(bootstrap.handler, request('POST', { teamName: 'Friends', ownerName: 'Owner' }, {
      'content-type': 'application/json', 'x-dsh-bootstrap-token': 'bootstrap-secret-1234',
    }))
    const authorization = { 'content-type': 'application/json', authorization: `Bearer ${String(boot.body.apiKey)}` }
    const started = await response(start.handler, request('POST', { label: 'Owner Codex' }, authorization))
    const account = started.body.account as Record<string, unknown>
    await response(cancel.handler, request('POST', { accountId: account.id }, authorization))

    const restarted = await response(reauthorize.handler, request('POST', { accountId: account.id }, authorization))

    expect(restarted).toMatchObject({ status: 200, body: { account: { id: account.id, status: 'authorizing' }, method: 'device_code' } })
    expect(broker.restarted).toEqual([{ ref: { teamId: account.teamId, accountId: account.id }, method: 'device_code' }])
    const accounts = await response(list.handler, request('GET', undefined, { authorization: authorization.authorization }))
    expect(accounts.body.accounts).toHaveLength(1)
  })

  it('supports browser handoff start, completion, and initial-account discard without exposing credentials', async () => {
    const broker = new FakeCredentialBroker()
    const cancelOAuth = vi.spyOn(broker, 'cancelOAuth')
    const routes = setup(broker)
    const bootstrap = routes.find(route => route.path === TEAM_BOOTSTRAP_PATH)
    const start = routes.find(route => route.path === TEAM_CONTRIBUTION_OAUTH_START_PATH)
    const complete = routes.find(route => route.path === TEAM_CONTRIBUTION_OAUTH_HANDOFF_COMPLETE_PATH)
    const cancel = routes.find(route => route.path === TEAM_CONTRIBUTION_OAUTH_CANCEL_PATH)
    if (bootstrap === undefined || start === undefined || complete === undefined || cancel === undefined) {
      throw new Error('browser OAuth routes missing')
    }
    const boot = await response(bootstrap.handler, request('POST', { teamName: 'Friends', ownerName: 'Owner' }, {
      'content-type': 'application/json', 'x-dsh-bootstrap-token': 'bootstrap-secret-1234',
    }))
    const authorization = { 'content-type': 'application/json', authorization: `Bearer ${String(boot.body.apiKey)}` }
    const started = await response(start.handler, request('POST', { label: 'Owner Codex', method: 'browser' }, authorization))
    const account = started.body.account as Record<string, unknown>
    expect(started).toMatchObject({
      status: 201,
      body: { method: 'browser_handoff', handoff: { version: 1, sessionId: 'handoff-session' } },
    })
    expect(broker.started).toEqual([{ ref: { teamId: account.teamId, accountId: account.id }, method: 'browser' }])

    const envelope = {
      version: 1,
      sessionId: 'handoff-session',
      clientPublicKey: 'client-public-key',
      iv: 'initialization-vector',
      ciphertext: 'ciphertext',
      tag: 'authentication-tag',
    }
    const completed = await response(complete.handler, request('POST', { accountId: account.id, envelope }, authorization))
    expect(completed).toMatchObject({ status: 200, body: { account: { id: account.id, status: 'active' } } })
    expect(broker.completed).toEqual([{ ref: { teamId: account.teamId, accountId: account.id }, envelope }])
    expect(JSON.stringify(completed.body)).not.toMatch(/access|refresh|credential/iu)

    const second = await response(start.handler, request('POST', { label: 'Discard me', method: 'browser' }, authorization))
    const secondAccount = second.body.account as Record<string, unknown>
    const rejectedUnsafeFailure = await response(cancel.handler, request('POST', {
      accountId: secondAccount.id,
      discardInitial: true,
      failureCode: 'raw provider error must not cross the Team boundary',
    }, authorization))
    expect(rejectedUnsafeFailure).toMatchObject({ status: 400 })
    expect(JSON.stringify(rejectedUnsafeFailure.body)).not.toContain('raw provider error')
    expect(cancelOAuth).not.toHaveBeenCalled()

    const discarded = await response(cancel.handler, request('POST', {
      accountId: secondAccount.id,
      discardInitial: true,
      failureCode: TEAM_AUTHORIZATION_FAILED_CODE,
    }, authorization))
    expect(discarded).toMatchObject({
      status: 200,
      body: {
        account: {
          id: secondAccount.id,
          status: 'revoked',
          lastError: TEAM_AUTHORIZATION_FAILED_CODE,
        },
      },
    })
  })

  it('exposes only role-shaped aggregate usage to an authenticated owner or member', async () => {
    const routes = setup()
    const bootstrap = routes.find(route => route.path === TEAM_BOOTSTRAP_PATH)
    const invites = routes.find(route => route.path === TEAM_INVITES_PATH)
    const join = routes.find(route => route.path === TEAM_JOIN_PATH)
    const usage = routes.find(route => route.path === TEAM_USAGE_PATH)
    if (bootstrap === undefined || invites === undefined || join === undefined || usage === undefined) {
      throw new Error('usage route missing')
    }
    const result = await response(bootstrap.handler, request('POST', { teamName: 'Friends', ownerName: 'Owner' }, {
      'content-type': 'application/json',
      'x-dsh-bootstrap-token': 'bootstrap-secret-1234',
    }))
    const ownerKey = String(result.body.apiKey)
    const emptyUsage = {
      requestCount: 0,
      tokenMeasuredRequestCount: 0,
      pricedRequestCount: 0,
      totalTokens: '0',
      estimatedCostUsdMicros: '0',
    }

    await expect(response(usage.handler, request('GET', undefined))).resolves.toMatchObject({ status: 401 })
    const ownerAudit = await response(usage.handler, request('GET', undefined, { authorization: `Bearer ${ownerKey}` }))
    expect(ownerAudit).toEqual({
      status: 200,
      body: {
        role: 'owner',
        window: { startedAt: expect.any(Number), endedAt: expect.any(Number) },
        currency: 'USD',
        team: emptyUsage,
        mine: emptyUsage,
        ownedAccounts: [],
      },
    })

    const invited = await response(invites.handler, request('POST', {}, {
      'content-type': 'application/json', authorization: `Bearer ${ownerKey}`,
    }))
    const joined = await response(join.handler, request('POST', {
      inviteToken: invited.body.inviteToken,
      displayName: 'Friend',
    }, { 'content-type': 'application/json' }))
    const memberKey = String(joined.body.apiKey)
    const memberAudit = await response(usage.handler, request('GET', undefined, {
      authorization: `Bearer ${memberKey}`,
    }))
    expect(memberAudit).toEqual({
      status: 200,
      body: {
        role: 'member',
        window: { startedAt: expect.any(Number), endedAt: expect.any(Number) },
        currency: 'USD',
        mine: emptyUsage,
        ownedAccounts: [],
      },
    })
    expect(memberAudit.body).not.toHaveProperty('team')
    expect(JSON.stringify([ownerAudit.body, memberAudit.body])).not.toMatch(
      /events|credits|accountId|memberId|model|status|error|prompt|response|file/iu,
    )
  })

  it('applies revision-aware Owner status writes idempotently and maps stale revisions to 409', async () => {
    const routes = setup()
    const bootstrap = routes.find(route => route.path === TEAM_BOOTSTRAP_PATH)
    const status = routes.find(route => route.path === TEAM_STATUS_PATH)
    if (bootstrap === undefined || status === undefined) throw new Error('Team status route missing')
    const result = await response(bootstrap.handler, request('POST', { teamName: 'Friends', ownerName: 'Owner' }, {
      'content-type': 'application/json',
      'x-dsh-bootstrap-token': 'bootstrap-secret-1234',
    }))
    const key = String(result.body.apiKey)

    const pauseHeaders: Record<string, string> = {}
    const pauseInput = {
      operationId: STATUS_PAUSE_OPERATION_ID,
      expectedLifecycleRevision: 1,
      status: 'paused',
    }
    const paused = await response(status.handler, request('POST', pauseInput, {
      'content-type': 'application/json', authorization: `Bearer ${key}`,
    }), pauseHeaders)
    expect(paused).toMatchObject({ status: 200, body: { team: { status: 'paused', lifecycleRevision: 2 } } })
    expect(pauseHeaders['cache-control']).toBe('no-store')

    const replayHeaders: Record<string, string> = {}
    const replayed = await response(status.handler, request('POST', pauseInput, {
      'content-type': 'application/json', authorization: `Bearer ${key}`,
    }), replayHeaders)
    expect(replayed).toEqual(paused)
    expect(replayHeaders['cache-control']).toBe('no-store')

    const resumeHeaders: Record<string, string> = {}
    const resumed = await response(status.handler, request('POST', {
      operationId: STATUS_RESUME_OPERATION_ID,
      expectedLifecycleRevision: 2,
      status: 'active',
    }, {
      'content-type': 'application/json', authorization: `Bearer ${key}`,
    }), resumeHeaders)
    expect(resumed).toMatchObject({ status: 200, body: { team: { status: 'active', lifecycleRevision: 3 } } })
    expect(resumeHeaders['cache-control']).toBe('no-store')

    const conflictHeaders: Record<string, string> = {}
    const conflict = await response(status.handler, request('POST', {
      operationId: STATUS_STALE_OPERATION_ID,
      expectedLifecycleRevision: 1,
      status: 'paused',
    }, {
      'content-type': 'application/json', authorization: `Bearer ${key}`,
    }), conflictHeaders)
    expect(conflict).toMatchObject({ status: 409, body: { error: expect.any(String) } })
    expect(conflictHeaders['cache-control']).toBe('no-store')
  })

  it('passes the dissolution confirmation name byte-for-byte instead of trimming it', async () => {
    const store = new MemoryTeamStore({ now: () => 456_000 })
    const bootstrapResult = await store.bootstrap('Friends', 'Owner')
    const expected: TeamDissolutionResult = {
      operationId: DISSOLUTION_OPERATION_ID,
      teamId: bootstrapResult.team.id,
      teamName: 'Friends',
      status: 'dissolved',
      lifecycleRevision: 2,
      dissolvedAt: 456_000,
      terminatedMemberCount: 1,
      revokedInviteCount: 0,
      revokedKeyCount: 1,
      revokedContributionCount: 0,
    }
    const dissolveSpy = vi.spyOn(store, 'dissolveTeam').mockResolvedValue(expected)
    const routes = setup(new FakeCredentialBroker(), async () => 'bootstrap-secret-1234', store)
    const dissolve = routes.find(route => route.path === TEAM_DISSOLVE_PATH)
    if (dissolve === undefined) throw new Error('Team dissolution route missing')
    const headers: Record<string, string> = {}

    const result = await response(dissolve.handler, request('POST', {
      operationId: DISSOLUTION_OPERATION_ID,
      expectedLifecycleRevision: 1,
      confirmationName: ' Friends ',
      recoverySecretHash: TEST_ONLY_RECOVERY_SECRET_HASH,
    }, {
      'content-type': 'application/json', authorization: `Bearer ${bootstrapResult.apiKey}`,
    }), headers)

    expect(result).toEqual({ status: 200, body: expected })
    expect(dissolveSpy).toHaveBeenCalledWith(expect.objectContaining({ role: 'owner' }), {
      operationId: DISSOLUTION_OPERATION_ID,
      expectedLifecycleRevision: 1,
      confirmationName: ' Friends ',
      recoverySecretHash: TEST_ONLY_RECOVERY_SECRET_HASH,
    })
    expect(headers['cache-control']).toBe('no-store')
  })

  it('allows only the current Owner to dissolve an active Team', async () => {
    const store = new MemoryTeamStore({ now: () => 456_000 })
    const bootstrapResult = await store.bootstrap('Friends', 'Owner')
    const ownerAuth = await store.authenticateApiKey(bootstrapResult.apiKey)
    if (ownerAuth === undefined) throw new Error('Owner fixture authentication failed')
    const invite = await store.createInvite(ownerAuth, 60_000, 'Member fixture')
    const member = await store.acceptInvite(invite.inviteToken, 'Member')
    const routes = setup(new FakeCredentialBroker(), async () => 'bootstrap-secret-1234', store)
    const dissolve = routes.find(route => route.path === TEAM_DISSOLVE_PATH)
    if (dissolve === undefined) throw new Error('Team dissolution route missing')
    const input = {
      operationId: DISSOLUTION_OPERATION_ID,
      expectedLifecycleRevision: 1,
      confirmationName: 'Friends',
      recoverySecretHash: TEST_ONLY_RECOVERY_SECRET_HASH,
    }

    const forbiddenHeaders: Record<string, string> = {}
    const forbidden = await response(dissolve.handler, request('POST', input, {
      'content-type': 'application/json', authorization: `Bearer ${member.apiKey}`,
    }), forbiddenHeaders)
    expect(forbidden).toEqual({ status: 403, body: { error: expect.any(String) } })
    expect(forbiddenHeaders['cache-control']).toBe('no-store')

    const ownerHeaders: Record<string, string> = {}
    const dissolved = await response(dissolve.handler, request('POST', input, {
      'content-type': 'application/json', authorization: `Bearer ${bootstrapResult.apiKey}`,
    }), ownerHeaders)
    expect(dissolved).toMatchObject({
      status: 200,
      body: { operationId: DISSOLUTION_OPERATION_ID, status: 'dissolved', lifecycleRevision: 2 },
    })
    expect(ownerHeaders['cache-control']).toBe('no-store')
  })

  it('maps lifecycle revision conflicts from Team dissolution to 409', async () => {
    const store = new MemoryTeamStore({ now: () => 456_000 })
    const bootstrapResult = await store.bootstrap('Friends', 'Owner')
    const ownerAuth = await store.authenticateApiKey(bootstrapResult.apiKey)
    if (ownerAuth === undefined) throw new Error('Owner fixture authentication failed')
    await store.setTeamStatus(ownerAuth, {
      operationId: STATUS_PAUSE_OPERATION_ID,
      expectedLifecycleRevision: 1,
      status: 'paused',
    })
    const routes = setup(new FakeCredentialBroker(), async () => 'bootstrap-secret-1234', store)
    const dissolve = routes.find(route => route.path === TEAM_DISSOLVE_PATH)
    if (dissolve === undefined) throw new Error('Team dissolution route missing')
    const headers: Record<string, string> = {}

    const conflict = await response(dissolve.handler, request('POST', {
      operationId: DISSOLUTION_STALE_OPERATION_ID,
      expectedLifecycleRevision: 1,
      confirmationName: 'Friends',
      recoverySecretHash: TEST_ONLY_RECOVERY_SECRET_HASH,
    }, {
      'content-type': 'application/json', authorization: `Bearer ${bootstrapResult.apiKey}`,
    }), headers)

    expect(conflict).toMatchObject({ status: 409, body: { error: expect.any(String) } })
    expect(headers['cache-control']).toBe('no-store')
  })

  it('recovers a dissolution result without a Team Key and hides wrong-secret misses', async () => {
    const fixture = await dissolvedStoreFixture()
    const routes = setup(new FakeCredentialBroker(), async () => 'bootstrap-secret-1234', fixture.store)
    const recover = routes.find(route => route.path === TEAM_DISSOLVE_RESULT_PATH)
    if (recover === undefined) throw new Error('Team dissolution result route missing')
    const input = { operationId: DISSOLUTION_OPERATION_ID, recoverySecret: TEST_ONLY_RECOVERY_SECRET }

    const firstHeaders: Record<string, string> = {}
    const first = await response(recover.handler, request('POST', input, {
      'content-type': 'application/json',
    }), firstHeaders)
    const replayHeaders: Record<string, string> = {}
    const replay = await response(recover.handler, request('POST', input, {
      'content-type': 'application/json',
    }), replayHeaders)
    expect(first).toEqual({
      status: 200,
      body: { operationType: 'team_dissolution', status: 'dissolved' },
    })
    expect(replay).toEqual(first)
    expect(JSON.stringify(first.body)).not.toMatch(/teamId|teamName|dissolvedAt|member|invite|key|contribution/iu)
    expect(firstHeaders['cache-control']).toBe('no-store')
    expect(replayHeaders['cache-control']).toBe('no-store')

    const wrongHeaders: Record<string, string> = {}
    const wrong = await response(recover.handler, request('POST', {
      operationId: DISSOLUTION_OPERATION_ID,
      recoverySecret: `${TEST_ONLY_RECOVERY_SECRET}-wrong`,
    }, { 'content-type': 'application/json' }), wrongHeaders)
    const unknownHeaders: Record<string, string> = {}
    const unknown = await response(recover.handler, request('POST', {
      operationId: UNKNOWN_DISSOLUTION_OPERATION_ID,
      recoverySecret: `${TEST_ONLY_RECOVERY_SECRET}-wrong`,
    }, { 'content-type': 'application/json' }), unknownHeaders)
    expect(wrong).toEqual(unknown)
    expect(wrong).toMatchObject({ status: 404, body: { error: expect.any(String) } })
    expect(JSON.stringify([wrong, unknown])).not.toContain(TEST_ONLY_RECOVERY_SECRET)
    expect(wrongHeaders['cache-control']).toBe('no-store')
    expect(unknownHeaders['cache-control']).toBe('no-store')
  })

  it('acknowledges the same dissolution repeatedly without a Team Key', async () => {
    const fixture = await dissolvedStoreFixture()
    const routes = setup(new FakeCredentialBroker(), async () => 'bootstrap-secret-1234', fixture.store)
    const ack = routes.find(route => route.path === TEAM_DISSOLVE_ACK_PATH)
    if (ack === undefined) throw new Error('Team dissolution ACK route missing')
    const input = { operationId: DISSOLUTION_OPERATION_ID, recoverySecret: TEST_ONLY_RECOVERY_SECRET }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const headers: Record<string, string> = {}
      const acknowledged = await response(ack.handler, request('POST', input, {
        'content-type': 'application/json',
      }), headers)
      expect(acknowledged).toEqual({ status: 200, body: { ok: true } })
      expect(headers['cache-control']).toBe('no-store')
    }
  })

  it('rate-limits anonymous dissolution recovery by socket source without letting forged forwarding headers or result traffic consume ACK capacity', async () => {
    const fixture = await dissolvedStoreFixture(120_000)
    const routes = setup(new FakeCredentialBroker(), async () => 'bootstrap-secret-1234', fixture.store)
    const recover = routes.find(route => route.path === TEAM_DISSOLVE_RESULT_PATH)
    const ack = routes.find(route => route.path === TEAM_DISSOLVE_ACK_PATH)
    if (recover === undefined || ack === undefined) throw new Error('Team dissolution recovery routes missing')
    const sourceAddress = '203.0.113.7'

    for (let attempt = 0; attempt < TEAM_DISSOLUTION_RECOVERY_RATE_LIMIT_MAX_ATTEMPTS; attempt += 1) {
      const operationId = `30000000-0000-4000-8000-${String(attempt + 1).padStart(12, '0')}`
      await expect(response(recover.handler, request('POST', {
        operationId,
        recoverySecret: `${TEST_ONLY_RECOVERY_SECRET}-${attempt}`,
      }, {
        'content-type': 'application/json',
        'x-forwarded-for': `198.51.100.${attempt + 1}`,
      }, sourceAddress))).resolves.toEqual({
        status: 404,
        body: {
          error: 'Team dissolution result is unavailable',
          code: 'team_dissolution_unavailable',
        },
      })
    }

    const limitedHeaders: Record<string, string> = {}
    const limited = await response(recover.handler, request('POST', {
      operationId: UNKNOWN_DISSOLUTION_OPERATION_ID,
      recoverySecret: `${TEST_ONLY_RECOVERY_SECRET}-limited`,
    }, {
      'content-type': 'application/json',
      'x-forwarded-for': '192.0.2.99',
    }, sourceAddress), limitedHeaders)
    expect(limited).toEqual({
      status: 429,
      body: { error: 'Team dissolution recovery rate limit exceeded' },
    })
    expect(limitedHeaders['retry-after']).toBe(String(TEAM_DISSOLUTION_RECOVERY_RATE_LIMIT_WINDOW_MS / 1_000))
    expect(limitedHeaders['cache-control']).toBe('no-store')
    expect(JSON.stringify(limited)).not.toMatch(
      /operationId|recoverySecret|teamId|teamName|dissolvedAt|member|invite|key|contribution/iu,
    )

    await expect(response(ack.handler, request('POST', {
      operationId: DISSOLUTION_OPERATION_ID,
      recoverySecret: TEST_ONLY_RECOVERY_SECRET,
    }, { 'content-type': 'application/json' }, sourceAddress))).resolves.toEqual({
      status: 200,
      body: { ok: true },
    })
    await expect(response(recover.handler, request('POST', {
      operationId: UNKNOWN_DISSOLUTION_OPERATION_ID,
      recoverySecret: `${TEST_ONLY_RECOVERY_SECRET}-other-source`,
    }, { 'content-type': 'application/json' }, '203.0.113.8'))).resolves.toMatchObject({ status: 404 })
  })

  it('maps every known revoked Team Key to only its coarse 410 terminal code', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const replacement = await store.issueApiKey(owner, 'Owner replacement')
    const replacementOwner = await store.authenticateApiKey(replacement.token)
    if (replacementOwner === undefined) throw new Error('replacement owner key should authenticate')
    await store.revokeApiKey(replacementOwner, owner.keyId)

    const leavingInvite = await store.createInvite(replacementOwner, 60_000)
    const leaving = await store.acceptInvite(leavingInvite.inviteToken, 'Leaving member')
    const leavingMember = await store.authenticateApiKey(leaving.apiKey)
    if (leavingMember === undefined) throw new Error('leaving member key should authenticate')
    await store.leaveTeam(leavingMember)

    const removedInvite = await store.createInvite(replacementOwner, 60_000)
    const removed = await store.acceptInvite(removedInvite.inviteToken, 'Removed member')
    await store.removeMember(replacementOwner, removed.member.id)
    await store.dissolveTeam(replacementOwner, {
      operationId: DISSOLUTION_OPERATION_ID,
      expectedLifecycleRevision: 1,
      confirmationName: 'Friends',
      recoverySecretHash: TEST_ONLY_RECOVERY_SECRET_HASH,
    })

    const routes = setup(new FakeCredentialBroker(), async () => 'bootstrap-secret-1234', store)
    const terminal = routes.find(route => route.path === TEAM_CONNECTION_TERMINAL_PATH)
    if (terminal === undefined) throw new Error('Team connection-terminal route missing')
    const cases = [
      [boot.apiKey, 'device_revoked'],
      [leaving.apiKey, 'member_left'],
      [removed.apiKey, 'member_removed'],
      [replacement.token, 'team_dissolved'],
    ] as const

    for (const [apiKey, code] of cases) {
      const headers: Record<string, string> = {}
      const diagnosed = await response(terminal.handler, request('POST', undefined, {
        authorization: `Bearer ${apiKey}`,
      }), headers)
      expect(diagnosed).toEqual({ status: 410, body: { code } })
      expect(Object.keys(diagnosed.body)).toEqual(['code'])
      expect(headers['cache-control']).toBe('no-store')
    }

    const unknown = await response(terminal.handler, request('POST', undefined, {
      authorization: 'Bearer dsh_team_unknown-secret-1234567890',
    }))
    const missing = await response(terminal.handler, request('POST'))
    expect(unknown).toEqual({ status: 401, body: { error: 'unauthorized' } })
    expect(missing).toEqual(unknown)
  })

  it('rejects current Owner-key revocation but lets a Member disconnect its current device', async () => {
    const routes = setup()
    const bootstrap = routes.find(route => route.path === TEAM_BOOTSTRAP_PATH)
    const currentKey = routes.find(route => route.path === TEAM_CURRENT_KEY_REVOKE_PATH)
    const invites = routes.find(route => route.path === TEAM_INVITES_PATH)
    const join = routes.find(route => route.path === TEAM_JOIN_PATH)
    const overview = routes.find(route => route.path === TEAM_OVERVIEW_PATH)
    if (
      bootstrap === undefined || currentKey === undefined || invites === undefined
      || join === undefined || overview === undefined
    ) throw new Error('current-key route fixture missing')
    const result = await response(bootstrap.handler, request('POST', { teamName: 'Friends', ownerName: 'Owner' }, {
      'content-type': 'application/json',
      'x-dsh-bootstrap-token': 'bootstrap-secret-1234',
    }))
    const ownerKey = String(result.body.apiKey)

    await expect(response(currentKey.handler, request('POST', {}, {
      'content-type': 'application/json', authorization: `Bearer ${ownerKey}`,
    }))).resolves.toMatchObject({ status: 403 })
    await expect(response(overview.handler, request('GET', undefined, {
      authorization: `Bearer ${ownerKey}`,
    }))).resolves.toMatchObject({ status: 200 })

    const invited = await response(invites.handler, request('POST', { label: 'Member' }, {
      'content-type': 'application/json', authorization: `Bearer ${ownerKey}`,
    }))
    const joined = await response(join.handler, request('POST', {
      inviteToken: String(invited.body.inviteToken),
      displayName: 'Member',
    }, { 'content-type': 'application/json' }))
    const memberKey = String(joined.body.apiKey)
    await expect(response(currentKey.handler, request('POST', {}, {
      'content-type': 'application/json', authorization: `Bearer ${memberKey}`,
    }))).resolves.toEqual({ status: 200, body: { ok: true } })
    await expect(response(overview.handler, request('GET', undefined, {
      authorization: `Bearer ${memberKey}`,
    }))).resolves.toMatchObject({ status: 401 })
  })

  it('lets a member leave completely but rejects owner departure', async () => {
    const routes = setup()
    const bootstrap = routes.find(route => route.path === TEAM_BOOTSTRAP_PATH)
    const invites = routes.find(route => route.path === TEAM_INVITES_PATH)
    const join = routes.find(route => route.path === TEAM_JOIN_PATH)
    const leave = routes.find(route => route.path === TEAM_MEMBERS_LEAVE_PATH)
    const overview = routes.find(route => route.path === TEAM_OVERVIEW_PATH)
    if (bootstrap === undefined || invites === undefined || join === undefined || leave === undefined || overview === undefined) {
      throw new Error('Team departure routes missing')
    }
    const boot = await response(bootstrap.handler, request('POST', { teamName: 'Friends', ownerName: 'Owner' }, {
      'content-type': 'application/json', 'x-dsh-bootstrap-token': 'bootstrap-secret-1234',
    }))
    const ownerKey = String(boot.body.apiKey)
    const invited = await response(invites.handler, request('POST', {}, {
      'content-type': 'application/json', authorization: `Bearer ${ownerKey}`,
    }))
    const joined = await response(join.handler, request('POST', {
      inviteToken: invited.body.inviteToken,
      displayName: 'Friend',
    }, { 'content-type': 'application/json' }))
    const memberKey = String(joined.body.apiKey)

    const departed = await response(leave.handler, request('POST', {}, {
      'content-type': 'application/json', authorization: `Bearer ${memberKey}`,
    }))

    expect(departed).toMatchObject({ status: 200, body: { member: { role: 'member', status: 'removed' }, contributions: [] } })
    await expect(response(overview.handler, request('GET', undefined, { authorization: `Bearer ${memberKey}` })))
      .resolves.toMatchObject({ status: 401 })
    await expect(response(leave.handler, request('POST', {}, {
      'content-type': 'application/json', authorization: `Bearer ${ownerKey}`,
    }))).resolves.toMatchObject({ status: 409 })
    await expect(response(overview.handler, request('GET', undefined, { authorization: `Bearer ${ownerKey}` })))
      .resolves.toMatchObject({ status: 200, body: { currentMember: { role: 'owner', status: 'active' } } })
  })

  it('runs two-party ownership transfer through exact, secret-free, no-store routes', async () => {
    const routes = setup()
    const bootstrap = routes.find(route => route.path === TEAM_BOOTSTRAP_PATH)
    const invites = routes.find(route => route.path === TEAM_INVITES_PATH)
    const join = routes.find(route => route.path === TEAM_JOIN_PATH)
    const requestTransfer = routes.find(route => route.path === TEAM_OWNERSHIP_TRANSFER_PATH)
    const acceptTransfer = routes.find(route => route.path === TEAM_OWNERSHIP_TRANSFER_ACCEPT_PATH)
    const rejectTransfer = routes.find(route => route.path === TEAM_OWNERSHIP_TRANSFER_REJECT_PATH)
    const revokeTransfer = routes.find(route => route.path === TEAM_OWNERSHIP_TRANSFER_REVOKE_PATH)
    if (
      bootstrap === undefined || invites === undefined || join === undefined || requestTransfer === undefined
      || acceptTransfer === undefined || rejectTransfer === undefined || revokeTransfer === undefined
    ) {
      throw new Error('Team ownership-transfer routes missing')
    }
    const boot = await response(bootstrap.handler, request('POST', { teamName: 'Friends', ownerName: 'Owner' }, {
      'content-type': 'application/json',
      'x-dsh-bootstrap-token': 'bootstrap-secret-1234',
    }))
    const ownerKey = String(boot.body.apiKey)
    const invite = await response(invites.handler, request('POST', {}, {
      'content-type': 'application/json', authorization: `Bearer ${ownerKey}`,
    }))
    const joined = await response(join.handler, request('POST', {
      inviteToken: String(invite.body.inviteToken), displayName: 'Friend',
    }, { 'content-type': 'application/json' }))
    const memberKey = String(joined.body.apiKey)
    const targetMemberId = String((joined.body.member as Record<string, unknown>).id)
    const formerOwnerId = String((boot.body.member as Record<string, unknown>).id)
    const observerInvite = await response(invites.handler, request('POST', { label: 'Observer' }, {
      'content-type': 'application/json', authorization: `Bearer ${ownerKey}`,
    }))
    const observerJoin = await response(join.handler, request('POST', {
      inviteToken: String(observerInvite.body.inviteToken), displayName: 'Observer',
    }, { 'content-type': 'application/json' }))
    const observerKey = String(observerJoin.body.apiKey)

    await expect(response(requestTransfer.handler, request('POST', { targetMemberId: formerOwnerId }, {
      'content-type': 'application/json', authorization: `Bearer ${memberKey}`,
    }))).resolves.toMatchObject({ status: 403 })
    await expect(response(requestTransfer.handler, request('POST', { targetMemberId, extra: true }, {
      'content-type': 'application/json', authorization: `Bearer ${ownerKey}`,
    }))).resolves.toMatchObject({ status: 400 })

    const firstHeaders: Record<string, string> = {}
    const requested = await response(requestTransfer.handler, request('POST', { targetMemberId }, {
      'content-type': 'application/json', authorization: `Bearer ${ownerKey}`,
    }), firstHeaders)
    expect(requested).toMatchObject({
      status: 200,
      body: {
        requestedByMemberId: formerOwnerId,
        targetMemberId,
        status: 'pending',
      },
    })
    expect(Object.keys(requested.body).sort()).toEqual([
      'createdAt', 'expiresAt', 'id', 'requestedByMemberId', 'status', 'targetMemberId', 'teamId',
    ])
    expect(Number(requested.body.expiresAt) - Number(requested.body.createdAt)).toBe(24 * 60 * 60 * 1_000)
    expect(firstHeaders['cache-control']).toBe('no-store')

    const requestedId = String(requested.body.id)
    await expect(response(rejectTransfer.handler, request('POST', { transferId: requestedId }, {
      'content-type': 'application/json', authorization: `Bearer ${ownerKey}`,
    }))).resolves.toMatchObject({ status: 403 })
    const rejectedHeaders: Record<string, string> = {}
    const rejected = await response(rejectTransfer.handler, request('POST', { transferId: requestedId }, {
      'content-type': 'application/json', authorization: `Bearer ${memberKey}`,
    }), rejectedHeaders)
    expect(rejected).toMatchObject({ status: 200, body: { id: requestedId, status: 'rejected' } })
    expect(rejectedHeaders['cache-control']).toBe('no-store')
    const rejectedRetryHeaders: Record<string, string> = {}
    await expect(response(rejectTransfer.handler, request('POST', { transferId: requestedId }, {
      'content-type': 'application/json', authorization: `Bearer ${memberKey}`,
    }), rejectedRetryHeaders)).resolves.toEqual(rejected)
    expect(rejectedRetryHeaders['cache-control']).toBe('no-store')
    await expect(response(acceptTransfer.handler, request('POST', { transferId: requestedId }, {
      'content-type': 'application/json', authorization: `Bearer ${memberKey}`,
    }))).resolves.toMatchObject({ status: 409 })

    const revokedRequest = await response(requestTransfer.handler, request('POST', { targetMemberId }, {
      'content-type': 'application/json', authorization: `Bearer ${ownerKey}`,
    }))
    const revokedId = String(revokedRequest.body.id)
    await expect(response(revokeTransfer.handler, request('POST', { transferId: revokedId }, {
      'content-type': 'application/json', authorization: `Bearer ${memberKey}`,
    }))).resolves.toMatchObject({ status: 403 })
    const revokedHeaders: Record<string, string> = {}
    const revoked = await response(revokeTransfer.handler, request('POST', { transferId: revokedId }, {
      'content-type': 'application/json', authorization: `Bearer ${ownerKey}`,
    }), revokedHeaders)
    expect(revoked).toMatchObject({ status: 200, body: { id: revokedId, status: 'revoked' } })
    expect(revokedHeaders['cache-control']).toBe('no-store')
    const revokedRetryHeaders: Record<string, string> = {}
    await expect(response(revokeTransfer.handler, request('POST', { transferId: revokedId }, {
      'content-type': 'application/json', authorization: `Bearer ${ownerKey}`,
    }), revokedRetryHeaders)).resolves.toEqual(revoked)
    expect(revokedRetryHeaders['cache-control']).toBe('no-store')

    const acceptedRequest = await response(requestTransfer.handler, request('POST', { targetMemberId }, {
      'content-type': 'application/json', authorization: `Bearer ${ownerKey}`,
    }))
    await expect(response(acceptTransfer.handler, request('POST', { transferId: acceptedRequest.body.id, extra: true }, {
      'content-type': 'application/json', authorization: `Bearer ${memberKey}`,
    }))).resolves.toMatchObject({ status: 400 })
    const acceptedHeaders: Record<string, string> = {}
    const transferred = await response(acceptTransfer.handler, request('POST', {
      transferId: acceptedRequest.body.id,
    }, {
      'content-type': 'application/json', authorization: `Bearer ${memberKey}`,
    }), acceptedHeaders)
    expect(transferred).toMatchObject({
      status: 200,
      body: {
        transfer: { id: acceptedRequest.body.id, status: 'accepted' },
        formerOwner: { id: formerOwnerId, role: 'member', status: 'active' },
        owner: { id: targetMemberId, role: 'owner', status: 'active' },
      },
    })
    expect(Object.keys(transferred.body).sort()).toEqual(['formerOwner', 'owner', 'transfer'])
    expect(acceptedHeaders['cache-control']).toBe('no-store')
    const acceptedRetryHeaders: Record<string, string> = {}
    await expect(response(acceptTransfer.handler, request('POST', { transferId: acceptedRequest.body.id }, {
      'content-type': 'application/json', authorization: `Bearer ${memberKey}`,
    }), acceptedRetryHeaders)).resolves.toEqual(transferred)
    expect(acceptedRetryHeaders['cache-control']).toBe('no-store')

    const terminalRevokeHeaders: Record<string, string> = {}
    await expect(response(revokeTransfer.handler, request('POST', { transferId: acceptedRequest.body.id }, {
      'content-type': 'application/json', authorization: `Bearer ${ownerKey}`,
    }), terminalRevokeHeaders)).resolves.toMatchObject({
      status: 200,
      body: { id: acceptedRequest.body.id, status: 'accepted' },
    })
    expect(terminalRevokeHeaders['cache-control']).toBe('no-store')

    const deniedHeaders: Record<string, string> = {}
    const denied = await response(acceptTransfer.handler, request('POST', { transferId: acceptedRequest.body.id }, {
      'content-type': 'application/json', authorization: `Bearer ${observerKey}`,
    }), deniedHeaders)
    const missingHeaders: Record<string, string> = {}
    const missing = await response(acceptTransfer.handler, request('POST', {
      transferId: '00000000-0000-4000-8000-000000009999',
    }, {
      'content-type': 'application/json', authorization: `Bearer ${observerKey}`,
    }), missingHeaders)
    expect(denied).toEqual({ status: 403, body: { error: 'ownership transfer is unavailable to this member' } })
    expect(missing).toEqual(denied)
    expect(deniedHeaders['cache-control']).toBe('no-store')
    expect(missingHeaders['cache-control']).toBe('no-store')
    expect(JSON.stringify([requested.body, rejected.body, revoked.body, transferred.body]))
      .not.toMatch(/dsh_team|apiKey|token|secret/iu)
  })

  it('disposes every registered route with the plugin effect', async () => {
    const routes = setup()
    expect(routes.length).toBeGreaterThan(0)
    await cleanups[0]!()
    expect(routes.every(route => route.disposed)).toBe(true)
    cleanups.shift()
  })

  it('leaves Team service disposal to the runtime that created it', async () => {
    class DisposalBroker extends FakeCredentialBroker {
      disposals = 0
      override dispose(): Promise<void> { this.disposals += 1; return Promise.resolve() }
    }
    const broker = new DisposalBroker()
    setup(broker)
    await cleanups[0]!()
    expect(broker.disposals).toBe(0)
    cleanups.shift()
  })
})


describe('anonymous Team provisioning routes', () => {
  const body = { creationToken: `dsh_create_${'a'.repeat(43)}`, teamName: 'Public Team', ownerName: 'Owner', apiKey: `dsh_team_${'b'.repeat(43)}`, recoveryCode: `dsh_recovery_${'c'.repeat(43)}` }
  it('allows credential-free creation/recovery while returning only identity summaries', async () => {
    const routes = setup()
    const create = routes.find(route => route.path === TEAM_CREATE_PATH)!
    const recover = routes.find(route => route.path === TEAM_RECOVER_OWNER_PATH)!
    expect(create).toBeDefined()
    expect(recover).toBeDefined()
    const created = await response(create.handler, request('POST', body, { 'content-type': 'application/json' }, '203.0.113.9'))
    expect(created.status).toBe(201)
    expect(Object.keys(created.body).sort()).toEqual(['member', 'team'])
    const recovered = await response(recover.handler, request('POST', { recoveryCode: body.recoveryCode, apiKey: `dsh_team_${'d'.repeat(43)}` }, { 'content-type': 'application/json' }, '203.0.113.9'))
    expect(recovered).toEqual(created)
  })
  it.each(['create', 'recover-owner'] as const)('returns retryable 503 after %s commits but its response fails, then retries one identity', async action => {
    const store = new MemoryTeamStore()
    const created = action === 'recover-owner' ? await store.createAnonymousTeam(body) : undefined
    const recoveryBody = { recoveryCode: body.recoveryCode, apiKey: `dsh_team_${'d'.repeat(43)}` }
    let committed: Awaited<ReturnType<MemoryTeamStore['createAnonymousTeam']>> | undefined
    if (action === 'create') {
      const delegate = store.createAnonymousTeam.bind(store)
      vi.spyOn(store, 'createAnonymousTeam').mockImplementationOnce(async input => {
        committed = await delegate(input)
        throw new Error('Connection terminated unexpectedly')
      })
    } else {
      const delegate = store.recoverAnonymousTeamOwner.bind(store)
      vi.spyOn(store, 'recoverAnonymousTeamOwner').mockImplementationOnce(async (code, key) => {
        committed = await delegate(code, key)
        throw new Error('Connection terminated unexpectedly')
      })
    }
    const route = setup(new FakeCredentialBroker(), undefined, store).find(candidate => candidate.path === (action === 'create' ? TEAM_CREATE_PATH : TEAM_RECOVER_OWNER_PATH))!
    const input = action === 'create' ? body : recoveryBody
    const failed = await response(route.handler, request('POST', input, { 'content-type': 'application/json' }))
    expect(failed.status).toBe(503)
    expect(committed).toBeDefined()
    const auth = await store.authenticateApiKey(input.apiKey)
    expect(auth).toMatchObject({ teamId: committed!.team.id, memberId: committed!.member.id, role: 'owner' })
    const retried = await response(route.handler, request('POST', input, { 'content-type': 'application/json' }))
    expect(retried).toEqual({ status: 201, body: committed })
    expect((await store.overview(auth!)).apiKeys).toHaveLength(action === 'create' ? 1 : 2)
    if (created !== undefined) expect(committed).toEqual(created)
  })

  it('classifies unexpected storage failures as 503 even when errors carry a client status', async () => {
    const store = new MemoryTeamStore()
    const routes = setup(new FakeCredentialBroker(), undefined, store)
    const create = routes.find(route => route.path === TEAM_CREATE_PATH)!
    vi.spyOn(store, 'consumeAnonymousTeamAttempt').mockRejectedValueOnce(new Error('database unavailable'))
    expect((await response(create.handler, request('POST', body, { 'content-type': 'application/json' }))).status).toBe(503)
    vi.spyOn(store, 'createAnonymousTeam').mockRejectedValueOnce(Object.assign(new Error('storage outcome unknown'), { status: 409 }))
    expect((await response(create.handler, request('POST', body, { 'content-type': 'application/json' }))).status).toBe(503)
  })

  it('rejects unknown fields, non-POST methods and malformed secrets', async () => {
    const create = setup().find(route => route.path === TEAM_CREATE_PATH)!
    expect(create).toBeDefined()
    expect((await response(create.handler, request('GET', undefined))).status).toBe(405)
    expect((await response(create.handler, request('POST', { ...body, role: 'owner' }, { 'content-type': 'application/json' }))).status).toBe(400)
    expect((await response(create.handler, request('POST', { ...body, recoveryCode: 'short' }, { 'content-type': 'application/json' }))).status).toBe(400)
  })
  it('keeps known validation, creation conflict and recovery misses as definite 4xx rejections', async () => {
    const routes = setup()
    const create = routes.find(route => route.path === TEAM_CREATE_PATH)!
    const recover = routes.find(route => route.path === TEAM_RECOVER_OWNER_PATH)!
    for (const patch of [{ teamName: 'x'.repeat(121) }, { ownerName: '\u200b' }]) {
      expect((await response(create.handler, request('POST', { ...body, ...patch }, { 'content-type': 'application/json' }))).status).toBe(400)
    }
    expect((await response(create.handler, request('POST', body, { 'content-type': 'application/json' }))).status).toBe(201)
    expect((await response(create.handler, request('POST', { ...body, teamName: 'Different' }, { 'content-type': 'application/json' }))).status).toBe(409)
    expect((await response(recover.handler, request('POST', { recoveryCode: `dsh_recovery_${'z'.repeat(43)}`, apiKey: body.apiKey }, { 'content-type': 'application/json' }))).status).toBe(404)
  })

  it('rate limits anonymous attempts before parsing regardless of spoofed forwarding headers', async () => {
    const create = setup().find(route => route.path === TEAM_CREATE_PATH)!
    expect(create).toBeDefined()
    for (let i = 0; i < 30; i++) {
      await response(create.handler, request('POST', {}, { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${i}` }, '203.0.113.9'))
    }
    const headers: Record<string, string> = {}
    expect((await response(create.handler, request('POST', body, { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.1' }, '198.51.100.1'), headers)).status).toBe(429)
    expect(Number(headers['retry-after'])).toBeGreaterThan(0)
  })
})
