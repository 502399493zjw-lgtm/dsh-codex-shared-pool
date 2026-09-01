# Team control-plane implementation slice

## Goal

Add the first standalone-plugin slice for an invitation-only Team control
plane without moving OAuth credentials into the Browser or changing DSH core.

## Scope

- Host-only Team/Member/Invite/API-key JSON-safe types.
- One-time local bootstrap and invitation flows.
- Per-member Team API keys stored as hashes and accepted through Bearer or
  `x-dsh-team-key` headers.
- Tenant-scoped overview, key issuance, key revocation, and route disposal.
- Contributor-owned account metadata: ownership, active/paused/revoked state,
  personal reserve, request-count cap, concurrency guard, model allow-list.
- Host-only Credential Broker interface and isolated device-code OAuth
  challenge route; only verification URL, user code, and expiry cross the Team
  API boundary, while polling and credential exchange stay on the central Host.
- Host-only request admission with session stickiness, own-account priority,
  shared fallback, reserve/model/request-window/shared-concurrency guards, and
  drain-before-credential-delete revocation.
- Metadata-only request usage events and an authenticated audit route.
- A fixed-endpoint, streaming Codex Responses gateway with live quota reads,
  provider reset evidence, per-key RPM/concurrency, and automatic circuit guard.
- Owner/Admin Team-wide emergency pause.
- Focused unit and route-security tests.

## Explicitly not in the first slice

- KMS/envelope-encrypted shared OpenAI OAuth credentials for hosted deployment.

## Durable store follow-up

- [x] Add a PostgreSQL `TeamStore` with versioned schema migrations.
- [x] Persist Teams, members, hashed invites/API keys, contribution policy,
  and metadata-only usage events across Host restarts.
- [x] Resolve the database URL and bootstrap token through DSH credential
  references instead of storing either secret in plugin configuration.
- [x] Re-resolve the bootstrap token for every bootstrap operation.
- [x] Move admission leases, shared concurrency, reset-window counters, and
  session bindings into database-atomic coordination for multiple replicas.
- [x] Add a Host-only Codex Responses gateway with live quota admission,
  streaming relay, lease renewal, and metadata-only settlement.
- [x] Add fixed per-key RPM/concurrency/circuit safeguards and Team pause.
- [x] Serialize PostgreSQL usage admission against emergency pause with a
  Team-row lock held through the metadata-only usage insert.
- [x] Add a same-origin Host management proxy and browser Team Settings UI.
- [x] Use device-code OAuth so a remote contributor does not depend on the
  central server receiving a browser callback addressed to localhost.
- [x] Reconcile interrupted contribution OAuth on Host startup and make paused
  and revoked states immune to stale authorization callbacks.
- [x] Replace PostgreSQL runtime files with a shared, per-account
  envelope-encrypted broker and a pluggable KMS/KEK boundary.
- [x] Add a provider-neutral, row-locked online key-rewrap operation with a
  primary/legacy Host keyring, bounded opaque-KMS ciphertext storage, and
  resumable per-account commits.
- [x] Route user-visible provider and Host diagnostics through one bounded
  credential redactor before browser, CLI/TUI, transcript, or durable output.
- [x] Add an optional authenticated, fixed-capability remote Credential Broker
  boundary; remote Team Hosts do not resolve the OAuth credential KEK and can
  resume polling an OAuth operation still running in the broker process.
- [ ] Add concrete managed-cloud-KMS adapters after selecting supported cloud
  providers and their credential/identity model.
- [x] Move the per-key traffic guard to distributed storage for multi-replica
  hosted deployments.

## Evidence

- `pnpm exec vitest run tests/team.spec.ts tests/team-routes.spec.ts tests/team-routing.spec.ts tests/team-request-service.spec.ts`
- `pnpm exec tsc -p tsconfig.json --noEmit`
- `pnpm test`
- `DSH_TEAM_POSTGRES_TEST_URL=postgres://… pnpm run test:postgres`
- `pnpm run build`
- `pnpm run verify:package`
- `pnpm pack --pack-destination <temporary-directory>`
- Isolated `@deepseek-ai/dsh@0.1.0-rc.7` tarball install and `--dump-config`
- Stock DSH browser interaction for Team overview and pause/resume, with a
  clean browser console and desktop/mobile screenshots

The PostgreSQL Team store and Router are restart-safe for control-plane, audit,
session-affinity, and admission state. The actual proxy bridge is now present.
The PostgreSQL runtime now shares per-account envelope-encrypted credentials
and serializes credential refresh on the account row. Memory mode intentionally
retains owner-only local files and a process-local traffic guard. PostgreSQL
mode now serializes per-key RPM, concurrency, expiring leases, and circuit state
across Host replicas. The package now provides an optional out-of-process
broker protocol and Node HTTP handler with fixed paths, bounded bodies,
process-local traffic guards, secret-free response validation, and streaming
relay. The self-hosted deployment now gives its one-shot migrator, Team Host,
and Credential Broker three distinct PostgreSQL identities: Host cannot read
the encrypted credential table, Broker cannot read control-plane tables, and
neither long-running workload receives schema-owner access. Concrete managed
KMS adapters, workload identity/mTLS, and egress policy remain explicit
deployment-hardening work.

The Settings surface is desktop-first for this MVP. The plugin itself does not
overflow a 390 px viewport, but stock DSH's persistent Settings navigation
leaves insufficient mobile content width and cannot be replaced from this
external plugin. The default suite uses pg-mem to validate emitted SQL and
store behavior; `pnpm run test:postgres` additionally verifies emergency-pause
serialization, credential-refresh/online-rewrap row locking, and cross-Host
traffic admission against PostgreSQL's real lock scheduler, and the public CI runs that gate
against PostgreSQL 17.
