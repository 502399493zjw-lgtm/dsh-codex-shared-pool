# Team OAuth Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make contributed-account OAuth recover safely across cancellation, revocation races, and Host restarts without exposing credential material outside the Host.

**Architecture:** Extend the Host-only broker with a secret-free credential inspection result, and extend the Team store with an internal query for contributions left in `authorizing`. The Team service reconciles those records before the runtime becomes available, preserves an OAuth success that races with cancellation, and treats `revoked` as a terminal state so late callbacks cannot reactivate a deleted contribution.

**Tech Stack:** TypeScript, Vitest, PostgreSQL/pg-mem, provider-native OpenAI Codex device OAuth, stock DSH Cordis plugin runtime.

## Global Constraints

- OAuth access and refresh tokens remain readable only by the Host credential broker.
- Browser and Team management routes receive only device verification URL, user code, expiry, and contribution status metadata.
- `revoked` is terminal and no background OAuth callback may transition it to another state.
- Startup reconciliation examines only records persisted as `authorizing`; it never performs an upstream request or starts OAuth automatically.
- A credential file containing exactly one profile reconciles to `active`; missing, empty, or ambiguous credential state reconciles to `reauth_required` with a non-secret diagnostic.
- Existing user changes remain uncommitted; this repository must not be committed, pushed, or published without explicit user authorization.

---

### Task 1: Lock the lifecycle contract with failing tests

**Files:**
- Modify: `tests/team-credentials.spec.ts`
- Modify: `tests/team.spec.ts`
- Modify: `tests/team-postgres.spec.ts`
- Modify: `tests/team-runtime.spec.ts`

**Interfaces:**
- Consumes: existing `TeamCredentialBroker`, `TeamStore`, `TeamService`, and `createTeamServiceFromConfig` APIs.
- Produces: executable expectations for `inspectAuthorization`, terminal revocation, cancel/success ordering, and startup reconciliation.

- [x] **Step 1: Test secret-free local credential inspection**

Create an isolated broker root, assert an absent credential returns:

```ts
{ status: 'reauth_required', lastError: 'authorization was interrupted; authorize this account again' }
```

Then write exactly one OAuth profile through `OpenAICodexCredentialStore` and assert inspection returns `{ status: 'active' }` without access, refresh, or account ID fields.

- [x] **Step 2: Test terminal revocation in both stores**

Create and revoke a contribution, invoke `setContributionAccountStatus(teamId, accountId, 'active')` as a simulated late OAuth callback, and assert the returned and persisted status remains `revoked` in the memory and PostgreSQL store suites.

- [x] **Step 3: Test cancellation racing with OAuth completion**

Use a broker whose `cancelOAuth` callback marks the contribution `active`; assert `TeamService.cancelContributionOAuth` returns and persists `active` instead of overwriting it with `reauth_required`.

- [x] **Step 4: Test runtime startup reconciliation**

Seed an initialized store with an `authorizing` contribution, inject a broker returning `{ status: 'active' }`, create the service through `createTeamServiceFromConfig`, and assert runtime construction does not return until the contribution is active.

- [x] **Step 5: Run the focused tests and confirm they fail for the missing contracts**

Run:

```bash
pnpm exec vitest run tests/team-credentials.spec.ts tests/team.spec.ts tests/team-postgres.spec.ts tests/team-runtime.spec.ts
```

Expected: failures identify the absent inspection/enumeration APIs, non-terminal callback behavior, cancellation overwrite, and missing runtime reconciliation.

### Task 2: Add terminal store transitions and pending-record enumeration

**Files:**
- Modify: `src/team/store.ts`
- Modify: `src/team/postgres-store.ts`

**Interfaces:**
- Consumes: `TeamContributionStatus` and `TeamContributionAccountSummary`.
- Produces: `TeamStore.listContributionAccountsByStatus(status: TeamContributionStatus): Promise<readonly TeamContributionAccountSummary[]>` and idempotent terminal behavior in `setContributionAccountStatus`.

- [x] **Step 1: Extend the store interface and memory implementation**

Filter all in-memory contribution records by exact status and return summaries. In `setContributionAccountStatus`, return the existing summary unchanged when the current status is `revoked` and the requested status differs.

- [x] **Step 2: Implement the PostgreSQL query and terminal transition**

Query `team_contributions` by exact status ordered by `created_at, id`. Keep the existing `FOR UPDATE` lock in `setContributionAccountStatus`, and return the locked row unchanged when it is already revoked.

- [x] **Step 3: Run store-focused tests**

Run:

```bash
pnpm exec vitest run tests/team.spec.ts tests/team-postgres.spec.ts
```

Expected: terminal revocation and pending-record queries pass for both implementations.

### Task 3: Reconcile Host credential state and make cancellation race-safe

**Files:**
- Modify: `src/team/credentials.ts`
- Modify: `src/team/service.ts`
- Modify: broker fakes in `tests/team*.spec.ts`

**Interfaces:**
- Consumes: `TeamCredentialRef`, `TeamStore.listContributionAccountsByStatus`, and Host-owned credential files.
- Produces: `TeamCredentialBroker.inspectAuthorization(ref): Promise<TeamCredentialAuthorizationState>` and `TeamService.reconcileContributionAuthorizations(): Promise<void>`.

