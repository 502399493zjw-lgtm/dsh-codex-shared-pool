# Self-hosted Credential Broker Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the official single-server deployment host many Teams while keeping OAuth credential decryption in a separate, private Credential Broker process.

**Architecture:** Docker Compose runs PostgreSQL, a one-shot schema/role migrator, a loopback-only stock DSH Team Host, the existing loopback-only broker daemon, and a narrow Team API Edge. The broker joins the Team Host network namespace, binds only `127.0.0.1:8788`, and alone receives the envelope master key; Team Host reaches it through the fixed remote-broker protocol and receives only short-lived authorization projections. The one-shot migrator is the only application service with the schema-owner URL; the Host and Broker use separate table-scoped runtime logins. The Edge alone binds `0.0.0.0:3080` and allowlists public Team routes because stock DSH intentionally refuses a non-loopback Web bind.

**Tech Stack:** Docker Compose, Node.js 24, TypeScript, Vitest, PostgreSQL 17, stock `@deepseek-ai/dsh@0.1.0-rc.8`

## Global Constraints

- Keep this repository as the only public package and do not modify a DSH fork.
- OAuth token material and the envelope master key must never enter Team Host configuration, Browser projections, smoke-test errors, or Compose YAML literals.
- Publish only Team Edge port `3080`; stock DSH, PostgreSQL, and Credential Broker remain private.
- Preserve all existing user-owned untracked files and do not commit, push, publish, or rewrite history without explicit user authorization.
- Give the one-shot migrator, Team Host, and Credential Broker distinct PostgreSQL identities; the two long-running workloads must not receive the schema-owner URL or each other's table privileges.

---

### Task 1: Split deployment secrets and switch Team Host to the remote broker

**Files:**
- Modify: `tests/deployment-assets.spec.ts`
- Modify: `deploy/self-hosted/init-secrets.mjs`
- Modify: `deploy/host/team-host.patch.yml`

**Interfaces:**
- Consumes: `initializeSelfHostedSecrets(rootDir: string)` and the existing remote-broker configuration schema.
- Produces: four mode-`0600` secret files through `{ postgresPath, migrationPath, hostPath, brokerPath }`; distinct migrator, Host, and Broker database URLs; matching `DSH_CODEX_SHARED_POOL_CREDENTIAL_BROKER_API_KEY` in Host and broker files; master key only in the broker file.

- [x] **Step 1: Write the failing deployment-secret and patch assertions**

```ts
expect(created).toEqual({ postgresPath, migrationPath, hostPath, brokerPath })
expect(migration).toHaveProperty('DSH_CODEX_SHARED_POOL_DATABASE_URL')
expect(host).not.toHaveProperty('DSH_CODEX_SHARED_POOL_CREDENTIAL_MASTER_KEY')
expect(broker.DSH_CODEX_SHARED_POOL_CREDENTIAL_MASTER_KEY).toMatch(/.+/u)
expect(host.DSH_CODEX_SHARED_POOL_CREDENTIAL_BROKER_API_KEY)
  .toBe(broker.DSH_CODEX_SHARED_POOL_CREDENTIAL_BROKER_API_KEY)
expect(patch).toMatch(/credentialBroker:\s*remote/u)
expect(patch).toMatch(/credentialBrokerBaseUrl:\s*http:\/\/127\.0\.0\.1:8788\/v1\/dsh-team-credential-broker/u)
```

- [x] **Step 2: Run the focused test and verify RED**

Run: `pnpm exec vitest run tests/deployment-assets.spec.ts`

Expected: FAIL because no broker env file exists and the Host patch still selects the local broker.

- [x] **Step 3: Implement atomic four-file secret generation and remote configuration**

```js
const postgresPassword = randomBytes(24).toString('hex')
const teamHostDatabasePassword = randomBytes(24).toString('hex')
const brokerDatabasePassword = randomBytes(24).toString('hex')
const brokerApiKey = randomBytes(32).toString('base64url')
await writePrivateFile(migrationTempPath, envDocument([
  ['DSH_CODEX_SHARED_POOL_DATABASE_URL',
    `postgres://dsh_team_migrator:${postgresPassword}@postgres:5432/dsh_codex_shared_pool`],
]))
await writePrivateFile(hostTempPath, envDocument([
  ['DSH_CODEX_SHARED_POOL_DATABASE_URL',
    `postgres://dsh_team_host_login:${teamHostDatabasePassword}@postgres:5432/dsh_codex_shared_pool`],
  ['DSH_CODEX_SHARED_POOL_BOOTSTRAP_TOKEN', bootstrapToken],
  ['DSH_CODEX_SHARED_POOL_CREDENTIAL_BROKER_API_KEY', brokerApiKey],
]))
await writePrivateFile(brokerTempPath, envDocument([
  ['DSH_CODEX_SHARED_POOL_DATABASE_URL',
    `postgres://dsh_team_broker_login:${brokerDatabasePassword}@postgres:5432/dsh_codex_shared_pool`],
  ['DSH_CODEX_SHARED_POOL_CREDENTIAL_MASTER_KEY', credentialMasterKey],
  ['DSH_CODEX_SHARED_POOL_CREDENTIAL_BROKER_API_KEY', brokerApiKey],
  ['DSH_CODEX_TEAM_BROKER_HOST', '127.0.0.1'],
]))
```

Configure `team-host.patch.yml` with `credentialBroker: remote`, the fixed loopback URL, and `credentialBrokerApiKeyRef`; remove `credentialMasterKeyRef`.

- [x] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm exec vitest run tests/deployment-assets.spec.ts`

