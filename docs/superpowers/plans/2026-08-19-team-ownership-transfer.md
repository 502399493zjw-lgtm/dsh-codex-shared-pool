# Team Ownership Transfer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the current Team Owner atomically transfer ownership to an active teammate so the former Owner can remain an Admin or leave without creating an ownerless Team.

**Architecture:** Add one store-level role swap serialized on the current Owner member row and protected by a PostgreSQL one-owner index. Expose only two secret-free member summaries through the central Team route and same-origin Host proxy, then add an Owner-only confirmation flow to the existing People UI. Existing Team keys and contribution ownership remain unchanged; their effective permissions follow the member role read during each authentication.

**Tech Stack:** TypeScript, Vitest, PostgreSQL/pg-mem, React 18, stock DSH Cordis routes and Settings slots.

## Global Constraints

- Only an authenticated current Owner can transfer ownership.
- The target must be a different, active member of the same Team and must have at least one non-revoked Team API key.
- The former Owner becomes `admin`; the target becomes `owner`; no contribution, invite, API key, or credential ownership changes.
- The swap is atomic, leaves exactly one Owner, and serializes with departure and other member-authenticated mutations.
- Browser responses contain only `TeamMemberSummary` projections; API key inventory and all credentials remain Host-only.
- Do not commit, push, publish, or rewrite history without explicit user authorization.

---

### Task 1: Define and enforce the atomic store contract

**Files:** `tests/team.spec.ts`, `tests/team-postgres.spec.ts`, `src/team/types.ts`, `src/team/store.ts`, `src/team/postgres-store.ts`

**Interfaces:**

```ts
export interface TeamOwnershipTransferResult {
  readonly formerOwner: TeamMemberSummary
  readonly owner: TeamMemberSummary
}

transferOwnership(
  auth: TeamAuthContext,
  targetMemberId: string,
): Promise<TeamOwnershipTransferResult>
```

- [x] Write failing memory-store tests for the role swap, refreshed key roles, contribution ownership preservation, and former-Owner departure.
- [x] Write failing rejection tests for non-Owner callers, self-transfer, removed/foreign targets, and targets without a live Team key.
- [x] Write failing PostgreSQL tests proving both role updates occur in one transaction and a partial unique index permits only one Owner per Team.
- [x] Add `TEAM_OWNERSHIP_TRANSFER_PATH`, `TeamOwnershipTransferResult`, and the `TeamStore.transferOwnership` contract.
- [x] Implement the Memory store swap after validating caller, target, and target-key liveness.
- [x] Add PostgreSQL migration 6 with `team_members_one_owner_idx`, then implement a row-locked demote/promote transaction.
- [x] Run `pnpm exec vitest run tests/team.spec.ts tests/team-postgres.spec.ts`.

### Task 2: Add central, same-origin, and Browser contracts

**Files:** `tests/team-routes.spec.ts`, `tests/team-management-routes.spec.ts`, `tests/team-management-client.spec.ts`, `src/team/routes.ts`, `src/shared/team-management.ts`, `src/team/management-routes.ts`, `src/client/team/api.ts`, `src/team/index.ts`, `src/index.ts`

**Interfaces:**

```ts
POST /plugins/dsh-codex-shared-pool/team/ownership/transfer
{ "targetMemberId": "member-id" }

POST /plugins/dsh-codex-shared-pool/team-client/ownership/transfer
{ "targetMemberId": "member-id" }
```

- [x] Write failing central-route tests for exact body validation, Owner success, non-Owner 403, and secret-free output.
- [x] Write failing management-proxy and Browser-client tests that reject malformed role swaps and discard unknown/key-bearing response fields.
- [x] Register both routes and add strict `TeamManagementOwnershipTransferResult` projection/parsing.
- [x] Export the new central/local path constants and result types from the Team and package roots.
- [x] Run the three focused route/client test files plus `pnpm exec tsc --noEmit`.

### Task 3: Add the Owner confirmation flow in Team Settings

**Files:** `tests/team-settings-contract.spec.ts`, `src/client/team/team-settings-contract.ts`, `src/client/team/TeamSettings.tsx`, `src/client/team/locales.ts`, `src/client/team/TeamSettings.module.css`

- [x] Write failing UI-contract tests proving only the current Owner may target another active non-Owner and covering English/Chinese destructive copy.
- [x] Add a per-member “Transfer ownership” action for eligible targets and an explicit confirmation modal naming the new Owner.
- [x] On success refresh the overview so the caller immediately becomes Admin; keep Team keys and contributions visible under their original owners.
- [x] Replace the obsolete “ownership transfer is unavailable” message with guidance that the Owner must transfer before leaving.
- [x] Run the focused UI, route, and client tests.

### Task 4: Prove concurrency and package delivery

**Files:** `tests/team-postgres.integration.spec.ts`, `scripts/verify-package.mjs`, `README.md`, `docs/superpowers/plans/2026-08-19-team-ownership-transfer.md`

- [x] Add a real-PostgreSQL test issuing two concurrent transfers from the same Owner context and proving one succeeds, one fails stale, and exactly one Owner remains.
- [x] Extend package verification for the central/local transfer paths, public result types, and English/Chinese UI copy.
- [x] Document target eligibility, former-Owner Admin role, unchanged contribution ownership, and the transfer-before-leave flow.
- [x] Run focused tests, `pnpm test`, `pnpm run build`, and `pnpm run verify:package`.
- [x] Pack and install the tarball into an isolated stock `@deepseek-ai/dsh@0.1.0-rc.7` Web profile, then run `pnpm run smoke:web` against the live process.
- [x] Run the PostgreSQL 17 integration gate when a database endpoint is available; otherwise retain the CI gate as required release evidence and report the local gap.
- [x] Perform a final read-only security/state review and report exact Git state.

Local evidence note: the real-PostgreSQL suite and its CI gate are present, but this workstation had neither a reachable Docker daemon nor a PostgreSQL endpoint. The normal local suite therefore skipped five real-database tests; PostgreSQL 17 CI remains mandatory release evidence. The Owner UI was exercised in an isolated stock DSH browser session; the available browser runtime supported screenshots but did not expose GIF recording.

Follow-up contract hardening: the same-origin Host derives a
`canReceiveOwnership` boolean from the caller role, member state, and live
remote Team-key summaries. The Browser receives that boolean but never the key
inventory, so it does not offer an ownership action that the central store is
guaranteed to reject.

## Self-Review

- Spec coverage: store invariants, target liveness, concurrency, central/local/Browser boundaries, UI, documentation, package exports, and stock-install evidence each have an explicit task.
- Placeholder scan: no TBD/TODO or unspecified implementation action remains.
- Type consistency: both central and management results use `formerOwner` and `owner`; both routes consume only `targetMemberId`.
