import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function parseEnv(content: string): Record<string, string> {
  return Object.fromEntries(content.trim().split('\n').map((line) => {
    const separator = line.indexOf('=')
    if (separator < 1) throw new Error(`invalid env line: ${line}`)
    return [line.slice(0, separator), line.slice(separator + 1)]
  }))
}

describe('self-hosted deployment assets', () => {
  it('publishes an explicit deployment allowlist that can never capture runtime secrets', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { files?: string[] }
    const deploymentFiles = packageJson.files?.filter(path => path.startsWith('deploy/'))

    expect(deploymentFiles).toEqual([
      'deploy/broker/Dockerfile',
      'deploy/broker/Dockerfile.dockerignore',
      'deploy/edge/Dockerfile',
      'deploy/edge/server.mjs',
      'deploy/host/bootstrap.mjs',
      'deploy/host/Dockerfile',
      'deploy/host/Dockerfile.dockerignore',
      'deploy/host/ensure-installed-team-plugin.mjs',
      'deploy/host/smoke-live-sharing.mjs',
      'deploy/host/smoke-live-team-routing.mjs',
      'deploy/host/smoke-multi-team.mjs',
      'deploy/host/start-team-host.sh',
      'deploy/host/team-host.patch.yml',
      'deploy/host/wait-for-credential-broker.mjs',
      'deploy/postgres/init-runtime-logins.sh',
      'deploy/postgres/runtime-roles.sql',
      'deploy/self-hosted/compose.yml',
      'deploy/self-hosted/init-secrets.mjs',
    ])
    expect(packageJson.files?.join('\n')).not.toMatch(/\.secrets|\.env|deploy\/\*\*/u)
  })

  it('generates separate migrator, Team Host, and Credential Broker database identities without overwriting them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-team-deploy-'))
    try {
      const { initializeSelfHostedSecrets } = await import('../deploy/self-hosted/init-secrets.mjs')

      const created = await initializeSelfHostedSecrets(root)
      const postgresPath = join(root, '.secrets', 'postgres.env')
      const migrationPath = join(root, '.secrets', 'team-migrations.env')
      const hostPath = join(root, '.secrets', 'team-host.env')
      const brokerPath = join(root, '.secrets', 'credential-broker.env')
      expect(created).toEqual({ postgresPath, migrationPath, hostPath, brokerPath })

      const postgres = parseEnv(await readFile(postgresPath, 'utf8'))
      const migration = parseEnv(await readFile(migrationPath, 'utf8'))
      const host = parseEnv(await readFile(hostPath, 'utf8'))
      const broker = parseEnv(await readFile(brokerPath, 'utf8'))
      expect(postgres.POSTGRES_DB).toBe('dsh_codex_shared_pool')
      expect(postgres.POSTGRES_USER).toBe('dsh_team_migrator')
      expect(postgres.POSTGRES_PASSWORD).toMatch(/^[a-f0-9]{48}$/u)
      expect(postgres.POSTGRES_TEAM_HOST_PASSWORD).toMatch(/^[a-f0-9]{48}$/u)
      expect(postgres.POSTGRES_TEAM_BROKER_PASSWORD).toMatch(/^[a-f0-9]{48}$/u)
      expect(new Set([
        postgres.POSTGRES_PASSWORD,
        postgres.POSTGRES_TEAM_HOST_PASSWORD,
        postgres.POSTGRES_TEAM_BROKER_PASSWORD,
      ])).toHaveProperty('size', 3)
      expect(migration.DSH_CODEX_SHARED_POOL_DATABASE_URL).toBe(
        `postgres://dsh_team_migrator:${postgres.POSTGRES_PASSWORD}@postgres:5432/dsh_codex_shared_pool`,
      )
      expect(host.DSH_CODEX_SHARED_POOL_DATABASE_URL).toBe(
        `postgres://dsh_team_host_login:${postgres.POSTGRES_TEAM_HOST_PASSWORD}@postgres:5432/dsh_codex_shared_pool`,
      )
      expect(broker.DSH_CODEX_SHARED_POOL_DATABASE_URL).toBe(
        `postgres://dsh_team_broker_login:${postgres.POSTGRES_TEAM_BROKER_PASSWORD}@postgres:5432/dsh_codex_shared_pool`,
      )
      expect(migration).not.toHaveProperty('DSH_CODEX_SHARED_POOL_BOOTSTRAP_TOKEN')
      expect(migration).not.toHaveProperty('DSH_CODEX_SHARED_POOL_CREDENTIAL_MASTER_KEY')
      expect(migration).not.toHaveProperty('DSH_CODEX_SHARED_POOL_INVITE_MASTER_KEY')
      expect(host).not.toHaveProperty('DSH_CODEX_SHARED_POOL_CREDENTIAL_MASTER_KEY')
      expect(Buffer.from(host.DSH_CODEX_SHARED_POOL_INVITE_MASTER_KEY, 'base64')).toHaveLength(32)
      expect(Buffer.from(broker.DSH_CODEX_SHARED_POOL_CREDENTIAL_MASTER_KEY, 'base64')).toHaveLength(32)
      expect(broker).not.toHaveProperty('DSH_CODEX_SHARED_POOL_INVITE_MASTER_KEY')
      expect(host.DSH_CODEX_SHARED_POOL_INVITE_MASTER_KEY).not.toBe(
        broker.DSH_CODEX_SHARED_POOL_CREDENTIAL_MASTER_KEY,
      )
      expect(host.DSH_CODEX_SHARED_POOL_CREDENTIAL_BROKER_API_KEY).toBe(
        broker.DSH_CODEX_SHARED_POOL_CREDENTIAL_BROKER_API_KEY,
      )
      expect(host.DSH_CODEX_SHARED_POOL_CREDENTIAL_BROKER_API_KEY.length).toBeGreaterThanOrEqual(32)
      expect(broker.DSH_CODEX_SHARED_POOL_DATABASE_URL).not.toBe(host.DSH_CODEX_SHARED_POOL_DATABASE_URL)
      expect(broker.DSH_CODEX_TEAM_BROKER_HOST).toBe('127.0.0.1')
      expect(host.DSH_CODEX_SHARED_POOL_BOOTSTRAP_TOKEN.length).toBeGreaterThanOrEqual(32)
      expect((await stat(postgresPath)).mode & 0o777).toBe(0o600)
      expect((await stat(migrationPath)).mode & 0o777).toBe(0o600)
      expect((await stat(hostPath)).mode & 0o777).toBe(0o600)
      expect((await stat(brokerPath)).mode & 0o777).toBe(0o600)

      await expect(initializeSelfHostedSecrets(root)).rejects.toThrow(/already exist/u)
      expect(parseEnv(await readFile(postgresPath, 'utf8'))).toEqual(postgres)
      expect(parseEnv(await readFile(migrationPath, 'utf8'))).toEqual(migration)
      expect(parseEnv(await readFile(hostPath, 'utf8'))).toEqual(host)
      expect(parseEnv(await readFile(brokerPath, 'utf8'))).toEqual(broker)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps the central Host image non-root and pinned to the verified DSH release', async () => {
    const dockerfile = await readFile(new URL('../deploy/host/Dockerfile', import.meta.url), 'utf8')
    expect(dockerfile).toMatch(/FROM node:24-bookworm-slim AS runtime/u)
    expect(dockerfile).toMatch(
      /npm install --global[\s\\]+pnpm@11\.7\.0[\s\\]+@deepseek-ai\/dsh@0\.1\.0-rc\.8/u,
    )
    expect(dockerfile).toMatch(/--before=2026-08-20T00:00:00\.000Z/u)
    expect(dockerfile).toMatch(/corepack disable/u)
    expect(dockerfile).not.toMatch(/pnpm add --global @deepseek-ai\/dsh/u)
    expect(dockerfile).toMatch(/COPY[^\n]*THIRD_PARTY_NOTICES\.md/u)
    expect(dockerfile).toMatch(/pnpm pack/u)
    const installer = await readFile(
      new URL('../deploy/host/ensure-installed-team-plugin.mjs', import.meta.url),
      'utf8',
    )
    expect(installer).toContain("spawn('dsh', ['plugin', '--profile', 'web', 'add', packagePath]")
    expect(installer).toContain("'/opt/dsh/plugin-package/dsh-codex-shared-pool.tgz'")
    expect(dockerfile).toMatch(
      /ln -s \/opt\/dsh-home\/profiles\/web\/node_modules\/dsh-codex-shared-pool[\s\\]+\/usr\/local\/lib\/node_modules\/@deepseek-ai\/dsh\/node_modules\/dsh-codex-shared-pool/u,
    )
    expect(dockerfile).toMatch(/require\('\/usr\/local\/lib\/node_modules\/@deepseek-ai\/dsh\/node_modules\/node-pty'\)/u)
    expect(dockerfile).toMatch(/USER node/u)
    expect(dockerfile).toContain('deploy/host/smoke-multi-team.mjs')
    expect(dockerfile).toContain('deploy/host/smoke-live-sharing.mjs')
    expect(dockerfile).toContain('deploy/host/smoke-live-team-routing.mjs')
    expect(dockerfile).toContain('deploy/host/ensure-installed-team-plugin.mjs')
    expect(dockerfile).toContain('deploy/host/wait-for-credential-broker.mjs')
    expect(dockerfile).toContain('deploy/host/start-team-host.sh')
    expect(dockerfile).toContain('lib/team-migrate-bin.js')
    expect(dockerfile).toMatch(/HEALTHCHECK[\s\S]*team\/overview[\s\S]*r\.status !== 401/u)
    expect(dockerfile).toMatch(/ENTRYPOINT \["sh", "\/opt\/dsh\/deploy\/host\/start-team-host\.sh"\]/u)
    expect(dockerfile).not.toMatch(/"--host", "0\.0\.0\.0"/u)
  })

  it('ships the guarded two-contributor live routing command', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> }
    const runner = await readFile(
      new URL('../deploy/host/smoke-live-team-routing.mjs', import.meta.url),
      'utf8',
    )

    expect(packageJson.scripts?.['smoke:team-live-routing']).toBe(
      'node deploy/host/smoke-live-team-routing.mjs',
    )
    expect(runner).toContain('--confirm-two-contributor-live-openai-test-data')
    expect(runner).toMatch(/if \(options\.confirmed !== true\)/u)
  })

  it('keeps the self-hosted plan on rc.8 while preserving rc.7 observations as history', async () => {
    const plan = await readFile(
      new URL('../docs/superpowers/plans/2026-08-20-self-hosted-credential-broker.md', import.meta.url),
      'utf8',
    )

    expect(plan).toMatch(/\*\*Tech Stack:\*\*[\s\S]*stock `@deepseek-ai\/dsh@0\.1\.0-rc\.8`/u)
    expect(plan).toMatch(/fresh isolated `DSH_HOME`[\s\S]*stock DSH `0\.1\.0-rc\.8`/u)
    expect(plan).toMatch(/Historical rc\.7 deployment observations/u)
    expect(plan).toMatch(/current rc\.8 image/u)
  })

  it('uses secret references in the Host patch and a private-by-default Compose topology', async () => {
    const patch = await readFile(new URL('../deploy/host/team-host.patch.yml', import.meta.url), 'utf8')
    expect(patch).toMatch(/storage:\s*postgres/u)
    expect(patch).toMatch(/databaseUrlRef:\s*DSH_CODEX_SHARED_POOL_DATABASE_URL/u)
    expect(patch).toMatch(/credentialBroker:\s*remote/u)
    expect(patch).toMatch(
      /credentialBrokerBaseUrl:\s*http:\/\/127\.0\.0\.1:8788\/v1\/dsh-team-credential-broker/u,
    )
    expect(patch).toMatch(
      /credentialBrokerApiKeyRef:\s*DSH_CODEX_SHARED_POOL_CREDENTIAL_BROKER_API_KEY/u,
    )
    expect(patch).not.toMatch(/credentialMasterKeyRef/u)
    expect(patch).toMatch(/inviteTokenMasterKeyRef:\s*DSH_CODEX_SHARED_POOL_INVITE_MASTER_KEY/u)
    expect(patch).toMatch(/bootstrapTokenRef:\s*DSH_CODEX_SHARED_POOL_BOOTSTRAP_TOKEN/u)
    expect(patch).not.toMatch(/postgres:\/\//u)

    const compose = await readFile(new URL('../deploy/self-hosted/compose.yml', import.meta.url), 'utf8')
    expect(compose).toMatch(/image:\s*postgres:17-alpine/u)
    expect(compose).toMatch(/127\.0\.0\.1\}:\$\{DSH_TEAM_PORT:-3080\}:3080/u)
    expect(compose).toMatch(/condition:\s*service_healthy/u)
    expect(compose).toMatch(/cap_drop:\s*\n\s*- ALL/u)
    expect(compose).toMatch(/no-new-privileges:true/u)
    expect(compose).toMatch(/credential-broker:[\s\S]*dockerfile:\s*deploy\/broker\/Dockerfile/u)
    expect(compose).toMatch(/team-migrations:[\s\S]*DSH_TEAM_MIGRATION_ENV_FILE:-\.\/\.secrets\/team-migrations\.env/u)
    expect(compose).toMatch(/team-migrations:[\s\S]*lib\/team-migrate-bin\.js/u)
    expect(compose).toMatch(/team-host:[\s\S]*team-migrations:[\s\S]*condition:\s*service_completed_successfully/u)
    expect(compose).toMatch(/credential-broker:[\s\S]*team-migrations:[\s\S]*condition:\s*service_completed_successfully/u)
    expect(compose).toMatch(/init-runtime-logins\.sh:\/docker-entrypoint-initdb\.d\/10-runtime-logins\.sh:ro/u)
    expect(compose).toMatch(/credential-broker:[\s\S]*network_mode:\s*["']?service:team-host/u)
    expect(compose).toMatch(/team-edge:[\s\S]*dockerfile:\s*deploy\/edge\/Dockerfile/u)
    expect(compose).toMatch(/team-edge:[\s\S]*network_mode:\s*["']?service:team-host/u)
    expect(compose).toMatch(/DSH_TEAM_BROKER_ENV_FILE:-\.\/\.secrets\/credential-broker\.env/u)

    const postgresService = compose.slice(compose.indexOf('  postgres:'), compose.indexOf('  team-migrations:'))
    const migrationService = compose.slice(compose.indexOf('  team-migrations:'), compose.indexOf('  team-host:'))
    const hostService = compose.slice(compose.indexOf('  team-host:'), compose.indexOf('  credential-broker:'))
    const brokerService = compose.slice(compose.indexOf('  credential-broker:'), compose.indexOf('  team-edge:'))
    const edgeService = compose.slice(compose.indexOf('  team-edge:'), compose.indexOf('\nvolumes:'))
    expect(postgresService).not.toMatch(/^\s+ports:/mu)
    expect(migrationService).not.toMatch(/^\s+ports:/mu)
    expect(migrationService).toMatch(/restart:\s*["']no["']/u)
    expect(migrationService).toMatch(/cap_drop:\s*\n\s*- ALL/u)
    expect(hostService).toMatch(/team\/overview[\s\S]*r\.status !== 401/u)
    expect(brokerService).not.toMatch(/^\s+ports:/mu)
    expect(edgeService).not.toMatch(/^\s+ports:/mu)
    expect(brokerService).toMatch(/depends_on:[\s\S]*postgres:[\s\S]*condition:\s*service_healthy/u)
    expect(edgeService).toMatch(/depends_on:[\s\S]*team-host:[\s\S]*condition:\s*service_healthy/u)
    expect(brokerService).toMatch(/cap_drop:\s*\n\s*- ALL/u)
    expect(brokerService).toMatch(/no-new-privileges:true/u)
    expect(hostService).toContain('DSH_OUTBOUND_PROXY_ENV_FILE:-./.secrets/outbound-network.env')
    expect(brokerService).toContain('DSH_OUTBOUND_PROXY_ENV_FILE:-./.secrets/outbound-network.env')
    expect(hostService).toMatch(/outbound-network\.env\}\s*\n\s*required:\s*false/u)
    expect(brokerService).toMatch(/outbound-network\.env\}\s*\n\s*required:\s*false/u)
    expect(compose).not.toMatch(/(?:HTTP|HTTPS|NO)_PROXY\s*:/u)
    expect(compose).not.toMatch(/DSH_CODEX_SHARED_POOL_BOOTSTRAP_TOKEN\s*:/u)
    expect(compose).not.toMatch(/DSH_CODEX_SHARED_POOL_CREDENTIAL_MASTER_KEY\s*:/u)
    expect(compose).not.toMatch(/DSH_CODEX_SHARED_POOL_INVITE_MASTER_KEY\s*:/u)
    expect(compose).not.toMatch(/--trusted-host|DSH_TEAM_TRUSTED_HOST/u)
  })

  it('bootstraps only through the fixed loopback Team endpoint', async () => {
    const helper = await readFile(new URL('../deploy/host/bootstrap.mjs', import.meta.url), 'utf8')
    expect(helper).toContain('http://127.0.0.1:3081/plugins/dsh-codex-shared-pool/team/bootstrap')
    expect(helper).toContain("process.env.DSH_CODEX_SHARED_POOL_BOOTSTRAP_TOKEN")
    expect(helper).not.toMatch(/process\.argv.*https?:/u)
  })

  it('publishes only Team routes and keeps bootstrap behind the loopback Host boundary', async () => {
    const { classifyEdgeTarget } = await import('../deploy/edge/server.mjs')
    expect(classifyEdgeTarget('/healthz')).toBe('health')
    expect(classifyEdgeTarget('/plugins/dsh-codex-shared-pool/team/overview')).toBe('team')
    expect(classifyEdgeTarget('/plugins/dsh-codex-shared-pool/team/codex/responses?trace=1')).toBe('team')
    expect(classifyEdgeTarget('/plugins/dsh-codex-shared-pool/team/bootstrap')).toBe('blocked')
    expect(classifyEdgeTarget('/plugins/dsh-codex-shared-pool/team/bootstrap?probe=1')).toBe('blocked')
    expect(classifyEdgeTarget('/plugins/dsh-codex-shared-pool/team-client/status')).toBe('blocked')
    expect(classifyEdgeTarget('/plugins/dsh-codex-shared-pool/team%2fbootstrap')).toBe('blocked')
    expect(classifyEdgeTarget('/api/remotes')).toBe('blocked')
    expect(classifyEdgeTarget('/')).toBe('blocked')

    const edge = await readFile(new URL('../deploy/edge/server.mjs', import.meta.url), 'utf8')
    expect(edge).toContain("delete headers['x-dsh-bootstrap-token']")
    expect(edge).toContain("headers.host = '127.0.0.1:3081'")
  })

  it('proves two deployed Teams support one-time friend invites, distinct member keys, and isolated overviews', async () => {
    const { runMultiTeamDeploymentSmoke } = await import('../deploy/host/smoke-multi-team.mjs')
    const bootstrapToken = 'bootstrap-secret-for-ci-smoke'
    const brokerApiKey = 'broker-secret-for-ci-smoke-1234567890'
    const alphaKey = 'dsh_team_alpha-owner-secret-1234567890'
    const betaKey = 'dsh_team_beta-owner-secret-1234567890'
    const alphaInvite = 'dsh_invite_alpha-secret-1234567890'
    const betaInvite = 'dsh_invite_beta-secret-1234567890'
    const alphaFriendKey = 'dsh_team_alpha-friend-secret-1234567890'
    const betaFriendKey = 'dsh_team_beta-friend-secret-1234567890'
    const calls: Array<{ url: string, init: RequestInit }> = []

    const fakeFetch: typeof globalThis.fetch = async (input, init = {}) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.endsWith('/authorization')) {
        expect(init.headers).toMatchObject({
          authorization: `Bearer ${brokerApiKey}`,
          'content-type': 'application/json',
        })
        expect(JSON.parse(String(init.body))).toEqual({
          teamId: 'team_smoke_probe',
          accountId: 'account_smoke_probe',
        })
        return Response.json({ status: 'reauth_required', lastError: 'credential unavailable' })
      }
      if (url.endsWith('/bootstrap')) {
        expect(init.headers).toMatchObject({
          'content-type': 'application/json',
          'x-dsh-bootstrap-token': bootstrapToken,
        })
        const body = JSON.parse(String(init.body)) as { teamName: string, ownerName: string }
        expect(Object.keys(body).sort()).toEqual(['ownerName', 'teamName'])
        const alpha = body.teamName === 'CI Alpha'
        return Response.json({
          team: { id: alpha ? 'team-alpha' : 'team-beta', name: body.teamName, status: 'active', createdAt: 1 },
          member: {
            id: alpha ? 'member-alpha' : 'member-beta',
            teamId: alpha ? 'team-alpha' : 'team-beta',
            displayName: body.ownerName,
            role: 'owner',
            status: 'active',
            joinedAt: 1,
          },
          apiKey: alpha ? alphaKey : betaKey,
        }, { status: 201 })
      }

      const authorization = (init.headers as Record<string, string> | undefined)?.authorization
      if (url.endsWith('/invites')) {
        const alpha = authorization === `Bearer ${alphaKey}`
        expect(authorization).toBe(`Bearer ${alpha ? alphaKey : betaKey}`)
        expect(JSON.parse(String(init.body))).toEqual({})
        return Response.json({
          invite: {
            id: alpha ? 'invite-alpha' : 'invite-beta',
            teamId: alpha ? 'team-alpha' : 'team-beta',
            invitedByMemberId: alpha ? 'member-alpha' : 'member-beta',
            status: 'pending',
            expiresAt: 60_000,
            createdAt: 1,
          },
          inviteToken: alpha ? alphaInvite : betaInvite,
        }, { status: 201 })
      }
      if (url.endsWith('/join')) {
        expect(authorization).toBeUndefined()
        const body = JSON.parse(String(init.body)) as { inviteToken: string, displayName: string }
        const alpha = body.inviteToken === alphaInvite
        const valid = alpha || body.inviteToken === betaInvite
        if (!valid || calls.filter(call => call.url.endsWith('/join') && String(call.init.body).includes(body.inviteToken)).length > 1) {
          return Response.json({ error: 'invite is invalid or expired' }, { status: 404 })
        }
        return Response.json({
          team: {
            id: alpha ? 'team-alpha' : 'team-beta',
            name: alpha ? 'CI Alpha' : 'CI Beta',
            status: 'active',
            createdAt: 1,
          },
          member: {
            id: alpha ? 'friend-alpha' : 'friend-beta',
            teamId: alpha ? 'team-alpha' : 'team-beta',
            displayName: body.displayName,
            role: 'member',
            status: 'active',
            joinedAt: 2,
          },
          apiKey: alpha ? alphaFriendKey : betaFriendKey,
        }, { status: 201 })
      }

      const alpha = authorization === `Bearer ${alphaKey}` || authorization === `Bearer ${alphaFriendKey}`
      const owner = authorization === `Bearer ${alphaKey}` || authorization === `Bearer ${betaKey}`
      const key = alpha ? alphaKey : betaKey
      const teamId = alpha ? 'team-alpha' : 'team-beta'
      const memberId = owner ? (alpha ? 'member-alpha' : 'member-beta') : (alpha ? 'friend-alpha' : 'friend-beta')
      const teamName = alpha ? 'CI Alpha' : 'CI Beta'
      const ownerName = alpha ? 'Alice' : 'Bob'
      const displayName = owner ? ownerName : (alpha ? 'Carol' : 'Dave')
      const ownerMemberId = alpha ? 'member-alpha' : 'member-beta'
      const friendMemberId = alpha ? 'friend-alpha' : 'friend-beta'
      return Response.json({
        team: { id: teamId, name: teamName, status: 'active', createdAt: 1 },
        currentMember: { id: memberId, teamId, displayName, role: owner ? 'owner' : 'member', status: 'active', joinedAt: owner ? 1 : 2 },
        members: [
          { id: ownerMemberId, teamId, displayName: ownerName, role: 'owner', status: 'active', joinedAt: 1 },
          { id: friendMemberId, teamId, displayName: alpha ? 'Carol' : 'Dave', role: 'member', status: 'active', joinedAt: 2 },
        ],
        invites: [{
          id: alpha ? 'invite-alpha' : 'invite-beta',
          teamId,
          invitedByMemberId: ownerMemberId,
          status: 'accepted',
          expiresAt: 60_000,
          createdAt: 1,
          acceptedAt: 2,
        }],
        apiKeys: [{ id: `key-${memberId}`, teamId, memberId, label: 'bootstrap', prefix: key.slice(0, 18), createdAt: 1 }],
        contributions: [],
      })
    }

    await expect(runMultiTeamDeploymentSmoke({ fetch: fakeFetch, bootstrapToken, brokerApiKey })).resolves.toBeUndefined()
    expect(calls.map(call => call.url)).toEqual([
      'http://127.0.0.1:8788/v1/dsh-team-credential-broker/authorization',
      'http://127.0.0.1:3081/plugins/dsh-codex-shared-pool/team/bootstrap',
      'http://127.0.0.1:3081/plugins/dsh-codex-shared-pool/team/bootstrap',
      'http://127.0.0.1:3080/plugins/dsh-codex-shared-pool/team/invites',
      'http://127.0.0.1:3080/plugins/dsh-codex-shared-pool/team/join',
      'http://127.0.0.1:3080/plugins/dsh-codex-shared-pool/team/join',
      'http://127.0.0.1:3080/plugins/dsh-codex-shared-pool/team/invites',
      'http://127.0.0.1:3080/plugins/dsh-codex-shared-pool/team/join',
      'http://127.0.0.1:3080/plugins/dsh-codex-shared-pool/team/join',
      'http://127.0.0.1:3080/plugins/dsh-codex-shared-pool/team/overview',
      'http://127.0.0.1:3080/plugins/dsh-codex-shared-pool/team/overview',
      'http://127.0.0.1:3080/plugins/dsh-codex-shared-pool/team/overview',
      'http://127.0.0.1:3080/plugins/dsh-codex-shared-pool/team/overview',
    ])
    expect((calls[9]?.init.headers as Record<string, string>).authorization).toBe(`Bearer ${alphaKey}`)
    expect((calls[10]?.init.headers as Record<string, string>).authorization).toBe(`Bearer ${alphaFriendKey}`)
    expect((calls[11]?.init.headers as Record<string, string>).authorization).toBe(`Bearer ${betaKey}`)
    expect((calls[12]?.init.headers as Record<string, string>).authorization).toBe(`Bearer ${betaFriendKey}`)
  })

  it('runs an explicitly confirmed live OAuth sharing smoke without returning secrets and always cleans up', async () => {
    const { runLiveSharingSmoke } = await import('../deploy/host/smoke-live-sharing.mjs')
    const bootstrapToken = 'bootstrap-secret-for-live-smoke'
    const ownerKey = 'dsh_team_live-owner-secret-1234567890'
    const friendKey = 'dsh_team_live-friend-secret-1234567890'
    const inviteToken = 'dsh_invite_live-secret-1234567890'
    const calls: Array<{ url: string, init: RequestInit }> = []
    const challenges: unknown[] = []
    let overviewReads = 0

    const fakeFetch: typeof globalThis.fetch = async (input, init = {}) => {
      const url = String(input)
      calls.push({ url, init })
      const authorization = (init.headers as Record<string, string> | undefined)?.authorization
      if (url.endsWith('/bootstrap')) {
        expect((init.headers as Record<string, string>)['x-dsh-bootstrap-token']).toBe(bootstrapToken)
        expect(JSON.parse(String(init.body))).toEqual({
          teamName: 'Live sharing smoke live-test-id',
          ownerName: 'Live Owner',
        })
        return Response.json({
          team: { id: 'team-live', name: 'Live sharing smoke live-test-id', status: 'active', createdAt: 1 },
          member: {
            id: 'member-owner', teamId: 'team-live', displayName: 'Live Owner', role: 'owner', status: 'active', joinedAt: 1,
          },
          apiKey: ownerKey,
        }, { status: 201 })
      }
      if (url.endsWith('/invites')) {
        expect(authorization).toBe(`Bearer ${ownerKey}`)
        return Response.json({
          invite: {
            id: 'invite-live', teamId: 'team-live', invitedByMemberId: 'member-owner', status: 'pending', expiresAt: 60_000, createdAt: 1,
          },
          inviteToken,
        }, { status: 201 })
      }
      if (url.endsWith('/join')) {
        expect(authorization).toBeUndefined()
        expect(JSON.parse(String(init.body))).toEqual({ inviteToken, displayName: 'Live Friend' })
        return Response.json({
          team: { id: 'team-live', name: 'Live sharing smoke live-test-id', status: 'active', createdAt: 1 },
          member: {
            id: 'member-friend', teamId: 'team-live', displayName: 'Live Friend', role: 'member', status: 'active', joinedAt: 2,
          },
          apiKey: friendKey,
        }, { status: 201 })
      }
      if (url.endsWith('/contributions/oauth/start')) {
        expect(authorization).toBe(`Bearer ${ownerKey}`)
        expect(JSON.parse(String(init.body))).toEqual({ label: 'Live Codex contribution' })
        return Response.json({
          account: {
            id: 'account-live', teamId: 'team-live', ownerMemberId: 'member-owner', label: 'Live Codex contribution',
            status: 'authorizing', personalReservePercent: 10, maxSharedRequestsPerWindow: null, dailySharedCreditLimit: null,
            maxSharedConcurrency: 1, allowedModels: [], createdAt: 3, updatedAt: 3,
          },
          method: 'device_code',
          verificationUrl: 'https://auth.openai.example/device',
          userCode: 'LIVE-CODE',
          expiresAt: 60_000,
        }, { status: 201 })
      }
      if (url.endsWith('/overview')) {
        expect(authorization).toBe(`Bearer ${ownerKey}`)
        overviewReads += 1
        return Response.json({
          team: { id: 'team-live', name: 'Live sharing smoke live-test-id', status: 'active', createdAt: 1 },
          currentMember: {
            id: 'member-owner', teamId: 'team-live', displayName: 'Live Owner', role: 'owner', status: 'active', joinedAt: 1,
          },
          members: [],
          invites: [],
          apiKeys: [],
          contributions: [{
            id: 'account-live', teamId: 'team-live', ownerMemberId: 'member-owner', label: 'Live Codex contribution',
            status: overviewReads === 1 ? 'authorizing' : 'active', personalReservePercent: 10,
            maxSharedRequestsPerWindow: null, dailySharedCreditLimit: null, maxSharedConcurrency: 1, allowedModels: [], createdAt: 3, updatedAt: 3,
          }],
        })
      }
      if (url.endsWith('/responses')) {
        expect(authorization).toBe(`Bearer ${friendKey}`)
        expect(JSON.parse(String(init.body))).toEqual({
          model: 'gpt-5.4',
          input: 'Reply with exactly: DSH team live smoke ok',
          stream: true,
          store: false,
        })
        return new Response([
          'data: {"type":"response.output_text.delta","delta":"DSH team live smoke ok"}',
          'data: {"type":"response.completed","response":{"status":"completed"}}',
          '',
        ].join('\n\n'), {
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      if (url.endsWith('/usage')) {
        expect(authorization).toBe(`Bearer ${friendKey}`)
        return Response.json({
          events: [{
            id: 'usage-live',
            teamId: 'team-live',
            consumerMemberId: 'member-friend',
            upstreamOwnerMemberId: 'member-owner',
            upstreamAccountId: 'account-live',
            model: 'gpt-5.4',
            unit: 'request',
            status: 'succeeded',
            credits: 125,
            creditsFormulaVersion: 'credits-v1',
            startedAt: 4,
            finishedAt: 5,
          }],
          aggregates: {
            generatedAt: 86_400_000,
            last24HoursStartedAt: 0,
            last7DaysStartedAt: 0,
            accountTotals24Hours: [{ upstreamAccountId: 'account-live', requestCount: 1, measuredRequestCount: 1, credits: 125 }],
            memberDaily7Days: [{
              upstreamAccountId: 'account-live', consumerMemberId: 'member-friend', dayStartedAt: 0,
              requestCount: 1, measuredRequestCount: 1, credits: 125,
            }],
          },
        })
      }
      if (url.endsWith('/status')) {
        expect(authorization).toBe(`Bearer ${ownerKey}`)
        expect(JSON.parse(String(init.body))).toEqual({ status: 'paused' })
        return Response.json({ team: { id: 'team-live', status: 'paused' } })
      }
      if (url.endsWith('/contributions/revoke')) {
        expect(authorization).toBe(`Bearer ${ownerKey}`)
        expect(JSON.parse(String(init.body))).toEqual({ accountId: 'account-live' })
        return Response.json({ account: { id: 'account-live', status: 'revoked' } })
      }
      if (url.endsWith('/members/leave')) {
        expect(authorization).toBe(`Bearer ${friendKey}`)
        expect(JSON.parse(String(init.body))).toEqual({})
        return Response.json({ member: { id: 'member-friend', status: 'removed' }, contributions: [] })
      }
      if (url.endsWith('/keys/current/revoke')) {
        expect(authorization).toBe(`Bearer ${ownerKey}`)
        expect(JSON.parse(String(init.body))).toEqual({})
        return Response.json({ ok: true })
      }
      throw new Error(`unexpected live smoke URL: ${url}`)
    }

    const result = await runLiveSharingSmoke({
      confirmed: true,
      fetch: fakeFetch,
      bootstrapToken,
      runId: 'live-test-id',
      onChallenge: challenge => { challenges.push(challenge) },
      wait: async () => undefined,
      now: () => 1_000,
    })

    expect(result).toEqual({
      teamId: 'team-live',
      ownerMemberId: 'member-owner',
      friendMemberId: 'member-friend',
      accountId: 'account-live',
      usageEventId: 'usage-live',
      model: 'gpt-5.4',
    })
    expect(challenges).toEqual([{
      verificationUrl: 'https://auth.openai.example/device',
      userCode: 'LIVE-CODE',
      expiresAt: 60_000,
    }])
    expect(JSON.stringify(result)).not.toContain(ownerKey)
    expect(JSON.stringify(result)).not.toContain(friendKey)
    expect(JSON.stringify(result)).not.toContain(inviteToken)
    expect(calls.slice(-4).map(call => call.url)).toEqual([
      'http://127.0.0.1:3080/plugins/dsh-codex-shared-pool/team/status',
      'http://127.0.0.1:3080/plugins/dsh-codex-shared-pool/team/contributions/revoke',
      'http://127.0.0.1:3080/plugins/dsh-codex-shared-pool/team/members/leave',
      'http://127.0.0.1:3080/plugins/dsh-codex-shared-pool/team/keys/current/revoke',
    ])
  })

  it('requires explicit live-test confirmation and never copies response bodies into live-smoke errors', async () => {
    const { runLiveSharingSmoke } = await import('../deploy/host/smoke-live-sharing.mjs')
    let calls = 0
    const leaked = 'dsh_team_live-response-secret-that-must-not-leak'
    const fakeFetch: typeof globalThis.fetch = async () => {
      calls += 1
      return new Response(`provider failed with ${leaked}`, { status: 500 })
    }

    await expect(runLiveSharingSmoke({
      confirmed: false,
      fetch: fakeFetch,
      bootstrapToken: 'bootstrap-secret-for-live-smoke',
      onChallenge: () => undefined,
    })).rejects.toThrow(/explicit disposable-test confirmation/u)
    expect(calls).toBe(0)

    await expect(runLiveSharingSmoke({
      confirmed: true,
      fetch: fakeFetch,
      bootstrapToken: 'bootstrap-secret-for-live-smoke',
      onChallenge: () => undefined,
    })).rejects.toThrowError(expect.not.stringContaining(leaked))
    expect(calls).toBe(1)
  })

  it('requires the live friend stream to contain the fixed expected model output without echoing mismatches', async () => {
    const { validateLiveFriendResponse } = await import('../deploy/host/smoke-live-sharing.mjs')
    const expected = 'DSH team live smoke ok'
    const valid = [
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'DSH team ' })}`,
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'live smoke ok' })}`,
      `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}`,
      '',
    ].join('\n\n')

    await expect(validateLiveFriendResponse(new Response(valid, {
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }))).resolves.toBeUndefined()

    const leakedMismatch = 'provider-output-that-must-not-reach-the-error'
    const invalid = [
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: leakedMismatch })}`,
      `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}`,
      '',
    ].join('\n\n')
    let mismatch
    try {
      await validateLiveFriendResponse(new Response(invalid, {
        headers: { 'content-type': 'text/event-stream' },
      }))
    } catch (error) {
      mismatch = error
    }
    expect(mismatch).toBeInstanceOf(Error)
    expect((mismatch as Error).message).toContain(`expected ${expected}`)
    expect((mismatch as Error).message).not.toContain(leakedMismatch)
  })

  it('never copies a secret-bearing remote response into smoke-test errors', async () => {
    const { runMultiTeamDeploymentSmoke } = await import('../deploy/host/smoke-multi-team.mjs')
    const leaked = 'dsh_team_this-must-never-reach-the-error'
    const fakeFetch: typeof globalThis.fetch = async (input) => String(input).endsWith('/authorization')
      ? Response.json({ status: 'reauth_required' })
      : new Response(`provider failed with ${leaked}`, { status: 500 })

    await expect(runMultiTeamDeploymentSmoke({
      fetch: fakeFetch,
      bootstrapToken: 'bootstrap-secret-for-ci-smoke',
      brokerApiKey: 'broker-secret-for-ci-smoke-1234567890',
    })).rejects.toThrowError(expect.not.stringContaining(leaked))
  })

  it('fails the deployment smoke when one Team overview contains another Team member', async () => {
    const { runMultiTeamDeploymentSmoke } = await import('../deploy/host/smoke-multi-team.mjs')
    const fixtures = [
      {
        teamId: 'team-alpha',
        memberId: 'member-alpha',
        friendMemberId: 'friend-alpha',
        teamName: 'CI Alpha',
        ownerName: 'Alice',
        friendName: 'Carol',
        apiKey: 'dsh_team_alpha-secret-1234567890',
        friendApiKey: 'dsh_team_alpha-friend-1234567890',
        inviteId: 'invite-alpha',
        inviteToken: 'dsh_invite_alpha-secret-1234567890',
      },
      {
        teamId: 'team-beta',
        memberId: 'member-beta',
        friendMemberId: 'friend-beta',
        teamName: 'CI Beta',
        ownerName: 'Bob',
        friendName: 'Dave',
        apiKey: 'dsh_team_beta-secret-1234567890',
        friendApiKey: 'dsh_team_beta-friend-1234567890',
        inviteId: 'invite-beta',
        inviteToken: 'dsh_invite_beta-secret-1234567890',
      },
    ]
    const brokerApiKey = 'broker-secret-for-ci-smoke-1234567890'
    const acceptedInvites = new Set<string>()
    let bootstrapIndex = 0
    const fakeFetch: typeof globalThis.fetch = async (input, init = {}) => {
      const url = String(input)
      if (url.endsWith('/authorization')) {
        expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${brokerApiKey}`)
        return Response.json({ status: 'reauth_required' })
      }
      if (url.endsWith('/bootstrap')) {
        const item = fixtures[bootstrapIndex++]!
        return Response.json({
          team: { id: item.teamId, name: item.teamName },
          member: { id: item.memberId, teamId: item.teamId, displayName: item.ownerName, role: 'owner', status: 'active' },
          apiKey: item.apiKey,
        }, { status: 201 })
      }
      const authorization = (init.headers as Record<string, string> | undefined)?.authorization
      if (url.endsWith('/invites')) {
        const item = fixtures.find(candidate => authorization === `Bearer ${candidate.apiKey}`)!
        return Response.json({
          invite: {
            id: item.inviteId,
            teamId: item.teamId,
            invitedByMemberId: item.memberId,
            status: 'pending',
          },
          inviteToken: item.inviteToken,
        }, { status: 201 })
      }
      if (url.endsWith('/join')) {
        const body = JSON.parse(String(init.body)) as { inviteToken: string, displayName: string }
        const item = fixtures.find(candidate => candidate.inviteToken === body.inviteToken)!
        if (acceptedInvites.has(body.inviteToken)) {
          return Response.json({ error: 'invite is invalid or expired' }, { status: 404 })
        }
        acceptedInvites.add(body.inviteToken)
        return Response.json({
          team: { id: item.teamId, name: item.teamName, status: 'active' },
          member: {
            id: item.friendMemberId,
            teamId: item.teamId,
            displayName: body.displayName,
            role: 'member',
            status: 'active',
          },
          apiKey: item.friendApiKey,
        }, { status: 201 })
      }
      const item = fixtures.find(candidate => (
        authorization === `Bearer ${candidate.apiKey}`
        || authorization === `Bearer ${candidate.friendApiKey}`
      ))!
      const isOwner = authorization === `Bearer ${item.apiKey}`
      return Response.json({
        team: { id: item.teamId, name: item.teamName, status: 'active' },
        currentMember: {
          id: isOwner ? item.memberId : item.friendMemberId,
          teamId: item.teamId,
          displayName: isOwner ? item.ownerName : item.friendName,
          role: isOwner ? 'owner' : 'member',
          status: 'active',
        },
        members: [{ id: 'foreign-member', teamId: 'team-beta' }],
        invites: [],
        apiKeys: [],
        contributions: [],
      })
    }

    await expect(runMultiTeamDeploymentSmoke({
      fetch: fakeFetch,
      bootstrapToken: 'bootstrap-secret-for-ci-smoke',
      brokerApiKey,
    })).rejects.toThrow(/cross-Team members entry/u)
  })

  it('builds and exercises the self-hosted stack in CI with unconditional cleanup', async () => {
    const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
    expect(workflow).toMatch(/docker compose -f deploy\/self-hosted\/compose\.yml up --build --wait/u)
    expect(workflow.match(/\/opt\/dsh\/deploy\/host\/smoke-multi-team\.mjs --confirm-test-data/gu)).toHaveLength(1)
    expect(workflow).toMatch(/DSH_TEAM_MIGRATION_ENV_FILE=\/dev\/null/u)
    expect(workflow).toMatch(/DSH_TEAM_BROKER_ENV_FILE=\/dev\/null/u)
    expect(workflow).toMatch(/if:\s*always\(\)[\s\S]*docker compose -f deploy\/self-hosted\/compose\.yml down --volumes/u)
  })

  it('documents the one-shot migrator and split runtime database identities', async () => {
    const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
    const controlPlanePlan = await readFile(
      new URL('../docs/superpowers/plans/2026-08-19-team-control-plane.md', import.meta.url),
      'utf8',
    )
    const selfHostedPlan = await readFile(
      new URL('../docs/superpowers/plans/2026-08-20-self-hosted-credential-broker.md', import.meta.url),
      'utf8',
    )

    expect(readme).toMatch(/four long-running processes[\s\S]*one-shot database\s+migrator/iu)
    expect(readme).toMatch(/four mode-`0600` files/iu)
    expect(readme).toContain('team-migrations.env')
    expect(readme).toContain('dsh_team_host_login')
    expect(readme).toContain('dsh_team_broker_login')
    expect(readme).toMatch(/Team\s+Host cannot read `team_contribution_credentials`/u)
    expect(readme).toMatch(/Credential\s+Broker cannot read the Team control-plane tables/u)
    expect(readme).toMatch(/outbound-network\.env[\s\S]*HTTP_PROXY[\s\S]*HTTPS_PROXY[\s\S]*NO_PROXY/iu)
    expect(readme).toMatch(/NO_PROXY[\s\S]*127\.0\.0\.1[\s\S]*localhost/iu)
    expect(readme).toMatch(/outbound-network\.env[\s\S]*(?:restart|recreate|重启)[\s\S]*Team Host[\s\S]*Credential Broker/iu)
    expect(readme).not.toMatch(/deliberately uses one PostgreSQL login/iu)
    expect(controlPlanePlan).not.toMatch(/separate database roles[\s\S]*remain explicit deployment-hardening work/iu)
    expect(selfHostedPlan).toMatch(/four mode-`0600` secret files/iu)
    expect(selfHostedPlan).not.toMatch(/atomic three-file secret generation/iu)
  })

  it('ships the Unicode data copyright and permission notice with the npm package', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { files?: string[] }
    const notice = await readFile(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8')

    expect(packageJson.files).toContain('THIRD_PARTY_NOTICES.md')
    expect(notice).toMatch(/Unicode License V3/u)
    expect(notice).toMatch(/Copyright © 1991-2026 Unicode, Inc\./u)
    expect(notice).toMatch(/Permission is hereby granted, free of charge/iu)
  })
})