Expected: PASS for secret ownership, modes, overwrite refusal, and patch references.

### Task 2: Add the private Credential Broker sidecar

**Files:**
- Modify: `tests/deployment-assets.spec.ts`
- Modify: `deploy/self-hosted/compose.yml`

**Interfaces:**
- Consumes: `deploy/broker/Dockerfile`, `.secrets/credential-broker.env`, and Team Host loopback port `8788`.
- Produces: Compose service `credential-broker` with `network_mode: service:team-host`, no published ports, restart recovery, healthcheck, dropped capabilities, and PostgreSQL health dependency.

- [x] **Step 1: Add failing topology assertions**

```ts
expect(compose).toMatch(/credential-broker:[\s\S]*dockerfile:\s*deploy\/broker\/Dockerfile/u)
expect(compose).toMatch(/credential-broker:[\s\S]*network_mode:\s*["']?service:team-host/u)
expect(compose).toMatch(/DSH_TEAM_BROKER_ENV_FILE:-\.\/\.secrets\/credential-broker\.env/u)
expect(brokerService).not.toMatch(/^\s+ports:/mu)
```

- [x] **Step 2: Run the focused test and verify RED**

Run: `pnpm exec vitest run tests/deployment-assets.spec.ts`

Expected: FAIL because Compose has no broker service.

- [x] **Step 3: Implement the broker service**

```yaml
  credential-broker:
    build:
      context: ../..
      dockerfile: deploy/broker/Dockerfile
    restart: unless-stopped
    init: true
    network_mode: service:team-host
    env_file:
      - ${DSH_TEAM_BROKER_ENV_FILE:-./.secrets/credential-broker.env}
    depends_on:
      postgres:
        condition: service_healthy
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
```

The restart policy lets a fresh broker retry after Team Host creates the credential table, while an existing database lets the broker be available during Host reconciliation.

- [x] **Step 4: Validate tests and Compose parsing**

Run: `pnpm exec vitest run tests/deployment-assets.spec.ts`

Run: `DSH_TEAM_POSTGRES_ENV_FILE=/dev/null DSH_TEAM_HOST_ENV_FILE=/dev/null DSH_TEAM_BROKER_ENV_FILE=/dev/null docker compose -f deploy/self-hosted/compose.yml config`

Expected: test PASS and Compose config exits `0` without publishing broker/PostgreSQL ports.

### Task 3: Prove the deployed Host-to-broker boundary without contacting OpenAI

**Files:**
- Modify: `tests/deployment-assets.spec.ts`
- Modify: `deploy/host/smoke-multi-team.mjs`

**Interfaces:**
- Consumes: `options.brokerApiKey`, optional `options.brokerBaseUrl`, and broker `POST /authorization`.
- Produces: deployment smoke that authenticates to the broker, queries a nonexistent probe reference, expects secret-free `reauth_required`, then validates two isolated Teams.

- [x] **Step 1: Extend fake-fetch tests with an authenticated broker probe**

```ts
if (url.endsWith('/authorization')) {
  expect(init.headers).toMatchObject({
    authorization: `Bearer ${brokerApiKey}`,
    'content-type': 'application/json',
  })
  return Response.json({ status: 'reauth_required', lastError: 'credential unavailable' })
}
```

Assert the broker call is the first call and that secret-bearing non-2xx bodies never enter thrown errors.

- [x] **Step 2: Run the focused test and verify RED**

Run: `pnpm exec vitest run tests/deployment-assets.spec.ts`

Expected: FAIL because the smoke does not read the broker API key or call `/authorization`.

- [x] **Step 3: Implement the bounded broker probe**

```js
const response = await fetch(`${brokerBaseUrl}/authorization`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${brokerApiKey}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({ teamId: 'team_smoke_probe', accountId: 'account_smoke_probe' }),
  redirect: 'error',
})
const result = record(await readJson(response, 'Credential Broker probe'), 'Credential Broker probe')
if (result.status !== 'reauth_required') throw new Error('Credential Broker probe returned an unexpected status')
rejectSecretFields(result)
```

Validate both deployment secrets before any request and include them in the serialized-response leak scan.

- [x] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm exec vitest run tests/deployment-assets.spec.ts`

Expected: PASS with broker authentication, failure sanitization, one-time friend
invites, distinct member keys, and Team isolation assertions.

### Task 4: Wire CI, operator documentation, and release gates

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-08-20-self-hosted-credential-broker.md`

