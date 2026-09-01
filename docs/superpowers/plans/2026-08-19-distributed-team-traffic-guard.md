# Distributed Team Traffic Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the fixed per-Team-API-key RPM, concurrency, and automatic circuit-breaker safeguards atomic across every Host replica sharing one PostgreSQL database.

**Architecture:** Extract the gateway's process-local guard behind an async Host-only interface. Memory mode keeps an in-process implementation; PostgreSQL mode stores one serialized circuit state per API key plus expiring request leases. Acquisition, completion, and circuit transitions lock the API-key traffic-state row so concurrent Hosts cannot over-admit or lose failure updates. The gateway renews long-running leases and maps expected guard failures to safe HTTP responses without exposing database errors.

**Tech Stack:** TypeScript 6, node-postgres 8, PostgreSQL 17, pg-mem 3, Vitest 4, stock DSH `0.1.0-rc.7`.

## Global Constraints

- These limits are fixed fault-safety controls, not configurable member consumption quotas.
- API-key plaintext, prompt/response bodies, provider credentials, and raw database errors never enter traffic tables or Browser projections.
- PostgreSQL is authoritative in hosted mode; process memory is authoritative only for the explicit memory/development mode.
- A crashed Host cannot hold a concurrency slot forever: leases expire unless renewed.
- RPM counts every authenticated acquisition attempt admitted during the trailing 60-second window, including completed and expired requests.
- Circuit sequencing follows completion order. Success resets consecutive failures, neutral completion leaves the counter unchanged, and the configured failure threshold opens the circuit for the configured duration.
- Revocation and admission serialize on the API-key row so no new distributed lease can be created after key revocation returns.
- Keep stock DSH core untouched and do not commit, push, publish, or create a PR without explicit user authorization.

---

## File Structure

- Create `src/team/traffic-guard.ts`: async guard contracts, error projection, memory implementation, and PostgreSQL implementation.
- Modify `src/team/postgres-store.ts`: migration v4 for traffic state and expiring leases.
- Modify `src/team/gateway.ts`: choose the backend from the Team store, await acquire/renew/finish, and safely handle guard backend failure.
- Modify `src/team/index.ts` and `src/index.ts`: export public Host-side traffic-guard contracts and implementations.
- Create `tests/team-traffic-guard.spec.ts`: deterministic memory and pg-mem behavior tests.
- Modify `tests/team-gateway.spec.ts`: gateway integration, injected backend failure, and async settlement tests.
- Modify `tests/team-postgres.integration.spec.ts`: real PostgreSQL row-lock contention proving one cross-Host concurrency admission.
- Modify `README.md` and `docs/superpowers/plans/2026-08-19-team-control-plane.md`: deployment semantics and evidence.

## Task 1: Define the async guard contract and preserve memory behavior

**Files:** `src/team/traffic-guard.ts`, `src/team/gateway.ts`, `tests/team-traffic-guard.spec.ts`, `tests/team-gateway.spec.ts`

**Interfaces:**

```ts
export type TeamTrafficResult = 'success' | 'failure' | 'neutral'

export interface TeamTrafficLease {
  renew(): Promise<void>
  finish(result: TeamTrafficResult): Promise<void>
}

export interface TeamTrafficGuard {
  acquire(keyId: string): Promise<TeamTrafficLease>
}

export interface TeamTrafficGuardOptions {
  requestsPerMinute: number
  maxConcurrency: number
  failureThreshold: number
  circuitOpenMs: number
  leaseTtlMs: number
  now?: () => number
  id?: () => string
}
```

- [x] Write failing tests that call an async memory guard and assert RPM, concurrency, retry-after, circuit open/reset, renew, idempotent finish, and lease expiry.
- [x] Run `pnpm exec vitest run tests/team-traffic-guard.spec.ts` and confirm failure because the module/contracts do not exist.
- [x] Move the current in-memory state machine into `MemoryTeamTrafficGuard`; return async leases and preserve completion-order circuit behavior.
- [x] Add `trafficGuard?: TeamTrafficGuard` and `trafficLeaseTtlMs?: number` to `TeamGatewayOptions`; make acquisition and final settlement awaitable.
- [x] Run the focused traffic and gateway tests and confirm the existing HTTP behavior remains unchanged.

## Task 2: Add the durable traffic schema and PostgreSQL implementation

**Files:** `src/team/postgres-store.ts`, `src/team/traffic-guard.ts`, `tests/team-postgres.spec.ts`, `tests/team-traffic-guard.spec.ts`

**Schema:**

```sql
CREATE TABLE team_api_key_traffic_state (
  key_id text PRIMARY KEY REFERENCES team_api_keys(id) ON DELETE CASCADE,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  open_until bigint NOT NULL DEFAULT 0 CHECK (open_until >= 0),
  updated_at bigint NOT NULL
);

CREATE TABLE team_api_key_traffic_leases (
  id text PRIMARY KEY,
  key_id text NOT NULL REFERENCES team_api_keys(id) ON DELETE CASCADE,
  started_at bigint NOT NULL,
  expires_at bigint NOT NULL CHECK (expires_at >= started_at),
  finished_at bigint,
  result text CHECK (result IS NULL OR result IN ('success', 'failure', 'neutral')),
  CHECK ((finished_at IS NULL) = (result IS NULL))
);
```

