# Anonymous Team Creation Implementation Plan

> **For agentic workers:** Execute the steps below in parallel across the specified file ownership boundaries, then integrate and independently review the complete change.

**Goal:** Allow anonymous users to create and recover a Team, with switching and joining under the Team-name dropdown and menus fully visible at narrow widths.

**Architecture:** The local Host generates and journals creation credentials before sending an idempotent request to the Team server. The server persists only credential hashes and verifies that a recovery credential still belongs to the current owner. The browser receives identity summaries; the recovery code is revealed only through an explicit same-origin export action.

**Tech Stack:** TypeScript, React 18, Cordis / stock DSH 0.1.0-rc.8, PostgreSQL, Vitest.

## Global Constraints

- One package; no DSH core modifications. Host owns Team API keys and credential storage.
- Existing Team remains active until the new identity is validated and locally saved.
- Reject concurrent authorization, pending joins and stale Team contexts before transitions.
- Creation and recovery are separate public endpoints; bootstrap remains administrator-only.
- Root task owns integration and deployment; worker agents commit only their assigned files.
- Existing tests, build, package verification, isolated stock installation and independent PR review gate delivery.

### Task 1: Durable anonymous server operations

**Files:** `src/team/{types,routes,store,postgres-store}.ts`, new migration/helpers, `deploy/edge/server.mjs`, corresponding tests.

**Interfaces:** `POST /team/create` receives `{creationToken,teamName,ownerName,apiKey,recoveryCode}`; `POST /team/recover-owner` receives `{recoveryCode,apiKey}`. Both return `{team,member}` and never raw credentials.

- [x] Write failing tests for identical retry returning one Team, altered retry rejection, hashed secrets, owner recovery, ownership-transfer revocation, and rate limits.
- [x] Add transactional creation/recovery records with unique hashes; enforce lifecycle/ownership checks and bounded anonymous request rates.
- [x] Run focused memory, PostgreSQL, route and edge tests; commit assigned files.

### Task 2: Local Host journal and typed browser API

**Files:** `src/team/management-routes.ts`, `src/shared/team-management.ts`, `src/client/team/api.ts`, corresponding tests.

**Interfaces:**

```ts
createTeam(teamName: string, ownerName: string, expectedContext: TeamManagementExpectedContext | null): Promise<TeamManagementConnectionResult>
recoverOwner(recoveryCode: string, expectedContext: TeamManagementExpectedContext | null): Promise<TeamManagementConnectionResult>
resumeTeamSetup(): Promise<TeamManagementConnectionResult>
exportRecoveryCode(expectedContext: TeamManagementExpectedContext): Promise<{ recoveryCode: string }>
```

- [x] Write failing tests that the journal precedes a request, errors preserve the current key, restarts replay identical credentials, and only explicit owner export returns a recovery code.
- [x] Persist versioned, server-scoped setup/recovery records through Cordis credentials; preserve saved Team connections and lock OAuth transitions.
- [x] Add same-origin capability-protected routes and exact typed parsers; test stale contexts and malformed responses.
- [x] Run focused Host and API tests; commit assigned files.

### Task 3: Team dropdown and setup UI

**Files:** `src/client/team/{TeamConnections,TeamSettings}.tsx`, new setup component, locales/CSS, UI tests, `README.md`.

- [x] Write failing tests for Team-name dropdown, footer actions, create/recovery forms, resume after uncertain response and original Team preservation.
- [x] Place dropdown in overview and settings headers, retaining keyboard access and bounded positioning.
- [x] Implement creation and owner recovery; offer explicit recovery-code export after success and from owner actions.
- [x] Remove narrow-width menu alignment that pushes management actions outside the panel; test real rendered menu geometry.
- [x] Run DOM and responsive tests; commit assigned files.

### Task 4: Integration and delivery

- [x] Run `node node_modules/vitest/vitest.mjs run tests`, prototype tests, `pnpm run build` and `pnpm run verify:package`.
- [x] Pack and install into an isolated stock DSH profile; exercise anonymous create, retry, recovery, switching and menu layout with disposable test data.
- [x] Open a draft PR and obtain independent change-scoped review; fix findings and re-review.
- [x] Confirm final-head CI, merge to main, and update local 3181 with backup and restart notice. Remote shared deployment requires separate authorization.
- [ ] Report exact Git state, verification layers and any remote deployment limitation.

## Verification record (2026-09-05)

- Final implementation: 1,101 unit/DOM tests passed; 26 PostgreSQL tests skipped locally because no test database was configured. Prototype suite: 33 passed. Build and package verification passed.
- Final-head CI passed, including PostgreSQL 17 concurrency and self-hosted Docker multi-Team invite/data-isolation checks.
- The packed artifact installed and started successfully with the published stock DSH 0.1.0-rc.8 CLI in an isolated profile; the browser bundle was served successfully.
- Browser acceptance with disposable data: anonymous creation of two Teams, switching between them, explicit recovery-code export, and recovery of the original Team into a fresh Host profile. Retry and ambiguous-commit recovery were verified by focused Host/server regression tests.
- Menu boundaries remained within 768px and 390px viewports. Final-package keyboard acceptance confirmed ArrowDown moves into menu items and Escape closes only the menu, preserving Settings and returning focus to the trigger.
- Independent review findings fixed: unknown server persistence failures return retryable 503; invalid owner-recovery codes retain the recovery form and accurate message; menu focus waits until positioning makes it visible. Whole-change review and the final focus-change review have no blocking findings.
- No live provider OAuth was performed. Remote Team service deployment and migration 23 remain separate from local UI installation.

- PR #53 merged into main as `3cfb148`. Local 3181 was backed up and updated; its existing Team connection and accounts remained available. A final screenshot exposed the Team-name trigger losing 10px to negative horizontal margins; a focused layout follow-up preserves single-line names and bounded ellipsis.