**Interfaces:**
- Consumes: the four long-running services, one-shot migrator, and smoke script from Tasks 1-3 plus the deployment-hardening addenda below.
- Produces: unconditional cleanup that tolerates absent secret files and accurate self-hosting/security documentation.

- [x] **Step 1: Add the CI cleanup assertion before editing workflow code**

```ts
expect(workflow).toMatch(/DSH_TEAM_BROKER_ENV_FILE=\/dev\/null/u)
```

- [x] **Step 2: Run the focused test and verify RED**

Run: `pnpm exec vitest run tests/deployment-assets.spec.ts`

Expected: FAIL because cleanup supplies only PostgreSQL and Host env-file overrides.

- [x] **Step 3: Update CI and README**

Add the Broker and migration env-file overrides to the cleanup command. Document the four generated env files, loopback-only broker, multi-Team behavior, automatic one-shot schema/role migration, split runtime logins, and that the smoke proves broker reachability/database access without testing OpenAI OAuth.

The deployment smoke also creates one friend member in each of two Teams,
requires distinct Owner/member keys, rejects invite reuse, and validates
tenant-scoped overviews for both roles.

- [x] **Step 4: Run focused and full gates**

Run: `pnpm exec vitest run tests/deployment-assets.spec.ts`

Run: `pnpm test`

Run: `pnpm run build`

Run: `pnpm run verify:package`

Run: `pnpm pack`

Expected: all tests, build, package verification, and packing pass. Report real Docker/stock-install results separately; a package-format pass is not a running deployment proof.

- [x] **Step 5: Perform stock DSH installation smoke if the local runtime is available**

Install the packed tarball into a fresh isolated `DSH_HOME`, run pinned stock DSH `0.1.0-rc.8`, validate Host/Browser loading, and remove only the temporary profile and tarball created by this task. If Docker cannot run locally, rely on the checked-in PostgreSQL 17/Compose CI gate and report that local container execution remains unverified.

- [x] **Step 6: Self-review and record exact state**

Run: `rg -n 'T''BD|T''ODO|implement l''ater|fill in d''etails' docs/superpowers/plans/2026-08-20-self-hosted-credential-broker.md`

Run: `git diff --check`

Run: `git status --short --branch`

Expected: no placeholder matches, no whitespace errors, and branch remains `codex/bootstrap` with no unauthorized commit.

### Historical rc.7 deployment observations retained in the current rc.8 design

The first real Compose start showed that stock DSH `0.1.0-rc.7` deliberately
rejects `--host 0.0.0.0` because the full Web surface is not a safe public API.
The final topology therefore keeps DSH on `127.0.0.1:3081`, adds
`deploy/edge/server.mjs` as the only public listener, and blocks bootstrap,
DSH Web/Remote routes, the Team management proxy, WebSocket upgrades, encoded
paths, cookies, and forwarding/bootstrap headers. Bootstrap is available only
to the container-local helper.

That rc.7 image start also established two stock-install layout requirements:
use the glibc `node:24-bookworm-slim` runtime so the verified `node-pty`
prebuild loads, and expose the profile-owned plugin package through a symlink
at the global loader lookup path. The current rc.8 image retains those
requirements but freezes the runtime dependency graph to the registry snapshot
that contains the verified rc.8 release. These conditions are asserted by
`tests/deployment-assets.spec.ts` and fail the image build early when they stop
holding.

- [x] Run the four long-running services locally and reach healthy state after the one-shot migrator exits successfully.
- [x] Verify `/healthz` is public while `/`, `/api/remotes`, bootstrap, and the Team management proxy return `404` through the Edge.
- [x] Run the real PostgreSQL multi-Team smoke successfully through the Edge and loopback Broker.
- [ ] Run the deliberate manual OpenAI OAuth sharing smoke with a disposable subscription account.

### Database least-privilege addendum: separate migration, Host, and Broker identities

The starter now treats the schema owner as a bounded deployment identity rather
than a long-running application credential. Fresh PostgreSQL initialization
creates the fixed `dsh_team_host_login` and `dsh_team_broker_login` workload
logins with distinct generated passwords. A one-shot `team-migrations` service
runs `dsh-codex-team-migrate`, applies the packaged schema and
`deploy/postgres/runtime-roles.sql`, verifies the effective privilege boundary,
and exits before Team Host or Credential Broker can start.

- [x] Add failing deployment and command tests for four secret files, three distinct database URLs, role initialization, and fail-closed role verification.
- [x] Add the packaged `dsh-codex-team-migrate` command and one-shot Compose service.
- [x] Restrict Team Host to control-plane tables and Credential Broker to `team_contribution_credentials`.
- [x] Remove the schema-owner URL from both long-running workloads and make them depend on successful migration.
- [x] Update CI cleanup, package verification, and operator documentation for the fourth secret file and migrator lifecycle.
- [x] Re-run the complete test/build/package gates and a fresh PostgreSQL 17 Compose smoke that proves both allowed and denied runtime table access.
