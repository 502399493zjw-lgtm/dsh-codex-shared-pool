# DSH Codex Shared Pool

`dsh-codex-shared-pool` is the independent package boundary for the DSH
Codex integration. It is installed into stock DeepSeek Harness through the
published Cordis/DSH extension points; it does not patch or fork the
`deepseek-harness` repository.

The package contains both halves of the original DSH bundle:

- a Host plugin for OAuth, refresh, credential storage, account quota, model
  requests, search, image generation, `read_image`, Responses preferences, and
  TUI integration;
- a browser plugin for the stock Settings page, local account and invite-only
  Team operations, quota cards, model fast-mode controls, imagegen tool views,
  and the sidebar quota footer;
- one `cordis.patch.yml` composition boundary and one public npm package.

## Runtime shape

```text
stock DSH profile
  └─ cordis.patch.yml
      └─ dsh-codex-shared-pool
          ├─ Host: OAuth + profile store + quota + request allocator
          ├─ Host: openai-codex Responses adapter
          ├─ Host: multi-Team control plane + gateway
          ├─ Optional broker service: OAuth + quota + fixed-endpoint forwarding
          ├─ Host: standalone web search / imagegen / read_image / TUI
          └─ Client: account + Team Settings + model slots + tool views + sidebar quota
```

The Host owns credentials, refresh tokens, Codex app-server subprocesses, and
filesystem access. Browser code receives only redacted data through same-origin
plugin routes. DSH itself remains an external runtime dependency.

## Account model and automatic failover

Profiles are stored under `$DSH_HOME/.openai-codex-profiles.json` in an ordered
v2 document. The array order is the global priority order. The older
`.openai-codex-auth.json` document is read as a non-destructive one-profile
migration. OAuth access/refresh credentials never cross the browser boundary.

The first profile is the default candidate. The request adapter checks the
selected model's quota before each session request. When that first profile is
proven exhausted, the allocator chooses a profile with known remaining capacity,
preferring the provider reset time that comes first, and promotes the selected
profile to global priority before the provider attempt is recorded. The allocator
understands the Codex and `gpt-5.3-codex-spark` quota buckets. A temporary quota-read
failure remains a fail-open fallback only when no account has proven model capacity.
It clears cached Responses context when a Session changes profiles, and concurrent
requests keep one committed binding per Session.

The Settings page exposes the first profile with one compact **使用中** marker;
other profiles offer a **使用此账号** action. A newly recorded provider attempt
triggers a profile-state refresh, so an automatic fallback moves that single marker
without waiting for the 60-second quota poll. Adding an account starts an isolated
OAuth flow and does not overwrite the current profile. Rename, remove, cancel-login,
and manual account-selection operations are available in Settings; Host routes and
the TUI address the same exact profiles.

### TUI profile commands

The `/codex` command uses the same Host-owned profile store as the model
adapter. Profile ids and labels are safe metadata; OAuth credentials never
enter command results.

```text
/codex status
/codex login
/codex profiles
/codex add
/codex cancel
/codex activate <profile-id>
/codex rename <profile-id> <label>
/codex remove <profile-id>
/codex logout
/codex usage
/codex config
/codex set <read-image|imagegen-other-models|fast|websocket-context|native-compaction> <on|off>
```

`login` creates the initial profile, while `add` performs an isolated OAuth
flow and does not overwrite an existing profile. Repeated `login`/`add`
commands share the one in-flight operation, and `cancel` aborts it. `activate`
moves a profile to the front of the global allocation order. `logout` removes
the current priority profile; if other profiles remain, the command reports
that fact instead of claiming the whole plugin is signed out. OAuth access
token refresh remains provider-driven and is persisted automatically on the
next request.

## Team control plane

The optional Team control plane lets one Host serve multiple invitation-only
Teams. It is disabled by default. The current slice provides local bootstrap,
one-time revocable invites, member summaries, atomic ownership transfer, one-time Team API
keys, tenant-scoped overview, and contributor-owned account controls. A contribution starts an
isolated OpenAI device-code OAuth challenge through a Host-only Credential
Broker. The broker can run inside the Team Host or behind the package's fixed
remote broker protocol. The caller receives only the verification URL, one-time
user code, and expiry; the credential-owning process polls and exchanges the
code, so remote contributors do not depend on a callback to `localhost:1455`. The Team Responses
gateway accepts each member's Team API key, reads live provider quota through
the broker, and implements session stickiness, requester-owned-account priority,
and shared fallback with provider quota, reserve, model, request-window, and
shared concurrency guards. Every admitted request creates a metadata-only audit
event; prompt, response, file, OAuth token, and Team-key contents are never
written to that audit stream.

