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

- [ ] Write failing tests for identical retry returning one Team, altered retry rejection, hashed secrets, owner recovery, ownership-transfer revocation, and rate limits.
- [ ] Add transactional creation/recovery records with unique hashes; enforce lifecycle/ownership checks and bounded anonymous request rates.
- [ ] Run focused memory, PostgreSQL, route and edge tests; commit assigned files.

### Task 2: Local Host journal and typed browser API

**Files:** `src/team/management-routes.ts`, `src/shared/team-management.ts`, `src/client/team/api.ts`, corresponding tests.

**Interfaces:**

```ts
createTeam(teamName: string, ownerName: string, expectedContext: TeamManagementExpectedContext | null): Promise<TeamManagementConnectionResult>
recoverOwner(recoveryCode: string, expectedContext: TeamManagementExpectedContext | null): Promise<TeamManagementConnectionResult>
resumeTeamSetup(): Promise<TeamManagementConnectionResult>
exportRecoveryCode(expectedContext: TeamManagementExpectedContext): Promise<{ recoveryCode: string }>
```

- [ ] Write failing tests that the journal precedes a request, errors preserve the current key, restarts replay identical credentials, and only explicit owner export returns a recovery code.
- [ ] Persist versioned, server-scoped setup/recovery records through Cordis credentials; preserve saved Team connections and lock OAuth transitions.
- [ ] Add same-origin capability-protected routes and exact typed parsers; test stale contexts and malformed responses.
- [ ] Run focused Host and API tests; commit assigned files.

### Task 3: Team dropdown and setup UI

**Files:** `src/client/team/{TeamConnections,TeamSettings}.tsx`, new setup component, locales/CSS, UI tests, `README.md`.

- [ ] Write failing tests for Team-name dropdown, footer actions, create/recovery forms, resume after uncertain response and original Team preservation.
- [ ] Place dropdown in overview and settings headers, retaining keyboard access and bounded positioning.
- [ ] Implement creation and owner recovery; offer explicit recovery-code export after success and from owner actions.
- [ ] Remove narrow-width menu alignment that pushes management actions outside the panel; test real rendered menu geometry.
- [ ] Run DOM and responsive tests; commit assigned files.

### Task 4: Integration and delivery

- [ ] Run `node node_modules/vitest/vitest.mjs run tests`, prototype tests, `pnpm run build` and `pnpm run verify:package`.
- [ ] Pack and install into an isolated stock DSH profile; exercise anonymous create, retry, recovery, switching and menu layout with disposable test data.
- [ ] Open a draft PR and obtain independent change-scoped review; fix findings and re-review.
- [ ] Confirm CI, merge to main, and update local 3181 with backup and restart notice. Remote shared deployment requires separate authorization.
- [ ] Report exact Git state, verification layers and any remote deployment limitation.
