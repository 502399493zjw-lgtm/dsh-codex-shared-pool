import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerTeamManagementRoutes } from '../src/team/management-routes.ts'
import type { TeamManagementRouteSecurity } from '../src/team/management-routes.ts'
import {
  TEAM_MANAGEMENT_CAPABILITY_HEADER,
  TEAM_MANAGEMENT_CONNECTION_TERMINAL_CLEAR_PATH,
  TEAM_MANAGEMENT_CONTRIBUTION_UPDATE_PATH,
  TEAM_MANAGEMENT_CONTRIBUTIONS_PATH,
  TEAM_MANAGEMENT_DISPLAY_NAME_MIGRATION_ACK_PATH,
  TEAM_MANAGEMENT_DISCONNECT_PATH,
  TEAM_MANAGEMENT_DISSOLUTION_CLEAR_PATH,
  TEAM_MANAGEMENT_DISSOLUTION_RECOVER_PATH,
  TEAM_MANAGEMENT_DISSOLVE_PATH,
  TEAM_MANAGEMENT_INVITES_PATH,
  TEAM_MANAGEMENT_INVITES_PREVIEW_PATH,
  TEAM_MANAGEMENT_INVITES_REVEAL_PATH,
  TEAM_MANAGEMENT_INVITES_REVOKE_PATH,
  TEAM_MANAGEMENT_JOIN_PATH,
  TEAM_MANAGEMENT_JOIN_DISCARD_PATH,
  TEAM_MANAGEMENT_JOIN_RECOVER_PATH,
  TEAM_MANAGEMENT_LEAVE_PATH,
  TEAM_MANAGEMENT_OVERVIEW_PATH,
  TEAM_MANAGEMENT_SESSION_PATH,
  TEAM_MANAGEMENT_MEMBERS_REMOVE_PATH,
  TEAM_MANAGEMENT_OAUTH_REAUTHORIZE_PATH,
  TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_ACCEPT_PATH,
  TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_PATH,
  TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_REJECT_PATH,
  TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_REVOKE_PATH,
  TEAM_MANAGEMENT_STATUS_PATH,
  TEAM_MANAGEMENT_TEAM_STATUS_PATH,
  TEAM_MANAGEMENT_USAGE_PATH,
} from '../src/shared/team-management.ts'
import type { TeamClientConfig } from '../src/team/client.ts'
import {
  TEAM_CONNECTION_TERMINAL_PATH,
  TEAM_DISPLAY_NAME_MIGRATION_ACK_PATH,
  TEAM_DISSOLVE_ACK_PATH,
  TEAM_DISSOLVE_PATH,
  TEAM_DISSOLVE_RESULT_PATH,
} from '../src/team/types.ts'

interface CapturedRoute {
  path: string
  handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>
  disposed: boolean
}

class FakeCredentials {
  private readonly values = new Map<string, string>()
  writable = true
  readonly readonlyRefs = new Set<string>()
  readonly sets: Array<{ ref: CredentialRef; value: string }> = []
  readonly unsets: CredentialRef[] = []

  get value(): string | undefined {
    return this.values.get('DSH_CODEX_SHARED_POOL_TEAM_API_KEY')
  }

  set value(value: string | undefined) {
    if (value === undefined) this.values.delete('DSH_CODEX_SHARED_POOL_TEAM_API_KEY')
    else this.values.set('DSH_CODEX_SHARED_POOL_TEAM_API_KEY', value)
  }

  get(ref: string): string | undefined {
    return this.values.get(ref)
  }

  put(ref: string, value: string): void {
    this.values.set(ref, value)
  }

  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.values.get(String(ref))
    return Promise.resolve(value === undefined ? undefined : { value, source: 'test' })
  }

  describe(ref: CredentialRef): Promise<CredentialInfo> {
    const value = this.values.get(String(ref))
    return Promise.resolve({
      configured: value !== undefined,
      source: value === undefined ? undefined : 'test',
      writable: this.writable && !this.readonlyRefs.has(String(ref)),
    })
  }

  set(ref: CredentialRef, value: string): Promise<void> {
    this.sets.push({ ref, value })
    this.values.set(String(ref), value)
    return Promise.resolve()
  }

  unset(ref: CredentialRef): Promise<void> {
    if (this.readonlyRefs.has(String(ref))) return Promise.reject(new Error('credential is not writable'))
    this.unsets.push(ref)
    this.values.delete(String(ref))
    return Promise.resolve()
  }
}