For a restart-safe control plane, put the PostgreSQL URL, local-only bootstrap
secret, and a random 32-byte credential-encryption key in the Host credential
provider (the environment provider is shown here). Plugin configuration
contains only their references:

```sh
export DSH_CODEX_SHARED_POOL_DATABASE_URL='postgres://...'
export DSH_CODEX_SHARED_POOL_BOOTSTRAP_TOKEN='use-a-local-secret-at-least-16-characters'
export DSH_CODEX_SHARED_POOL_CREDENTIAL_MASTER_KEY="$(openssl rand -base64 32)"
```

```yaml
- id: codex-shared-pool
  name: dsh-codex-shared-pool
  config:
    team:
      enabled: true
      storage: postgres
      databaseUrlRef: DSH_CODEX_SHARED_POOL_DATABASE_URL
      credentialMasterKeyRef: DSH_CODEX_SHARED_POOL_CREDENTIAL_MASTER_KEY
      bootstrapTokenRef: DSH_CODEX_SHARED_POOL_BOOTSTRAP_TOKEN
      maxInviteTtlMs: 604800000
```

`storage: memory` remains available for tests and disposable local
development. PostgreSQL schema migrations run automatically at Team service
startup. Team API keys and invite tokens are stored only as SHA-256 hashes;
the original values are returned once when created. Revoking an unused invite
immediately invalidates it and replaces its live hash with a terminal sentinel.
PostgreSQL mode with the
default local broker fails startup if the credential master key is missing,
malformed, or does not decode to exactly 32 bytes.

### Self-hosted central Team server

One central Host can serve any number of independent Teams; a Team does not
need its own server. The starter deployment runs four long-running processes
on one server—PostgreSQL, a loopback-only stock DSH Team Host, a loopback-only
Credential Broker, and a narrow public Team API Edge—plus a one-shot database
migrator that exits before either application workload starts. From the
repository root:

```sh
node deploy/self-hosted/init-secrets.mjs
docker compose -f deploy/self-hosted/compose.yml up --build -d
```

The initializer creates four mode-`0600` files under the ignored
`deploy/self-hosted/.secrets/` directory and refuses to replace existing
secrets:

- `postgres.env` initializes the shared PostgreSQL database and its distinct
  runtime login passwords;
- `team-migrations.env` gives only the one-shot migrator the schema-owner
  database URL;
- `team-host.env` gives Team Host its database URL, bootstrap token, and the
  internal Broker API key, but no credential decryption key;
- `credential-broker.env` gives only the Broker its envelope master key,
  database URL, and matching internal API key.

The database starts with a schema-owner `dsh_team_migrator` identity and two
separate workload logins. The one-shot migrator applies every packaged schema
migration and the checked-in role policy, verifies the effective grants, and
then exits. `dsh_team_host_login` can use Team control-plane tables but Team
Host cannot read `team_contribution_credentials`.
`dsh_team_broker_login` can use that credential table, while the Credential
Broker cannot read the Team control-plane tables. Neither long-running
workload receives the migrator URL; only the Broker receives the envelope key.

The Compose stack uses the verified stock DSH `0.1.0-rc.8`. The image freezes
installation to the registry snapshot containing that release, keeping the
full runtime graph on the tested version. It installs the plugin tarball rather
than loading repository source, validates the native PTY dependency while the
image is built, and runs each Node.js process as a non-root user.

Stock DSH listens only on `127.0.0.1:3081` and is never published. This is an
intentional security boundary: its Web and Remote APIs are not a public Team
service. The Team API Edge is the only listener on container port `3080` and
the only port published to the host, bound to `127.0.0.1` by default. It
forwards only `/plugins/dsh-codex-shared-pool/team/...`, blocks bootstrap and
the Team Host management proxy, rejects WebSocket upgrades and encoded path
variants, and removes cookies plus forwarding/bootstrap headers. PostgreSQL
has no published port. The Broker shares the Team Host network namespace,
binds `127.0.0.1:8788`, and therefore cannot be reached through the Compose
bridge or host network. Put an HTTPS reverse proxy in front of the Team API
Edge, never in front of the stock DSH listener.

