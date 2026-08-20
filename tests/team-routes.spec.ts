import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { registerTeamRoutes } from '../src/team/routes.ts'
import {
  TEAM_MEMBERS_LEAVE_PATH as PUBLIC_TEAM_MEMBERS_LEAVE_PATH,
  TEAM_OWNERSHIP_TRANSFER_PATH as PUBLIC_TEAM_OWNERSHIP_TRANSFER_PATH,
  type TeamMemberDepartureResult,
  type TeamOwnershipTransferResult,
} from '../src/team/index.ts'
import {
  TEAM_BOOTSTRAP_PATH,
  TEAM_CONTRIBUTION_OAUTH_CANCEL_PATH,
  TEAM_CONTRIBUTION_OAUTH_REAUTHORIZE_PATH,
  TEAM_CONTRIBUTION_OAUTH_START_PATH,
  TEAM_CONTRIBUTIONS_PATH,
  TEAM_CURRENT_KEY_REVOKE_PATH,
  TEAM_INVITES_PATH,
  TEAM_INVITES_REVOKE_PATH,
  TEAM_JOIN_PATH,
  TEAM_MEMBERS_LEAVE_PATH,
  TEAM_OWNERSHIP_TRANSFER_PATH,
  TEAM_OVERVIEW_PATH,
  TEAM_STATUS_PATH,
  TEAM_USAGE_PATH,
} from '../src/team/types.ts'
import { MemoryTeamStore } from '../src/team/store.ts'
import { TeamService } from '../src/team/service.ts'
import type { TeamCredentialBroker, TeamCredentialRef } from '../src/team/credentials.ts'