const cleanups: Array<() => Promise<void>> = []
const MANAGEMENT_ORIGIN = 'http://127.0.0.1:31415'
const MANAGEMENT_CAPABILITY = `dsh_tm_${'c'.repeat(43)}`
const TEAM_KEY_REF = 'DSH_CODEX_SHARED_POOL_TEAM_API_KEY'
const DISSOLUTION_PENDING_REF = `${TEAM_KEY_REF}_DISSOLUTION_PENDING`
const DISSOLUTION_TERMINAL_REF = `${TEAM_KEY_REF}_DISSOLUTION_TERMINAL`
const DISSOLUTION_KEY_DIGEST_REF = `${TEAM_KEY_REF}_DISSOLUTION_KEY_DIGEST`
const CONNECTION_TERMINAL_REF = `${TEAM_KEY_REF}_CONNECTION_TERMINAL`
const CONNECTION_TERMINAL_KEY_DIGEST_REF = `${TEAM_KEY_REF}_CONNECTION_TERMINAL_KEY_DIGEST`
const deterministicSecurity: TeamManagementRouteSecurity = {
  allowedOrigins: [MANAGEMENT_ORIGIN],
  issue(origin) {
    if (origin !== MANAGEMENT_ORIGIN) throw new Error('Team management origin is forbidden')
    return { capability: MANAGEMENT_CAPABILITY, expiresAt: 4_000_000_000_000 }
  },
  verify(capability, origin) {
    return capability === MANAGEMENT_CAPABILITY && origin === MANAGEMENT_ORIGIN
  },
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function setup(
  config: TeamClientConfig,
  credentials = new FakeCredentials(),
  fetch = vi.fn<typeof globalThis.fetch>(),
  options: { realSecurity?: boolean; now?: () => number } = {},
): { routes: CapturedRoute[]; credentials: FakeCredentials; fetch: typeof fetch } {
  const routes: CapturedRoute[] = []
  const fake = {
    webServer: {
      host: '127.0.0.1',
      port: 31_415,
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
  registerTeamManagementRoutes(fake, config, credentials, {
    fetch,
    ...options.now === undefined ? {} : { now: options.now },
    ...options.realSecurity === true ? {} : { security: deterministicSecurity },
  })
  return { routes, credentials, fetch }
}

function request(
  method: string,
  body?: unknown,
  headers: Record<string, string | undefined> = {},
  remoteAddress = '127.0.0.1',
): IncomingMessage {
  const payload = body === undefined ? '' : JSON.stringify(body)
  const stream = Readable.from(payload === '' ? [] : [Buffer.from(payload)]) as unknown as IncomingMessage
  Object.assign(stream, {
    method,
    headers: {
      host: '127.0.0.1:31415',
      origin: MANAGEMENT_ORIGIN,
      'sec-fetch-site': 'same-origin',
      ...method === 'POST' ? { [TEAM_MANAGEMENT_CAPABILITY_HEADER]: MANAGEMENT_CAPABILITY } : {},
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
  return { id: 'team-1', name: 'Friends', status: 'active', lifecycleRevision: 7, createdAt: 1 }
}

function dissolutionResult(operationId = '20000000-0000-4000-8000-000000000001') {
  return {
    operationId,
    teamId: 'team-1',
    teamName: 'Friends',
    status: 'dissolved',
    lifecycleRevision: 8,
    dissolvedAt: 1_800_000_000_100,
    terminatedMemberCount: 3,
    revokedInviteCount: 2,
    revokedKeyCount: 3,
    revokedContributionCount: 2,
  }
}

function member() {
  return { id: 'member-1', teamId: 'team-1', displayName: 'Edison', role: 'owner', status: 'active', joinedAt: 2 }
}

function ownershipTransfer(status: 'pending' | 'accepted' | 'rejected' | 'revoked' | 'expired' | 'canceled' = 'pending') {
  return {
    id: 'transfer-1', teamId: 'team-1', requestedByMemberId: 'member-1', targetMemberId: 'member-2',
    status, createdAt: 1_800_000_000_000, expiresAt: 1_800_086_400_000,
    ...(status === 'pending' ? {} : { resolvedAt: 1_800_000_000_500 }),
  }
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
    dailySharedCreditLimit: null,
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

const EXPECTED_CONTEXT = {
  serverOrigin: 'https://pool.example',
  teamId: 'team-1',
  currentMemberId: 'member-1',
} as const

function withExpectedContext<T extends Record<string, unknown>>(
  body: T,
): T & { expectedContext: typeof EXPECTED_CONTEXT } {
  return { ...body, expectedContext: EXPECTED_CONTEXT }
}

function withOverviewPreflight(
  mutationFetch: typeof globalThis.fetch,
  currentOverview: Record<string, unknown> = overview(),
) {
  return vi.fn<typeof globalThis.fetch>(async (input, init) => {
    if (String(input) === 'https://pool.example/plugins/dsh-codex-shared-pool/team/overview') {
      return new Response(JSON.stringify(currentOverview), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return mutationFetch(input, init)
  })
}

describe('local Team management routes', () => {
  it('requires a fixed-origin Host session capability before a protected write', async () => {
    const { routes } = setup({ enabled: false }, new FakeCredentials(), vi.fn<typeof globalThis.fetch>(), {
      realSecurity: true,
    })
    const session = route(routes, TEAM_MANAGEMENT_SESSION_PATH)
    const joinTeam = route(routes, TEAM_MANAGEMENT_JOIN_PATH)
    const body = {
      joinHandle: `dsh_join_${'a'.repeat(43)}`,
      displayName: 'Edison',
    }
    const browserHeaders = {
      origin: 'http://127.0.0.1:31415',
      'sec-fetch-site': 'same-origin',
      [TEAM_MANAGEMENT_CAPABILITY_HEADER]: undefined,
    }

    await expect(response(joinTeam.handler, request('POST', body, browserHeaders)))
      .resolves.toMatchObject({ status: 403 })

    const issued = await response(session.handler, request('POST', {}, browserHeaders))
    expect(issued).toMatchObject({
      status: 200,
      body: {
        capability: expect.stringMatching(/^dsh_tm_[A-Za-z0-9_-]{43}$/u),
        expiresAt: expect.any(Number),
      },
    })

    await expect(response(joinTeam.handler, request('POST', body, {
      ...browserHeaders,
      [TEAM_MANAGEMENT_CAPABILITY_HEADER]: String(issued.body.capability),
    }))).resolves.toMatchObject({ status: 409 })
  })

  it('rejects an expired Host capability before resolving credentials or contacting Team', async () => {
    let now = 1_000
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_owner-secret-1234567890'
    const resolve = vi.spyOn(credentials, 'resolve')
    const describe = vi.spyOn(credentials, 'describe')
    const fetch = vi.fn<typeof globalThis.fetch>()
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
      { realSecurity: true, now: () => now },
    )
    const issued = await response(
      route(routes, TEAM_MANAGEMENT_SESSION_PATH).handler,
      request('POST', {}, { [TEAM_MANAGEMENT_CAPABILITY_HEADER]: undefined }),
    )
    now = Number(issued.body.expiresAt)

    const result = await response(
      route(routes, TEAM_MANAGEMENT_INVITES_PATH).handler,
      request('POST', { label: '周末协作', expiresInMs: 86_400_000 }, {
        [TEAM_MANAGEMENT_CAPABILITY_HEADER]: String(issued.body.capability),
      }),
    )

    expect(result).toMatchObject({
      status: 403,
      body: { error: { code: 'team_management_forbidden' } },
    })
    expect(resolve).not.toHaveBeenCalled()
    expect(describe).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects missing or wrong capabilities before resolving credentials or contacting Team', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_owner-secret-1234567890'
    const resolve = vi.spyOn(credentials, 'resolve')
    const describe = vi.spyOn(credentials, 'describe')
    const fetch = vi.fn<typeof globalThis.fetch>()
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
    )
    const createInvite = route(routes, TEAM_MANAGEMENT_INVITES_PATH)
    const body = { label: '周末协作', expiresInMs: 86_400_000 }

    for (const capability of [undefined, `dsh_tm_${'w'.repeat(43)}`]) {
      const result = await response(createInvite.handler, request('POST', body, {
        [TEAM_MANAGEMENT_CAPABILITY_HEADER]: capability,
      }))
      expect(result).toMatchObject({
        status: 403,
        body: { error: { code: 'team_management_forbidden' } },
      })
    }

    expect(resolve).not.toHaveBeenCalled()
    expect(describe).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reports disabled configuration without exposing a key reference and rejects cross-site requests', async () => {
    const { routes } = setup({ enabled: false })
    const status = route(routes, TEAM_MANAGEMENT_STATUS_PATH)
    const normal = await response(status.handler, request('GET'))
    expect(normal).toEqual(expect.objectContaining({
      status: 200,
      body: { enabled: false, keyConfigured: false, keyWritable: false, pendingJoinConfigured: false },
    }))
    expect(JSON.stringify(normal.body)).not.toMatch(/apiKey|credential|ref/iu)
    expect(normal.headers).toMatchObject({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })

    await expect(response(status.handler, request('GET', undefined, {
      origin: 'https://evil.example',
      'sec-fetch-site': 'cross-site',
    }))).resolves.toMatchObject({ status: 403 })
  })

  it('rejects DNS-rebinding authorities even when browser metadata and forwarded headers claim same-origin', async () => {
    const { routes } = setup({ enabled: false })
    const status = route(routes, TEAM_MANAGEMENT_STATUS_PATH)

    for (const headers of [
      {
        host: 'attacker.example:31415',
        origin: 'http://attacker.example:31415',
        'sec-fetch-site': 'same-origin',
      },
      {
        host: 'attacker.example:31415',
        origin: 'http://attacker.example:31415',
        'sec-fetch-site': 'same-origin',
        forwarded: 'host=127.0.0.1:31415;proto=http',
      },
      {
        host: 'attacker.example:31415',
        origin: 'http://attacker.example:31415',
        'sec-fetch-site': 'same-origin',
        'x-forwarded-host': '127.0.0.1:31415',
        'x-forwarded-proto': 'http',
      },
      {
        host: 'localhost.attacker.example:31415',
        origin: 'http://localhost.attacker.example:31415',
        'sec-fetch-site': 'same-origin',
      },
    ]) {
      await expect(response(status.handler, request('GET', undefined, headers)))
        .resolves.toMatchObject({ status: 403 })
    }
  })

  it('fails closed for browser-shaped requests without trustworthy origin provenance', async () => {
    const { routes } = setup({ enabled: false })
    const status = route(routes, TEAM_MANAGEMENT_STATUS_PATH)
    const joinTeam = route(routes, TEAM_MANAGEMENT_JOIN_PATH)

    await expect(response(status.handler, request('GET', undefined, {
      origin: undefined,
      'user-agent': 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    }))).resolves.toMatchObject({ status: 403 })

    await expect(response(status.handler, request('GET', undefined, {
      origin: 'null',
      'sec-fetch-site': 'same-origin',
    }))).resolves.toMatchObject({ status: 403 })

    await expect(response(status.handler, request('GET', undefined, {
      origin: 'https://127.0.0.1:31415',
      'sec-fetch-site': 'same-origin',
    }))).resolves.toMatchObject({ status: 403 })

    await expect(response(joinTeam.handler, request('POST', {
      joinHandle: `dsh_join_${'a'.repeat(43)}`,
      displayName: 'Edison',
    }, {
      origin: undefined,
      referer: 'http://127.0.0.1:31415/settings/team',
      'user-agent': 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    }))).resolves.toMatchObject({ status: 403 })
  })

  it('accepts only the configured browser origin and rejects alternate loopbacks or originless calls', async () => {
    const { routes } = setup({ enabled: false })
    const status = route(routes, TEAM_MANAGEMENT_STATUS_PATH)
    const joinTeam = route(routes, TEAM_MANAGEMENT_JOIN_PATH)

    await expect(response(status.handler, request('GET', undefined, {
      referer: 'http://127.0.0.1:31415/settings/team',
      'user-agent': 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    }))).resolves.toMatchObject({ status: 200 })

    await expect(response(joinTeam.handler, request('POST', {
      joinHandle: `dsh_join_${'a'.repeat(43)}`,
      displayName: 'Edison',
    }, {
      origin: 'http://127.0.0.1:31415',
      'user-agent': 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    }))).resolves.toMatchObject({ status: 409 })

    await expect(response(status.handler, request('GET', undefined, {
      host: '[::1]:31415',
      origin: 'http://[::1]:31415',
      'sec-fetch-site': 'same-origin',
    }, '::1'))).resolves.toMatchObject({ status: 403 })

    await expect(response(status.handler, request('GET', undefined, {
      host: '127.42.0.7:31415',
      origin: 'http://127.42.0.7:31415',
      'sec-fetch-site': 'same-origin',
    }, '127.42.0.7'))).resolves.toMatchObject({ status: 403 })

    await expect(response(status.handler, request('GET', undefined, {
      host: '127.42.0.7:31415',
      origin: 'http://127.42.0.7:31415',
      'sec-fetch-site': 'same-origin',
    }, '::ffff:127.42.0.7'))).resolves.toMatchObject({ status: 403 })

    await expect(response(status.handler, request('GET'))).resolves.toMatchObject({ status: 200 })

    await expect(response(status.handler, request('GET', undefined, {
      origin: undefined,
      'sec-fetch-site': undefined,
      accept: '*/*',
      'sec-fetch-mode': 'cors',
      'user-agent': 'node',
    }))).resolves.toMatchObject({ status: 403 })
  })

  it('resolves the Team key per operation and projects a secret-free overview', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(overview({
      refresh_token: 'remote-secret',
      prompt: 'private prompt',
      contributions: [{ ...contribution(), dailySharedCreditLimit: 424_242 }],
    })), { status: 200, headers: { 'content-type': 'application/json' } }))
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch)

    const result = await response(route(routes, TEAM_MANAGEMENT_OVERVIEW_PATH).handler, request('GET'))
    expect(result.status, JSON.stringify(result.body)).toBe(200)
    expect(result.body).toMatchObject({ viewerRole: 'owner', team: { name: 'Friends' }, currentMember: { displayName: 'Edison' } })
    expect((result.body.contributions as Array<Record<string, unknown>>)[0]).not.toHaveProperty('dailySharedCreditLimit')
    expect(JSON.stringify(result.body)).not.toMatch(/remote-secret|private prompt|tokenHash|apiKeys/iu)
    expect(fetch).toHaveBeenCalledWith(
      'https://pool.example/plugins/dsh-codex-shared-pool/team/overview',
      expect.objectContaining({ headers: expect.objectContaining({ authorization: `Bearer ${credentials.value}` }), redirect: 'error' }),
    )
  })

  it('projects only the current member migration version in a notice', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(overview({
      displayNameMigrationNotice: { migrationVersion: 20 },
    })), { status: 200, headers: { 'content-type': 'application/json' } }))
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch)

    const result = await response(route(routes, TEAM_MANAGEMENT_OVERVIEW_PATH).handler, request('GET'))

    expect(result).toMatchObject({
      status: 200,
      body: {
        displayNameMigrationNotice: { migrationVersion: 20 },
      },
    })
    expect(JSON.stringify(result.body)).not.toMatch(/previousDisplayName|nextDisplayName|repairReason|auditId|"memberId":/iu)
  })

  it('fails closed on an over-broad display-name migration notice', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(overview({
      displayNameMigrationNotice: {
        migrationVersion: 20,
        previousDisplayName: 'must-not-cross',
      },
    })), { status: 200, headers: { 'content-type': 'application/json' } }))
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch)

    const result = await response(route(routes, TEAM_MANAGEMENT_OVERVIEW_PATH).handler, request('GET'))

    expect(result.status).toBe(502)
    expect(JSON.stringify(result.body)).not.toContain('must-not-cross')
  })

  it('forwards one capability-protected migration ACK with the configured Team key', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const mutationFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      migrationVersion: 20,
      acknowledged: true,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const fetch = withOverviewPreflight(mutationFetch)
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch)

    const result = await response(
      route(routes, TEAM_MANAGEMENT_DISPLAY_NAME_MIGRATION_ACK_PATH).handler,
      request('POST', withExpectedContext({ migrationVersion: 20 })),
    )

    expect(result).toMatchObject({ status: 200, body: { migrationVersion: 20, acknowledged: true } })
    expect(fetch).toHaveBeenCalledWith(
      `https://pool.example${TEAM_DISPLAY_NAME_MIGRATION_ACK_PATH}`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ migrationVersion: 20 }),
        headers: expect.objectContaining({ authorization: `Bearer ${credentials.value}` }),
      }),
    )
  })

  it('rejects malformed migration ACK bodies before resolving the Team key or contacting Team', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const resolve = vi.spyOn(credentials, 'resolve')
    const fetch = vi.fn<typeof globalThis.fetch>()
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
    )
    const acknowledge = route(routes, TEAM_MANAGEMENT_DISPLAY_NAME_MIGRATION_ACK_PATH)

    for (const body of [
      {},
      { migrationVersion: 20, extra: true },
      { migrationVersion: 0 },
      { migrationVersion: -1 },
      { migrationVersion: 1.5 },
      { migrationVersion: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      await expect(response(acknowledge.handler, request('POST', body)))
        .resolves.toMatchObject({ status: 400 })
    }

    expect(resolve).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('fails closed when the remote migration acknowledgement does not match the requested version', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const mutationFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      migrationVersion: 21,
      acknowledged: true,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const fetch = withOverviewPreflight(mutationFetch)
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
    )

    const result = await response(
      route(routes, TEAM_MANAGEMENT_DISPLAY_NAME_MIGRATION_ACK_PATH).handler,
      request('POST', withExpectedContext({ migrationVersion: 20 })),
    )

    expect(result).toMatchObject({ status: 502 })
    expect(JSON.stringify(result.body)).not.toContain('21')
  })

  it('keeps Host-only policy names out of malformed remote response errors', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(overview({
      contributions: [{ ...contribution(), dailySharedCreditLimit: 0 }],
    })), { status: 200, headers: { 'content-type': 'application/json' } }))
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch)

    const result = await response(route(routes, TEAM_MANAGEMENT_OVERVIEW_PATH).handler, request('GET'))

    expect(result.status).toBe(502)
    expect(JSON.stringify(result.body)).not.toMatch(/Credits|dailySharedCreditLimit/iu)
  })

  it('keeps old invitation rows readable during a central-first rolling upgrade', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(overview({
      invites: [{
        id: 'invite-old', teamId: 'team-1', invitedByMemberId: 'member-1', status: 'pending', expiresAt: 5, createdAt: 3,
      }],
    })), { status: 200, headers: { 'content-type': 'application/json' } }))
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch)

    const result = await response(route(routes, TEAM_MANAGEMENT_OVERVIEW_PATH).handler, request('GET'))

    expect(result).toMatchObject({
      status: 200,
      body: { invites: [{ id: 'invite-old', label: 'Team invitation' }] },
    })
  })

  it('projects aggregate-only Team usage and drops remote event or account details', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      role: 'owner',
      window: { startedAt: 113_600_000, endedAt: 200_000_000 },
      currency: 'USD',
      team: {
        requestCount: 2,
        tokenMeasuredRequestCount: 1,
        pricedRequestCount: 1,
        totalTokens: '8750',
        estimatedCostUsdMicros: '125000',
        prompt: 'must-not-cross',
      },
      mine: {
        requestCount: 1,
        tokenMeasuredRequestCount: 0,
        pricedRequestCount: 0,
        totalTokens: null,
        estimatedCostUsdMicros: null,
      },
      events: [{
        id: 'usage-1', teamId: 'team-1', consumerMemberId: 'member-2', upstreamOwnerMemberId: 'member-1',
        upstreamAccountId: 'account-1', model: 'gpt-5-codex', unit: 'request', status: 'succeeded',
        credits: 125, creditsFormulaVersion: 'credits-v1', startedAt: 190_000_000, finishedAt: 190_001_000,
        inputTokens: 999, refreshToken: 'must-not-cross',
      }],
      aggregates: {
        generatedAt: 200_000_000, last24HoursStartedAt: 113_600_000, last7DaysStartedAt: 0,
        accountTotals24Hours: [{
          upstreamAccountId: 'account-1', requestCount: 2, measuredRequestCount: 1, credits: 125, prompt: 'must-not-cross',
        }],
        memberDaily7Days: [{
          upstreamAccountId: 'account-1', consumerMemberId: 'member-2', dayStartedAt: 172_800_000,
          requestCount: 2, measuredRequestCount: 1, credits: 125,
        }],
      },
      accessToken: 'must-not-cross',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch)

    const result = await response(route(routes, TEAM_MANAGEMENT_USAGE_PATH).handler, request('GET'))

    expect(result).toMatchObject({
      status: 200,
      body: {
        role: 'owner',
        window: { startedAt: 113_600_000, endedAt: 200_000_000 },
        currency: 'USD',
        team: {
          requestCount: 2, tokenMeasuredRequestCount: 1, pricedRequestCount: 1,
          totalTokens: '8750', estimatedCostUsdMicros: '125000',
        },
        mine: {
          requestCount: 1, tokenMeasuredRequestCount: 0, pricedRequestCount: 0,
          totalTokens: null, estimatedCostUsdMicros: null,
        },
      },
    })
    expect(result.body).not.toHaveProperty('events')
    expect(result.body).not.toHaveProperty('aggregates')
    expect(JSON.stringify(result.body)).not.toMatch(
      /must-not-cross|inputTokens|refreshToken|accessToken|prompt|consumerMemberId|upstreamAccountId|credits/u,
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
    expect(contributions).toHaveLength(1)
    expect(JSON.stringify(result.body)).not.toContain('must-not-cross')
  })

  it('strips owner-only and sibling data from a legacy broad member overview', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const currentMember = { ...member(), id: 'member-2', role: 'member' }
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(overview({
      currentMember,
      members: [member(), currentMember],
      invites: [{
        id: 'invite-private', teamId: 'team-1', invitedByMemberId: 'member-1', label: 'Private',
        status: 'pending', expiresAt: 5, createdAt: 3,
      }],
      contributions: [contribution(), { ...contribution(), id: 'account-2', ownerMemberId: currentMember.id, label: 'Mine' }],
    })), { status: 200, headers: { 'content-type': 'application/json' } }))
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch)

    const result = await response(route(routes, TEAM_MANAGEMENT_OVERVIEW_PATH).handler, request('GET'))

    expect(result).toMatchObject({
      status: 200,
      body: { viewerRole: 'member', contributions: [{ id: 'account-2', ownerMemberId: 'member-2' }] },
    })
    expect(result.body).not.toHaveProperty('invites')
    expect(JSON.stringify(result.body)).not.toMatch(/invite-private|account-1/u)
  })

  it('final-filters standalone contributions to the authenticated member at the Host boundary', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const currentMemberId = 'member-2'
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      currentMemberId,
      accounts: [
        contribution(),
        { ...contribution(), id: 'account-2', ownerMemberId: currentMemberId, label: 'Mine' },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch)

    const result = await response(route(routes, TEAM_MANAGEMENT_CONTRIBUTIONS_PATH).handler, request('GET'))

    expect(result).toMatchObject({
      status: 200,
      body: { accounts: [{ id: 'account-2', ownerMemberId: currentMemberId, label: 'Mine' }] },
    })
    expect(JSON.stringify(result.body)).not.toContain('account-1')
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
      { ...eligible, role: 'member', canReceiveOwnership: true },
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
    const mutationFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      account: { ...contribution(), status: 'authorizing', lastError: undefined },
      method: 'device_code',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-EFGH',
      expiresAt: Date.now() + 900_000,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const fetch = withOverviewPreflight(mutationFetch)
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch)

    const result = await response(
      route(routes, TEAM_MANAGEMENT_OAUTH_REAUTHORIZE_PATH).handler,
      request('POST', withExpectedContext({ accountId: 'account-1' })),
    )

    expect(result).toMatchObject({ status: 200, body: { account: { id: 'account-1', status: 'authorizing' }, method: 'device_code' } })
    expect(fetch).toHaveBeenCalledWith(
      'https://pool.example/plugins/dsh-codex-shared-pool/team/contributions/oauth/reauthorize',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ accountId: 'account-1' }) }),
    )
  })

  it('previews an invite without authentication or echoing its token', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      teamName: 'Friends', label: '周末协作', expiresAt: 99, teamStatus: 'active',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, new FakeCredentials(), fetch)

    const result = await response(route(routes, TEAM_MANAGEMENT_INVITES_PREVIEW_PATH).handler, request('POST', {
      inviteToken: 'dsh_invite_secret-1234567890',
    }))

    expect(result).toEqual(expect.objectContaining({ status: 200 }))
    expect(result.body).toMatchObject({ teamName: 'Friends', label: '周末协作', expiresAt: 99, teamStatus: 'active' })
    expect(result.body.joinHandle).toMatch(/^dsh_join_[A-Za-z0-9_-]{43}$/u)
    expect(JSON.stringify(result.body)).not.toContain('dsh_invite_')
    expect(fetch).toHaveBeenCalledWith(
      'https://pool.example/plugins/dsh-codex-shared-pool/team/invites/preview',
      expect.objectContaining({ headers: expect.not.objectContaining({ authorization: expect.anything() }) }),
    )
  })

  it('accepts an invite with a Host-generated key and returns no secret to the Browser', async () => {
    const inviteToken = 'dsh_invite_secret-1234567890'
    const displayName = '\u3000Edison\u3000'
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        teamName: 'Friends', label: '周末协作', expiresAt: Date.now() + 3_600_000, teamStatus: 'active',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        team: team(), member: member(),
      }), { status: 201, headers: { 'content-type': 'application/json' } }))
    const { routes, credentials } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, new FakeCredentials(), fetch)
    const preview = await response(route(routes, TEAM_MANAGEMENT_INVITES_PREVIEW_PATH).handler, request('POST', { inviteToken }))

    const result = await response(route(routes, TEAM_MANAGEMENT_JOIN_PATH).handler, request('POST', {
      joinHandle: preview.body.joinHandle,
      displayName,
    }))
    expect(result.status).toBe(201)
    expect(result.body).toEqual({ team: team(), member: member() })
    expect(JSON.stringify(result.body)).not.toMatch(/dsh_team|dsh_invite/iu)
    expect(credentials.sets).toHaveLength(2)
    const finalKey = credentials.value
    expect(finalKey).toMatch(/^dsh_team_[A-Za-z0-9_-]{16,}$/u)
    expect(credentials.get('DSH_CODEX_SHARED_POOL_TEAM_API_KEY_PENDING_JOIN')).toBeUndefined()
    expect(fetch).toHaveBeenCalledWith(
      'https://pool.example/plugins/dsh-codex-shared-pool/team/join',
      expect.objectContaining({
        headers: expect.not.objectContaining({ authorization: expect.anything() }),
        body: JSON.stringify({
          inviteToken,
          displayName,
          apiKey: finalKey,
        }),
      }),
    )
  })

  it('preserves the exact pending display name when a join must be recovered', async () => {
    const credentials = new FakeCredentials()
    const pendingKey = 'dsh_team_pending-secret-1234567890'
    const inviteToken = 'dsh_invite_original-secret-1234567890'
    const displayName = '\u3000Edison\u3000'
    credentials.put('DSH_CODEX_SHARED_POOL_TEAM_API_KEY_PENDING_JOIN', JSON.stringify({
      version: 1,
      apiKey: pendingKey,
      inviteToken,
      displayName,
    }))
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'member not found' }), {
        status: 404, headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ team: team(), member: member() }), {
        status: 201, headers: { 'content-type': 'application/json' },
      }))
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch)

    const result = await response(route(routes, TEAM_MANAGEMENT_JOIN_RECOVER_PATH).handler, request('POST', {}))

    expect(result.status).toBe(200)
    expect(fetch).toHaveBeenNthCalledWith(2,
      'https://pool.example/plugins/dsh-codex-shared-pool/team/join',
      expect.objectContaining({
        body: JSON.stringify({ inviteToken, displayName, apiKey: pendingKey }),
      }),
    )
  })

  it('rejects an expired local join handle before forwarding an accept request', async () => {
    let now = Date.UTC(2026, 7, 23, 12)
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response(JSON.stringify({
      teamName: 'Friends', label: '周末协作', expiresAt: now + 86_400_000, teamStatus: 'active',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, new FakeCredentials(), fetch)
    const preview = await response(route(routes, TEAM_MANAGEMENT_INVITES_PREVIEW_PATH).handler, request('POST', {
      inviteToken: 'dsh_invite_secret-1234567890',
    }))

    now += 15 * 60 * 1000 + 1
    const result = await response(route(routes, TEAM_MANAGEMENT_JOIN_PATH).handler, request('POST', {
      joinHandle: preview.body.joinHandle,
      displayName: 'Edison',
    }))

    expect(result).toMatchObject({ status: 400, body: { error: expect.stringMatching(/join handle/iu) } })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('consumes a local join handle before a definite remote rejection', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        teamName: 'Friends', label: '周末协作', expiresAt: Date.now() + 86_400_000, teamStatus: 'active',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'invite is invalid or expired' }), {
        status: 409, headers: { 'content-type': 'application/json' },
      }))
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, new FakeCredentials(), fetch)
    const preview = await response(route(routes, TEAM_MANAGEMENT_INVITES_PREVIEW_PATH).handler, request('POST', {
      inviteToken: 'dsh_invite_secret-1234567890',
    }))
    const joinBody = { joinHandle: preview.body.joinHandle, displayName: 'Edison' }

    await expect(response(route(routes, TEAM_MANAGEMENT_JOIN_PATH).handler, request('POST', joinBody)))
      .resolves.toMatchObject({ status: 409 })
    await expect(response(route(routes, TEAM_MANAGEMENT_JOIN_PATH).handler, request('POST', joinBody)))
      .resolves.toMatchObject({ status: 400, body: { error: expect.stringMatching(/join handle/iu) } })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('keeps an uncertain join recoverable, then promotes the pending key after verification', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        teamName: 'Friends', label: '周末协作', expiresAt: Date.now() + 3_600_000, teamStatus: 'active',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'temporarily unavailable' }), {
        status: 503, headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(overview()), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))
    const { routes, credentials } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, new FakeCredentials(), fetch)
    const preview = await response(route(routes, TEAM_MANAGEMENT_INVITES_PREVIEW_PATH).handler, request('POST', {
      inviteToken: 'dsh_invite_secret-1234567890',
    }))

    const failed = await response(route(routes, TEAM_MANAGEMENT_JOIN_PATH).handler, request('POST', {
      joinHandle: preview.body.joinHandle, displayName: 'Edison',
    }))
    expect(failed.status).toBe(502)
    expect(credentials.value).toBeUndefined()
    expect(credentials.get('DSH_CODEX_SHARED_POOL_TEAM_API_KEY_PENDING_JOIN')).toBeDefined()

    const status = await response(route(routes, TEAM_MANAGEMENT_STATUS_PATH).handler, request('GET'))
    expect(status.body.pendingJoinConfigured).toBe(true)

    const recovered = await response(route(routes, TEAM_MANAGEMENT_JOIN_RECOVER_PATH).handler, request('POST', {}))
    expect(recovered).toMatchObject({ status: 200, body: { team: { id: 'team-1' }, member: { id: 'member-1' } } })
    expect(credentials.value).toMatch(/^dsh_team_/u)
    expect(credentials.get('DSH_CODEX_SHARED_POOL_TEAM_API_KEY_PENDING_JOIN')).toBeUndefined()
  })

  it('does not overwrite an unresolved pending join with a new invitation', async () => {
    const credentials = new FakeCredentials()
    const pending = JSON.stringify({
      version: 1,
      apiKey: 'dsh_team_pending-secret-1234567890',
      inviteToken: 'dsh_invite_original-secret-1234567890',
      displayName: 'Edison',
    })
    credentials.put('DSH_CODEX_SHARED_POOL_TEAM_API_KEY_PENDING_JOIN', pending)
    const fetch = vi.fn<typeof globalThis.fetch>()
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch)

    const result = await response(route(routes, TEAM_MANAGEMENT_JOIN_PATH).handler, request('POST', {
      joinHandle: `dsh_join_${'a'.repeat(43)}`, displayName: 'Another name',
    }))

    expect(result.status).toBe(409)
    expect(credentials.get('DSH_CODEX_SHARED_POOL_TEAM_API_KEY_PENDING_JOIN')).toBe(pending)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not register a Browser route that accepts a raw Team API key', () => {
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' })

    expect(routes.some(candidate => candidate.path === '/plugins/dsh-codex-shared-pool/team-client/connect')).toBe(false)
  })

  it('does not recover a pending join over a different active Team key', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_active-other-team-1234567890'
    const pending = JSON.stringify({
      version: 1,
      apiKey: 'dsh_team_pending-secret-1234567890',
      inviteToken: 'dsh_invite_original-secret-1234567890',
      displayName: 'Edison',
    })
    credentials.put('DSH_CODEX_SHARED_POOL_TEAM_API_KEY_PENDING_JOIN', pending)
    const fetch = vi.fn<typeof globalThis.fetch>()
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch)

    const result = await response(route(routes, TEAM_MANAGEMENT_JOIN_RECOVER_PATH).handler, request('POST', {}))

    expect(result.status).toBe(409)
    expect(credentials.value).toBe('dsh_team_active-other-team-1234567890')
    expect(credentials.get('DSH_CODEX_SHARED_POOL_TEAM_API_KEY_PENDING_JOIN')).toBe(pending)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('serializes discard behind an in-flight join and does not report a discarded active connection', async () => {
    let resolveJoin!: (value: Response) => void
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        teamName: 'Friends', label: '周末协作', expiresAt: Date.now() + 3_600_000, teamStatus: 'active',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockImplementationOnce(() => new Promise<Response>(resolve => {
        resolveJoin = resolve
      }))
    const { routes, credentials } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      new FakeCredentials(),
      fetch,
    )
    const preview = await response(route(routes, TEAM_MANAGEMENT_INVITES_PREVIEW_PATH).handler, request('POST', {
      inviteToken: 'dsh_invite_secret-1234567890',
    }))

    const joining = response(route(routes, TEAM_MANAGEMENT_JOIN_PATH).handler, request('POST', {
      joinHandle: preview.body.joinHandle, displayName: 'Edison',
    }))
    await vi.waitFor(() => { expect(fetch).toHaveBeenCalledTimes(2) })
    const discarding = response(route(routes, TEAM_MANAGEMENT_JOIN_DISCARD_PATH).handler, request('POST', {}))
    resolveJoin(new Response(JSON.stringify({ team: team(), member: member() }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }))

    await expect(joining).resolves.toMatchObject({ status: 201 })
    await expect(discarding).resolves.toMatchObject({ status: 409 })
    expect(credentials.value).toMatch(/^dsh_team_/u)
    expect(credentials.get('DSH_CODEX_SHARED_POOL_TEAM_API_KEY_PENDING_JOIN')).toBeUndefined()
  })

  it('leaves a remotely accepted pending membership before discarding its only local key', async () => {
    const credentials = new FakeCredentials()
    const pendingKey = 'dsh_team_pending-secret-1234567890'
    credentials.put('DSH_CODEX_SHARED_POOL_TEAM_API_KEY_PENDING_JOIN', JSON.stringify({
      version: 1,
      apiKey: pendingKey,
      inviteToken: 'dsh_invite_original-secret-1234567890',
      displayName: 'Edison',
    }))
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(overview()), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        member: { ...member(), role: 'member', status: 'removed' },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch)

    const result = await response(route(routes, TEAM_MANAGEMENT_JOIN_DISCARD_PATH).handler, request('POST', {}))

    expect(result).toMatchObject({ status: 200, body: { discarded: true } })
    expect(credentials.get('DSH_CODEX_SHARED_POOL_TEAM_API_KEY_PENDING_JOIN')).toBeUndefined()
    expect(fetch).toHaveBeenNthCalledWith(2,
      'https://pool.example/plugins/dsh-codex-shared-pool/team/members/leave',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: `Bearer ${pendingKey}` }),
      }),
    )
  })

  it('discards a pending join without touching the active Team key', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_active-secret-1234567890'
    credentials.put('DSH_CODEX_SHARED_POOL_TEAM_API_KEY_PENDING_JOIN', JSON.stringify({ pending: true }))
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials)

    const result = await response(route(routes, TEAM_MANAGEMENT_JOIN_DISCARD_PATH).handler, request('POST', {}))
    expect(result).toMatchObject({ status: 200, body: { discarded: true } })
    expect(credentials.value).toBe('dsh_team_active-secret-1234567890')
    expect(credentials.get('DSH_CODEX_SHARED_POOL_TEAM_API_KEY_PENDING_JOIN')).toBeUndefined()
  })

  it('returns a newly-created invite token intentionally, while keeping the Team key Host-only', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const mutationFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      invite: {
        id: 'invite-1', teamId: 'team-1', invitedByMemberId: 'member-1', label: '周末协作', status: 'pending', expiresAt: 5, createdAt: 3,
      },
      inviteToken: 'dsh_invite_share-this-once-1234567890',
      internal: 'drop-me',
    }), { status: 201, headers: { 'content-type': 'application/json' } }))
    const fetch = withOverviewPreflight(mutationFetch)
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch)

    const result = await response(
      route(routes, TEAM_MANAGEMENT_INVITES_PATH).handler,
      request('POST', withExpectedContext({ label: '周末协作', expiresInMs: 86_400_000 })),
    )
    expect(result.status).toBe(201)
    expect(result.body.inviteToken).toBe('dsh_invite_share-this-once-1234567890')
    expect(result.body).not.toHaveProperty('internal')
    expect(JSON.stringify(result.body)).not.toContain(String(credentials.value))
  })

  it('reveals an existing invite through the Host-only proxy and projects only the intended secret fields', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_owner-secret-1234567890'
    const mutationFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      inviteId: 'invite-1',
      inviteToken: 'dsh_invite_revealed-secret-1234567890',
      expiresAt: 86_400_003,
      internal: 'drop-me',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const fetch = withOverviewPreflight(mutationFetch)
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch)

    const result = await response(
      route(routes, TEAM_MANAGEMENT_INVITES_REVEAL_PATH).handler,
      request('POST', withExpectedContext({ inviteId: 'invite-1' })),
    )

    expect(result).toMatchObject({
      status: 200,
      headers: { 'cache-control': 'no-store' },
      body: {
        inviteId: 'invite-1',
        inviteToken: 'dsh_invite_revealed-secret-1234567890',
        expiresAt: 86_400_003,
      },
    })
    expect(result.body).not.toHaveProperty('internal')
    expect(JSON.stringify(result.body)).not.toContain(String(credentials.value))
    expect(fetch).toHaveBeenCalledWith(
      'https://pool.example/plugins/dsh-codex-shared-pool/team/invites/reveal',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ inviteId: 'invite-1' }),
        headers: expect.objectContaining({ authorization: `Bearer ${credentials.value}` }),
      }),
    )
  })

  it('proxies invite revocation without exposing the Host-owned Team key', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const mutationFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      invite: {
        id: 'invite-1', teamId: 'team-1', invitedByMemberId: 'member-1', label: '周末协作', status: 'revoked', expiresAt: 5, createdAt: 3,
      },
      internal: 'drop-me',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const fetch = withOverviewPreflight(mutationFetch)
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch)

    const result = await response(
      route(routes, TEAM_MANAGEMENT_INVITES_REVOKE_PATH).handler,
      request('POST', withExpectedContext({ inviteId: 'invite-1' })),
    )

    expect(result).toMatchObject({ status: 200, body: { invite: { id: 'invite-1', status: 'revoked' } } })
    expect(result.body).not.toHaveProperty('internal')
    expect(JSON.stringify(result.body)).not.toContain(String(credentials.value))
    expect(fetch).toHaveBeenCalledWith(
      'https://pool.example/plugins/dsh-codex-shared-pool/team/invites/revoke',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ inviteId: 'invite-1' }) }),
    )
  })

  it('does not register generic role mutation and still proxies member removal', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_owner-secret-1234567890'
    const mutationFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      member: { ...member(), id: 'member-2', role: 'member', status: 'removed' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const fetch = withOverviewPreflight(mutationFetch)
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch)

    expect(routes.some(route => route.path === '/plugins/dsh-codex-shared-pool/team-client/members/role')).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
    await expect(response(route(routes, TEAM_MANAGEMENT_MEMBERS_REMOVE_PATH).handler, request('POST', withExpectedContext({
      memberId: 'member-2',
    })))).resolves.toMatchObject({ status: 200, body: { member: { id: 'member-2', status: 'removed' } } })
  })

  it('rejects Browser attempts to write the Host-only daily Credits limit before fetching remote state', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_owner-secret-1234567890'
    const fetch = vi.fn<typeof globalThis.fetch>()
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch)

    await expect(response(route(routes, TEAM_MANAGEMENT_CONTRIBUTION_UPDATE_PATH).handler, request('POST', {
      accountId: 'account-1',
      dailySharedCreditLimit: 424_242,
    }))).resolves.toMatchObject({ status: 400 })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('adds a Host-owned operation id while forwarding the Browser lifecycle revision', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_owner-secret-1234567890'
    let remoteBody: Record<string, unknown> | undefined
    const mutationFetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      remoteBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ team: { ...team(), status: 'paused', lifecycleRevision: 8 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const fetch = withOverviewPreflight(mutationFetch)
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
    )

    const result = await response(
      route(routes, TEAM_MANAGEMENT_TEAM_STATUS_PATH).handler,
      request('POST', withExpectedContext({ status: 'paused', expectedLifecycleRevision: 7 })),
    )

    expect(result).toMatchObject({
      status: 200,
      body: { team: { status: 'paused', lifecycleRevision: 8 } },
    })
    expect(remoteBody).toEqual({
      status: 'paused',
      expectedLifecycleRevision: 7,
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    })
  })

  it.each([
    {
      operation: 'invite creation',
      path: TEAM_MANAGEMENT_INVITES_PATH,
      body: { label: '周末协作', expiresInMs: 86_400_000 },
    },
    {
      operation: 'Team status change',
      path: TEAM_MANAGEMENT_TEAM_STATUS_PATH,
      body: { status: 'paused', expectedLifecycleRevision: 7 },
    },
    {
      operation: 'Team dissolution',
      path: TEAM_MANAGEMENT_DISSOLVE_PATH,
      body: { confirmationName: 'Friends', expectedLifecycleRevision: 7 },
    },
    {
      operation: 'ownership-transfer acceptance',
      path: TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_ACCEPT_PATH,
      body: { transferId: 'transfer-1' },
    },
    {
      operation: 'ownership-transfer revocation',
      path: TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_REVOKE_PATH,
      body: { transferId: 'transfer-1' },
    },
    {
      operation: 'Team departure',
      path: TEAM_MANAGEMENT_LEAVE_PATH,
      body: {},
    },
  ])(
    'rejects $operation when the local credential now belongs to another Team',
    async ({ path, body }) => {
      const credentials = new FakeCredentials()
      credentials.value = 'dsh_team_owner-a-secret-1234567890'
      const replacementKey = 'dsh_team_owner-b-secret-1234567890'
      const replacementOwner = { ...member(), id: 'member-9', teamId: 'team-2' }
      const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
        if (String(input) === 'https://pool.example/plugins/dsh-codex-shared-pool/team/overview') {
          return new Response(JSON.stringify(overview({
            team: { ...team(), id: 'team-2' },
            currentMember: replacementOwner,
            members: [replacementOwner],
            apiKeys: [{
              id: 'key-9', teamId: 'team-2', memberId: 'member-9', label: 'owner', prefix: 'dsh_team_owner_b', createdAt: 1,
            }],
          })), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        throw new Error(`unexpected remote mutation: ${String(input)}`)
      })
      const { routes } = setup(
        { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
        credentials,
        fetch,
      )
      credentials.value = replacementKey

      const result = await response(route(routes, path).handler, request('POST', {
        ...body,
        expectedContext: {
          serverOrigin: 'https://pool.example',
          teamId: 'team-1',
          currentMemberId: 'member-1',
        },
      }))

      expect(result).toMatchObject({ status: 409 })
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(fetch).toHaveBeenCalledWith(
        'https://pool.example/plugins/dsh-codex-shared-pool/team/overview',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({ authorization: `Bearer ${replacementKey}` }),
        }),
      )
      expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
      expect(credentials.value).toBe(replacementKey)
      expect(credentials.sets).toHaveLength(0)
      expect(credentials.unsets).toHaveLength(0)
      expect(credentials.get(DISSOLUTION_PENDING_REF)).toBeUndefined()
    },
  )

  it('can revoke the current remote key before removing the local credential', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const mutationFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const fetch = withOverviewPreflight(mutationFetch)
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch)

    const result = await response(
      route(routes, TEAM_MANAGEMENT_DISCONNECT_PATH).handler,
      request('POST', withExpectedContext({ revokeRemote: true })),
    )
    expect(result).toMatchObject({ status: 200, body: { disconnected: true, remoteRevoked: true } })
    expect(credentials.unsets).toHaveLength(1)
    expect(fetch).toHaveBeenCalledWith(
      'https://pool.example/plugins/dsh-codex-shared-pool/team/keys/current/revoke',
      expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer dsh_team_member-secret-1234567890' }) }),
    )
  })

  it('refuses to delete a locally configured key while the remote Team identity is still valid', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(overview()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
    )

    const result = await response(
      route(routes, TEAM_MANAGEMENT_DISCONNECT_PATH).handler,
      request('POST', { revokeRemote: false }),
    )

    expect(result).toMatchObject({ status: 400 })
    expect(credentials.value).toBe('dsh_team_member-secret-1234567890')
    expect(credentials.unsets).toHaveLength(0)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('never deletes a replacement Team key after a stale local-only disconnect receives 401', async () => {
    const credentials = new FakeCredentials()
    const staleKey = 'dsh_team_stale-member-secret-1234567890'
    const replacementKey = 'dsh_team_replacement-member-secret-1234567890'
    credentials.value = staleKey
    let resolveOverview!: (value: Response) => void
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockImplementationOnce(() => new Promise<Response>(resolve => {
        resolveOverview = resolve
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'not terminal' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }))
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
    )

    const disconnecting = response(
      route(routes, TEAM_MANAGEMENT_DISCONNECT_PATH).handler,
      request('POST', { revokeRemote: false }),
    )
    await vi.waitFor(() => { expect(fetch).toHaveBeenCalledTimes(1) })
    credentials.value = replacementKey
    resolveOverview(new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }))

    await expect(disconnecting).resolves.toMatchObject({
      status: 200,
      body: { disconnected: true, remoteRevoked: false },
    })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch).toHaveBeenNthCalledWith(1,
      'https://pool.example/plugins/dsh-codex-shared-pool/team/overview',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: `Bearer ${staleKey}` }),
      }),
    )
    expect(fetch).toHaveBeenNthCalledWith(2,
      `https://pool.example${TEAM_CONNECTION_TERMINAL_PATH}`,
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: `Bearer ${staleKey}` }),
      }),
    )
    expect(credentials.value).toBe(replacementKey)
    expect(credentials.unsets).toHaveLength(0)
  })

  it('leaves the remote Team before removing the local credential', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const mutationFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      member: { ...member(), role: 'member', status: 'removed' },
      contributions: [{ ...contribution(), status: 'revoked', refreshToken: 'must-not-cross' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const fetch = withOverviewPreflight(mutationFetch)
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch)

    const result = await response(
      route(routes, TEAM_MANAGEMENT_LEAVE_PATH).handler,
      request('POST', withExpectedContext({})),
    )

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

  it('creates a pending ownership transfer without changing either role', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_owner-secret-1234567890'
    const mutationFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(ownershipTransfer()), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    const fetch = withOverviewPreflight(mutationFetch)
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch)

    const result = await response(
      route(routes, TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_PATH).handler,
      request('POST', withExpectedContext({ targetMemberId: 'member-2' })),
    )

    expect(result).toMatchObject({
      status: 200,
      body: { id: 'transfer-1', status: 'pending', requestedByMemberId: 'member-1', targetMemberId: 'member-2' },
    })
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

  it('proxies target acceptance, rejection, and Owner revocation through distinct routes', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_owner-secret-1234567890'
    const mutationFetch = vi.fn<typeof globalThis.fetch>(async input => {
      const path = String(input)
      if (path.endsWith('/ownership/transfer/accept')) {
        return new Response(JSON.stringify({
          transfer: ownershipTransfer('accepted'),
          formerOwner: { ...member(), role: 'member' },
          owner: { ...member(), id: 'member-2', displayName: 'Friend', role: 'owner' },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (path.endsWith('/ownership/transfer/reject')) {
        return new Response(JSON.stringify(ownershipTransfer('rejected')), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (path.endsWith('/ownership/transfer/revoke')) {
        return new Response(JSON.stringify(ownershipTransfer('revoked')), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`unexpected path ${path}`)
    })
    const fetch = withOverviewPreflight(mutationFetch)
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch)

    await expect(response(route(routes, TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_ACCEPT_PATH).handler, request('POST', withExpectedContext({ transferId: 'transfer-1' }))))
      .resolves.toMatchObject({ status: 200, body: { transfer: { status: 'accepted' }, formerOwner: { role: 'member' }, owner: { role: 'owner' } } })
    await expect(response(route(routes, TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_REJECT_PATH).handler, request('POST', withExpectedContext({ transferId: 'transfer-1' }))))
      .resolves.toMatchObject({ status: 200, body: { status: 'rejected' } })
    await expect(response(route(routes, TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_REVOKE_PATH).handler, request('POST', withExpectedContext({ transferId: 'transfer-1' }))))
      .resolves.toMatchObject({ status: 200, body: { status: 'revoked' } })
    expect(fetch).toHaveBeenCalledTimes(6)
  })

  it('rejects malformed local and remote ownership-transfer requests', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_owner-secret-1234567890'
    const mutationFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      ...ownershipTransfer(),
      recoverySecret: 'must-not-cross',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const fetch = withOverviewPreflight(mutationFetch)
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch)
    const transfer = route(routes, TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_PATH)

    await expect(response(transfer.handler, request('POST', { targetMemberId: 'member-2', unknown: true })))
      .resolves.toMatchObject({ status: 400 })
    await expect(response(transfer.handler, request('POST', withExpectedContext({ targetMemberId: 'member-2' }))))
      .resolves.toMatchObject({ status: 502 })
  })

  it('retains the local key when remote Team departure fails', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_owner-secret-1234567890'
    const mutationFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      error: 'Team owner cannot leave before ownership transfer is available',
    }), { status: 409, headers: { 'content-type': 'application/json' } }))
    const fetch = withOverviewPreflight(mutationFetch)
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch)

    const result = await response(
      route(routes, TEAM_MANAGEMENT_LEAVE_PATH).handler,
      request('POST', withExpectedContext({})),
    )

    expect(result.status).not.toBe(200)
    expect(credentials.value).toBe('dsh_team_owner-secret-1234567890')
    expect(credentials.unsets).toHaveLength(0)
  })

  it('retains the local key when the remote response does not prove departure', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const mutationFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      member: member(),
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const fetch = withOverviewPreflight(mutationFetch)
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch)

    const result = await response(
      route(routes, TEAM_MANAGEMENT_LEAVE_PATH).handler,
      request('POST', withExpectedContext({})),
    )

    expect(result.status).not.toBe(200)
    expect(credentials.value).toBe('dsh_team_member-secret-1234567890')
    expect(credentials.unsets).toHaveLength(0)
  })

  it('diagnoses a dissolved Team after an old key receives 401 and persists a secret-free local terminal', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_old-owner-secret-1234567890'
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'team_dissolved' }), {
        status: 410,
        headers: { 'content-type': 'application/json' },
      }))
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
    )

    const rejected = await response(route(routes, TEAM_MANAGEMENT_OVERVIEW_PATH).handler, request('GET'))
    const projected = await response(route(routes, TEAM_MANAGEMENT_STATUS_PATH).handler, request('GET'))

    expect(rejected.status).toBe(410)
    expect(fetch).toHaveBeenNthCalledWith(2,
      `https://pool.example${TEAM_CONNECTION_TERMINAL_PATH}`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer dsh_team_old-owner-secret-1234567890' }),
      }),
    )
    expect(credentials.value).toBeUndefined()
    expect(projected.body).toMatchObject({
      keyConfigured: false,
      dissolution: { state: 'confirmed', localCleanup: 'completed' },
    })
    expect(projected.body.dissolution).not.toHaveProperty('teamName')
    expect(projected.body.dissolution).not.toHaveProperty('dissolvedAt')
    expect(JSON.stringify(projected.body)).not.toContain('team_dissolved')
    expect(JSON.stringify(credentials.get(DISSOLUTION_TERMINAL_REF))).not.toContain('dsh_team_old-owner-secret')
    expect(JSON.parse(credentials.get(DISSOLUTION_KEY_DIGEST_REF)!)).toEqual({
      version: 1,
      keySha256: createHash('sha256').update('dsh_team_old-owner-secret-1234567890').digest('hex'),
    })
  })

  it.each(['member_removed', 'member_left', 'device_revoked'] as const)(
    'persists the secret-free %s connection terminal without pretending the Team was dissolved',
    async code => {
      const credentials = new FakeCredentials()
      credentials.value = 'dsh_team_old-member-secret-1234567890'
      const fetch = vi.fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ code }), {
          status: 410,
          headers: { 'content-type': 'application/json' },
        }))
      const { routes } = setup(
        { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
        credentials,
        fetch,
      )

      const rejected = await response(route(routes, TEAM_MANAGEMENT_OVERVIEW_PATH).handler, request('GET'))
      const projected = await response(route(routes, TEAM_MANAGEMENT_STATUS_PATH).handler, request('GET'))

      expect(rejected.status).toBe(410)
      expect(credentials.value).toBeUndefined()
      expect(projected.body).toMatchObject({
        keyConfigured: false,
        connectionTerminal: { code, localCleanup: 'completed' },
      })
      expect(projected.body).not.toHaveProperty('dissolution')
      expect(JSON.parse(credentials.get(CONNECTION_TERMINAL_REF)!)).toEqual({
        version: 1,
        code,
        localCleanup: 'completed',
      })
      expect(JSON.stringify(credentials.get(CONNECTION_TERMINAL_REF)))
        .not.toMatch(/dsh_team_|operationId|recoverySecret|teamId|memberId|keyId/iu)
    },
  )

  it('forgets a completed connection terminal locally and then permits a fresh Team join flow', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_old-member-secret-1234567890'
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401, headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'member_removed' }), {
        status: 410, headers: { 'content-type': 'application/json' },
      }))
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
    )

    await response(route(routes, TEAM_MANAGEMENT_OVERVIEW_PATH).handler, request('GET'))
    const cleared = await response(
      route(routes, TEAM_MANAGEMENT_CONNECTION_TERMINAL_CLEAR_PATH).handler,
      request('POST', {}),
    )
    const status = await response(route(routes, TEAM_MANAGEMENT_STATUS_PATH).handler, request('GET'))

    expect(cleared).toMatchObject({ status: 200, body: { cleared: true } })
    expect(credentials.get(CONNECTION_TERMINAL_REF)).toBeUndefined()
    expect(credentials.get(CONNECTION_TERMINAL_KEY_DIGEST_REF)).toBeUndefined()
    expect(status.body).not.toHaveProperty('connectionTerminal')
    expect(status.body).not.toHaveProperty('dissolution')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('never deletes a replacement Team key while retrying cleanup for an older terminal', async () => {
    const credentials = new FakeCredentials()
    const oldKey = 'dsh_team_old-member-secret-1234567890'
    const replacementKey = 'dsh_team_new-member-secret-1234567890'
    credentials.value = oldKey
    const originalUnset = credentials.unset.bind(credentials)
    let oldKeyUnsetAttempts = 0
    vi.spyOn(credentials, 'unset').mockImplementation(async ref => {
      if (String(ref) === TEAM_KEY_REF && credentials.value === oldKey && oldKeyUnsetAttempts++ === 0) {
        throw new Error('keychain unavailable')
      }
      await originalUnset(ref)
    })
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401, headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'device_revoked' }), {
        status: 410, headers: { 'content-type': 'application/json' },
      }))
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch,
    )

    await response(route(routes, TEAM_MANAGEMENT_OVERVIEW_PATH).handler, request('GET'))
    expect(JSON.parse(credentials.get(CONNECTION_TERMINAL_REF)!)).toMatchObject({ localCleanup: 'retry_required' })
    credentials.value = replacementKey

    const retried = await response(
      route(routes, TEAM_MANAGEMENT_CONNECTION_TERMINAL_CLEAR_PATH).handler,
      request('POST', {}),
    )
    expect(retried).toMatchObject({
      status: 200,
      body: { code: 'device_revoked', localCleanup: 'completed' },
    })
    expect(credentials.value).toBe(replacementKey)

    const dismissed = await response(
      route(routes, TEAM_MANAGEMENT_CONNECTION_TERMINAL_CLEAR_PATH).handler,
      request('POST', {}),
    )
    expect(dismissed).toMatchObject({ status: 200, body: { cleared: true } })
    expect(credentials.value).toBe(replacementKey)
    expect(credentials.get(CONNECTION_TERMINAL_REF)).toBeUndefined()
    expect(credentials.get(CONNECTION_TERMINAL_KEY_DIGEST_REF)).toBeUndefined()
  })

  it.each([
    ['missing', undefined],
    ['damaged', JSON.stringify({ version: 1, keySha256: 'not-a-sha256-digest' })],
  ] as const)(
    'fails closed when a %s connection-terminal key digest cannot bind cleanup to the old key',
    async (_label, keyDigest) => {
      const credentials = new FakeCredentials()
      const replacementKey = 'dsh_team_replacement-member-secret-1234567890'
      credentials.value = replacementKey
      credentials.put(CONNECTION_TERMINAL_REF, JSON.stringify({
        version: 1,
        code: 'device_revoked',
        localCleanup: 'retry_required',
      }))
      if (keyDigest !== undefined) credentials.put(CONNECTION_TERMINAL_KEY_DIGEST_REF, keyDigest)
      const { routes } = setup(
        { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
        credentials,
      )

      const retried = await response(
        route(routes, TEAM_MANAGEMENT_CONNECTION_TERMINAL_CLEAR_PATH).handler,
        request('POST', {}),
      )

      expect(retried).toMatchObject({
        status: 200,
        body: { code: 'device_revoked', localCleanup: 'manual_required' },
      })
      expect(credentials.value).toBe(replacementKey)
      expect(credentials.unsets.map(String)).not.toContain(TEAM_KEY_REF)
      expect(JSON.parse(credentials.get(CONNECTION_TERMINAL_REF)!)).toMatchObject({
        code: 'device_revoked',
        localCleanup: 'manual_required',
      })
    },
  )

  it('durably journals a Host-owned recovery secret before dissolution and persists a secret-free terminal before ACK', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_owner-secret-1234567890'
    const setSpy = vi.spyOn(credentials, 'set')
    let dissolveBody: Record<string, unknown> | undefined
    let ackBody: Record<string, unknown> | undefined
    const mutationFetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      if (String(input).endsWith(TEAM_DISSOLVE_PATH)) {
        dissolveBody = body
        return new Response(JSON.stringify(dissolutionResult(String(body.operationId))), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      if (String(input).endsWith(TEAM_DISSOLVE_ACK_PATH)) {
        ackBody = body
        return new Response(JSON.stringify({ ok: true }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected request: ${String(input)}`)
    })
    const fetch = withOverviewPreflight(mutationFetch)
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
      { now: () => 1_800_000_000_000 },
    )

    const result = await response(route(routes, TEAM_MANAGEMENT_DISSOLVE_PATH).handler, request('POST', withExpectedContext({
      confirmationName: 'Friends',
      expectedLifecycleRevision: 7,
    })))

    expect(result).toEqual({
      status: 200,
      headers: expect.objectContaining({ 'cache-control': 'no-store' }),
      body: {
        state: 'confirmed',
        teamName: 'Friends',
        dissolvedAt: 1_800_000_000_100,
        localCleanup: 'completed',
      },
    })
    const pendingWriteIndex = credentials.sets.findIndex(write => String(write.ref) === DISSOLUTION_PENDING_REF)
    const terminalWriteIndex = credentials.sets.findIndex(write => String(write.ref) === DISSOLUTION_TERMINAL_REF)
    expect(pendingWriteIndex).toBeGreaterThanOrEqual(0)
    expect(terminalWriteIndex).toBeGreaterThanOrEqual(0)
    const pending = JSON.parse(credentials.sets[pendingWriteIndex]!.value) as Record<string, unknown>
    expect(pending).toMatchObject({
      version: 1,
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      teamName: 'Friends',
      expectedLifecycleRevision: 7,
      requestedAt: 1_800_000_000_000,
      recoverySecret: expect.any(String),
    })
    expect(Buffer.from(String(pending.recoverySecret), 'base64url').byteLength).toBeGreaterThanOrEqual(32)
    expect(dissolveBody).toEqual({
      operationId: pending.operationId,
      expectedLifecycleRevision: 7,
      confirmationName: 'Friends',
      recoverySecretHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    })
    expect(dissolveBody?.recoverySecretHash).not.toBe(pending.recoverySecret)
    expect(ackBody).toEqual({ operationId: pending.operationId, recoverySecret: pending.recoverySecret })
    expect(fetch.mock.calls[2]?.[1]?.headers).not.toEqual(expect.objectContaining({ authorization: expect.anything() }))
    expect(setSpy.mock.invocationCallOrder[pendingWriteIndex]!).toBeLessThan(fetch.mock.invocationCallOrder[1]!)
    expect(setSpy.mock.invocationCallOrder[terminalWriteIndex]!).toBeLessThan(fetch.mock.invocationCallOrder[2]!)
    expect(credentials.get(DISSOLUTION_PENDING_REF)).toBeUndefined()
    expect(credentials.value).toBeUndefined()
    expect(JSON.stringify(credentials.get(DISSOLUTION_TERMINAL_REF))).not.toMatch(/recoverySecret|operationId/iu)
    expect(JSON.stringify(result.body)).not.toMatch(/recoverySecret|operationId|revokedKeyCount/iu)
  })

  it('survives an uncertain response and recovers after a Host restart with the same operation and secret', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_owner-secret-1234567890'
    const mutationFetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError('socket closed'))
    const firstFetch = withOverviewPreflight(mutationFetch)
    const first = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      firstFetch,
      { now: () => 1_800_000_000_000 },
    )

    const uncertain = await response(route(first.routes, TEAM_MANAGEMENT_DISSOLVE_PATH).handler, request('POST', withExpectedContext({
      confirmationName: 'Friends', expectedLifecycleRevision: 7,
    })))
    expect(uncertain).toMatchObject({
      status: 202,
      body: { state: 'confirming', teamName: 'Friends', requestedAt: 1_800_000_000_000 },
    })
    const pendingText = credentials.get(DISSOLUTION_PENDING_REF)
    expect(pendingText).toBeDefined()
    const pending = JSON.parse(pendingText!) as Record<string, unknown>
    expect(credentials.value).toBe('dsh_team_owner-secret-1234567890')
    const projected = await response(route(first.routes, TEAM_MANAGEMENT_STATUS_PATH).handler, request('GET'))
    expect(projected.body).toMatchObject({ dissolution: uncertain.body })
    expect(JSON.stringify(projected.body)).not.toContain(String(pending.recoverySecret))

    let replayBody: Record<string, unknown> | undefined
    let recoveryBody: Record<string, unknown> | undefined
    const secondFetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      if (String(input).endsWith(TEAM_DISSOLVE_RESULT_PATH)) {
        recoveryBody = body
        return new Response(JSON.stringify({ error: 'not found' }), {
          status: 404, headers: { 'content-type': 'application/json' },
        })
      }
      if (String(input).endsWith(TEAM_DISSOLVE_PATH)) {
        replayBody = body
        return new Response(JSON.stringify(dissolutionResult(String(body.operationId))), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      if (String(input).endsWith(TEAM_DISSOLVE_ACK_PATH)) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected request: ${String(input)}`)
    })
    const restarted = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      secondFetch,
      { now: () => 1_800_000_000_500 },
    )
    const recovered = await response(
      route(restarted.routes, TEAM_MANAGEMENT_DISSOLUTION_RECOVER_PATH).handler,
      request('POST', {}),
    )

    expect(recovered).toMatchObject({
      status: 200,
      body: { state: 'confirmed', teamName: 'Friends', localCleanup: 'completed' },
    })
    expect(recoveryBody).toEqual({
      operationId: pending.operationId,
      recoverySecret: pending.recoverySecret,
    })
    expect(replayBody).toMatchObject({
      operationId: pending.operationId,
      confirmationName: 'Friends',
      expectedLifecycleRevision: 7,
    })
    expect(replayBody?.recoverySecretHash).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('does not replay a pending dissolution with a replacement Team key', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_owner-secret-1234567890'
    const first = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      withOverviewPreflight(vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError('socket closed'))),
      { now: () => 1_800_000_000_000 },
    )
    await response(route(first.routes, TEAM_MANAGEMENT_DISSOLVE_PATH).handler, request('POST', withExpectedContext({
      confirmationName: 'Friends', expectedLifecycleRevision: 7,
    })))
    const pending = credentials.get(DISSOLUTION_PENDING_REF)
    const keyDigest = credentials.get(DISSOLUTION_KEY_DIGEST_REF)
    expect(pending).toBeDefined()
    expect(keyDigest).toBeDefined()

    const replacementKey = 'dsh_team_replacement-owner-secret-1234567890'
    credentials.value = replacementKey
    const fetch = vi.fn<typeof globalThis.fetch>(async input => {
      if (String(input).endsWith(TEAM_DISSOLVE_RESULT_PATH)) {
        return new Response(JSON.stringify({ error: 'not found' }), {
          status: 404, headers: { 'content-type': 'application/json' },
        })
      }
      if (String(input).endsWith(TEAM_DISSOLVE_PATH)) {
        return new Response(JSON.stringify(dissolutionResult()), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected request: ${String(input)}`)
    })
    const restarted = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
    )

    const recovered = await response(
      route(restarted.routes, TEAM_MANAGEMENT_DISSOLUTION_RECOVER_PATH).handler,
      request('POST', {}),
    )

    expect(recovered).toMatchObject({
      status: 202,
      body: { state: 'confirming', teamName: 'Friends' },
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(String(fetch.mock.calls[0]?.[0])).toMatch(new RegExp(`${TEAM_DISSOLVE_RESULT_PATH}$`, 'u'))
    expect(credentials.value).toBe(replacementKey)
    expect(credentials.get(DISSOLUTION_PENDING_REF)).toBe(pending)
    expect(credentials.get(DISSOLUTION_KEY_DIGEST_REF)).toBe(keyDigest)
    expect(credentials.get(DISSOLUTION_TERMINAL_REF)).toBeUndefined()
  })

  it.each([
    ['missing', undefined],
    ['damaged', '{not-json'],
  ] as const)('does not replay a pending dissolution when its key digest is %s', async (_label, storedDigest) => {
    const credentials = new FakeCredentials()
    const ownerKey = 'dsh_team_owner-secret-1234567890'
    credentials.value = ownerKey
    const first = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      withOverviewPreflight(vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError('socket closed'))),
      { now: () => 1_800_000_000_000 },
    )
    await response(route(first.routes, TEAM_MANAGEMENT_DISSOLVE_PATH).handler, request('POST', withExpectedContext({
      confirmationName: 'Friends', expectedLifecycleRevision: 7,
    })))
    const pending = credentials.get(DISSOLUTION_PENDING_REF)
    expect(pending).toBeDefined()
    if (storedDigest === undefined) await credentials.unset(DISSOLUTION_KEY_DIGEST_REF as CredentialRef)
    else credentials.put(DISSOLUTION_KEY_DIGEST_REF, storedDigest)

    const fetch = vi.fn<typeof globalThis.fetch>(async input => {
      if (String(input).endsWith(TEAM_DISSOLVE_RESULT_PATH)) {
        return new Response(JSON.stringify({ error: 'not found' }), {
          status: 404, headers: { 'content-type': 'application/json' },
        })
      }
      if (String(input).endsWith(TEAM_DISSOLVE_PATH)) {
        return new Response(JSON.stringify(dissolutionResult()), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected request: ${String(input)}`)
    })
    const restarted = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
    )

    const recovered = await response(
      route(restarted.routes, TEAM_MANAGEMENT_DISSOLUTION_RECOVER_PATH).handler,
      request('POST', {}),
    )

    expect(recovered).toMatchObject({
      status: 202,
      body: { state: 'confirming', teamName: 'Friends' },
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(String(fetch.mock.calls[0]?.[0])).toMatch(new RegExp(`${TEAM_DISSOLVE_RESULT_PATH}$`, 'u'))
    expect(credentials.value).toBe(ownerKey)
    expect(credentials.get(DISSOLUTION_PENDING_REF)).toBe(pending)
    expect(credentials.get(DISSOLUTION_KEY_DIGEST_REF)).toBe(storedDigest)
    expect(credentials.get(DISSOLUTION_TERMINAL_REF)).toBeUndefined()
  })

  it('persists only a coarse terminal when restart recovery proves dissolution', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_owner-secret-1234567890'
    const first = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      withOverviewPreflight(vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError('socket closed'))),
      { now: () => 1_800_000_000_000 },
    )
    await response(route(first.routes, TEAM_MANAGEMENT_DISSOLVE_PATH).handler, request('POST', withExpectedContext({
      confirmationName: 'Friends', expectedLifecycleRevision: 7,
    })))

    const fetch = vi.fn<typeof globalThis.fetch>(async input => {
      if (String(input).endsWith(TEAM_DISSOLVE_RESULT_PATH)) {
        return new Response(JSON.stringify({ operationType: 'team_dissolution', status: 'dissolved' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      if (String(input).endsWith(TEAM_DISSOLVE_ACK_PATH)) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected request: ${String(input)}`)
    })
    const restarted = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
    )

    const recovered = await response(
      route(restarted.routes, TEAM_MANAGEMENT_DISSOLUTION_RECOVER_PATH).handler,
      request('POST', {}),
    )

    expect(recovered).toEqual({
      status: 200,
      headers: expect.anything(),
      body: { state: 'confirmed', localCleanup: 'completed' },
    })
    expect(JSON.parse(credentials.get(DISSOLUTION_TERMINAL_REF)!)).toEqual({
      version: 2, state: 'confirmed', localCleanup: 'completed',
    })
    expect(JSON.stringify(recovered.body)).not.toMatch(/Friends|teamName|dissolvedAt|operationId|recoverySecret/iu)
    expect(credentials.get(DISSOLUTION_PENDING_REF)).toBeUndefined()
    expect(credentials.value).toBeUndefined()
  })

  it('keeps the pending secret until ACK when replay diagnoses a committed dissolution', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_owner-secret-1234567890'
    const first = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      withOverviewPreflight(vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError('socket closed'))),
      { now: () => 1_800_000_000_000 },
    )
    await response(route(first.routes, TEAM_MANAGEMENT_DISSOLVE_PATH).handler, request('POST', withExpectedContext({
      confirmationName: 'Friends', expectedLifecycleRevision: 7,
    })))
    const pending = JSON.parse(credentials.get(DISSOLUTION_PENDING_REF)!) as Record<string, unknown>
    let acknowledgedBody: Record<string, unknown> | undefined
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input)
      if (url.endsWith(TEAM_DISSOLVE_RESULT_PATH)) {
        return new Response(JSON.stringify({ error: 'not found' }), {
          status: 404, headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith(TEAM_DISSOLVE_PATH)) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401, headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith(TEAM_CONNECTION_TERMINAL_PATH)) {
        return new Response(JSON.stringify({ code: 'team_dissolved' }), {
          status: 410, headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith(TEAM_DISSOLVE_ACK_PATH)) {
        acknowledgedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        expect(credentials.get(DISSOLUTION_PENDING_REF)).toBeDefined()
        return new Response(JSON.stringify({ ok: true }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected request: ${url}`)
    })
    const restarted = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
    )

    const recovered = await response(
      route(restarted.routes, TEAM_MANAGEMENT_DISSOLUTION_RECOVER_PATH).handler,
      request('POST', {}),
    )

    expect(recovered).toMatchObject({
      status: 200,
      body: { state: 'confirmed', localCleanup: 'completed' },
    })
    expect(acknowledgedBody).toEqual({
      operationId: pending.operationId,
      recoverySecret: pending.recoverySecret,
    })
    expect(credentials.get(DISSOLUTION_PENDING_REF)).toBeUndefined()
    expect(credentials.value).toBeUndefined()
  })

  it.each([403, 409])('clears the abandoned dissolution journal after a definite %i rejection', async remoteStatus => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_owner-secret-1234567890'
    const mutationFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      error: remoteStatus === 403 ? 'only the Owner may dissolve this Team' : 'Team lifecycle changed',
    }), { status: remoteStatus, headers: { 'content-type': 'application/json' } }))
    const fetch = withOverviewPreflight(mutationFetch)
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
    )

    const rejected = await response(route(routes, TEAM_MANAGEMENT_DISSOLVE_PATH).handler, request('POST', withExpectedContext({
      confirmationName: 'Friends', expectedLifecycleRevision: 7,
    })))

    expect(rejected.status).toBe(remoteStatus)
    expect(credentials.get(DISSOLUTION_PENDING_REF)).toBeUndefined()
    expect(credentials.get(DISSOLUTION_KEY_DIGEST_REF)).toBeUndefined()
    expect(credentials.get(DISSOLUTION_TERMINAL_REF)).toBeUndefined()
    expect(credentials.value).toBe('dsh_team_owner-secret-1234567890')
  })

  it('reports retryable local cleanup after a committed dissolution and retries without replaying the remote operation', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_owner-secret-1234567890'
    const originalUnset = credentials.unset.bind(credentials)
    let keyUnsetAttempts = 0
    vi.spyOn(credentials, 'unset').mockImplementation(async ref => {
      if (String(ref) === TEAM_KEY_REF && keyUnsetAttempts++ === 0) throw new Error('keychain unavailable')
      await originalUnset(ref)
    })
    const mutationFetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (String(input).endsWith(TEAM_DISSOLVE_PATH)) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(JSON.stringify(dissolutionResult(String(body.operationId))), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    })
    const fetch = withOverviewPreflight(mutationFetch)
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch,
    )

    const committed = await response(route(routes, TEAM_MANAGEMENT_DISSOLVE_PATH).handler, request('POST', withExpectedContext({
      confirmationName: 'Friends', expectedLifecycleRevision: 7,
    })))
    expect(committed).toMatchObject({ status: 200, body: { state: 'confirmed', localCleanup: 'retry_required' } })
    expect(credentials.value).toBeDefined()

    const cleared = await response(
      route(routes, TEAM_MANAGEMENT_DISSOLUTION_CLEAR_PATH).handler,
      request('POST', {}),
    )
    expect(cleared).toMatchObject({ status: 200, body: { state: 'confirmed', localCleanup: 'completed' } })
    expect(credentials.value).toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('dismisses a completed dissolution terminal locally without another remote request', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_owner-secret-1234567890'
    const mutationFetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (String(input).endsWith(TEAM_DISSOLVE_PATH)) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(JSON.stringify(dissolutionResult(String(body.operationId))), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    })
    const fetch = withOverviewPreflight(mutationFetch)
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch,
    )

    const committed = await response(route(routes, TEAM_MANAGEMENT_DISSOLVE_PATH).handler, request('POST', withExpectedContext({
      confirmationName: 'Friends', expectedLifecycleRevision: 7,
    })))
    expect(committed).toMatchObject({ status: 200, body: { state: 'confirmed', localCleanup: 'completed' } })
    expect(credentials.get(DISSOLUTION_KEY_DIGEST_REF)).toBeDefined()
    const remoteCallsBeforeDismiss = fetch.mock.calls.length

    const dismissed = await response(
      route(routes, TEAM_MANAGEMENT_DISSOLUTION_CLEAR_PATH).handler,
      request('POST', {}),
    )

    expect(dismissed).toMatchObject({ status: 200, body: { cleared: true } })
    expect(credentials.get(DISSOLUTION_TERMINAL_REF)).toBeUndefined()
    expect(credentials.get(DISSOLUTION_KEY_DIGEST_REF)).toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(remoteCallsBeforeDismiss)
  })

  it('never deletes a replacement Team key while retrying cleanup for a dissolved Team', async () => {
    const credentials = new FakeCredentials()
    const oldKey = 'dsh_team_old-owner-secret-1234567890'
    const replacementKey = 'dsh_team_new-member-secret-1234567890'
    credentials.value = oldKey
    const originalUnset = credentials.unset.bind(credentials)
    let oldKeyUnsetAttempts = 0
    vi.spyOn(credentials, 'unset').mockImplementation(async ref => {
      if (String(ref) === TEAM_KEY_REF && credentials.value === oldKey && oldKeyUnsetAttempts++ === 0) {
        throw new Error('keychain unavailable')
      }
      await originalUnset(ref)
    })
    const mutationFetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (String(input).endsWith(TEAM_DISSOLVE_PATH)) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(JSON.stringify(dissolutionResult(String(body.operationId))), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    })
    const fetch = withOverviewPreflight(mutationFetch)
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch,
    )

    const committed = await response(route(routes, TEAM_MANAGEMENT_DISSOLVE_PATH).handler, request('POST', withExpectedContext({
      confirmationName: 'Friends', expectedLifecycleRevision: 7,
    })))
    expect(committed).toMatchObject({ status: 200, body: { state: 'confirmed', localCleanup: 'retry_required' } })
    credentials.value = replacementKey

    const retried = await response(
      route(routes, TEAM_MANAGEMENT_DISSOLUTION_CLEAR_PATH).handler,
      request('POST', {}),
    )
    expect(retried).toMatchObject({ status: 200, body: { state: 'confirmed', localCleanup: 'completed' } })
    expect(credentials.value).toBe(replacementKey)

    const dismissed = await response(
      route(routes, TEAM_MANAGEMENT_DISSOLUTION_CLEAR_PATH).handler,
      request('POST', {}),
    )
    expect(dismissed).toMatchObject({ status: 200, body: { cleared: true } })
    expect(credentials.value).toBe(replacementKey)
    expect(credentials.get(DISSOLUTION_TERMINAL_REF)).toBeUndefined()
    expect(credentials.get(DISSOLUTION_KEY_DIGEST_REF)).toBeUndefined()
  })

  it.each([
    ['missing', undefined],
    ['damaged', '{not-json'],
  ] as const)('fails closed when the dissolution key digest is %s', async (_label, keyDigest) => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_replacement-secret-1234567890'
    credentials.put(DISSOLUTION_TERMINAL_REF, JSON.stringify({
      version: 2,
      state: 'confirmed',
      localCleanup: 'retry_required',
    }))
    if (keyDigest !== undefined) credentials.put(DISSOLUTION_KEY_DIGEST_REF, keyDigest)
    const fetch = vi.fn<typeof globalThis.fetch>()
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch,
    )

    const cleared = await response(
      route(routes, TEAM_MANAGEMENT_DISSOLUTION_CLEAR_PATH).handler,
      request('POST', {}),
    )

    expect(cleared).toMatchObject({ status: 200, body: { state: 'confirmed', localCleanup: 'manual_required' } })
    expect(credentials.value).toBe('dsh_team_replacement-secret-1234567890')
    expect(credentials.unsets.map(String)).not.toContain(TEAM_KEY_REF)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('finishes remotely but reports manual cleanup for a read-only Team key', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_owner-secret-1234567890'
    credentials.readonlyRefs.add(TEAM_KEY_REF)
    const mutationFetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (String(input).endsWith(TEAM_DISSOLVE_PATH)) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(JSON.stringify(dissolutionResult(String(body.operationId))), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    })
    const fetch = withOverviewPreflight(mutationFetch)
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch,
    )

    const committed = await response(route(routes, TEAM_MANAGEMENT_DISSOLVE_PATH).handler, request('POST', withExpectedContext({
      confirmationName: 'Friends', expectedLifecycleRevision: 7,
    })))

    expect(committed).toMatchObject({ status: 200, body: { state: 'confirmed', localCleanup: 'manual_required' } })
    expect(credentials.value).toBe('dsh_team_owner-secret-1234567890')
    expect(JSON.stringify(committed.body)).not.toMatch(/operationId|recoverySecret/iu)
  })

  it('rejects Browser-supplied operation and recovery fields before any remote request', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_owner-secret-1234567890'
    const fetch = vi.fn<typeof globalThis.fetch>()
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch,
    )

    const rejected = await response(route(routes, TEAM_MANAGEMENT_DISSOLVE_PATH).handler, request('POST', {
      confirmationName: 'Friends',
      expectedLifecycleRevision: 7,
      operationId: 'browser-controlled',
      recoverySecret: 'browser-controlled',
    }))

    expect(rejected.status).toBe(400)
    expect(fetch).not.toHaveBeenCalled()
    expect(credentials.get(DISSOLUTION_PENDING_REF)).toBeUndefined()
  })

  it('disposes all local proxy routes', async () => {
    const { routes } = setup({ enabled: false })
    expect(routes.length).toBeGreaterThan(5)
    await cleanups[0]!()
    expect(routes.every(candidate => candidate.disposed)).toBe(true)
    cleanups.shift()
  })
})