After the services are healthy, create the first Team from inside the Host
container. The result contains the Owner's one-time Team API key, so save it in
a password manager when it is printed:

```sh
docker compose -f deploy/self-hosted/compose.yml exec team-host \
  node /opt/dsh/deploy/host/bootstrap.mjs "Friends" "Alice"
```

Further Teams can be created with the same command and different names. Each
Team and member gets separate hashed credentials and tenant-scoped data in the
shared PostgreSQL instance. Stop the stack without deleting its named database
volume with `docker compose -f deploy/self-hosted/compose.yml down`.

The checked-in CI starts these four long-running services plus the one-shot
migrator. Startup fails unless PostgreSQL reports the exact Host/Broker table
privilege boundary. A bounded smoke then authenticates through the loopback
Broker protocol, verifies its credential-table read path using a nonexistent
probe account, and creates two disposable Teams. In each Team the Owner creates
a one-time invite, a friend joins and receives a distinct member key, reuse of
the invite is rejected, and both Owner and friend read a tenant-isolated
overview. It does not contact OpenAI or prove a real OAuth exchange.

Maintainers can run a separate, deliberately manual live gate when preparing a
release. It creates a disposable Team, asks the maintainer to complete one
OpenAI device-code authorization, joins a synthetic friend, sends one fixed
`gpt-5.4` Responses request through that friend's Team key, requires the SSE
stream to complete with the fixed expected model output, and requires a
metadata-only usage event that identifies the friend, contribution Owner, and
upstream account:

```sh
docker compose -f deploy/self-hosted/compose.yml exec -T team-host \
  node /opt/dsh/deploy/host/smoke-live-sharing.mjs \
  --confirm-disposable-live-openai-test-data
```

Pass `-e DSH_CODEX_SHARED_POOL_LIVE_SMOKE_MODEL=<model>` to `docker compose
exec` if the test account cannot use the default model. The confirmation flag
is mandatory because this gate creates real OpenAI OAuth state and consumes one
real request. It is intentionally excluded from CI.
During cleanup the script pauses the Team, asks the Credential Broker to delete
the Pool's credential copy, removes the friend, and revokes the disposable
Team keys. The paused Team and metadata-only audit rows remain in PostgreSQL.
Pool deletion is not a claim that every OpenAI-side session or authorization
has been globally revoked; use the provider's own account controls when that is
required. The script prints the short-lived device challenge and secret-free
identifiers, never Team keys, invite tokens, prompts, or response content.

This Compose file is a small self-host starter, not a complete public-service
security posture. It separates the schema-owner, Team Host, and Credential
Broker database identities, but the included Edge is an API allowlist—not TLS,
authentication termination, rate limiting, or a general-purpose WAF. For a
hosted public service, also add managed secret delivery/KMS, database backups,
egress controls, monitoring, rate limiting, and an HTTPS reverse proxy in front
of the Edge. Never commit or copy the generated `.secrets` directory.

The PostgreSQL image's login initializer runs only when Docker creates an empty
database volume. This pre-release starter does not silently rewrite an older
shared-login volume: preserve and migrate existing data explicitly before
switching its env files, or use a fresh volume only when the existing data is
known to be disposable.

### Credential Broker topology and external deployments

The self-host starter already moves provider OAuth material, refresh, quota
reads, and fixed-endpoint Responses forwarding into the separate Broker
container. Larger deployments can run the same daemon on another host. Put a
random internal key in both services' credential providers and select remote
mode:

```sh
export DSH_CODEX_SHARED_POOL_CREDENTIAL_BROKER_API_KEY="$(openssl rand -base64 48)"
```

```yaml
- id: codex-shared-pool
  name: dsh-codex-shared-pool
  config:
    team:
      enabled: true
      storage: postgres
      databaseUrlRef: DSH_CODEX_SHARED_POOL_DATABASE_URL
      credentialBroker: remote
      credentialBrokerBaseUrl: https://broker.internal.example/v1/dsh-team-credential-broker
      credentialBrokerApiKeyRef: DSH_CODEX_SHARED_POOL_CREDENTIAL_BROKER_API_KEY
      bootstrapTokenRef: DSH_CODEX_SHARED_POOL_BOOTSTRAP_TOKEN
```