- [x] Add failing pg-mem tests using two `PostgresTeamTrafficGuard` instances sharing one pool: one active concurrency slot, one RPM window, shared circuit threshold, success reset, renew/expiry, idempotent finish, and revoked-key rejection.
- [x] Add migration v4 and indexes for `(key_id, started_at)` and `(key_id, finished_at, expires_at)` under the existing advisory migration lock.
- [x] Implement `PostgresTeamTrafficGuard.acquire()` as one transaction: `SELECT team_api_keys ... FOR SHARE`, reject missing/revoked keys, ensure and `SELECT ... FOR UPDATE` the traffic-state row, prune only old settled/expired leases, count the trailing RPM window and live leases, then insert one expiring lease.
- [x] Implement `renew()` so only an unfinished, unexpired lease can extend; a missing/expired lease fails closed.
- [x] Implement idempotent `finish()` under the same state-row lock. Update the lease once, then atomically reset/increment/open the circuit according to the result.
- [x] Ensure expected limit/revocation errors contain only stable codes/messages/retry seconds; unexpected SQL errors are never embedded in HTTP or persisted diagnostics.
- [x] Run `pnpm exec vitest run tests/team-traffic-guard.spec.ts tests/team-postgres.spec.ts` and confirm all pg-mem behavior passes without claiming real row-lock scheduling evidence.

## Task 3: Select the distributed backend in the gateway and renew leases

**Files:** `src/team/gateway.ts`, `src/team/index.ts`, `src/index.ts`, `tests/team-gateway.spec.ts`

- [x] Add a failing test proving a `PostgresTeamStore` defaults to `PostgresTeamTrafficGuard`, while `MemoryTeamStore` keeps `MemoryTeamTrafficGuard`; retain explicit `trafficGuard` injection for unit tests/adapters.
- [x] Build one bounded options object in the gateway. Use `PostgresTeamTrafficGuard({ pool })` only when `service.store instanceof PostgresTeamStore`; otherwise use memory mode.
- [x] Start the heartbeat immediately after traffic admission. Each tick renews the traffic lease and, after route admission, the contribution route lease. A renewal failure aborts forwarding and settles metadata safely.
- [x] Map limit/circuit errors to `429` with `Retry-After`, a key revoked between authentication and acquisition to `401`, and unexpected guard backend failures to a stable `503` body.
- [x] Await `finish()` in `finally`; swallow only settlement errors after the primary HTTP result is fixed so a database diagnostic never crosses the gateway boundary.
- [x] Export the Host-only guard contracts and implementations; do not add them to JSON-safe Team route types or Browser bundles.
- [x] Run `pnpm exec vitest run tests/team-gateway.spec.ts tests/team-traffic-guard.spec.ts tests/team-safe-message.spec.ts`.

## Task 4: Prove the cross-Host row-lock invariant on PostgreSQL 17

**Files:** `tests/team-postgres.integration.spec.ts`, `README.md`

- [x] Add a real-PostgreSQL test that creates the traffic state, holds its row lock on a control connection, starts acquisitions from two guard instances, and waits until both acquisition queries are visible in `pg_stat_activity` with `wait_event_type = 'Lock'`.
- [x] Release the control lock and assert exactly one acquisition succeeds with `maxConcurrency: 1`; the other returns `TEAM_TRAFFIC_GUARD`, then finish the winning lease.
- [x] Keep the test in a random strictly validated schema; release locks/connections and drop the schema in `finally` on every path.
- [x] Run `DSH_TEAM_POSTGRES_TEST_URL=postgres://… pnpm run test:postgres` when a real endpoint is available. If unavailable, leave this item unchecked and report that pg-mem proves SQL behavior but not scheduler semantics.

Local verification on 2026-08-20 used a disposable PostgreSQL 17 container and
passed all five real-database cases. The traffic case observed both acquisition
queries waiting in PostgreSQL's row-lock queue, traced each blocking chain to
the control transaction, then proved exactly one admission with
`maxConcurrency: 1`.

## Task 5: Document and verify the package boundary

**Files:** `README.md`, `docs/superpowers/plans/2026-08-19-team-control-plane.md`, `docs/superpowers/plans/2026-08-19-distributed-team-traffic-guard.md`

- [x] Replace the process-local traffic-guard limitation with the PostgreSQL shared-state behavior, expiry/renewal semantics, and memory-mode limitation.
- [x] Mark distributed per-key safety complete in the control-plane plan; leave managed KMS/online rewrap, broker process isolation, and egress restriction as production hardening.
- [x] Run focused tests, `pnpm test`, `pnpm run build`, and `pnpm run verify:package`.
- [x] Pack and install the tarball into an isolated `DSH_HOME` using pinned stock `@deepseek-ai/dsh@0.1.0-rc.7`; verify the `codex-shared-pool` bundle remains present in `--dump-config`.
- [x] Scan the publish payload/worktree for credential material, auth files, machine-specific paths, and temporary artifacts; report exact Git state without committing.

## Self-Review

- Spec coverage: the plan covers fixed RPM, concurrency, circuit state, crash expiry, renewal, revocation ordering, Host selection, safe HTTP errors, pg-mem behavior, real PostgreSQL scheduling evidence, documentation, package verification, and stock-install evidence.
- Placeholder scan: no TBD/TODO, unspecified error-handling step, or unnamed implementation remains.
- Type consistency: `TeamTrafficGuard.acquire()` returns the same `TeamTrafficLease` consumed by gateway heartbeat/finalization; both implementations use the same options and result union; PostgreSQL tests and gateway injection use those exact exports.
