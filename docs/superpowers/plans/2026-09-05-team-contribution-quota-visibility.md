# Team Contribution Quota Visibility Implementation Plan

> **For agentic workers:** Implement this plan task-by-task in the current task; request an independent change-scoped review before merge.

**Goal:** Let authenticated teammates inspect active contributed accounts' quota and sharing limits without management permissions.

**Architecture:** Extend the active shared-account directory with optional `sharing` and `capacity` projections. Keep owned contributions and request details scoped to the contributor. Reuse validated capacity parsing and add a shared strict sharing-policy parser for Host and Browser.

**Tech Stack:** TypeScript, React, Vitest, stock DSH 0.1.0-rc.8, Cordis 4.0.1.

## Global Constraints

- Host owns credentials; Browser receives only enumerated JSON-safe fields.
- Only active accounts in the authenticated Team appear in the directory.
- Existing member mutation permissions remain unchanged.
- Older directory rows without details render an unavailable state.

### Task 1: Read-only sharing information

**Files:** `src/team/types.ts`, `src/team/service.ts`, `src/shared/team-management.ts`, `src/shared/team-sharing.ts`, `src/team/management-routes.ts`, `src/client/team/api.ts`, `src/client/team/TeamSettings.tsx`, `src/client/team/locales.ts` and focused Team tests.

**Interfaces:** `sharing?: TeamSharedAccountSharingSummary`, `capacity?: TeamContributionCapacitySummary` on directory entries. `parseTeamSharing(value: unknown)` returns a validated sharing summary or throws for invalid data.

- [x] Add failing service, Browser parser and DOM assertions for teammate quota (74%), reserve (20%) and weekly limit ($50).
- [x] Verify the focused failures, implement safe projections and read-only details, retain private-field rejection.
- [x] Test malformed and legacy entries, run focused tests, build and package verification.
- [x] Pack and verify the UI in stock DSH with explicitly synthetic provider data; report real provider verification separately.
- [ ] Commit, push, draft PR, independent review, fix blocking findings, then merge after checks pass.