Remote mode requires PostgreSQL and deliberately does not resolve
`credentialMasterKeyRef` in the Team Host. The package exports
`createTeamCredentialBrokerHttpHandler`, `LocalTeamCredentialBroker`, and
`PostgresTeamEnvelopeCredentialBackend` for the separate broker service. That
service owns the KEK/KMS identity and credential-table access, while the Team
Host owns control-plane tables and only an internal broker key. Run the package
migrations with a migration role before starting either restricted runtime
against a new schema.

The package also installs a ready-to-run `dsh-codex-team-broker` command. It
binds to `127.0.0.1:8788` by default, validates the credential-table schema and
its runtime role's CRUD privileges before listening, exposes unauthenticated
`GET /healthz` with no secret data, and drains open connections on SIGINT or
SIGTERM. Every required secret accepts either a direct environment value or a
mutually exclusive `_FILE` path; file input is bounded to a regular 64 KiB
file. A container-secret setup can use:

```sh
export DSH_CODEX_SHARED_POOL_DATABASE_URL_FILE=/run/secrets/database-url
export DSH_CODEX_SHARED_POOL_CREDENTIAL_MASTER_KEY_FILE=/run/secrets/credential-master-key
export DSH_CODEX_SHARED_POOL_CREDENTIAL_BROKER_API_KEY_FILE=/run/secrets/broker-api-key
dsh-codex-team-broker
```

`deploy/broker/Dockerfile` is a non-root reference image, and
`deploy/postgres/runtime-roles.sql` grants the Team Host only the control-plane
tables while granting the Broker only `team_contribution_credentials`. The SQL
assumes the `public` schema and must be adapted if the deployment uses a
different `search_path`. The bundled Compose migrator applies this policy and
checks both fixed workload logins automatically. The runtime Host first checks
`team_schema_migrations`; when all packaged versions are present it performs no
DDL, so the restricted Host role needs only `SELECT` on that migration table.
For an external deployment, run `dsh-codex-team-migrate` with the schema-owner
URL before rolling either restricted runtime after every package upgrade.

The protocol has no token-export or arbitrary-URL method. It exposes only
OAuth start/restart/cancel/status, secret-free usage metadata, revoke, and raw
Responses streaming to the broker's fixed Codex endpoint. Its handler verifies
the internal Bearer key before reading a body, re-resolves the expected key for
each call, accepts at most 32 MiB request bodies, and applies fixed process-local
safety defaults of 600 requests/minute and 64 concurrent calls. The Team Host
re-resolves its key on every operation and accepts plain HTTP only for loopback
development; production transport must be HTTPS.
If the Team Host disconnects or a bounded quota read times out, the broker
propagates cancellation to the provider request and releases its process-local
concurrency slot instead of leaving detached upstream work running.

Process separation is not automatically a complete privilege boundary. Keep
the separate PostgreSQL roles so the Team Host role cannot read
`team_contribution_credentials`, restrict broker ingress to Team Hosts, restrict
broker egress to the required OpenAI/ChatGPT endpoints and identity provider,
and prefer workload identity or mTLS in addition to the rotating internal key.
A compromised Team Host can still invoke the broker's allowed capabilities,
but it has no API for reading provider access or refresh tokens.

Each contributed account in PostgreSQL has an independent random DEK. Its OAuth
document is encrypted with AES-256-GCM, and the DEK is wrapped by a pluggable
Host-only key-encryption provider. The bundled provider reads the KEK through
the DSH credential service; a deployment can inject a managed-KMS adapter at
the same interface. Wrapped-key storage accepts either the bundled provider's
separate AES-GCM nonce/tag or a bounded opaque KMS ciphertext blob with no
AES-specific metadata columns. A KMS adapter remains responsible for binding
the Team/account reference into its encryption context. Database backups remain
recoverable only together with a provider that can unwrap the matching stored
key ids. Encryption protects a stolen database, but it is not zero knowledge—a
compromised Host/broker process or operator with runtime decrypt authority can
still use the account. There is no token-export route, and Team owners cannot
inspect another member's credential.

The package exports a Host-only, resumable online rewrap operation. It changes
only each account's wrapped DEK and leaves the encrypted OAuth document,
document nonce, and authentication tag unchanged. Each account runs in its own
transaction under the same PostgreSQL row lock as refresh-token mutation. A
replacement is committed only after the active provider proves that it can
unwrap the new envelope to the same 32-byte DEK.

For a local-KEK rotation, use this deployment sequence:

1. Add the new key as `credentialPreviousMasterKeyRef` while the old key stays
   in `credentialMasterKeyRef`, and roll that readable keyring to every Host.
2. Swap the references so the new key is primary and the old key is previous;
   roll that configuration to every Host. Both generations can now read rows
   written by either generation.
3. From trusted Host administration code, construct the same primary-first
   `TeamKeyEncryptionKeyring` and call
   `PostgresTeamEnvelopeCredentialBackend.rewrapCredentialKeys()`. Do not put
   this operation behind a Browser or Team-owner route.
4. Repeat until the report has `rewrapped: 0`, `unchanged === scanned`, and
   `missing: 0`; a concurrent account creation or deletion is handled by the
   next run.
5. Remove `credentialPreviousMasterKeyRef` from every Host only after that
   verification, and retain the old key with backups that still need it.

`batchSize` controls metadata pagination (1–1000). Rows commit independently,
so an interrupted run resumes safely; `force: true` rewraps even when the
target returns the same key id. The bundled configuration supports one previous
local KEK during rotation. Cloud-specific KMS adapters are not bundled yet.

The bootstrap route only accepts loopback requests and the
`x-dsh-bootstrap-token` header. After bootstrap, use the returned Team API key
as `Authorization: Bearer <key>` or `x-dsh-team-key`. OAuth access and refresh
tokens are not part of these responses.

```text
/plugins/dsh-codex-shared-pool/team/bootstrap
/plugins/dsh-codex-shared-pool/team/overview
/plugins/dsh-codex-shared-pool/team/status
/plugins/dsh-codex-shared-pool/team/invites
/plugins/dsh-codex-shared-pool/team/invites/revoke
/plugins/dsh-codex-shared-pool/team/join
/plugins/dsh-codex-shared-pool/team/members/leave
/plugins/dsh-codex-shared-pool/team/ownership/transfer
/plugins/dsh-codex-shared-pool/team/keys
/plugins/dsh-codex-shared-pool/team/keys/revoke
/plugins/dsh-codex-shared-pool/team/contributions
/plugins/dsh-codex-shared-pool/team/contributions/oauth/start
/plugins/dsh-codex-shared-pool/team/contributions/oauth/cancel
/plugins/dsh-codex-shared-pool/team/contributions/oauth/reauthorize
/plugins/dsh-codex-shared-pool/team/contributions/update
/plugins/dsh-codex-shared-pool/team/contributions/revoke
/plugins/dsh-codex-shared-pool/team/usage
/plugins/dsh-codex-shared-pool/team/responses
/plugins/dsh-codex-shared-pool/team/codex/responses
```

Use the URL ending in `/team` as an OpenAI-compatible base URL and the member's
one-time Team key as its Bearer/API key. Generic clients can call `/responses`;
Codex-native pi-ai clients append `/codex/responses`. Both aliases use the same
authenticated handler. The gateway accepts the Codex client's zstd request
encoding, validates the decompressed size, and forwards only to the fixed
ChatGPT Codex Responses endpoint. It never
accepts an arbitrary upstream URL and never forwards the Team authorization
header. A provider response is streamed without being stored by the plugin.
If the client disconnects before that stream finishes, the gateway aborts the
broker/upstream request and settles the routing lease plus metadata-only usage
event as cancelled so the member and contribution concurrency slots are not
left occupied until their TTLs expire.

### Using a Team from another DSH Host

A member does not run a separate Team server. One hosted plugin instance can
serve many Teams, while each member's local DSH enables `teamClient` and keeps
only that member's Team API key in the Host credential provider:

```sh
export DSH_CODEX_SHARED_POOL_TEAM_API_KEY='dsh_team_...'
```

```yaml
- id: codex-shared-pool
  name: dsh-codex-shared-pool
  config:
    teamClient:
      enabled: true
      baseUrl: https://pool.example.com/plugins/dsh-codex-shared-pool/team
      apiKeyRef: DSH_CODEX_SHARED_POOL_TEAM_API_KEY
```

The configured URL must use HTTPS; plain HTTP is accepted only for loopback
development. User info, passwords, query strings, fragments, and non-Team paths
are rejected before a key can be sent. The Host re-resolves `apiKeyRef` for
every request, wraps the opaque key only to satisfy the Codex provider's local
JWT-shaped account-id check, and the Team gateway unwraps it before checking
the original stored key hash. The Host never returns a stored Team key to the
browser. The only browser-held Team key is one the user explicitly enters for
the one-time existing-key bootstrap flow; it is submitted only to the local
Host credential provider.