- [x] **Step 1: Define the secret-free broker result**

Add:

```ts
export interface TeamCredentialAuthorizationState {
  readonly status: 'active' | 'reauth_required'
  readonly lastError?: string
}
```

The result type must contain no credential, provider account ID, filename, or raw error object.

- [x] **Step 2: Implement local inspection**

Read only profile summaries from the isolated `OpenAICodexCredentialStore`. Return active for exactly one profile; otherwise return reauthorization-required with the fixed interrupted-authorization diagnostic.

- [x] **Step 3: Add service reconciliation**

List only `authorizing` contributions, inspect each through the broker, and persist the returned status and diagnostic. Process records independently so one corrupt credential file does not prevent the remaining records from reconciling; convert inspection failures to a sanitized `reauth_required` diagnostic.

- [x] **Step 4: Preserve completion during cancellation**

Assert ownership and current state, return unchanged when the contribution is no longer `authorizing`, wait for broker cancellation, read the contribution again, and write `reauth_required` only if the persisted status is still `authorizing`.

- [x] **Step 5: Run broker and service tests**

Run:

```bash
pnpm exec vitest run tests/team-credentials.spec.ts tests/team.spec.ts
```

Expected: inspection, cancellation, and reconciliation tests pass without exposing token fields.

### Task 4: Gate runtime readiness on reconciliation

**Files:**
- Modify: `src/team/runtime.ts`
- Modify: `tests/team-runtime.spec.ts`

**Interfaces:**
- Consumes: initialized `TeamStore`, optional injected `TeamCredentialBroker`, and `TeamService.reconcileContributionAuthorizations()`.
- Produces: a runtime service whose persisted `authorizing` records have been reconciled before routes can use it.

- [x] **Step 1: Add a broker test seam to runtime dependencies**

Accept `broker?: TeamCredentialBroker` and pass it into `TeamService` without widening plugin JSON configuration or exposing a browser-controlled credential choice.

- [x] **Step 2: Reconcile before returning the service**

Construct the service after store initialization, await `reconcileContributionAuthorizations()`, dispose the service on reconciliation failure, and return it only after reconciliation succeeds.

- [x] **Step 3: Run the runtime test**

Run:

```bash
pnpm exec vitest run tests/team-runtime.spec.ts
```

Expected: initialization order is store initialize, credential inspection, status persistence, then runtime return.

### Task 5: Document and verify the lifecycle slice

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-08-19-team-control-plane.md`
- Modify: this plan to check completed steps.

**Interfaces:**
- Consumes: completed lifecycle implementation and test evidence.
- Produces: accurate operator documentation and package evidence.

- [x] **Step 1: Document restart and terminal-state semantics**

State that interrupted device authorization is reconciled from Host-owned credential storage at startup, `revoked` cannot be reactivated by stale callbacks, and this local-file implementation remains a single-Host development/self-hosted boundary.

- [x] **Step 2: Run the complete verification sequence**

Run:

```bash
pnpm test
pnpm run build
pnpm run verify:package
```

Expected: all commands exit zero.

- [x] **Step 3: Pack and smoke the changed Host runtime in stock DSH**

Pack into a temporary directory, install that tarball into an isolated `DSH_HOME` with pinned `@deepseek-ai/dsh@0.1.0-rc.7`, and run `--dump-config`. This is a real stock-install smoke, distinct from `verify:package`.

- [x] **Step 4: Request independent read-only review**

Ask the existing review agent to inspect credential boundaries, state transitions, tests, documentation accuracy, and exact Git state without editing files.

### Task 6: Close provider-diagnostic credential leakage

**Files:**
- Create: `src/team/safe-message.ts`
- Create: `tests/team-safe-message.spec.ts`
- Modify: credential, service, store, routing, HTTP route, management proxy, and related test files

**Interfaces:**
- Consumes: untrusted provider, broker, database, and remote-Team diagnostic text.
- Produces: one bounded error sanitizer used before persistence and at every Host-to-Browser projection boundary.

- [x] **Step 1: Reproduce the complete leak path**

Cover opaque Bearer tokens, API keys, client secrets, ID/access/refresh tokens,
JWTs, Team keys, and invite tokens. Assert both OAuth callback delivery and the
remote contribution-to-Browser projection remove the original values.

- [x] **Step 2: Centralize and apply diagnostic redaction**

Use the shared sanitizer in the credential broker, service errors, public Team
routes, local management proxy, in-memory store, PostgreSQL store, and
PostgreSQL routing summaries. Sanitize before database writes and again when
reading old or remote contribution records.

- [x] **Step 3: Verify behavior and package compatibility**

Run focused tests, the complete test suite, build, package verification, and a
fresh tarball install into pinned stock DSH. Keep the real PostgreSQL gate as a
separate required release check when a real database is available.

- [x] **Step 4: Re-review the fixed credential boundary**

Confirm the sanitizer is not pulled into the browser bundle, ordinary
diagnostics remain readable, raw values are absent from PostgreSQL, and the
previous blocker is closed without claiming real-PostgreSQL evidence that was
not run in this environment.