class FakeCredentialBroker implements TeamCredentialBroker {
  readonly started: TeamCredentialRef[] = []
  readonly restarted: TeamCredentialRef[] = []
  startOAuth(ref: TeamCredentialRef): Promise<{ method: 'device_code'; verificationUrl: string; userCode: string; expiresAt: number }> {
    this.started.push(ref)
    return Promise.resolve({
      method: 'device_code',
      verificationUrl: 'https://auth.example.test/codex/device',
      userCode: 'ABCD-EFGH',
      expiresAt: 1_800_000,
    })
  }
  restartOAuth(ref: TeamCredentialRef): ReturnType<TeamCredentialBroker['startOAuth']> {
    this.restarted.push(ref)
    return this.startOAuth(ref)
  }
  cancelOAuth(): Promise<void> { return Promise.resolve() }
  inspectAuthorization(): Promise<{ status: 'active' }> { return Promise.resolve({ status: 'active' }) }
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

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function setup(
  broker: TeamCredentialBroker = new FakeCredentialBroker(),
  resolveBootstrapToken: () => Promise<string | undefined> = async () => 'bootstrap-secret-1234',
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
  registerTeamRoutes(fake, new TeamService({ store: new MemoryTeamStore(), broker }), {
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

async function response(handler: CapturedRoute['handler'], req: IncomingMessage): Promise<{ status: number; body: Record<string, unknown> }> {
  let status = 0
  let text = ''
  const res = {
    writeHead(code: number) { status = code },
    end(value?: string) { text = value ?? '' },
  } as unknown as ServerResponse
  await handler(req, res)
  return { status, body: JSON.parse(text) as Record<string, unknown> }
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
      formerOwner: {
        id: 'member-1', teamId: 'team-1', displayName: 'Former Owner', role: 'admin', status: 'active', joinedAt: 1,
      },
      owner: {
        id: 'member-2', teamId: 'team-1', displayName: 'New Owner', role: 'owner', status: 'active', joinedAt: 2,
      },
    }

    expect(PUBLIC_TEAM_OWNERSHIP_TRANSFER_PATH).toBe(TEAM_OWNERSHIP_TRANSFER_PATH)
    expect(transferred).toMatchObject({ formerOwner: { role: 'admin' }, owner: { role: 'owner' } })
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

  it('requires a Team key for overview and exposes only summaries', async () => {
    const routes = setup()
    const bootstrap = routes.find(route => route.path === TEAM_BOOTSTRAP_PATH)
    const overview = routes.find(route => route.path === TEAM_OVERVIEW_PATH)
    if (bootstrap === undefined || overview === undefined) throw new Error('Team routes missing')
    const result = await response(bootstrap.handler, request('POST', { teamName: 'Friends', ownerName: 'Owner' }, {
      'content-type': 'application/json',
      'x-dsh-bootstrap-token': 'bootstrap-secret-1234',
    }))
    const key = String(result.body.apiKey)

    await expect(response(overview.handler, request('GET', undefined, {}))).resolves.toMatchObject({ status: 401 })
    const current = await response(overview.handler, request('GET', undefined, { authorization: `Bearer ${key}` }, '10.0.0.2'))
    expect(current.status).toBe(200)
    expect(JSON.stringify(current.body)).not.toContain(key)
    expect(current.body.team).toMatchObject({ name: 'Friends', status: 'active' })
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
    expect(accounts.body.accounts).toMatchObject([{ label: 'Owner Codex', status: 'authorizing' }])
    expect(broker.started).toHaveLength(1)
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
    expect(broker.restarted).toEqual([{ teamId: account.teamId, accountId: account.id }])
    const accounts = await response(list.handler, request('GET', undefined, { authorization: authorization.authorization }))
    expect(accounts.body.accounts).toHaveLength(1)
  })

  it('exposes an authenticated metadata-only usage audit route', async () => {
    const routes = setup()
    const bootstrap = routes.find(route => route.path === TEAM_BOOTSTRAP_PATH)
    const usage = routes.find(route => route.path === TEAM_USAGE_PATH)
    if (bootstrap === undefined || usage === undefined) throw new Error('usage route missing')
    const result = await response(bootstrap.handler, request('POST', { teamName: 'Friends', ownerName: 'Owner' }, {
      'content-type': 'application/json',
      'x-dsh-bootstrap-token': 'bootstrap-secret-1234',
    }))
    const key = String(result.body.apiKey)

    await expect(response(usage.handler, request('GET', undefined))).resolves.toMatchObject({ status: 401 })
    const audit = await response(usage.handler, request('GET', undefined, { authorization: `Bearer ${key}` }))
    expect(audit).toEqual({ status: 200, body: { events: [] } })
    expect(JSON.stringify(audit.body)).not.toMatch(/prompt|response|file|token/iu)
  })

  it('lets an administrator apply the Team-wide emergency pause', async () => {
    const routes = setup()
    const bootstrap = routes.find(route => route.path === TEAM_BOOTSTRAP_PATH)
    const status = routes.find(route => route.path === TEAM_STATUS_PATH)
    if (bootstrap === undefined || status === undefined) throw new Error('Team status route missing')
    const result = await response(bootstrap.handler, request('POST', { teamName: 'Friends', ownerName: 'Owner' }, {
      'content-type': 'application/json',
      'x-dsh-bootstrap-token': 'bootstrap-secret-1234',
    }))
    const key = String(result.body.apiKey)

    const paused = await response(status.handler, request('POST', { status: 'paused' }, {
      'content-type': 'application/json', authorization: `Bearer ${key}`,
    }))
    expect(paused).toMatchObject({ status: 200, body: { team: { status: 'paused' } } })

    const resumed = await response(status.handler, request('POST', { status: 'active' }, {
      'content-type': 'application/json', authorization: `Bearer ${key}`,
    }))
    expect(resumed).toMatchObject({ status: 200, body: { team: { status: 'active' } } })
  })

  it('lets an authenticated member revoke the exact key used by the request', async () => {
    const routes = setup()
    const bootstrap = routes.find(route => route.path === TEAM_BOOTSTRAP_PATH)
    const currentKey = routes.find(route => route.path === TEAM_CURRENT_KEY_REVOKE_PATH)
    const overview = routes.find(route => route.path === TEAM_OVERVIEW_PATH)
    if (bootstrap === undefined || currentKey === undefined || overview === undefined) throw new Error('current-key route missing')
    const result = await response(bootstrap.handler, request('POST', { teamName: 'Friends', ownerName: 'Owner' }, {
      'content-type': 'application/json',
      'x-dsh-bootstrap-token': 'bootstrap-secret-1234',
    }))
    const key = String(result.body.apiKey)

    await expect(response(currentKey.handler, request('POST', {}, {
      'content-type': 'application/json', authorization: `Bearer ${key}`,
    }))).resolves.toEqual({ status: 200, body: { ok: true } })
    await expect(response(overview.handler, request('GET', undefined, {
      authorization: `Bearer ${key}`,
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

  it('transfers ownership through an exact, owner-only, secret-free route', async () => {
    const routes = setup()
    const bootstrap = routes.find(route => route.path === TEAM_BOOTSTRAP_PATH)
    const invites = routes.find(route => route.path === TEAM_INVITES_PATH)
    const join = routes.find(route => route.path === TEAM_JOIN_PATH)
    const transfer = routes.find(route => route.path === TEAM_OWNERSHIP_TRANSFER_PATH)
    if (bootstrap === undefined || invites === undefined || join === undefined || transfer === undefined) {
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

    await expect(response(transfer.handler, request('POST', { targetMemberId: formerOwnerId }, {
      'content-type': 'application/json', authorization: `Bearer ${memberKey}`,
    }))).resolves.toMatchObject({ status: 403 })
    await expect(response(transfer.handler, request('POST', { targetMemberId, extra: true }, {
      'content-type': 'application/json', authorization: `Bearer ${ownerKey}`,
    }))).resolves.toMatchObject({ status: 400 })

    const transferred = await response(transfer.handler, request('POST', { targetMemberId }, {
      'content-type': 'application/json', authorization: `Bearer ${ownerKey}`,
    }))
    expect(transferred).toMatchObject({
      status: 200,
      body: {
        formerOwner: { id: formerOwnerId, role: 'admin', status: 'active' },
        owner: { id: targetMemberId, role: 'owner', status: 'active' },
      },
    })
    expect(Object.keys(transferred.body).sort()).toEqual(['formerOwner', 'owner'])
    expect(JSON.stringify(transferred.body)).not.toMatch(/dsh_team|apiKey|token/iu)
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