The stock Settings shell also receives a **Codex Team** page through the public
`settings.section` slot. It talks only to a local same-origin management proxy;
that Host resolves the member key for each operation and projects the remote
response before returning it. The page supports invite join, an existing-key
bootstrap path, member and revocable pending-invite views, Owner transfer, device-code contribution,
contributor-owned reserve/cap/model controls, pause/revoke, Team emergency
pause, owner-only current sharing-capacity diagnostics, real non-owner Team
departure, and metadata-only recent activity. Raw
credentials, key hashes, contribution-cleanup details, and API key inventories
are not part of the browser contract.

“Leave this Host” and “Leave Team” are intentionally different operations.
Disconnecting a Host revokes only the current Team key (or, for emergency local
cleanup, deletes only its local copy); membership and contributed accounts stay
in the Team. A non-owner Team departure atomically marks the member removed,
revokes all of that member's Team keys, and marks all of their contributions
revoked. The service then stops new routing, drains admitted work, and deletes
each isolated Pool credential. Persisted revoked contributions are reconciled
again on Host startup, so interrupted broker cleanup is retried fail-closed.
An Owner must transfer ownership before leaving. The target must be a different,
active member of the same Team with at least one live Team API key. The transfer
atomically makes the target Owner and the caller Admin, so the caller may then
leave. Existing Team keys stay valid, and contributions remain owned by their
original contributors. Settings shows the action only when the local Host has
confirmed the target's eligibility from the remote overview; the underlying
API-key inventory is not forwarded to the Browser. Pool credential deletion
still does not claim that OpenAI-side sessions or tokens were revoked.

The first Settings UI is desktop-first. It remains horizontally contained on a
390 px viewport, but stock DSH's persistent Settings navigation leaves too
little content width for a production-quality phone layout; improving that
shell is outside this plugin's public extension boundary.

In Team client mode, `openai-codex` model requests and native compaction use the
remote Team gateway, local OAuth profile allocation is skipped, and transport
is fixed to HTTP SSE because the Team gateway does not expose an upstream
WebSocket. Standalone search, image generation, quota cards, and local account
management still use local OAuth in this MVP; they are not silently routed
through the Team key.

The data plane has fixed per-key safety defaults of 60 admitted requests per
minute and four concurrent requests. Eight consecutive provider/auth/quota
failures open a one-minute circuit. One external request may try at most eight
upstream accounts after explicit `401`/`403`/`429` hard-limit responses. These
are process safety controls, not member consumption allocations. Owner/Admin
can call the status route with
`{"status":"paused"}` to stop all new Team admission immediately; existing
streams are allowed to settle.

Contribution settings include `active`/`paused`/`revoked` state, a
`personalReservePercent`, an optional request-count cap for the longest
observed provider quota window, fixed shared concurrency, and an optional model
allow-list. The reserve check uses the lowest remaining percentage across the
model bucket and individual limit. The request-count cap is a conservative
safety upper bound, not a claim about exact token cost; if the longest provider
window has no reset timestamp, capped shared admission fails closed instead of
inventing one from its duration. A failed admitted request is still counted
because the upstream provider may already have consumed subscription capacity;
settling always releases its in-flight slot. Only an account confirmed by the
Host credential broker can
enter `active`; the ordinary contribution update route may switch an already
authorized account only between `active` and `paused`. On Host startup, a
persisted `authorizing` record is reconciled against its credential broker, and
a persisted `revoked` record is drained and removed from the broker again. An
in-process broker requires exactly one stored profile; an out-of-process broker
can report that OAuth is still `authorizing`, in which case the Host resumes
status polling rather than prematurely requiring another login. Missing or
ambiguous state becomes `reauth_required`. A stale OAuth callback cannot
reactivate a paused or revoked contribution. Revocation first blocks new
admission and drains in-flight work, then deletes this plugin's local
credential. It does **not** claim to revoke all OpenAI-side sessions or tokens
for that account. Provider diagnostics are reduced to bounded, credential-
redacted text before persistence and are sanitized again when projected to the
browser, including legacy or remote `lastError` values. The same Host-only
projection is used for OAuth browser routes, CLI/TUI output, search and image
provider errors, and Responses failures before those messages leave the Host.

