# Team Switching Implementation Plan

> Execute task-by-task in this worktree; the user's development request authorizes inline execution. Independent change-scoped review is required before merge.

**Goal:** Join another Team without losing the existing membership, and switch between saved Teams on the configured server.

**Architecture:** Host credentials retain a versioned list of Team identities and their keys, scoped to the configured server. Browser receives identity summaries only. Joining keeps the old key active until success; the pending join journal records the old key for crash recovery. Switching validates both the displayed current identity and destination before changing the active credential.

**Tech Stack:** TypeScript, Cordis Credentials, React, Vitest.

## Global Constraints

- One active Team per local Host; saved connections only apply to the configured server.
- Never revoke membership or contributions on switch; keep credentials out of Browser projections.
- Preserve uncertain joins, block switching during pending authorization or terminal cleanup, reject stale context.
- Run focused tests, build, package verification, isolated stock installation, independent PR review and CI.

### Task 1: Host connection storage and transitions

Files: `src/team/management-routes.ts`, `src/shared/team-management.ts`, `tests/team-management-routes.spec.ts`.

Interfaces:
```ts
interface TeamSavedConnection {
  id: string; teamId: string; teamName: string; memberName: string; currentMemberId: string
}
// GET /connections -> { connections: TeamSavedConnection[] }
// POST /connections/switch -> { connectionId, expectedContext: TeamManagementExpectedContext | null }
// POST /join gains optional expectedContext when an existing key is configured.
```

- [x] Add failing round-trip test: join B from A, restart proxy, switch back to A; keys never occur in responses.
- [x] Add tests for stale context, readonly keys, failed destination validation, and uncertain join recovery.
- [x] Persist saved connections before replacing the active key; extend pending join with optional previousKey.
- [x] Preserve other Teams' local contribution bindings when refreshing the active Team.
- [x] Run `pnpm exec vitest run tests/team-management-routes.spec.ts`.

### Task 2: Browser join and switch controls

Files: `src/client/team/api.ts`, `src/client/team/TeamSettings.tsx`, `src/client/team/TeamConnections.tsx`, `src/client/team/locales.ts`, focused client tests.

- [x] Add failing UI tests for joining another Team and switching a saved identity.
- [x] Add strict response parsing and capability-protected calls.
- [x] Show switch controls in connected and unconnected views; reuse invite preview and join flow, keeping current connection until successful join.
- [x] Explain local Host scope and retained membership; translate all visible copy.
- [x] Refresh identity and clear obsolete dialog state after switching.

### Task 3: Delivery

- [x] Document same-server scope and recovery in README.
- [x] Run focused Host/client tests, `pnpm run build`, `pnpm run verify:package`, and stock package smoke.
- [x] Commit only task changes, push, create draft PR targeting main.
- [x] Independent subagent review; fix blocking findings, pass CI, then merge.
- [ ] Update 3181 with rollback backup and verify installed package; report limits of actual runtime testing.
