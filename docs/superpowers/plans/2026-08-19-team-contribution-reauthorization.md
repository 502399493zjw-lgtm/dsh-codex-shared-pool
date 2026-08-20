# Team Contribution Reauthorization Implementation Plan

> **For agentic workers:** Execute each checkbox test-first in this worktree. Do not commit, push, or publish without explicit user authorization.

**Goal:** Let a contributor repair an existing `reauth_required` Codex contribution in place, preserving its identity and sharing protections while replacing only its isolated Host-owned OAuth credential.

**Architecture:** Add an owner-only atomic store transition from `reauth_required` to `authorizing`, an explicit Host broker restart operation that clears only the exact stale credential file, and central/local management endpoints that reuse the existing device-code modal. The service closes revoke/restart races by re-reading state after the broker begins and cleaning up if the contribution became terminal.

**Tech Stack:** TypeScript, Vitest, PostgreSQL/pg-mem, provider-native Codex device OAuth, React 18, stock DSH Cordis extension points.

## Constraints

- Provider credentials remain readable only by the Host credential broker.
- Only the contribution owner may restart its OAuth authorization.
- Reauthorization never creates a second contribution or resets protection fields.
- `revoked` remains terminal, including across delayed OAuth callbacks and concurrent restart.
- Browser responses contain only account metadata plus device verification URL, one-time code, and expiry.
- Existing uncommitted files are user-owned and remain uncommitted.

### Task 1: Lock the reauthorization and redaction contracts

**Files:** `tests/team.spec.ts`, `tests/team-postgres.spec.ts`, `tests/team-credentials.spec.ts`, `tests/team-routes.spec.ts`, `tests/team-management-routes.spec.ts`, `tests/team-management-client.spec.ts`

- [x] Add memory and PostgreSQL tests for owner-only `reauth_required -> authorizing`, cleared diagnostics, preserved limits, and invalid-state rejection.
- [x] Add broker tests proving stale credentials are replaced rather than appended and no secret crosses the broker API.
- [x] Add service tests for successful restart, failed restart rollback, and concurrent revoke cleanup.
- [x] Add central route, local proxy, and browser client contract tests.
- [x] Expand redaction regression coverage for Bearer, provider key fields, and Team/invite secrets.
- [x] Run the focused tests and confirm the new behavior tests fail before implementation.

### Task 2: Implement the Host lifecycle

**Files:** `src/team/store.ts`, `src/team/postgres-store.ts`, `src/team/credentials.ts`, `src/team/service.ts`

- [x] Add the atomic store transition in memory and PostgreSQL implementations.
- [x] Add `restartOAuth` to the broker and remove only the validated contribution credential file before device login.
- [x] Add service orchestration with conditional rollback and post-start revoked-state cleanup.
- [x] Run focused store, broker, and service tests.

### Task 3: Add central and local management contracts

**Files:** `src/team/types.ts`, `src/team/routes.ts`, `src/shared/team-management.ts`, `src/team/management-routes.ts`, `src/client/team/api.ts`, `src/team/index.ts`, `src/index.ts`

- [x] Add the central reauthorize route and request validation.
- [x] Forward it through the same-origin Host management proxy.
- [x] Expose the typed browser API without widening any credential-bearing contract.
- [x] Run route and browser API tests.

### Task 4: Reuse the device-code UI

**Files:** `src/client/team/TeamSettings.tsx`, `src/client/team/locales.ts`

- [x] Show `重新授权 / Sign in again` only for the owning member's `reauth_required` contribution.
- [x] Reuse the existing device-code modal and authorization polling.
- [x] Verify the interaction through the repeatable stock-DSH browser smoke path and capture machine-checkable evidence.

### Task 5: Document, package, and review

**Files:** `README.md`, this plan

- [x] Document identity/limits preservation, isolated credential replacement, and OpenAI-side revocation limits.
- [x] Run focused tests, `pnpm test`, `pnpm run build`, and `pnpm run verify:package`.
- [x] Pack and install the tarball into an isolated `DSH_HOME` using pinned stock `@deepseek-ai/dsh@0.1.0-rc.7`; distinguish this from package verification.
- [x] Run real PostgreSQL concurrency evidence if a PostgreSQL 17 endpoint is available; otherwise report the exact unverified risk.
- [x] Perform a final read-only diff/security review and report exact Git state.

Local verification on 2026-08-20 used a disposable `postgres:17-alpine`
database and passed all five cases in `pnpm run test:postgres`, including the
shared credential-row mutation lock used by credential replacement/refresh.