An active contribution's owner can also see a secret-free current-capacity
snapshot for each allowed provider bucket: remaining percentage, longest-window
reset, shared requests counted in that window, shared requests currently in
flight, and the first routing guard that blocks new sharing. This projection is
never included for another member's contribution, even for a Team Owner/Admin,
and both the local Host proxy and Browser parser enforce that ownership boundary
again. Provider usage reads may be cached for up to 15 seconds and routing counts
are observational snapshots; admission still rechecks every guard atomically.

The contributor can repair a `reauth_required` account in place from **Codex
Team → 重新授权 / Sign in again**. This keeps the contribution ID, owner,
personal reserve, request cap, shared concurrency, and model allow-list. The
Host deletes only that contribution's isolated stale credential record before
starting a fresh device-code login; it never imports a local Codex `auth.json`
or exposes the resulting credential to the browser. Team administrators may
revoke a contribution, but cannot reauthorize another member's account.

The PostgreSQL mode makes Team, membership, contribution policy, key, invite,
metadata-only usage state, admission leases, shared concurrency, reset-window
request counts, session bindings, per-key RPM/concurrency/circuit state, and
encrypted contribution credentials restart-safe and shared across Host
replicas. Credential refresh holds that account's row lock through
decrypt/update/encrypt/commit so parallel Hosts do not overwrite refresh-token
rotation. Lease admission locks the
candidate contribution rows, so multiple Hosts cannot overbook the same shared
account. Starting a usage event also holds a shared Team-row lock through the
status check and insert, so an emergency pause cannot return before all earlier
admissions are durable. The per-key traffic guard serializes admission and
circuit transitions on one API-key state row; its expiring request leases are
renewed with long-running provider streams, so an interrupted Host eventually
releases its concurrency slot.
The default store suite validates query shape and behavior with pg-mem. The
separate real-database gate creates and removes a random isolated schema and
exercises PostgreSQL's actual lock scheduler:

```sh
DSH_TEAM_POSTGRES_TEST_URL='postgres://...' pnpm run test:postgres
```

The public CI workflow runs this gate against PostgreSQL 17 in addition to the
normal unit, build, and package checks. It covers concurrent ownership-transfer
serialization, emergency-pause ordering, cross-Host credential refresh, online
key-rewrap, and traffic-admission serialization. The command fails clearly when the URL is absent rather than
silently skipping real-database evidence.
The full five-case gate was also run locally on 2026-08-20 against a disposable
`postgres:17-alpine` database. The two multi-waiter cases validate PostgreSQL's
queued blocker chain rather than assuming every waiter is directly blocked by
the control transaction.
Provider `reset_at` and `reset_after_seconds` evidence is normalized once and
cached briefly; the window duration is never misused as a reset countdown. The
fixed per-key guard is process-local only in the intentionally single-process
memory mode. PostgreSQL mode selects the shared guard automatically. The
self-host starter automatically separates its database roles. A managed
cloud-KMS adapter, workload identity/mTLS, and broker egress policy remain
deployment-hardening choices rather than claims made by the optional process
boundary, bundled KEK adapter, and provider-neutral rewrap engine.

## Included feature surface

The independent package carries the DSH bundle's complete Codex surface:

- ChatGPT OAuth login, refresh, logout, named profiles, and legacy migration;
- live per-profile usage, individual limits, credits, and model-specific
  exhaustion checks;
- aggregate sidebar quota with an app-server reader when DSH subprocess is
  available and a profile-usage fallback otherwise;
- OpenAI Codex Responses streaming, WebSocket context reuse, native compaction,
  fast-mode preference, and model reasoning metadata;
- bounded process-memory receipts for local request routing, with safe ordinal
  account aliases, selection reasons, request status, and no request content;
- standalone cached/indexed/live web search;
- image generation/editing, vision attachment conversion, and the enhanced
  `read_image` URL path;
- TUI login/status, multi-profile lifecycle, and live preference commands,
  plus stock DSH Settings/model/tool slots.

Important Host routes are all plugin-owned and same-origin:

