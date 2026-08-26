# Team Member Departure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a non-owner leave an invite-only Team completely: stop new access, revoke every Team API key and contributed account owned by that member, drain admitted work, delete isolated OAuth credentials, and remove the local connection.

**Architecture:** Add one atomic Host-store departure transition, then orchestrate runtime draining and credential-broker deletion in the Team service. Expose it through an authenticated central route and the existing same-origin management proxy so the Browser never receives a Team key or provider credential. Persisted `revoked` contributions are reconciled at startup so a broker outage cannot turn a partial cleanup into permanent credential retention.

**Tech Stack:** TypeScript, Vitest, PostgreSQL/pg-mem, React 18, stock DSH Cordis extension points, provider-native Codex OAuth.

## Global Constraints

- Owner departure is rejected until an ownership-transfer feature exists; the MVP must never create an ownerless Team.
- Departure is not “disconnect this browser”: it removes Team membership, revokes all member keys, and revokes all member contributions.
- The durable member/key/contribution transition is atomic and serialized with authenticated member mutations.
- New routing stops before credentials are deleted; admitted requests drain before broker revocation.
- OAuth tokens remain Host/broker-only, and responses contain secret-free summaries only.
- Broker cleanup is idempotent and retried for already-revoked contributions during startup reconciliation.
- Do not commit, push, publish, or rewrite history. Each task ends at a test checkpoint because repository instructions require explicit user authorization for Git publication actions.

---

### Task 1: Lock the atomic store contract

**Files:** `tests/team.spec.ts`, `tests/team-postgres.spec.ts`, `src/team/types.ts`, `src/team/store.ts`, `src/team/postgres-store.ts`

- [x] Add memory-store tests proving a member departure marks the member `removed`, revokes every one of their API keys, revokes every owned contribution, and leaves unrelated members/accounts unchanged.
- [x] Add tests proving an owner cannot leave and no owner state changes on rejection.
- [x] Add PostgreSQL query/transaction tests for the same state transition, including member-row locking and durable key/contribution updates.
- [x] Add JSON-safe `TeamMemberDepartureResult` containing the removed member plus secret-free revoked contribution summaries.
- [x] Add `TeamStore.leaveTeam(auth): Promise<TeamMemberDepartureResult>` and implement it in memory and PostgreSQL stores.
- [x] Ensure PostgreSQL authenticated mutations share-lock the active member row so a concurrent departure cannot be followed by a newly created key or contribution.
- [x] Run `pnpm exec vitest run tests/team.spec.ts tests/team-postgres.spec.ts` and confirm the new tests fail before implementation, then pass.

### Task 2: Complete drain, broker deletion, and restart recovery

**Files:** `tests/team.spec.ts`, `tests/team-runtime.spec.ts`, `src/team/service.ts`, `src/team/runtime.ts`

- [x] Add a service test proving all revoked contribution IDs are passed to `drainAccount` before broker deletion completes.
- [x] Add a failure/restart test proving an already-revoked contribution is drained and its broker credential is deleted during lifecycle reconciliation.
- [x] Implement `TeamService.leaveTeam(auth)` as durable departure, concurrent drain of all owned accounts, then idempotent broker revocation.
- [x] Extend startup reconciliation to clean persisted `revoked` contribution credentials without reactivating or exposing them.
- [x] Run `pnpm exec vitest run tests/team.spec.ts tests/team-runtime.spec.ts`.

### Task 3: Expose central and same-origin management routes

**Files:** `tests/team-routes.spec.ts`, `tests/team-management-routes.spec.ts`, `tests/team-management-client.spec.ts`, `src/team/types.ts`, `src/team/routes.ts`, `src/shared/team-management.ts`, `src/team/management-routes.ts`, `src/client/team/api.ts`, `src/team/index.ts`, `src/index.ts`

- [x] Add authenticated `POST /team/members/leave` with an empty request contract and secret-free departure response.
- [x] Add `POST /team-client/leave`; call the central route first and delete the locally stored Team key only after remote departure succeeds.
- [x] Prove an owner rejection retains the local key and a successful member departure removes it.
- [x] Add the typed Browser client method without adding any credential-bearing Browser contract.
- [x] Run the three focused route/client test files.

### Task 4: Make departure explicit in Team Settings

**Files:** `src/client/team/TeamSettings.tsx`, `src/client/team/locales.ts`, `src/client/team/team-settings-contract.ts`, `tests/team-settings-contract.spec.ts`

- [x] Keep “disconnect this Host” as a local/key-scoped action and add a distinct destructive “Leave Team” action for non-owners.
- [x] Explain in the confirmation UI that every member key and contributed account will be revoked; on success return to the disconnected state.
- [x] Explain that owners must retain ownership in this MVP rather than showing an action that will always fail.
- [x] Add UI contract evidence for both English and Chinese copy and the management endpoint.
- [x] Run the focused UI and route/client tests.

### Task 5: Document and verify the complete slice

**Files:** `README.md`, `docs/superpowers/plans/2026-08-19-team-member-departure.md`

- [x] Document departure versus local disconnect, owner limitation, drain ordering, broker-cleanup retry, and upstream revoke caveat.
- [x] Run focused tests, `pnpm test`, `pnpm run build`, and `pnpm run verify:package`.
- [x] Pack the plugin and install that tarball into an isolated `DSH_HOME` with pinned stock `@deepseek-ai/dsh@0.1.0-rc.7`; distinguish stock-install evidence from package-format verification.
- [x] Check for a real PostgreSQL endpoint; none was available locally, so keep the PostgreSQL 17 CI gate as required release evidence and report the local gap.
- [x] Perform a final read-only security/diff review and report exact Git state.
