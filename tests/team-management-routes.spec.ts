import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import type { AuthInteraction } from '@earendil-works/pi-ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerTeamManagementRoutes } from '../src/team/management-routes.ts'
import type { TeamManagementRouteOptions, TeamManagementRouteSecurity } from '../src/team/management-routes.ts'
import type { OpenAICodexProfileStore } from '../src/store.ts'
import { TeamCredentialHandoffRegistry, TEAM_CREDENTIAL_HANDOFF_TTL_MS } from '../src/team/oauth-handoff.ts'
import {
  TEAM_AUTHORIZATION_FAILED_CODE,
  TEAM_AUTHORIZATION_NETWORK_UNAVAILABLE_CODE,
  TEAM_BROWSER_AUTHORIZATION_ALREADY_PENDING_CODE,
  TEAM_LOCAL_ACCOUNT_ALREADY_SHARED_CODE,
  TEAM_MANAGEMENT_CAPABILITY_HEADER,
  TEAM_MANAGEMENT_CONTEXT_CHANGED_MESSAGE,
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
  TEAM_MANAGEMENT_OAUTH_CANCEL_PATH,
  TEAM_MANAGEMENT_OAUTH_REAUTHORIZE_PATH,
  TEAM_MANAGEMENT_OAUTH_START_PATH,
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
  TEAM_CONTRIBUTION_PROVIDER_ACCOUNT_MATCHES_PATH,
  TEAM_CONTRIBUTION_OAUTH_HANDOFF_COMPLETE_PATH,
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
const BROWSER_OAUTH_PENDING_REF = `${TEAM_KEY_REF}_BROWSER_OAUTH_PENDING`
const LOCAL_CONTRIBUTION_BINDINGS_REF = `${TEAM_KEY_REF}_LOCAL_CONTRIBUTION_BINDINGS`
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
  options: Omit<TeamManagementRouteOptions, 'fetch' | 'security'> & { realSecurity?: boolean } = {},
): { routes: CapturedRoute[]; credentials: FakeCredentials; fetch: typeof fetch } {
  const { realSecurity, ...routeOptions } = options
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
    ...routeOptions,
    ...realSecurity === true ? {} : { security: deterministicSecurity },
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
    activeSharedAccounts: [],
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

function withOverviewSequence(
  mutationFetch: typeof globalThis.fetch,
  currentOverviews: readonly Record<string, unknown>[],
) {
  if (currentOverviews.length === 0) throw new Error('overview sequence must not be empty')
  let overviewReadIndex = 0
  return vi.fn<typeof globalThis.fetch>(async (input, init) => {
    if (String(input) === 'https://pool.example/plugins/dsh-codex-shared-pool/team/overview') {
      const currentOverview = currentOverviews[Math.min(overviewReadIndex, currentOverviews.length - 1)]!
      overviewReadIndex += 1
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

  it('projects aggregate-only Team usage plus safe owner windows and drops private remote details', async () => {
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
      ownedAccounts: [{
        accountId: 'account-1',
        window: { startedAt: 0, endedAt: 200_000_000 },
        aggregate: {
          requestCount: 2, tokenMeasuredRequestCount: 1, pricedRequestCount: 1,
          totalTokens: '8750', estimatedCostUsdMicros: '125000',
        },
        currentUtcWeek: {
          window: { startedAt: 100_000_000, endedAt: 200_000_000 },
          resetAt: 300_000_000,
          aggregate: {
            requestCount: 1, tokenMeasuredRequestCount: 1, pricedRequestCount: 1,
            totalTokens: '4000', estimatedCostUsdMicros: '64000',
          },
          accessToken: 'must-not-cross',
        },
        last24Hours: {
          window: { startedAt: 113_600_000, endedAt: 200_000_000 },
          aggregate: {
            requestCount: 1, tokenMeasuredRequestCount: 0, pricedRequestCount: 0,
            totalTokens: null, estimatedCostUsdMicros: null,
          },
          prompt: 'must-not-cross',
        },
        recentRequests: [],
        refreshToken: 'must-not-cross',
      }],
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
        ownedAccounts: [{
          accountId: 'account-1',
          window: { startedAt: 0, endedAt: 200_000_000 },
          aggregate: {
            requestCount: 2, tokenMeasuredRequestCount: 1, pricedRequestCount: 1,
            totalTokens: '8750', estimatedCostUsdMicros: '125000',
          },
          currentUtcWeek: {
            window: { startedAt: 100_000_000, endedAt: 200_000_000 },
            resetAt: 300_000_000,
            aggregate: {
              requestCount: 1, tokenMeasuredRequestCount: 1, pricedRequestCount: 1,
              totalTokens: '4000', estimatedCostUsdMicros: '64000',
            },
          },
          last24Hours: {
            window: { startedAt: 113_600_000, endedAt: 200_000_000 },
            aggregate: {
              requestCount: 1, tokenMeasuredRequestCount: 0, pricedRequestCount: 0,
              totalTokens: null, estimatedCostUsdMicros: null,
            },
          },
          recentRequests: [],
        }],
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
        subscription: { planType: 'plus', weeklyEstimatedUsd: 999999, weeklyRemainingEstimatedUsd: 72, access_token: 'must-not-cross' },
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
        subscription: { planType: 'plus', weeklyEstimatedUsd: 100 },
      }],
    })
    expect(contributions).toHaveLength(1)
    expect(JSON.stringify(result.body)).not.toContain('must-not-cross')
  })

  it('projects the active shared-account directory without private contribution fields', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const currentMember = { ...member(), id: 'member-2', role: 'member' }
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(overview({
      currentMember,
      members: [member(), currentMember],
      activeSharedAccounts: [{
        id: 'account-1',
        label: 'Owner Codex',
        ownerMemberId: 'member-1',
        status: 'active',
      }],
    })), { status: 200, headers: { 'content-type': 'application/json' } }))
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch)

    const result = await response(route(routes, TEAM_MANAGEMENT_OVERVIEW_PATH).handler, request('GET'))

    expect(result).toMatchObject({
      status: 200,
      body: {
        viewerRole: 'member',
        activeSharedAccounts: [{
          id: 'account-1', label: 'Owner Codex', ownerMemberId: 'member-1', status: 'active',
        }],
      },
    })
    expect(Object.keys((result.body.activeSharedAccounts as Array<Record<string, unknown>>)[0]!).sort())
      .toEqual(['id', 'label', 'ownerMemberId', 'status'])
  })

  it('keeps rolling upgrades usable when an older Team Host omits the shared-account directory', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_owner-secret-1234567890'
    const legacyOverview = overview()
    delete legacyOverview.activeSharedAccounts
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(legacyOverview), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch)

    const result = await response(route(routes, TEAM_MANAGEMENT_OVERVIEW_PATH).handler, request('GET'))

    expect(result).toMatchObject({ status: 200, body: { activeSharedAccounts: [] } })
  })

  it('fails closed when a remote shared-account directory entry contains private fields', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_owner-secret-1234567890'
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(overview({
      activeSharedAccounts: [{
        id: 'account-1', label: 'Owner Codex', ownerMemberId: 'member-1', status: 'active',
        capacity: { buckets: [] },
      }],
    })), { status: 200, headers: { 'content-type': 'application/json' } }))
    const { routes } = setup({ enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }, credentials, fetch)

    const result = await response(route(routes, TEAM_MANAGEMENT_OVERVIEW_PATH).handler, request('GET'))

    expect(result.status).toBe(502)
    expect(JSON.stringify(result.body)).not.toContain('capacity')
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

  it('replaces remote OAuth diagnostics with a closed stable code before Browser projection', async () => {
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
    expect((result.body.contributions as Array<Record<string, unknown>>)[0]?.lastError)
      .toBe(TEAM_AUTHORIZATION_FAILED_CODE)
    expect(serialized).not.toMatch(/Authorization: Bearer|opaque-provider-token|provider-api-secret|provider-client-secret|provider-id-secret|dsh_invite_/u)
  })

  it('projects an OAuth mutation failure before returning it to the Browser', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const mutationFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      error: 'provider refused Authorization: Bearer opaque-provider-token',
    }), { status: 400, headers: { 'content-type': 'application/json' } }))
    const fetch = withOverviewPreflight(mutationFetch)
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
    )

    const result = await response(
      route(routes, TEAM_MANAGEMENT_OAUTH_START_PATH).handler,
      request('POST', withExpectedContext({ label: 'Owner Codex' })),
    )

    expect(result).toMatchObject({ status: 400, body: { error: TEAM_AUTHORIZATION_FAILED_CODE } })
    expect(JSON.stringify(result.body)).not.toMatch(/provider refused|opaque-provider-token|Authorization: Bearer/iu)
  })

  it.each([
    {
      name: 'cancellation',
      path: TEAM_MANAGEMENT_OAUTH_CANCEL_PATH,
      body: withExpectedContext({ accountId: 'account-1' }),
    },
    {
      name: 'reauthorization',
      path: TEAM_MANAGEMENT_OAUTH_REAUTHORIZE_PATH,
      body: withExpectedContext({ accountId: 'account-1' }),
    },
  ])('projects a remote OAuth $name failure before returning it to the Browser', async ({ path, body }) => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const rawDiagnostic = 'provider refused Authorization: Bearer opaque-provider-token'
    const mutationFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      error: rawDiagnostic,
    }), { status: 400, headers: { 'content-type': 'application/json' } }))
    const fetch = withOverviewPreflight(mutationFetch)
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
    )

    const result = await response(route(routes, path).handler, request('POST', body))

    expect(result).toMatchObject({ status: 400, body: { error: TEAM_AUTHORIZATION_FAILED_CODE } })
    expect(JSON.stringify(result.body)).not.toMatch(/provider refused|opaque-provider-token|Authorization: Bearer/iu)
  })

  it.each([
    {
      name: 'start',
      path: TEAM_MANAGEMENT_OAUTH_START_PATH,
      body: withExpectedContext({ label: 'Owner Codex' }),
    },
    {
      name: 'cancellation',
      path: TEAM_MANAGEMENT_OAUTH_CANCEL_PATH,
      body: withExpectedContext({ accountId: 'account-1' }),
    },
    {
      name: 'reauthorization',
      path: TEAM_MANAGEMENT_OAUTH_REAUTHORIZE_PATH,
      body: withExpectedContext({ accountId: 'account-1' }),
    },
  ])('projects an OAuth $name overview preflight fetch rejection to a stable Browser error', async ({ path, body }) => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const rawDiagnostic = 'preflight fetch failed: ECONNRESET Authorization: Bearer opaque-preflight-token'
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error(rawDiagnostic))
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
    )

    const result = await response(route(routes, path).handler, request('POST', body))

    expect(result).toMatchObject({
      status: 502,
      body: { error: TEAM_AUTHORIZATION_NETWORK_UNAVAILABLE_CODE },
    })
    expect(JSON.stringify(result.body)).not.toMatch(/preflight|ECONNRESET|opaque-preflight-token|Authorization: Bearer/iu)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    {
      name: 'start',
      path: TEAM_MANAGEMENT_OAUTH_START_PATH,
      body: withExpectedContext({ label: 'Owner Codex' }),
    },
    {
      name: 'cancellation',
      path: TEAM_MANAGEMENT_OAUTH_CANCEL_PATH,
      body: withExpectedContext({ accountId: 'account-1' }),
    },
    {
      name: 'reauthorization',
      path: TEAM_MANAGEMENT_OAUTH_REAUTHORIZE_PATH,
      body: withExpectedContext({ accountId: 'account-1' }),
    },
  ])('projects an OAuth $name overview preflight rejection to a stable Browser error', async ({ path, body }) => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const rawDiagnostic = 'preflight refused Authorization: Bearer opaque-preflight-token'
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      error: rawDiagnostic,
    }), { status: 400, headers: { 'content-type': 'application/json' } }))
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
    )

    const result = await response(route(routes, path).handler, request('POST', body))

    expect(result).toMatchObject({ status: 400, body: { error: TEAM_AUTHORIZATION_FAILED_CODE } })
    expect(JSON.stringify(result.body)).not.toMatch(/preflight refused|opaque-preflight-token|Authorization: Bearer/iu)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    {
      name: 'start',
      path: TEAM_MANAGEMENT_OAUTH_START_PATH,
      body: withExpectedContext({ label: 'Owner Codex' }),
    },
    {
      name: 'reauthorization',
      path: TEAM_MANAGEMENT_OAUTH_REAUTHORIZE_PATH,
      body: withExpectedContext({ accountId: 'account-1' }),
    },
  ])('projects a malformed 2xx OAuth $name payload to a stable Browser error', async ({ path, body }) => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const rawProviderValue = 'unexpected-provider-method-opaque-provider-token'
    const mutationFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      account: { ...contribution(), status: 'authorizing', lastError: undefined },
      method: rawProviderValue,
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-EFGH',
      expiresAt: Date.now() + 900_000,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const fetch = withOverviewPreflight(mutationFetch)
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
    )

    const result = await response(route(routes, path).handler, request('POST', body))

    expect(result).toMatchObject({ status: 400, body: { error: TEAM_AUTHORIZATION_FAILED_CODE } })
    expect(JSON.stringify(result.body)).not.toContain(rawProviderValue)
  })

  it('projects safe initial browser authorization metadata only while its authorizing account is visible', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const temporaryRootDir = await mkdtemp(join(tmpdir(), 'dsh-team-management-browser-pending-test-'))
    cleanups.push(async () => { await rm(temporaryRootDir, { recursive: true, force: true }) })
    const offer = new TeamCredentialHandoffRegistry().create({ teamId: 'team-1', accountId: 'account-1' })
    let accountVisible = false
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/overview')) {
        return new Response(JSON.stringify(overview({
          contributions: accountVisible
            ? [{ ...contribution(), status: 'authorizing', lastError: undefined }]
            : [],
        })), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/contributions/oauth/start')) {
        accountVisible = true
        return new Response(JSON.stringify({
          account: { ...contribution(), status: 'authorizing', lastError: undefined },
          method: 'browser_handoff',
          handoff: offer,
        }), { status: 201, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/contributions/oauth/cancel')) {
        accountVisible = false
        return new Response(JSON.stringify({
          account: { ...contribution(), status: 'revoked', lastError: undefined },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`unexpected remote request: ${url}; ${String(init?.body)}`)
    })
    const loginProfile = async (interaction: AuthInteraction): Promise<never> => {
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/oauth/authorize?state=host-only' })
      return await new Promise<never>((_resolve, reject) => {
        interaction.signal.addEventListener('abort', () => { reject(interaction.signal.reason) }, { once: true })
      })
    }
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
      { loginProfile, temporaryRootDir },
    )

    const started = await response(route(routes, TEAM_MANAGEMENT_OAUTH_START_PATH).handler, request('POST', withExpectedContext({
      label: 'Personal Pro', method: 'browser',
    })))
    expect(started).toMatchObject({ status: 201, body: { method: 'browser' } })
    const localExpiresAt = started.body.expiresAt
    expect(localExpiresAt).toEqual(expect.any(Number))

    const projected = await response(route(routes, TEAM_MANAGEMENT_OVERVIEW_PATH).handler, request('GET'))
    expect(projected.body.pendingBrowserAuthorization).toEqual({
      accountId: 'account-1',
      method: 'browser',
      expiresAt: localExpiresAt,
      discardInitial: true,
    })
    expect(JSON.stringify(projected.body.pendingBrowserAuthorization)).not.toMatch(/authorizationUrl|handoff|sessionId|serverPublicKey|auth\.openai/iu)
    const journal = credentials.get(BROWSER_OAUTH_PENDING_REF)
    expect(journal).toBeDefined()
    expect(JSON.parse(journal!)).toMatchObject({
      version: 1,
      operations: [{
        expectedContext: EXPECTED_CONTEXT,
        pending: {
          accountId: 'account-1', method: 'browser', expiresAt: localExpiresAt, discardInitial: true,
        },
      }],
    })
    expect(journal).not.toMatch(/authorizationUrl|handoff|sessionId|serverPublicKey|auth\.openai|secret/iu)

    accountVisible = false
    const accountMissing = await response(route(routes, TEAM_MANAGEMENT_OVERVIEW_PATH).handler, request('GET'))
    expect(accountMissing.body.pendingBrowserAuthorization).toBeUndefined()

    accountVisible = true
    const cancelled = await response(route(routes, TEAM_MANAGEMENT_OAUTH_CANCEL_PATH).handler, request('POST', withExpectedContext({
      accountId: 'account-1', discardInitial: false,
    })))
    expect(cancelled).toMatchObject({ status: 200, body: { account: { id: 'account-1', status: 'revoked' } } })
    const cancellation = fetch.mock.calls.find(([input]) => String(input).endsWith('/contributions/oauth/cancel'))
    expect(cancellation?.[1]?.body).toBe(JSON.stringify({ accountId: 'account-1', discardInitial: true }))
  })

  it('uses a local browser authorization deadline when the Team Host clock is behind', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const temporaryRootDir = await mkdtemp(join(tmpdir(), 'dsh-team-management-browser-clock-skew-test-'))
    cleanups.push(async () => { await rm(temporaryRootDir, { recursive: true, force: true }) })
    const localNow = 1_800_000_000_000
    const remoteNow = localNow - 11 * 60_000
    const offer = new TeamCredentialHandoffRegistry({ now: () => remoteNow })
      .create({ teamId: 'team-1', accountId: 'account-1' })
    let overviewReads = 0
    let cancellations = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/overview')) {
        overviewReads += 1
        return new Response(JSON.stringify(overview({
          contributions: overviewReads === 1
            ? []
            : [{ ...contribution(), status: 'authorizing', lastError: undefined }],
        })), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/contributions/oauth/start')) {
        return new Response(JSON.stringify({
          account: { ...contribution(), status: 'authorizing', lastError: undefined },
          method: 'browser_handoff',
          handoff: offer,
        }), { status: 201, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/contributions/oauth/cancel')) {
        cancellations += 1
        return new Response(JSON.stringify({
          account: { ...contribution(), status: 'revoked', lastError: undefined },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`unexpected remote request: ${url}`)
    })
    const loginProfile = async (interaction: AuthInteraction): Promise<never> => {
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/oauth/authorize?state=clock-skew' })
      return await new Promise<never>((_resolve, reject) => {
        interaction.signal.addEventListener('abort', () => { reject(interaction.signal.reason) }, { once: true })
      })
    }
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
      { loginProfile, temporaryRootDir, now: () => localNow },
    )

    const started = await response(route(routes, TEAM_MANAGEMENT_OAUTH_START_PATH).handler, request('POST', withExpectedContext({
      label: 'Personal Pro', method: 'browser',
    })))

    expect(started).toMatchObject({
      status: 201,
      body: { method: 'browser', expiresAt: localNow + 10 * 60_000 },
    })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(cancellations).toBe(0)

    await expect(response(route(routes, TEAM_MANAGEMENT_OAUTH_CANCEL_PATH).handler, request('POST', withExpectedContext({
      accountId: 'account-1', discardInitial: true,
    })))).resolves.toMatchObject({ status: 200 })
    expect(cancellations).toBe(1)
  })

  it('projects reauthorization as non-discarding and ignores a conflicting Browser cancellation hint', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const temporaryRootDir = await mkdtemp(join(tmpdir(), 'dsh-team-management-browser-reauthorize-pending-test-'))
    cleanups.push(async () => { await rm(temporaryRootDir, { recursive: true, force: true }) })
    const offer = new TeamCredentialHandoffRegistry().create({ teamId: 'team-1', accountId: 'account-1' })
    const mutationFetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/contributions/oauth/reauthorize')) {
        return new Response(JSON.stringify({
          account: { ...contribution(), status: 'authorizing', lastError: undefined },
          method: 'browser_handoff',
          handoff: offer,
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/contributions/oauth/cancel')) {
        return new Response(JSON.stringify({
          account: { ...contribution(), status: 'reauth_required', lastError: undefined },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`unexpected remote request: ${url}; ${String(init?.body)}`)
    })
    const loginProfile = async (interaction: AuthInteraction): Promise<never> => {
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/oauth/authorize?state=reauthorize-host-only' })
      return await new Promise<never>((_resolve, reject) => {
        interaction.signal.addEventListener('abort', () => { reject(interaction.signal.reason) }, { once: true })
      })
    }
    const fetch = withOverviewSequence(mutationFetch, [
      overview({ contributions: [contribution()] }),
      overview({
        contributions: [{ ...contribution(), status: 'authorizing', lastError: undefined }],
      }),
    ])
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
      { loginProfile, temporaryRootDir },
    )

    const started = await response(route(routes, TEAM_MANAGEMENT_OAUTH_REAUTHORIZE_PATH).handler, request('POST', withExpectedContext({
      accountId: 'account-1', method: 'browser',
    })))
    expect(started).toMatchObject({ status: 200, body: { method: 'browser' } })
    const localExpiresAt = started.body.expiresAt
    expect(localExpiresAt).toEqual(expect.any(Number))
    const projected = await response(route(routes, TEAM_MANAGEMENT_OVERVIEW_PATH).handler, request('GET'))
    expect(projected.body.pendingBrowserAuthorization).toEqual({
      accountId: 'account-1',
      method: 'browser',
      expiresAt: localExpiresAt,
      discardInitial: false,
    })

    const cancelled = await response(route(routes, TEAM_MANAGEMENT_OAUTH_CANCEL_PATH).handler, request('POST', withExpectedContext({
      accountId: 'account-1', discardInitial: true,
    })))
    expect(cancelled).toMatchObject({ status: 200, body: { account: { id: 'account-1', status: 'reauth_required' } } })
    const cancellation = mutationFetch.mock.calls.find(([input]) => String(input).endsWith('/contributions/oauth/cancel'))
    expect(cancellation?.[1]?.body).toBe(JSON.stringify({ accountId: 'account-1', discardInitial: false }))
  })

  it.each([
    { name: 'initial authorization', discardInitial: true, cancelledStatus: 'revoked' },
    { name: 'reauthorization', discardInitial: false, cancelledStatus: 'reauth_required' },
  ])('restores persisted browser OAuth metadata after a Host restart for $name', async ({
    discardInitial,
    cancelledStatus,
  }) => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    credentials.put(BROWSER_OAUTH_PENDING_REF, JSON.stringify({
      version: 1,
      operations: [{
        expectedContext: EXPECTED_CONTEXT,
        pending: {
          accountId: 'account-1',
          method: 'browser',
          expiresAt: Date.now() + 900_000,
          discardInitial,
        },
      }],
    }))
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/overview')) {
        return new Response(JSON.stringify(overview({
          contributions: [{ ...contribution(), status: 'authorizing', lastError: undefined }],
        })), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/contributions/oauth/cancel')) {
        return new Response(JSON.stringify({
          account: { ...contribution(), status: cancelledStatus, lastError: undefined },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`unexpected remote request: ${url}; ${String(init?.body)}`)
    })
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
    )

    const projected = await response(route(routes, TEAM_MANAGEMENT_OVERVIEW_PATH).handler, request('GET'))
    expect(projected.body.pendingBrowserAuthorization).toMatchObject({
      accountId: 'account-1', method: 'browser', discardInitial,
    })

    const cancelled = await response(route(routes, TEAM_MANAGEMENT_OAUTH_CANCEL_PATH).handler, request('POST', withExpectedContext({
      accountId: 'account-1', discardInitial: !discardInitial,
    })))

    expect(cancelled).toMatchObject({ status: 200, body: { account: { status: cancelledStatus } } })
    const cancellation = fetch.mock.calls.find(([input]) => String(input).endsWith('/contributions/oauth/cancel'))
    expect(cancellation?.[1]?.body).toBe(JSON.stringify({ accountId: 'account-1', discardInitial }))
    expect(credentials.get(BROWSER_OAUTH_PENDING_REF)).toBeUndefined()
  })

  it('discards malformed browser OAuth recovery metadata without breaking overview', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    credentials.put(BROWSER_OAUTH_PENDING_REF, '{"version":1,"operations":"not-an-array"}')
    const backgroundErrors: unknown[] = []
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(overview({
      contributions: [{ ...contribution(), status: 'authorizing', lastError: undefined }],
    })), { status: 200, headers: { 'content-type': 'application/json' } }))
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
      { onBackgroundError: error => { backgroundErrors.push(error) } },
    )

    const projected = await response(route(routes, TEAM_MANAGEMENT_OVERVIEW_PATH).handler, request('GET'))

    expect(projected.status).toBe(200)
    expect(projected.body.pendingBrowserAuthorization).toBeUndefined()
    expect(credentials.get(BROWSER_OAUTH_PENDING_REF)).toBeUndefined()
    expect(backgroundErrors).toHaveLength(1)
    expect(JSON.stringify(backgroundErrors)).not.toContain('not-an-array')
  })

  it('prunes browser OAuth recovery metadata that belongs to a different Team context', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    credentials.put(BROWSER_OAUTH_PENDING_REF, JSON.stringify({
      version: 1,
      operations: [{
        expectedContext: { ...EXPECTED_CONTEXT, teamId: 'previous-team' },
        pending: {
          accountId: 'account-1', method: 'browser', expiresAt: Date.now() + 900_000, discardInitial: true,
        },
      }],
    }))
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(overview({
      contributions: [{ ...contribution(), status: 'authorizing', lastError: undefined }],
    })), { status: 200, headers: { 'content-type': 'application/json' } }))
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
    )

    const projected = await response(route(routes, TEAM_MANAGEMENT_OVERVIEW_PATH).handler, request('GET'))

    expect(projected.body.pendingBrowserAuthorization).toBeUndefined()
    expect(credentials.get(BROWSER_OAUTH_PENDING_REF)).toBeUndefined()
  })

  it('completes browser OAuth locally and transfers only an encrypted one-time credential envelope', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const temporaryRootDir = await mkdtemp(join(tmpdir(), 'dsh-team-management-browser-test-'))
    cleanups.push(async () => { await rm(temporaryRootDir, { recursive: true, force: true }) })
    const handoffs = new TeamCredentialHandoffRegistry()
    const offer = handoffs.create({ teamId: 'team-1', accountId: 'account-1' })
    let transferred: ReturnType<typeof handoffs.complete> | undefined
    let releaseLogin = () => {}
    const loginGate = new Promise<void>((resolve) => { releaseLogin = resolve })
    cleanups.push(async () => { releaseLogin() })
    const mutationFetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/contributions/oauth/start')) {
        return new Response(JSON.stringify({
          account: { ...contribution(), status: 'authorizing', lastError: undefined },
          method: 'browser_handoff',
          handoff: offer,
        }), { status: 201, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith(TEAM_CONTRIBUTION_OAUTH_HANDOFF_COMPLETE_PATH)) {
        const body = JSON.parse(String(init?.body)) as {
          accountId: string
          envelope: Parameters<typeof handoffs.complete>[1]
        }
        transferred = handoffs.complete({ teamId: 'team-1', accountId: body.accountId }, body.envelope)
        return new Response(JSON.stringify({
          account: { ...contribution(), label: 'Captured OAuth', status: 'active', lastError: undefined },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`unexpected remote request: ${url}`)
    })
    const loginProfile = async (interaction: AuthInteraction, store: OpenAICodexProfileStore) => {
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/oauth/authorize?state=local-only' })
      await loginGate
      return store.addProfile('Captured OAuth', {
        type: 'oauth',
        access: 'provider-access-secret',
        refresh: 'provider-refresh-secret',
        expires: Date.now() + 3_600_000,
        accountId: 'provider-account-1',
      })
    }
    const fetch = withOverviewSequence(mutationFetch, [
      overview(),
      overview({
        contributions: [{ ...contribution(), status: 'authorizing', lastError: undefined }],
      }),
      overview({
        contributions: [{ ...contribution(), status: 'authorizing', lastError: undefined }],
      }),
      overview({
        contributions: [{ ...contribution(), label: 'Captured OAuth', status: 'active', lastError: undefined }],
      }),
    ])
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
      {
        loginProfile,
        temporaryRootDir,
        localProfiles: {
          listProfiles: async () => [{ id: 'local-profile-1', label: 'Local', createdAt: 1, updatedAt: 1 }],
          readProfileProviderAccountId: async (profileId: string) => (
            profileId === 'local-profile-1' ? 'provider-account-1' : undefined
          ),
        },
      },
    )

    const result = await response(route(routes, TEAM_MANAGEMENT_OAUTH_START_PATH).handler, request('POST', withExpectedContext({
      label: 'Personal Pro', method: 'browser', sourceLocalProfileId: 'local-profile-1',
    })))

    expect(result).toMatchObject({
      status: 201,
      body: {
        account: { id: 'account-1', status: 'authorizing' },
        method: 'browser',
        authorizationUrl: 'https://auth.openai.com/oauth/authorize?state=local-only',
      },
    })
    expect(JSON.stringify(result.body)).not.toMatch(/provider-access|provider-refresh|serverPublicKey|sessionId/u)
    const pending = await response(route(routes, TEAM_MANAGEMENT_OVERVIEW_PATH).handler, request('GET'))
    expect(pending.body.pendingBrowserAuthorization).toMatchObject({
      accountId: 'account-1', method: 'browser', discardInitial: true,
    })
    releaseLogin()
    await vi.waitFor(() => { expect(transferred?.credential.accountId).toBe('provider-account-1') })
    expect(transferred).toMatchObject({
      label: 'Captured OAuth',
      credential: { access: 'provider-access-secret', refresh: 'provider-refresh-secret' },
    })
    expect(JSON.stringify(mutationFetch.mock.calls[1]?.[1]?.body)).not.toMatch(/provider-access-secret|provider-refresh-secret/u)
    expect(mutationFetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ label: 'Personal Pro', method: 'browser' }))
    await vi.waitFor(() => { expect(mutationFetch).toHaveBeenCalledTimes(2) })
    await vi.waitFor(() => { expect(credentials.get(BROWSER_OAUTH_PENDING_REF)).toBeUndefined() })
    await vi.waitFor(() => {
      expect(JSON.parse(credentials.get(LOCAL_CONTRIBUTION_BINDINGS_REF) ?? '{}')).toMatchObject({
        version: 1,
        bindings: [{
          accountId: 'account-1',
          sourceLocalProfileId: 'local-profile-1',
          expectedContext: EXPECTED_CONTEXT,
        }],
      })
    })
    expect(await readdir(temporaryRootDir)).toEqual([])
    await vi.waitFor(async () => {
      const settled = await response(route(routes, TEAM_MANAGEMENT_OVERVIEW_PATH).handler, request('GET'))
      expect(settled.body.pendingBrowserAuthorization).toBeUndefined()
    })

    const activeFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(overview({
      contributions: [{ ...contribution(), label: 'Captured OAuth', status: 'active', lastError: undefined }],
    })), { status: 200, headers: { 'content-type': 'application/json' } }))
    const restarted = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      activeFetch,
    )
    const afterRestart = await response(
      route(restarted.routes, TEAM_MANAGEMENT_OVERVIEW_PATH).handler,
      request('GET'),
    )
    expect(afterRestart.body.contributions[0]).toMatchObject({
      id: 'account-1', status: 'active', sourceLocalProfileId: 'local-profile-1',
    })
  })

  it('reconciles a Team-first contribution to a later local profile without exposing provider identity', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const providerAccountId = 'provider-account-private-sentinel'
    const remoteOverview = overview({
      contributions: [{ ...contribution(), status: 'active', lastError: undefined }],
      activeSharedAccounts: [{
        id: 'account-1', label: 'Owner Codex', ownerMemberId: 'member-1', status: 'active',
      }],
    })
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/overview')) {
        return new Response(JSON.stringify(remoteOverview), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/contributions/provider-account/matches')) {
        expect(url).toBe(`https://pool.example${TEAM_CONTRIBUTION_PROVIDER_ACCOUNT_MATCHES_PATH}`)
        expect(JSON.parse(String(init?.body))).toEqual({ providerAccountId })
        return new Response(JSON.stringify({ accountIds: ['account-1'] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected remote request: ${url}`)
    })
    const localProfiles = {
      listProfiles: async () => [{ id: 'local-profile-1', label: 'Local', createdAt: 1, updatedAt: 2 }],
      readProfileProviderAccountId: async (profileId: string) => (
        profileId === 'local-profile-1' ? providerAccountId : undefined
      ),
    }
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
      { localProfiles },
    )

    const projected = await response(route(routes, TEAM_MANAGEMENT_OVERVIEW_PATH).handler, request('GET'))

    expect(projected).toMatchObject({
      status: 200,
      body: {
        contributions: [{
          id: 'account-1', status: 'active', sourceLocalProfileId: 'local-profile-1',
        }],
      },
    })
    expect(JSON.stringify(projected.body)).not.toContain(providerAccountId)
    expect(credentials.get(LOCAL_CONTRIBUTION_BINDINGS_REF)).not.toContain(providerAccountId)
    expect(JSON.parse(credentials.get(LOCAL_CONTRIBUTION_BINDINGS_REF) ?? '{}')).toMatchObject({
      version: 1,
      bindings: [{
        expectedContext: EXPECTED_CONTEXT,
        accountId: 'account-1',
        sourceLocalProfileId: 'local-profile-1',
      }],
    })
  })

  it('does not guess a local binding when one provider identity matches multiple current contributions', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const providerAccountId = 'provider-account-ambiguous-private-sentinel'
    const remoteOverview = overview({
      contributions: [
        { ...contribution(), id: 'account-1', status: 'active', lastError: undefined },
        { ...contribution(), id: 'account-2', label: 'Second Codex', status: 'paused', lastError: undefined },
      ],
    })
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/overview')) {
        return new Response(JSON.stringify(remoteOverview), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/contributions/provider-account/matches')) {
        return new Response(JSON.stringify({ accountIds: ['account-1', 'account-2'] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected remote request: ${url}`)
    })
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
      {
        localProfiles: {
          listProfiles: async () => [{ id: 'local-profile-1', label: 'Local', createdAt: 1, updatedAt: 2 }],
          readProfileProviderAccountId: async () => providerAccountId,
        },
      },
    )

    const projected = await response(route(routes, TEAM_MANAGEMENT_OVERVIEW_PATH).handler, request('GET'))

    expect(projected.status).toBe(200)
    const contributions = projected.body.contributions as Array<Record<string, unknown>>
    expect(contributions.map(account => account.id)).toEqual(['account-1', 'account-2'])
    for (const account of contributions) expect(account).not.toHaveProperty('sourceLocalProfileId')
    expect(credentials.get(LOCAL_CONTRIBUTION_BINDINGS_REF)).toBeUndefined()
    expect(JSON.stringify(projected.body)).not.toContain(providerAccountId)
    expect(fetch.mock.calls.some(([input]) => String(input).endsWith('/contributions/provider-account/matches')))
      .toBe(true)
  })

  it('does not guess a local binding when multiple local profiles match one contribution', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const providerAccountId = 'provider-account-local-ambiguity-private-sentinel'
    const remoteOverview = overview({
      contributions: [{ ...contribution(), status: 'active', lastError: undefined }],
    })
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/overview')) {
        return new Response(JSON.stringify(remoteOverview), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/contributions/provider-account/matches')) {
        expect(JSON.parse(String(init?.body))).toEqual({ providerAccountId })
        return new Response(JSON.stringify({ accountIds: ['account-1'] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected remote request: ${url}`)
    })
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
      {
        localProfiles: {
          listProfiles: async () => [
            { id: 'local-profile-1', label: 'Local one', createdAt: 1, updatedAt: 2 },
            { id: 'local-profile-2', label: 'Local two', createdAt: 3, updatedAt: 4 },
          ],
          readProfileProviderAccountId: async () => providerAccountId,
        },
      },
    )

    const projected = await response(route(routes, TEAM_MANAGEMENT_OVERVIEW_PATH).handler, request('GET'))

    expect(projected.status).toBe(200)
    expect(projected.body.contributions).toMatchObject([{ id: 'account-1' }])
    expect(projected.body.contributions[0]).not.toHaveProperty('sourceLocalProfileId')
    expect(credentials.get(LOCAL_CONTRIBUTION_BINDINGS_REF)).toBeUndefined()
    expect(JSON.stringify(projected.body)).not.toContain(providerAccountId)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('replaces a stale binding when the same provider account is re-added as a new local profile', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    credentials.put(LOCAL_CONTRIBUTION_BINDINGS_REF, JSON.stringify({
      version: 1,
      bindings: [{
        expectedContext: EXPECTED_CONTEXT,
        accountId: 'account-1',
        sourceLocalProfileId: 'local-profile-removed',
      }],
    }))
    const providerAccountId = 'provider-account-readded-private-sentinel'
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/overview')) {
        return new Response(JSON.stringify(overview({
          contributions: [{ ...contribution(), status: 'active', lastError: undefined }],
        })), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/contributions/provider-account/matches')) {
        expect(JSON.parse(String(init?.body))).toEqual({ providerAccountId })
        return new Response(JSON.stringify({ accountIds: ['account-1'] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected remote request: ${url}`)
    })
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
      {
        localProfiles: {
          listProfiles: async () => [{ id: 'local-profile-new', label: 'Local', createdAt: 3, updatedAt: 4 }],
          readProfileProviderAccountId: async () => providerAccountId,
        },
      },
    )

    const projected = await response(route(routes, TEAM_MANAGEMENT_OVERVIEW_PATH).handler, request('GET'))

    expect(projected).toMatchObject({
      status: 200,
      body: {
        contributions: [{ id: 'account-1', sourceLocalProfileId: 'local-profile-new' }],
      },
    })
    expect(JSON.parse(credentials.get(LOCAL_CONTRIBUTION_BINDINGS_REF) ?? '{}')).toMatchObject({
      bindings: [{ accountId: 'account-1', sourceLocalProfileId: 'local-profile-new' }],
    })
    expect(credentials.get(LOCAL_CONTRIBUTION_BINDINGS_REF)).not.toContain('local-profile-removed')
    expect(credentials.get(LOCAL_CONTRIBUTION_BINDINGS_REF)).not.toContain(providerAccountId)
  })

  it('drops a persisted binding when the same local profile changes provider identity', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    credentials.put(LOCAL_CONTRIBUTION_BINDINGS_REF, JSON.stringify({
      version: 1,
      bindings: [{
        expectedContext: EXPECTED_CONTEXT,
        accountId: 'account-1',
        sourceLocalProfileId: 'local-profile-1',
      }],
    }))
    const changedProviderAccountId = 'changed-provider-account-private-sentinel'
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/overview')) {
        return new Response(JSON.stringify(overview({
          contributions: [{ ...contribution(), status: 'active', lastError: undefined }],
        })), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/contributions/provider-account/matches')) {
        expect(JSON.parse(String(init?.body))).toEqual({ providerAccountId: changedProviderAccountId })
        return new Response(JSON.stringify({ accountIds: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected remote request: ${url}`)
    })
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
      {
        localProfiles: {
          listProfiles: async () => [{ id: 'local-profile-1', label: 'Local', createdAt: 1, updatedAt: 2 }],
          readProfileProviderAccountId: async () => changedProviderAccountId,
        },
      },
    )

    const projected = await response(route(routes, TEAM_MANAGEMENT_OVERVIEW_PATH).handler, request('GET'))

    expect(projected.status).toBe(200)
    expect(projected.body.contributions).toMatchObject([{ id: 'account-1' }])
    expect(projected.body.contributions[0]).not.toHaveProperty('sourceLocalProfileId')
    expect(credentials.get(LOCAL_CONTRIBUTION_BINDINGS_REF)).toBeUndefined()
    expect(JSON.stringify(projected.body)).not.toContain(changedProviderAccountId)
  })

  it('blocks a stale local-share start after reconciliation finds that account already contributed', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const providerAccountId = 'provider-account-private-sentinel'
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/overview')) {
        return new Response(JSON.stringify(overview({
          contributions: [{ ...contribution(), status: 'active', lastError: undefined }],
        })), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/contributions/provider-account/matches')) {
        return new Response(JSON.stringify({ accountIds: ['account-1'] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected remote request: ${url}`)
    })
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
      {
        localProfiles: {
          listProfiles: async () => [{ id: 'local-profile-1', label: 'Local', createdAt: 1, updatedAt: 2 }],
          readProfileProviderAccountId: async () => providerAccountId,
        },
      },
    )

    const result = await response(route(routes, TEAM_MANAGEMENT_OAUTH_START_PATH).handler, request('POST', withExpectedContext({
      label: 'Local', method: 'browser', sourceLocalProfileId: 'local-profile-1',
    })))

    expect(result).toMatchObject({
      status: 409,
      body: { error: TEAM_LOCAL_ACCOUNT_ALREADY_SHARED_CODE },
    })
    expect(fetch.mock.calls.some(([input]) => String(input).endsWith('/contributions/oauth/start'))).toBe(false)
    expect(credentials.get(BROWSER_OAUTH_PENDING_REF)).toBeUndefined()
  })

  it('fails closed before a local-share start when exact provider matching is unavailable', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const providerAccountId = 'provider-account-unavailable-private-sentinel'
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/overview')) {
        return new Response(JSON.stringify(overview({
          contributions: [{ ...contribution(), status: 'active', lastError: undefined }],
        })), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/contributions/provider-account/matches')) {
        return new Response(JSON.stringify({ error: 'provider-account match unavailable' }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/contributions/oauth/start')) {
        return new Response(JSON.stringify({}), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected remote request: ${url}`)
    })
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
      {
        localProfiles: {
          listProfiles: async () => [{ id: 'local-profile-1', label: 'Local', createdAt: 1, updatedAt: 2 }],
          readProfileProviderAccountId: async () => providerAccountId,
        },
      },
    )

    const result = await response(route(routes, TEAM_MANAGEMENT_OAUTH_START_PATH).handler, request('POST', withExpectedContext({
      label: 'Local', method: 'browser', sourceLocalProfileId: 'local-profile-1',
    })))

    expect(result).toMatchObject({
      status: 502,
      body: { error: TEAM_AUTHORIZATION_FAILED_CODE },
    })
    expect(fetch.mock.calls.some(([input]) => String(input).endsWith('/contributions/oauth/start'))).toBe(false)
    expect(credentials.get(BROWSER_OAUTH_PENDING_REF)).toBeUndefined()
  })

  it('starts only one browser authorization for concurrent requests from different local profiles', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const handoffs = new TeamCredentialHandoffRegistry()
    let oauthStarts = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/overview')) {
        return new Response(JSON.stringify(overview()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/contributions/provider-account/matches')) {
        return new Response(JSON.stringify({ accountIds: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/contributions/oauth/start')) {
        oauthStarts += 1
        const accountId = `account-${oauthStarts}`
        return new Response(JSON.stringify({
          account: { ...contribution(), id: accountId, status: 'authorizing', lastError: undefined },
          method: 'browser_handoff',
          handoff: handoffs.create({ teamId: 'team-1', accountId }),
        }), { status: 201, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/contributions/oauth/cancel')) {
        const { accountId } = JSON.parse(String(init?.body)) as { accountId: string }
        return new Response(JSON.stringify({
          account: { ...contribution(), id: accountId, status: 'revoked', lastError: undefined },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`unexpected remote request: ${url}`)
    })
    const loginProfile = async (interaction: AuthInteraction): Promise<never> => {
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/oauth/authorize?state=single-flight' })
      return await new Promise<never>((_resolve, reject) => {
        interaction.signal.addEventListener('abort', () => { reject(interaction.signal.reason) }, { once: true })
      })
    }
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
      {
        loginProfile,
        localProfiles: {
          listProfiles: async () => [
            { id: 'local-profile-1', label: 'Local 1', createdAt: 1, updatedAt: 2 },
            { id: 'local-profile-2', label: 'Local 2', createdAt: 3, updatedAt: 4 },
          ],
          readProfileProviderAccountId: async profileId => `provider-account-${profileId.at(-1)}`,
        },
      },
    )
    const start = route(routes, TEAM_MANAGEMENT_OAUTH_START_PATH)

    const results = await Promise.all([
      response(start.handler, request('POST', withExpectedContext({
        label: 'Local 1', method: 'browser', sourceLocalProfileId: 'local-profile-1',
      }))),
      response(start.handler, request('POST', withExpectedContext({
        label: 'Local 2', method: 'browser', sourceLocalProfileId: 'local-profile-2',
      }))),
    ])

    expect(results.map(result => result.status).sort()).toEqual([201, 409])
    expect(results.find(result => result.status === 409)?.body).toEqual({
      error: TEAM_BROWSER_AUTHORIZATION_ALREADY_PENDING_CODE,
    })
    expect(oauthStarts).toBe(1)

    await expect(response(route(routes, TEAM_MANAGEMENT_OAUTH_CANCEL_PATH).handler, request('POST', withExpectedContext({
      accountId: 'account-1', discardInitial: true,
    })))).resolves.toMatchObject({ status: 200, body: { account: { status: 'revoked' } } })
  })

  it('treats an authorizing Team contribution as a durable browser OAuth reservation after Host restart', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/overview')) {
        return new Response(JSON.stringify(overview({
          contributions: [{ ...contribution(), status: 'authorizing', lastError: undefined }],
        })), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/contributions/oauth/start')) {
        return new Response(JSON.stringify({}), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected remote request: ${url}`)
    })
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
    )

    const result = await response(route(routes, TEAM_MANAGEMENT_OAUTH_START_PATH).handler, request('POST', withExpectedContext({
      label: 'Second browser authorization', method: 'browser',
    })))

    expect(result).toMatchObject({
      status: 409,
      body: { error: TEAM_BROWSER_AUTHORIZATION_ALREADY_PENDING_CODE },
    })
    expect(fetch.mock.calls.some(([input]) => String(input).endsWith('/contributions/oauth/start'))).toBe(false)
    expect(credentials.get(BROWSER_OAUTH_PENDING_REF)).toBeUndefined()
  })

  it('does not restart an authorizing Team contribution when its local OAuth journal was never written', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/overview')) {
        return new Response(JSON.stringify(overview({
          contributions: [{ ...contribution(), status: 'authorizing', lastError: undefined }],
        })), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/contributions/oauth/reauthorize')) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected remote request: ${url}`)
    })
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
    )

    const result = await response(route(routes, TEAM_MANAGEMENT_OAUTH_REAUTHORIZE_PATH).handler, request('POST', withExpectedContext({
      accountId: 'account-1', method: 'browser',
    })))

    expect(result).toMatchObject({
      status: 409,
      body: { error: TEAM_BROWSER_AUTHORIZATION_ALREADY_PENDING_CODE },
    })
    expect(fetch.mock.calls.some(([input]) => String(input).endsWith('/contributions/oauth/reauthorize'))).toBe(false)
    expect(credentials.get(BROWSER_OAUTH_PENDING_REF)).toBeUndefined()
  })

  it('blocks a new browser authorization using only the recovered Host journal reservation', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    credentials.put(BROWSER_OAUTH_PENDING_REF, JSON.stringify({
      version: 1,
      operations: [{
        expectedContext: EXPECTED_CONTEXT,
        pending: {
          accountId: 'account-1',
          method: 'browser',
          expiresAt: Date.now() + 900_000,
          discardInitial: true,
        },
      }],
    }))
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/overview')) {
        return new Response(JSON.stringify(overview({ contributions: [] })), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/contributions/oauth/start')) {
        return new Response(JSON.stringify({}), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected remote request: ${url}`)
    })
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
    )

    const result = await response(route(routes, TEAM_MANAGEMENT_OAUTH_START_PATH).handler, request('POST', withExpectedContext({
      label: 'Second browser authorization', method: 'browser',
    })))

    expect(result).toMatchObject({
      status: 409,
      body: { error: TEAM_BROWSER_AUTHORIZATION_ALREADY_PENDING_CODE },
    })
    expect(fetch.mock.calls.some(([input]) => String(input).endsWith('/contributions/oauth/start'))).toBe(false)
  })

  it('does not restart an active browser reauthorization when the same request arrives concurrently', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const handoffs = new TeamCredentialHandoffRegistry()
    let reauthorizationStarts = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/overview')) {
        return new Response(JSON.stringify(overview({
          contributions: [{ ...contribution(), status: 'reauth_required', lastError: undefined }],
        })), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/contributions/oauth/reauthorize')) {
        reauthorizationStarts += 1
        return new Response(JSON.stringify({
          account: { ...contribution(), status: 'authorizing', lastError: undefined },
          method: 'browser_handoff',
          handoff: handoffs.create({ teamId: 'team-1', accountId: 'account-1' }),
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/contributions/oauth/cancel')) {
        return new Response(JSON.stringify({
          account: { ...contribution(), status: 'reauth_required', lastError: undefined },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`unexpected remote request: ${url}`)
    })
    const loginProfile = async (interaction: AuthInteraction): Promise<never> => {
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/oauth/authorize?state=reauthorize-single-flight' })
      return await new Promise<never>((_resolve, reject) => {
        interaction.signal.addEventListener('abort', () => { reject(interaction.signal.reason) }, { once: true })
      })
    }
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
      { loginProfile },
    )
    const reauthorize = route(routes, TEAM_MANAGEMENT_OAUTH_REAUTHORIZE_PATH)
    const body = withExpectedContext({ accountId: 'account-1', method: 'browser' })

    const results = await Promise.all([
      response(reauthorize.handler, request('POST', body)),
      response(reauthorize.handler, request('POST', body)),
    ])

    expect(results.map(result => result.status).sort()).toEqual([200, 409])
    expect(results.find(result => result.status === 409)?.body).toEqual({
      error: TEAM_BROWSER_AUTHORIZATION_ALREADY_PENDING_CODE,
    })
    expect(reauthorizationStarts).toBe(1)

    await expect(response(route(routes, TEAM_MANAGEMENT_OAUTH_CANCEL_PATH).handler, request('POST', withExpectedContext({
      accountId: 'account-1', discardInitial: false,
    })))).resolves.toMatchObject({ status: 200, body: { account: { status: 'reauth_required' } } })
  })

  it.each([
    {
      failure: 'the committed response body stream is interrupted',
      firstResponse: () => {
        let pulls = 0
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1
            if (pulls === 1) {
              controller.enqueue(new TextEncoder().encode('{"account":'))
              return
            }
            controller.error(new Error('connection reset while reading the committed response'))
          },
        }, { highWaterMark: 0 })
        return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
      },
    },
    {
      failure: 'a gateway replaces the response with a non-JSON 503',
      firstResponse: () => new Response('temporarily unavailable', {
        status: 503,
        headers: { 'content-type': 'text/plain' },
      }),
    },
  ])('retries the exact handoff envelope when $failure', async ({ firstResponse }) => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const temporaryRootDir = await mkdtemp(join(tmpdir(), 'dsh-team-management-browser-retry-test-'))
    cleanups.push(async () => { await rm(temporaryRootDir, { recursive: true, force: true }) })
    const handoffs = new TeamCredentialHandoffRegistry()
    const offer = handoffs.create({ teamId: 'team-1', accountId: 'account-1' })
    let releaseLogin = () => {}
    const loginGate = new Promise<void>((resolve) => { releaseLogin = resolve })
    cleanups.push(async () => { releaseLogin() })
    const completionBodies: string[] = []
    const mutationFetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/contributions/oauth/start')) {
        return new Response(JSON.stringify({
          account: { ...contribution(), status: 'authorizing', lastError: undefined },
          method: 'browser_handoff',
          handoff: offer,
        }), { status: 201, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith(TEAM_CONTRIBUTION_OAUTH_HANDOFF_COMPLETE_PATH)) {
        const rawBody = String(init?.body)
        completionBodies.push(rawBody)
        const body = JSON.parse(rawBody) as {
          accountId: string
          envelope: Parameters<typeof handoffs.complete>[1]
        }
        handoffs.completeReplaySafe({ teamId: 'team-1', accountId: body.accountId }, body.envelope)
        if (completionBodies.length === 1) return firstResponse()
        return new Response(JSON.stringify({
          account: { ...contribution(), label: 'Captured OAuth', status: 'active', lastError: undefined },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`unexpected remote request: ${url}`)
    })
    const loginProfile = async (interaction: AuthInteraction, store: OpenAICodexProfileStore) => {
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/oauth/authorize?state=retry' })
      await loginGate
      return store.addProfile('Captured OAuth', {
        type: 'oauth', access: 'provider-access-secret', refresh: 'provider-refresh-secret',
        expires: Date.now() + 3_600_000, accountId: 'provider-account-1',
      })
    }
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      withOverviewSequence(mutationFetch, [
        overview(),
        overview({
          contributions: [{ ...contribution(), status: 'authorizing', lastError: undefined }],
        }),
      ]),
      {
        loginProfile,
        temporaryRootDir,
        localProfiles: {
          listProfiles: async () => [{ id: 'local-profile-1', label: 'Local', createdAt: 1, updatedAt: 1 }],
          readProfileProviderAccountId: async () => 'provider-account-1',
        },
      },
    )

    await expect(response(route(routes, TEAM_MANAGEMENT_OAUTH_START_PATH).handler, request('POST', withExpectedContext({
      label: 'Personal Pro', method: 'browser', sourceLocalProfileId: 'local-profile-1',
    })))).resolves.toMatchObject({ status: 201 })
    releaseLogin()

    await vi.waitFor(() => { expect(completionBodies).toHaveLength(2) })
    expect(completionBodies[1]).toBe(completionBodies[0])
    await vi.waitFor(() => {
      expect(JSON.parse(credentials.get(LOCAL_CONTRIBUTION_BINDINGS_REF) ?? '{}')).toMatchObject({
        bindings: [{ accountId: 'account-1', sourceLocalProfileId: 'local-profile-1' }],
      })
    })
    expect(mutationFetch.mock.calls.some(([input]) => String(input).endsWith('/contributions/oauth/cancel'))).toBe(false)
  })

  it('limits transient handoff completion failures to two attempts before cleanup', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const temporaryRootDir = await mkdtemp(join(tmpdir(), 'dsh-team-management-browser-retry-limit-test-'))
    cleanups.push(async () => { await rm(temporaryRootDir, { recursive: true, force: true }) })
    const offer = new TeamCredentialHandoffRegistry().create({ teamId: 'team-1', accountId: 'account-1' })
    let releaseLogin = () => {}
    const loginGate = new Promise<void>((resolve) => { releaseLogin = resolve })
    cleanups.push(async () => { releaseLogin() })
    const completionBodies: string[] = []
    const cancellationBodies: string[] = []
    const backgroundErrors: unknown[] = []
    const mutationFetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/contributions/oauth/start')) {
        return new Response(JSON.stringify({
          account: { ...contribution(), status: 'authorizing', lastError: undefined },
          method: 'browser_handoff',
          handoff: offer,
        }), { status: 201, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith(TEAM_CONTRIBUTION_OAUTH_HANDOFF_COMPLETE_PATH)) {
        completionBodies.push(String(init?.body))
        throw new TypeError('fetch failed: ECONNRESET')
      }
      if (url.endsWith('/contributions/oauth/cancel')) {
        cancellationBodies.push(String(init?.body))
        return new Response(JSON.stringify({
          account: {
            ...contribution(),
            status: 'revoked',
            lastError: TEAM_AUTHORIZATION_NETWORK_UNAVAILABLE_CODE,
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`unexpected remote request: ${url}`)
    })
    const loginProfile = async (interaction: AuthInteraction, store: OpenAICodexProfileStore) => {
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/oauth/authorize?state=retry-limit' })
      await loginGate
      return store.addProfile('Captured OAuth', {
        type: 'oauth', access: 'provider-access-secret', refresh: 'provider-refresh-secret',
        expires: Date.now() + 3_600_000, accountId: 'provider-account-1',
      })
    }
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      withOverviewSequence(mutationFetch, [
        overview(),
        overview({
          contributions: [{ ...contribution(), status: 'authorizing', lastError: undefined }],
        }),
      ]),
      { loginProfile, temporaryRootDir, onBackgroundError: error => { backgroundErrors.push(error) } },
    )

    await expect(response(route(routes, TEAM_MANAGEMENT_OAUTH_START_PATH).handler, request('POST', withExpectedContext({
      label: 'Personal Pro', method: 'browser',
    })))).resolves.toMatchObject({ status: 201 })
    releaseLogin()

    await vi.waitFor(() => { expect(backgroundErrors).toHaveLength(1) })
    expect(backgroundErrors[0]).toMatchObject({ message: TEAM_AUTHORIZATION_NETWORK_UNAVAILABLE_CODE })
    expect(completionBodies).toHaveLength(2)
    expect(completionBodies[1]).toBe(completionBodies[0])
    expect(cancellationBodies).toHaveLength(1)
    expect(JSON.parse(cancellationBodies[0]!)).toEqual({
      accountId: 'account-1',
      discardInitial: true,
      failureCode: TEAM_AUTHORIZATION_NETWORK_UNAVAILABLE_CODE,
    })
    expect(credentials.get(BROWSER_OAUTH_PENDING_REF)).toBeUndefined()
    expect(await readdir(temporaryRootDir)).toEqual([])
  })

  it('does not resend the credential handoff after cancellation between transient attempts', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const temporaryRootDir = await mkdtemp(join(tmpdir(), 'dsh-team-management-browser-retry-cancel-test-'))
    cleanups.push(async () => { await rm(temporaryRootDir, { recursive: true, force: true }) })
    const offer = new TeamCredentialHandoffRegistry().create({ teamId: 'team-1', accountId: 'account-1' })
    let releaseLogin = () => {}
    const loginGate = new Promise<void>((resolve) => { releaseLogin = resolve })
    cleanups.push(async () => { releaseLogin() })
    let resolveFirstCompletion!: (response: Response) => void
    const firstCompletion = new Promise<Response>((resolve) => { resolveFirstCompletion = resolve })
    let markFirstCompletionStarted = () => {}
    const firstCompletionStarted = new Promise<void>((resolve) => { markFirstCompletionStarted = resolve })
    let loginSignal: AbortSignal | undefined
    let overviewReads = 0
    let cancellations = 0
    const completionBodies: string[] = []
    const backgroundErrors: unknown[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/overview')) {
        overviewReads += 1
        return new Response(JSON.stringify(overview({
          contributions: overviewReads === 1
            ? []
            : [{ ...contribution(), status: 'authorizing', lastError: undefined }],
        })), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/contributions/oauth/start')) {
        return new Response(JSON.stringify({
          account: { ...contribution(), status: 'authorizing', lastError: undefined },
          method: 'browser_handoff',
          handoff: offer,
        }), { status: 201, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith(TEAM_CONTRIBUTION_OAUTH_HANDOFF_COMPLETE_PATH)) {
        completionBodies.push(String(init?.body))
        markFirstCompletionStarted()
        return await firstCompletion
      }
      if (url.endsWith('/contributions/oauth/cancel')) {
        cancellations += 1
        return new Response(JSON.stringify({
          account: { ...contribution(), status: 'revoked', lastError: undefined },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`unexpected remote request: ${url}`)
    })
    const loginProfile = async (interaction: AuthInteraction, store: OpenAICodexProfileStore) => {
      loginSignal = interaction.signal
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/oauth/authorize?state=retry-cancel' })
      await loginGate
      return store.addProfile('Captured OAuth', {
        type: 'oauth', access: 'provider-access-secret', refresh: 'provider-refresh-secret',
        expires: Date.now() + 3_600_000, accountId: 'provider-account-1',
      })
    }
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
      { loginProfile, temporaryRootDir, onBackgroundError: error => { backgroundErrors.push(error) } },
    )

    await expect(response(route(routes, TEAM_MANAGEMENT_OAUTH_START_PATH).handler, request('POST', withExpectedContext({
      label: 'Personal Pro', method: 'browser',
    })))).resolves.toMatchObject({ status: 201 })
    releaseLogin()
    await firstCompletionStarted

    const cancellation = response(route(routes, TEAM_MANAGEMENT_OAUTH_CANCEL_PATH).handler, request('POST', withExpectedContext({
      accountId: 'account-1', discardInitial: true,
    })))
    await vi.waitFor(() => { expect(loginSignal?.aborted).toBe(true) })
    resolveFirstCompletion(new Response('temporarily unavailable', {
      status: 503,
      headers: { 'content-type': 'text/plain' },
    }))

    await expect(cancellation).resolves.toMatchObject({ status: 200, body: { account: { status: 'revoked' } } })
    expect(completionBodies).toHaveLength(1)
    expect(overviewReads).toBe(3)
    expect(cancellations).toBe(1)
    expect(backgroundErrors).toEqual([])
    expect(credentials.get(BROWSER_OAUTH_PENDING_REF)).toBeUndefined()
    expect(await readdir(temporaryRootDir)).toEqual([])
  })

  it('does not retry a transient Team context read after cancellation', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const temporaryRootDir = await mkdtemp(join(tmpdir(), 'dsh-team-management-browser-context-cancel-test-'))
    cleanups.push(async () => { await rm(temporaryRootDir, { recursive: true, force: true }) })
    const offer = new TeamCredentialHandoffRegistry().create({ teamId: 'team-1', accountId: 'account-1' })
    let releaseLogin = () => {}
    const loginGate = new Promise<void>((resolve) => { releaseLogin = resolve })
    cleanups.push(async () => { releaseLogin() })
    let rejectPostLoginOverview!: (error: unknown) => void
    const postLoginOverview = new Promise<Response>((_resolve, reject) => { rejectPostLoginOverview = reject })
    let markPostLoginOverviewStarted = () => {}
    const postLoginOverviewStarted = new Promise<void>((resolve) => { markPostLoginOverviewStarted = resolve })
    let loginSignal: AbortSignal | undefined
    let overviewReads = 0
    let handoffCompletions = 0
    let cancellations = 0
    const backgroundErrors: unknown[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/overview')) {
        overviewReads += 1
        if (overviewReads === 2) {
          markPostLoginOverviewStarted()
          return await postLoginOverview
        }
        return new Response(JSON.stringify(overview({
          contributions: overviewReads === 1
            ? []
            : [{ ...contribution(), status: 'authorizing', lastError: undefined }],
        })), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/contributions/oauth/start')) {
        return new Response(JSON.stringify({
          account: { ...contribution(), status: 'authorizing', lastError: undefined },
          method: 'browser_handoff',
          handoff: offer,
        }), { status: 201, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith(TEAM_CONTRIBUTION_OAUTH_HANDOFF_COMPLETE_PATH)) {
        handoffCompletions += 1
        throw new Error('credential handoff must not start after cancellation')
      }
      if (url.endsWith('/contributions/oauth/cancel')) {
        cancellations += 1
        return new Response(JSON.stringify({
          account: { ...contribution(), status: 'revoked', lastError: undefined },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`unexpected remote request: ${url}`)
    })
    const loginProfile = async (interaction: AuthInteraction, store: OpenAICodexProfileStore) => {
      loginSignal = interaction.signal
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/oauth/authorize?state=context-cancel' })
      await loginGate
      return store.addProfile('Captured OAuth', {
        type: 'oauth', access: 'provider-access-secret', refresh: 'provider-refresh-secret',
        expires: Date.now() + 3_600_000, accountId: 'provider-account-1',
      })
    }
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
      { loginProfile, temporaryRootDir, onBackgroundError: error => { backgroundErrors.push(error) } },
    )

    await expect(response(route(routes, TEAM_MANAGEMENT_OAUTH_START_PATH).handler, request('POST', withExpectedContext({
      label: 'Personal Pro', method: 'browser',
    })))).resolves.toMatchObject({ status: 201 })
    releaseLogin()
    await postLoginOverviewStarted

    const cancellation = response(route(routes, TEAM_MANAGEMENT_OAUTH_CANCEL_PATH).handler, request('POST', withExpectedContext({
      accountId: 'account-1', discardInitial: true,
    })))
    await vi.waitFor(() => { expect(loginSignal?.aborted).toBe(true) })
    rejectPostLoginOverview(new TypeError('temporary Team connection reset'))

    await expect(cancellation).resolves.toMatchObject({ status: 200, body: { account: { status: 'revoked' } } })
    expect(overviewReads).toBe(3)
    expect(handoffCompletions).toBe(0)
    expect(cancellations).toBe(1)
    expect(backgroundErrors).toEqual([])
    expect(credentials.get(BROWSER_OAUTH_PENDING_REF)).toBeUndefined()
    expect(await readdir(temporaryRootDir)).toEqual([])
  })

  it('retries a transient Team context read after browser sign-in before completing the handoff', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const temporaryRootDir = await mkdtemp(join(tmpdir(), 'dsh-team-management-browser-context-retry-test-'))
    cleanups.push(async () => { await rm(temporaryRootDir, { recursive: true, force: true }) })
    const handoffs = new TeamCredentialHandoffRegistry()
    const offer = handoffs.create({ teamId: 'team-1', accountId: 'account-1' })
    let releaseLogin = () => {}
    const loginGate = new Promise<void>((resolve) => { releaseLogin = resolve })
    cleanups.push(async () => { releaseLogin() })
    let overviewReads = 0
    let handoffCompletions = 0
    let cancellations = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/overview')) {
        overviewReads += 1
        if (overviewReads === 2) throw new TypeError('temporary Team connection reset')
        return new Response(JSON.stringify(overview({
          contributions: overviewReads === 1
            ? []
            : [{ ...contribution(), status: 'authorizing', lastError: undefined }],
        })), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/contributions/oauth/start')) {
        return new Response(JSON.stringify({
          account: { ...contribution(), status: 'authorizing', lastError: undefined },
          method: 'browser_handoff',
          handoff: offer,
        }), { status: 201, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith(TEAM_CONTRIBUTION_OAUTH_HANDOFF_COMPLETE_PATH)) {
        handoffCompletions += 1
        const body = JSON.parse(String(init?.body)) as {
          accountId: string
          envelope: Parameters<typeof handoffs.complete>[1]
        }
        handoffs.complete({ teamId: 'team-1', accountId: body.accountId }, body.envelope)
        return new Response(JSON.stringify({
          account: { ...contribution(), label: 'Captured OAuth', status: 'active', lastError: undefined },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/contributions/oauth/cancel')) {
        cancellations += 1
        return new Response(JSON.stringify({
          account: { ...contribution(), status: 'revoked', lastError: TEAM_AUTHORIZATION_NETWORK_UNAVAILABLE_CODE },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`unexpected remote request: ${url}; ${String(init?.body)}`)
    })
    const loginProfile = async (interaction: AuthInteraction, store: OpenAICodexProfileStore) => {
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/oauth/authorize?state=context-retry' })
      await loginGate
      return store.addProfile('Captured OAuth', {
        type: 'oauth', access: 'provider-access-secret', refresh: 'provider-refresh-secret',
        expires: Date.now() + 3_600_000, accountId: 'provider-account-1',
      })
    }
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
      { loginProfile, temporaryRootDir },
    )

    await expect(response(route(routes, TEAM_MANAGEMENT_OAUTH_START_PATH).handler, request('POST', withExpectedContext({
      label: 'Personal Pro', method: 'browser',
    })))).resolves.toMatchObject({ status: 201 })
    releaseLogin()

    await vi.waitFor(() => { expect(handoffCompletions).toBe(1) })
    expect(overviewReads).toBe(3)
    expect(cancellations).toBe(0)
    expect(await readdir(temporaryRootDir)).toEqual([])
  })

  it('does not retry a terminal handoff response after browser sign-in', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const temporaryRootDir = await mkdtemp(join(tmpdir(), 'dsh-team-management-browser-terminal-handoff-test-'))
    cleanups.push(async () => { await rm(temporaryRootDir, { recursive: true, force: true }) })
    const offer = new TeamCredentialHandoffRegistry().create({ teamId: 'team-1', accountId: 'account-1' })
    let releaseLogin = () => {}
    const loginGate = new Promise<void>((resolve) => { releaseLogin = resolve })
    cleanups.push(async () => { releaseLogin() })
    let overviewReads = 0
    let handoffCompletions = 0
    let cancellations = 0
    const backgroundErrors: unknown[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/overview')) {
        overviewReads += 1
        return new Response(JSON.stringify(overview({
          contributions: overviewReads === 1
            ? []
            : [{ ...contribution(), status: 'authorizing', lastError: undefined }],
        })), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/contributions/oauth/start')) {
        return new Response(JSON.stringify({
          account: { ...contribution(), status: 'authorizing', lastError: undefined },
          method: 'browser_handoff',
          handoff: offer,
        }), { status: 201, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith(TEAM_CONTRIBUTION_OAUTH_HANDOFF_COMPLETE_PATH)) {
        handoffCompletions += 1
        return new Response(JSON.stringify({ error: 'handoff expired' }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/contributions/oauth/cancel')) {
        cancellations += 1
        return new Response(JSON.stringify({
          account: { ...contribution(), status: 'revoked', lastError: TEAM_AUTHORIZATION_FAILED_CODE },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`unexpected remote request: ${url}`)
    })
    const loginProfile = async (interaction: AuthInteraction, store: OpenAICodexProfileStore) => {
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/oauth/authorize?state=terminal-handoff' })
      await loginGate
      return store.addProfile('Captured OAuth', {
        type: 'oauth', access: 'provider-access-secret', refresh: 'provider-refresh-secret',
        expires: Date.now() + 3_600_000, accountId: 'provider-account-1',
      })
    }
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
      { loginProfile, temporaryRootDir, onBackgroundError: error => { backgroundErrors.push(error) } },
    )

    await expect(response(route(routes, TEAM_MANAGEMENT_OAUTH_START_PATH).handler, request('POST', withExpectedContext({
      label: 'Personal Pro', method: 'browser',
    })))).resolves.toMatchObject({ status: 201 })
    releaseLogin()

    await vi.waitFor(() => { expect(backgroundErrors).toHaveLength(1) })
    expect(backgroundErrors[0]).toMatchObject({ message: TEAM_AUTHORIZATION_FAILED_CODE })
    expect(handoffCompletions).toBe(1)
    expect(cancellations).toBe(1)
    expect(await readdir(temporaryRootDir)).toEqual([])
  })

  it('preserves the local profile binding when cancellation races with an active completion', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    credentials.put(LOCAL_CONTRIBUTION_BINDINGS_REF, JSON.stringify({
      version: 1,
      bindings: [{
        expectedContext: EXPECTED_CONTEXT,
        accountId: 'account-1',
        sourceLocalProfileId: 'local-profile-1',
      }],
    }))
    credentials.put(BROWSER_OAUTH_PENDING_REF, JSON.stringify({
      version: 1,
      operations: [{
        expectedContext: EXPECTED_CONTEXT,
        pending: {
          accountId: 'account-1', method: 'browser', expiresAt: Date.now() + 900_000, discardInitial: true,
        },
      }],
    }))
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/overview')) {
        return new Response(JSON.stringify(overview({
          contributions: [{ ...contribution(), status: 'active', lastError: undefined }],
        })), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/contributions/oauth/cancel')) {
        return new Response(JSON.stringify({
          account: { ...contribution(), status: 'active', lastError: undefined },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`unexpected remote request: ${url}`)
    })
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
    )

    const cancelled = await response(route(routes, TEAM_MANAGEMENT_OAUTH_CANCEL_PATH).handler, request('POST', withExpectedContext({
      accountId: 'account-1', discardInitial: true,
    })))

    expect(cancelled).toMatchObject({ status: 200, body: { account: { status: 'active' } } })
    expect(JSON.parse(credentials.get(LOCAL_CONTRIBUTION_BINDINGS_REF) ?? '{}')).toMatchObject({
      bindings: [{ accountId: 'account-1', sourceLocalProfileId: 'local-profile-1' }],
    })
    expect(credentials.get(BROWSER_OAUTH_PENDING_REF)).toBeUndefined()
  })

  it('times out browser OAuth at the local authorization deadline and removes the initial contribution', async () => {
    vi.useFakeTimers()
    try {
      const localNow = 1_800_000_000_000
      vi.setSystemTime(localNow)
      const credentials = new FakeCredentials()
      credentials.value = 'dsh_team_member-secret-1234567890'
      const mutationFetch = vi.fn<typeof globalThis.fetch>(async (input) => {
        const url = String(input)
        if (url.endsWith('/contributions/oauth/start')) {
          return new Response(JSON.stringify({
            account: { ...contribution(), status: 'authorizing', lastError: undefined },
            method: 'browser_handoff',
            handoff: {
              version: 1,
              sessionId: 'timeout-session',
              serverPublicKey: 'unused-before-timeout',
              expiresAt: localNow + 30,
            },
          }), { status: 201, headers: { 'content-type': 'application/json' } })
        }
        if (url.endsWith('/contributions/oauth/cancel')) {
          return new Response(JSON.stringify({
            account: { ...contribution(), status: 'revoked', lastError: undefined },
          }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        throw new Error(`unexpected remote request: ${url}`)
      })
      const loginProfile = (interaction: AuthInteraction): Promise<never> => {
        interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/oauth/authorize?state=timeout' })
        return new Promise((_resolve, reject) => {
          interaction.signal.addEventListener('abort', () => { reject(interaction.signal.reason) }, { once: true })
        })
      }
      const { routes } = setup(
        { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
        credentials,
        withOverviewSequence(mutationFetch, [
          overview(),
          overview({
            contributions: [{ ...contribution(), status: 'authorizing', lastError: undefined }],
          }),
        ]),
        { loginProfile },
      )

      const started = await response(route(routes, TEAM_MANAGEMENT_OAUTH_START_PATH).handler, request('POST', withExpectedContext({
        label: 'Personal Pro', method: 'browser',
      })))
      expect(started).toMatchObject({
        status: 201,
        body: { expiresAt: localNow + TEAM_CREDENTIAL_HANDOFF_TTL_MS },
      })

      await vi.advanceTimersByTimeAsync(30)
      expect(mutationFetch.mock.calls.some(([input]) => String(input).endsWith('/contributions/oauth/cancel')))
        .toBe(false)
      expect(credentials.get(BROWSER_OAUTH_PENDING_REF)).toBeDefined()

      await vi.advanceTimersByTimeAsync(TEAM_CREDENTIAL_HANDOFF_TTL_MS - 30)
      await vi.waitFor(() => {
        expect(mutationFetch.mock.calls.some(([input]) => String(input).endsWith('/contributions/oauth/cancel')))
          .toBe(true)
        expect(credentials.get(BROWSER_OAUTH_PENDING_REF)).toBeUndefined()
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a browser OAuth account mismatch and discards the initial remote contribution', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const temporaryRootDir = await mkdtemp(join(tmpdir(), 'dsh-team-management-browser-mismatch-test-'))
    cleanups.push(async () => { await rm(temporaryRootDir, { recursive: true, force: true }) })
    const offer = new TeamCredentialHandoffRegistry().create({ teamId: 'team-1', accountId: 'account-1' })
    let releaseLogin = () => {}
    const loginGate = new Promise<void>((resolve) => { releaseLogin = resolve })
    cleanups.push(async () => { releaseLogin() })
    const backgroundErrors: unknown[] = []
    const mutationFetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/contributions/oauth/start')) {
        return new Response(JSON.stringify({
          account: { ...contribution(), status: 'authorizing', lastError: undefined },
          method: 'browser_handoff',
          handoff: offer,
        }), { status: 201, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/contributions/oauth/cancel')) {
        return new Response(JSON.stringify({
          account: { ...contribution(), status: 'revoked', lastError: undefined },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`unexpected remote request: ${url}; ${String(init?.body)}`)
    })
    const loginProfile = async (interaction: AuthInteraction, store: OpenAICodexProfileStore) => {
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/oauth/authorize?state=mismatch' })
      await loginGate
      return store.addProfile('Different OAuth', {
        type: 'oauth',
        access: 'different-provider-access-secret',
        refresh: 'different-provider-refresh-secret',
        expires: Date.now() + 3_600_000,
        accountId: 'provider-account-2',
      })
    }
    const fetch = withOverviewSequence(mutationFetch, [
      overview(),
      overview({
        contributions: [{ ...contribution(), status: 'authorizing', lastError: undefined }],
      }),
      overview({
        contributions: [{ ...contribution(), status: 'revoked', lastError: undefined }],
      }),
    ])
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
      {
        loginProfile,
        temporaryRootDir,
        onBackgroundError: error => { backgroundErrors.push(error) },
        localProfiles: {
          listProfiles: async () => [{ id: 'local-profile-1', label: 'Local', createdAt: 1, updatedAt: 1 }],
          readProfileProviderAccountId: async () => 'provider-account-1',
        },
      },
    )

    const result = await response(route(routes, TEAM_MANAGEMENT_OAUTH_START_PATH).handler, request('POST', withExpectedContext({
      label: 'Personal Pro', method: 'browser', sourceLocalProfileId: 'local-profile-1',
    })))

    expect(result).toMatchObject({
      status: 201,
      body: { method: 'browser', authorizationUrl: 'https://auth.openai.com/oauth/authorize?state=mismatch' },
    })
    const pending = await response(route(routes, TEAM_MANAGEMENT_OVERVIEW_PATH).handler, request('GET'))
    expect(pending.body.pendingBrowserAuthorization).toMatchObject({
      accountId: 'account-1', method: 'browser', discardInitial: true,
    })
    releaseLogin()
    await vi.waitFor(() => { expect(backgroundErrors).toHaveLength(1) })
    expect(backgroundErrors[0]).toMatchObject({ message: TEAM_AUTHORIZATION_FAILED_CODE })
    expect(mutationFetch).toHaveBeenCalledTimes(2)
    expect(mutationFetch.mock.calls[1]?.[0]).toBe(
      'https://pool.example/plugins/dsh-codex-shared-pool/team/contributions/oauth/cancel',
    )
    expect(mutationFetch.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({
      accountId: 'account-1',
      discardInitial: true,
      failureCode: TEAM_AUTHORIZATION_FAILED_CODE,
    }))
    expect(mutationFetch.mock.calls.some(([input]) => String(input).endsWith(TEAM_CONTRIBUTION_OAUTH_HANDOFF_COMPLETE_PATH)))
      .toBe(false)
    expect(await readdir(temporaryRootDir)).toEqual([])
    await vi.waitFor(async () => {
      const settled = await response(route(routes, TEAM_MANAGEMENT_OVERVIEW_PATH).handler, request('GET'))
      expect(settled.body.pendingBrowserAuthorization).toBeUndefined()
    })
  })

  it('discards the initial contribution when the provider emits an unsafe browser authorization URL', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const temporaryRootDir = await mkdtemp(join(tmpdir(), 'dsh-team-management-browser-unsafe-url-test-'))
    cleanups.push(async () => { await rm(temporaryRootDir, { recursive: true, force: true }) })
    const offer = new TeamCredentialHandoffRegistry().create({ teamId: 'team-1', accountId: 'account-1' })
    const mutationFetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/contributions/oauth/start')) {
        return new Response(JSON.stringify({
          account: { ...contribution(), status: 'authorizing', lastError: undefined },
          method: 'browser_handoff',
          handoff: offer,
        }), { status: 201, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/contributions/oauth/cancel')) {
        return new Response(JSON.stringify({
          account: { ...contribution(), status: 'revoked', lastError: undefined },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`unexpected remote request: ${url}; ${String(init?.body)}`)
    })
    const loginProfile = async (interaction: AuthInteraction): Promise<never> => {
      interaction.notify({ type: 'auth_url', url: 'file:///tmp/provider-login.html' })
      throw new Error('provider login stopped after unsafe URL')
    }
    const fetch = withOverviewPreflight(mutationFetch)
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
      { loginProfile, temporaryRootDir },
    )

    const result = await response(route(routes, TEAM_MANAGEMENT_OAUTH_START_PATH).handler, request('POST', withExpectedContext({
      label: 'Personal Pro', method: 'browser',
    })))

    expect(result).toMatchObject({ status: 400, body: { error: TEAM_AUTHORIZATION_FAILED_CODE } })
    await vi.waitFor(() => { expect(mutationFetch).toHaveBeenCalledTimes(2) })
    expect(mutationFetch.mock.calls[1]?.[0]).toBe(
      'https://pool.example/plugins/dsh-codex-shared-pool/team/contributions/oauth/cancel',
    )
    expect(mutationFetch.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({
      accountId: 'account-1', discardInitial: true, failureCode: TEAM_AUTHORIZATION_FAILED_CODE,
    }))
    expect(await readdir(temporaryRootDir)).toEqual([])
  })

  it('aborts an in-flight browser OAuth operation when overview discovers a different Team', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const temporaryRootDir = await mkdtemp(join(tmpdir(), 'dsh-team-management-browser-stale-cancel-test-'))
    cleanups.push(async () => { await rm(temporaryRootDir, { recursive: true, force: true }) })
    const offer = new TeamCredentialHandoffRegistry().create({ teamId: 'team-1', accountId: 'account-1' })
    let overviewReads = 0
    let loginAborted = false
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/overview')) {
        overviewReads += 1
        const current = overviewReads === 1
          ? overview()
          : overview({
              team: { ...team(), id: 'replacement-team' },
              contributions: [{ ...contribution(), status: 'authorizing', lastError: undefined }],
            })
        return new Response(JSON.stringify(current), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/contributions/oauth/start')) {
        return new Response(JSON.stringify({
          account: { ...contribution(), status: 'authorizing', lastError: undefined },
          method: 'browser_handoff',
          handoff: offer,
        }), { status: 201, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/contributions/oauth/cancel')) {
        return new Response(JSON.stringify({
          account: { ...contribution(), status: 'revoked', lastError: undefined },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`unexpected remote request: ${url}; ${String(init?.body)}`)
    })
    const loginProfile = async (interaction: AuthInteraction): Promise<never> => {
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/oauth/authorize?state=stale-cancel' })
      return await new Promise<never>((_resolve, reject) => {
        interaction.signal.addEventListener('abort', () => {
          loginAborted = true
          reject(interaction.signal.reason)
        }, { once: true })
      })
    }
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
      { loginProfile, temporaryRootDir },
    )

    const started = await response(route(routes, TEAM_MANAGEMENT_OAUTH_START_PATH).handler, request('POST', withExpectedContext({
      label: 'Personal Pro', method: 'browser',
    })))
    expect(started).toMatchObject({ status: 201, body: { method: 'browser' } })

    const replacementOverview = await response(route(routes, TEAM_MANAGEMENT_OVERVIEW_PATH).handler, request('GET'))
    expect(replacementOverview.body.pendingBrowserAuthorization).toBeUndefined()
    await vi.waitFor(() => { expect(loginAborted).toBe(true) })
    await vi.waitFor(() => {
      expect(fetch.mock.calls.some(([input]) => String(input).endsWith('/contributions/oauth/cancel'))).toBe(true)
    })
    expect(fetch.mock.calls.some(([input]) => String(input).endsWith(TEAM_CONTRIBUTION_OAUTH_HANDOFF_COMPLETE_PATH)))
      .toBe(false)
  })

  it('stops after a retried Team context read detects that the Team changed', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const temporaryRootDir = await mkdtemp(join(tmpdir(), 'dsh-team-management-browser-handoff-context-test-'))
    cleanups.push(async () => { await rm(temporaryRootDir, { recursive: true, force: true }) })
    const offer = new TeamCredentialHandoffRegistry().create({ teamId: 'team-1', accountId: 'account-1' })
    let overviewReads = 0
    let releaseLogin = () => {}
    const loginGate = new Promise<void>((resolve) => { releaseLogin = resolve })
    cleanups.push(async () => { releaseLogin() })
    const backgroundErrors: unknown[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/overview')) {
        overviewReads += 1
        if (overviewReads === 2) throw new TypeError('temporary Team connection reset')
        const current = overviewReads === 1
          ? overview()
          : overview({
              team: { ...team(), id: 'replacement-team' },
              contributions: [],
            })
        return new Response(JSON.stringify(current), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/contributions/oauth/start')) {
        return new Response(JSON.stringify({
          account: { ...contribution(), status: 'authorizing', lastError: undefined },
          method: 'browser_handoff',
          handoff: offer,
        }), { status: 201, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/contributions/oauth/cancel')) {
        return new Response(JSON.stringify({
          account: { ...contribution(), status: 'revoked', lastError: undefined },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith(TEAM_CONTRIBUTION_OAUTH_HANDOFF_COMPLETE_PATH)) {
        throw new Error(`handoff must not be completed after a Team switch: ${String(init?.body)}`)
      }
      throw new Error(`unexpected remote request: ${url}; ${String(init?.body)}`)
    })
    const loginProfile = async (interaction: AuthInteraction, store: OpenAICodexProfileStore) => {
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/oauth/authorize?state=context-race' })
      await loginGate
      return store.addProfile('Captured OAuth', {
        type: 'oauth',
        access: 'provider-access-secret',
        refresh: 'provider-refresh-secret',
        expires: Date.now() + 3_600_000,
        accountId: 'provider-account-1',
      })
    }
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
      { loginProfile, temporaryRootDir, onBackgroundError: error => { backgroundErrors.push(error) } },
    )

    const started = await response(route(routes, TEAM_MANAGEMENT_OAUTH_START_PATH).handler, request('POST', withExpectedContext({
      label: 'Personal Pro', method: 'browser',
    })))
    expect(started).toMatchObject({ status: 201, body: { method: 'browser' } })

    releaseLogin()
    await vi.waitFor(() => { expect(backgroundErrors).toHaveLength(1) })
    expect(overviewReads).toBe(3)
    expect(fetch.mock.calls.some(([input]) => String(input).endsWith('/contributions/oauth/cancel'))).toBe(true)
    expect(fetch.mock.calls.some(([input]) => String(input).endsWith(TEAM_CONTRIBUTION_OAUTH_HANDOFF_COMPLETE_PATH)))
      .toBe(false)
    expect(credentials.get(BROWSER_OAUTH_PENDING_REF)).toBeUndefined()
  })

  it('falls back to legacy cleanup when an older Team Host rejects the safe failure field', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const cancellationBodies: string[] = []
    const mutationFetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/contributions/oauth/start')) {
        return new Response(JSON.stringify({
          account: { ...contribution(), status: 'authorizing', lastError: undefined },
          method: 'browser_handoff',
          handoff: { version: 2 },
        }), { status: 201, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/contributions/oauth/cancel')) {
        cancellationBodies.push(String(init?.body))
        if (cancellationBodies.length === 1) {
          return new Response(JSON.stringify({ error: 'request contains an unknown field' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          })
        }
        if (cancellationBodies.length === 2) throw new TypeError('temporary legacy cleanup connection reset')
        return new Response(JSON.stringify({
          account: { ...contribution(), status: 'revoked', lastError: 'authorization cancelled' },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`unexpected remote request: ${url}; ${String(init?.body)}`)
    })
    const fetch = withOverviewSequence(mutationFetch, [overview()])
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
    )

    const result = await response(route(routes, TEAM_MANAGEMENT_OAUTH_START_PATH).handler, request('POST', withExpectedContext({
      label: 'Personal Pro', method: 'browser',
    })))

    expect(result.status).toBeGreaterThanOrEqual(400)
    expect(cancellationBodies).toEqual([
      JSON.stringify({
        accountId: 'account-1',
        discardInitial: true,
        failureCode: TEAM_AUTHORIZATION_FAILED_CODE,
      }),
      JSON.stringify({ accountId: 'account-1', discardInitial: true }),
      JSON.stringify({ accountId: 'account-1', discardInitial: true }),
    ])
    expect(credentials.get(BROWSER_OAUTH_PENDING_REF)).toBeUndefined()
  })

  it('discards the initial browser OAuth contribution when the local routes are disposed', async () => {
    const credentials = new FakeCredentials()
    credentials.value = 'dsh_team_member-secret-1234567890'
    const temporaryRootDir = await mkdtemp(join(tmpdir(), 'dsh-team-management-browser-dispose-test-'))
    cleanups.push(async () => { await rm(temporaryRootDir, { recursive: true, force: true }) })
    const offer = new TeamCredentialHandoffRegistry().create({ teamId: 'team-1', accountId: 'account-1' })
    let loginAborted = false
    let cancellationAttempts = 0
    const mutationFetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/contributions/oauth/start')) {
        return new Response(JSON.stringify({
          account: { ...contribution(), status: 'authorizing', lastError: undefined },
          method: 'browser_handoff',
          handoff: offer,
        }), { status: 201, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/contributions/oauth/cancel')) {
        cancellationAttempts += 1
        if (cancellationAttempts === 1) throw new TypeError('temporary cleanup connection reset')
        return new Response(JSON.stringify({
          account: { ...contribution(), status: 'revoked', lastError: undefined },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`unexpected remote request: ${url}; ${String(init?.body)}`)
    })
    const loginProfile = async (interaction: AuthInteraction): Promise<never> => {
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/oauth/authorize?state=dispose' })
      return await new Promise<never>((_resolve, reject) => {
        interaction.signal.addEventListener('abort', () => {
          loginAborted = true
          reject(interaction.signal.reason)
        }, { once: true })
      })
    }
    const fetch = withOverviewPreflight(mutationFetch)
    const { routes } = setup(
      { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' },
      credentials,
      fetch,
      { loginProfile, temporaryRootDir },
    )

    const started = await response(route(routes, TEAM_MANAGEMENT_OAUTH_START_PATH).handler, request('POST', withExpectedContext({
      label: 'Personal Pro', method: 'browser',
    })))
    expect(started).toMatchObject({ status: 201, body: { method: 'browser' } })
    const disposeRoutes = cleanups.pop()
    if (disposeRoutes === undefined) throw new Error('route cleanup should be registered')

    await disposeRoutes()

    expect(loginAborted).toBe(true)
    expect(mutationFetch).toHaveBeenCalledTimes(3)
    expect(mutationFetch.mock.calls[1]?.[0]).toBe(
      'https://pool.example/plugins/dsh-codex-shared-pool/team/contributions/oauth/cancel',
    )
    expect(mutationFetch.mock.calls[2]?.[0]).toBe(
      'https://pool.example/plugins/dsh-codex-shared-pool/team/contributions/oauth/cancel',
    )
    expect(mutationFetch.mock.calls[2]?.[1]?.body).toBe(JSON.stringify({
      accountId: 'account-1', discardInitial: true, failureCode: TEAM_AUTHORIZATION_FAILED_CODE,
    }))
    expect(credentials.get(BROWSER_OAUTH_PENDING_REF)).toBeUndefined()
    expect(await readdir(temporaryRootDir)).toEqual([])
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
      request('POST', withExpectedContext({ accountId: 'account-1', method: 'device_code' })),
    )

    expect(result).toMatchObject({ status: 200, body: { account: { id: 'account-1', status: 'authorizing' }, method: 'device_code' } })
    expect(fetch).toHaveBeenCalledWith(
      'https://pool.example/plugins/dsh-codex-shared-pool/team/contributions/oauth/reauthorize',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ accountId: 'account-1', method: 'device_code' }) }),
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
    {
      operation: 'OAuth start',
      path: TEAM_MANAGEMENT_OAUTH_START_PATH,
      body: { label: 'Owner Codex' },
    },
    {
      operation: 'OAuth cancellation',
      path: TEAM_MANAGEMENT_OAUTH_CANCEL_PATH,
      body: { accountId: 'account-1' },
    },
    {
      operation: 'OAuth reauthorization',
      path: TEAM_MANAGEMENT_OAUTH_REAUTHORIZE_PATH,
      body: { accountId: 'account-1' },
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

      expect(result).toMatchObject({
        status: 409,
        body: { error: TEAM_MANAGEMENT_CONTEXT_CHANGED_MESSAGE },
      })
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

describe('saved Team connections', () => {
  const config = { enabled: true, baseUrl: 'https://pool.example/plugins/dsh-codex-shared-pool/team' }
  const connectionsPath = '/plugins/dsh-codex-shared-pool/team-client/connections'
  const switchPath = `${connectionsPath}/switch`
  const oldKey = `dsh_team_${'a'.repeat(43)}`
  const otherTeam = { ...team(), id: 'team-2', name: 'Other Team' }
  const otherMember = { ...member(), id: 'member-2', teamId: 'team-2' }
  const otherContext = { ...EXPECTED_CONTEXT, teamId: 'team-2', currentMemberId: 'member-2' }
  function fixture() {
    const credentials = new FakeCredentials()
    credentials.value = oldKey
    let rejectOther = false
    let failJoin = false
    let joinedKey: string | undefined
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/invites/preview')) return Response.json({ teamName: 'Other Team', label: 'test', expiresAt: Date.now() + 60_000, teamStatus: 'active' })
      if (path.endsWith('/join')) {
        joinedKey = JSON.parse(String(init?.body)).apiKey as string
        if (failJoin) throw new Error('network interrupted')
        return Response.json({ team: otherTeam, member: otherMember }, { status: 201 })
      }
      if (!path.endsWith('/overview')) throw new Error('unexpected remote mutation')
      const key = new Headers(init?.headers).get('authorization')
      if (key === `Bearer ${oldKey}`) return Response.json(overview())
      if (rejectOther) return Response.json({ error: 'unavailable' }, { status: 503 })
      return Response.json(overview({ team: otherTeam, currentMember: otherMember, members: [otherMember], apiKeys: [] }))
    })
    const env = setup(config, credentials, fetch)
    const call = (path: string, body?: unknown) => response(route(env.routes, path).handler, request(body === undefined ? 'GET' : 'POST', body))
    const joinOther = async () => {
      const preview = await call(TEAM_MANAGEMENT_INVITES_PREVIEW_PATH, { inviteToken: 'dsh_invite_test-1234567890' })
      return call(TEAM_MANAGEMENT_JOIN_PATH, { joinHandle: preview.body.joinHandle, displayName: 'Edison', expectedContext: EXPECTED_CONTEXT })
    }
    return { ...env, call, joinOther, rejectOther: () => { rejectOther = true }, failJoin: () => { failJoin = true }, joinedKey: () => joinedKey }
  }

  it('joins another Team, survives restart, and switches back without revoking anything or exposing keys', async () => {
    const env = fixture()
    expect((await env.joinOther()).status).toBe(201)
    const secondKey = env.credentials.value
    expect(secondKey).not.toBe(oldKey)
    const restarted = setup(config, env.credentials, env.fetch)
    const listed = await response(route(restarted.routes, connectionsPath).handler, request('GET'))
    expect(listed.status).toBe(200)
    expect(JSON.stringify(listed.body)).not.toMatch(/dsh_team_|apiKey|tokenHash/)
    const saved = (listed.body.connections as Array<{ id: string; teamId: string }>).find(item => item.teamId === 'team-1')!
    expect(saved).toBeDefined()
    const switched = await response(route(restarted.routes, switchPath).handler, request('POST', { connectionId: saved.id, expectedContext: otherContext }))
    expect(switched.status).toBe(200)
    expect(env.credentials.value).toBe(oldKey)
    expect(JSON.stringify(switched.body)).not.toContain(secondKey)
    const listAgain = await env.call(connectionsPath)
    const second = (listAgain.body.connections as Array<{ id: string; teamId: string }>).find(item => item.teamId === 'team-2')!
    expect((await env.call(switchPath, { connectionId: second.id, expectedContext: EXPECTED_CONTEXT })).status).toBe(200)
    expect(env.credentials.value).toBe(secondKey)
  })

  it('keeps the original connection on an uncertain join and recovers after restart', async () => {
    const env = fixture()
    env.failJoin()
    expect((await env.joinOther()).status).toBeGreaterThanOrEqual(400)
    expect(env.credentials.value).toBe(oldKey)
    const restarted = setup(config, env.credentials, env.fetch)
    const recovered = await response(route(restarted.routes, TEAM_MANAGEMENT_JOIN_RECOVER_PATH).handler, request('POST', {}))
    expect(recovered.status).toBe(200)
    expect(env.credentials.value).toBe(env.joinedKey())
  })

  it('rejects stale context and unavailable destinations without replacing the active key', async () => {
    const env = fixture()
    expect((await env.joinOther()).status).toBe(201)
    const listed = await env.call(connectionsPath)
    const saved = (listed.body.connections as Array<{ id: string }>)[0]!
    expect((await env.call(switchPath, { connectionId: saved.id, expectedContext: EXPECTED_CONTEXT })).status).toBe(409)
    const secondKey = env.credentials.value
    expect(env.credentials.value).toBe(secondKey)
    expect((await env.call(switchPath, { connectionId: saved.id, expectedContext: otherContext })).status).toBe(200)
    const second = ((await env.call(connectionsPath)).body.connections as Array<{ id: string; teamId: string }>).find(item => item.teamId === 'team-2')!
    env.rejectOther()
    expect((await env.call(switchPath, { connectionId: second.id, expectedContext: EXPECTED_CONTEXT })).status).toBeGreaterThanOrEqual(400)
    expect(env.credentials.value).toBe(oldKey)
  })

  it('blocks switching and joining when the active credential is readonly', async () => {
    const env = fixture()
    await env.joinOther()
    const saved = ((await env.call(connectionsPath)).body.connections as Array<{ id: string }>)[0]!
    const currentKey = env.credentials.value
    env.credentials.readonlyRefs.add(TEAM_KEY_REF)
    expect((await env.call(switchPath, { connectionId: saved.id, expectedContext: otherContext })).status).toBeGreaterThanOrEqual(400)
    expect((await env.joinOther()).status).toBeGreaterThanOrEqual(400)
    expect(env.credentials.value).toBe(currentKey)
  })

  it('blocks switching while a join is uncertain and scopes saved identities to the server', async () => {
    const env = fixture()
    env.failJoin()
    await env.joinOther()
    const saved = ((await env.call(connectionsPath)).body.connections as Array<{ id: string }>)[0]!
    expect((await env.call(switchPath, { connectionId: saved.id, expectedContext: EXPECTED_CONTEXT })).status).toBeGreaterThanOrEqual(400)
    expect(env.credentials.value).toBe(oldKey)
    const otherServer = setup({ ...config, baseUrl: 'https://other.example/plugins/dsh-codex-shared-pool/team' }, env.credentials, env.fetch)
    const listed = await response(route(otherServer.routes, connectionsPath).handler, request('GET'))
    expect(listed.body.connections).toEqual([])
  })

})