```text
/plugins/dsh-openai-codex/auth/status
/plugins/dsh-openai-codex/profiles
/plugins/dsh-openai-codex/profiles/login
/plugins/dsh-openai-codex/profiles/login/cancel
/plugins/dsh-openai-codex/profiles/priority
/plugins/dsh-openai-codex/profiles/rename
/plugins/dsh-openai-codex/profiles/remove
/plugins/dsh-openai-codex/quota
/plugins/dsh-openai-codex/network
/plugins/dsh-openai-codex/routing-events
/plugins/dsh-openai-codex/image-tools
/plugins/dsh-openai-codex/response-api
```

## DSH composition

`cordis.patch.yml` adds this package after the stock LLM and Web services and
sets the default agent model. The package's `dsh.client.inject` list mirrors
the original DSH bundle (`dsh-api-remotes`, client runtime, model selection,
primitives, tool, Settings, sidebar, and locale), so installing it does not
replace or hide the stock sidebar shell.

The only mutable state owned by this repository is the plugin's own profile
document and preference namespace. The DSH core repository, its `master`
branch, and its worktrees are not part of this project. Git state for this
package is therefore maintained in this repository's `codex/*` branch.

## Configuration

The Cordis plugin accepts the search and Responses settings used by DSH. The
optional `quota` object controls the exact app-server sidebar reader:

```yaml
- id: codex-shared-pool
  name: dsh-codex-shared-pool
  config:
    quota:
      accountHomes: ["~/.codex"]
      refreshIntervalMs: 60000
      requestTimeoutMs: 15000
      disposeGraceMs: 3000
      codexCommand: codex
```

Without `accountHomes`, the reader uses `DSH_CODEX_ACCOUNT_HOMES`, then
`CODEX_HOME`, then `~/.codex`. The profile store used for OAuth requests is
independent of this optional app-server projection, so a DSH installation
without the subprocess service still has account Settings and request-time
usage fallback.

## Local verification

```sh
pnpm install
pnpm test
pnpm run build
pnpm run verify:package
# with a stock DSH Web profile already running:
pnpm run smoke:web
# with a disposable Team-enabled stock DSH on 127.0.0.1:3099:
pnpm run smoke:team-web
```

`build` emits the Host ESM entry, the lazy browser entry expected by DSH's
module loader, the browser stylesheet, and TypeScript declarations. `verify:package`
checks the public package shape and plugin-owned route names; it is not a
substitute for a real stock-DSH installation smoke test. `smoke:web` probes the
stock web shell and the credential-safe auth, profile, and quota routes without
printing their response bodies. `smoke:team-web` uses the secret-free
`tests/fixtures/team-web-smoke.patch.yml` overlay and requires
`DSH_CODEX_SHARED_POOL_BOOTSTRAP_TOKEN`. It creates an in-memory Team, connects
the local Browser proxy, creates and revokes an invitation, proves the revoked
token cannot join, then revokes the temporary Owner key and removes it from the
local credential store. Run it only against a disposable loopback stock DSH;
the intentionally inaccessible in-memory Team disappears when that process
stops.

## Install into DSH

```sh
pnpm pack
dsh plugin --profile web add ./dsh-codex-shared-pool-0.1.0-alpha.0.tgz
```

Start the same Web profile, open Settings → OpenAI Codex for local profiles or
Settings → Codex Team for invite-only sharing. Local profile labels can be
renamed in place without changing the underlying OAuth credential. Use
**添加账号** to begin local OAuth, or **获取设备码** to contribute through a
central Team Host. Existing
contributions that show **需要重新登录** can be repaired with **重新授权**;
the account's sharing protections remain unchanged. Existing
sessions are rescanned against the current global profile order on every local
request. A readable 0% model bucket is skipped; a known-usable fallback with the
earliest provider reset time becomes the new global priority. Unreadable quota
remains fail-open only if no alternative has proven model capacity, and if every
profile reports exhausted the existing binding (or the first profile for a new
session) is retained for the provider to decide. The
OpenAI Codex settings page keeps at most 100 metadata-only local request
receipts in Host process memory and shows the newest three. Each receipt is one
request attempt—not a token, cost, or exact subscription-consumption metric—and
is lost when the Host restarts. Ordinal aliases reflect priority order at the
time of admission; they are not account identities. Do not copy
`auth.json`, refresh tokens, or `.openai-codex-profiles.json` into the package
or browser bundle.

## Compatibility

The package is verified against DSH `0.1.0-rc.8` public packages and the
current DSH Codex bundle contracts. A DSH release that changes slot names,
Cordis service contracts, or the Responses adapter requires a fresh stock
installation check before widening this range.

## License

MIT
