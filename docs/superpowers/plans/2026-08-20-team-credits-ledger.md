# Team Credits Ledger Implementation Plan

> **For Codex:** Execute this plan in the existing `codex/team-phase-two` worktree. Do not commit, push, publish, or rewrite history without explicit user authorization.

**Goal:** Turn the approved Wodex-style Credits concept into a durable Team Gateway feature: provider-reported usage is converted into versioned Credits, shared requests are atomically bounded by a contributor-owned daily cap, and the Browser shows one-day and seven-day aggregates without receiving content or credentials.

**Architecture:** The Host parses only numeric usage counters from the upstream Responses stream while forwarding bytes unchanged. The Team store reserves a fixed maximum before a shared provider attempt, then atomically replaces that reservation with the measured `credits-v1` value or releases it when usage is unavailable. PostgreSQL is authoritative in hosted mode; the memory adapter keeps identical semantics for deterministic tests. Same-origin management routes expose only usage events and aggregate Credits projections.

**Tech Stack:** TypeScript 6, Vitest 4, PostgreSQL 17/`pg`, React 18, stock DSH `0.1.0-rc.8`, Cordis `4.0.1`.

---

## Global constraints

- Preserve all existing dirty files in this worktree.
- Never store or project prompts, responses, files, OAuth credentials, or raw provider errors.
- `remainingPercent` remains a routing reserve signal; it is not converted into consumption.
- Credits are an internal weighted-token unit, not OpenAI price, money, or exact subscription percentage.
- A retry is a separate request attempt and therefore a separate usage event.
- Daily contribution limits apply only when `consumerMemberId !== upstreamOwnerMemberId` and reset at UTC midnight.
- Run a focused failing test before each behavior change, then focused suites, `pnpm run build`, `pnpm run verify:package`, and the sensitive-data scan from the DSH plugin skill.

### Task 1: Freeze the Credits calculator and public projections

**Files:**

- Create: `src/team/credits.ts`
- Modify: `src/team/types.ts`
- Modify: `src/team/store.ts`
- Modify: `src/team/postgres-store.ts`
- Test: `tests/team-credits.spec.ts`
- Test: `tests/team-postgres.spec.ts`

- [x] Add a failing calculator test for `credits-v1 = ceil(max(input-cached, 0) + cached*0.25 + output*4)`, including invalid/oversized counters.
- [x] Export Host-only `TeamProviderTokenUsage`, `TeamCreditsFormulaVersion`, `calculateTeamCredits`, and parsing helpers from `src/team/credits.ts`.
- [x] Extend contribution summaries and patches with `dailySharedCreditLimit: number | null`.
- [x] Extend usage summaries with optional `credits` and `creditsFormulaVersion`; do not project raw token counters to the Browser.
- [x] Add PostgreSQL migration 7 for the daily limit, reservation, numeric usage counters, settled Credits, and formula version.
- [x] Keep memory and PostgreSQL summary/parsing behavior identical.

### Task 2: Add atomic daily reservation and settlement

**Files:**

- Modify: `src/team/store.ts`
- Modify: `src/team/postgres-store.ts`
- Modify: `src/team/service.ts`
- Test: `tests/team-request-service.spec.ts`
- Test: `tests/team-postgres.spec.ts`
- Test: `tests/team-postgres.integration.spec.ts`

- [x] Add failing memory tests proving an owner request does not consume the shared daily cap, a friend request reserves Credits, and failed/unmeasured settlement releases the reservation.
- [x] Change `beginUsageEvent(auth, eventId, accountId, model, reservedCredits)` so shared admission fails when `settled + reserved + requested > daily limit`.
- [x] Change `settleUsageEvent(teamId, eventId, status, usage?)` so measured provider usage is settled exactly once and unused reservation is released.
- [x] In PostgreSQL, lock the Team row then the selected contribution row, sum the current UTC-day settled and active reserved Credits, and insert the usage event in the same transaction.
- [x] Add a real PostgreSQL concurrency test showing two simultaneous admissions cannot oversubscribe one daily contribution limit.
- [x] Map daily-cap exhaustion to the existing explicit no-capacity response without leaking SQL details.

### Task 3: Capture provider usage without changing the response stream

**Files:**

- Modify: `src/team/gateway.ts`
- Modify: `src/team/service.ts`
- Test: `tests/team-gateway.spec.ts`

- [x] Add failing tests for streamed `response.completed` usage, non-stream JSON usage, chunk-split SSE frames, retries, missing usage, and client cancellation.
- [x] Replace the byte-only pipe helper with a bounded metadata observer that forwards every upstream byte unchanged and retains only a small incomplete line buffer plus the latest validated numeric usage object.
- [x] Accept the Responses usage shape only when input, cached-input, and output counters are safe non-negative integers; ignore malformed provider metadata.
- [x] Pass measured usage into `settleRequest`; release the full reservation when no valid usage was observed.
- [x] Verify hard-capacity retries settle and release the first attempt before reserving the next attempt.

### Task 4: Expose one-day and seven-day aggregates

**Files:**

- Modify: `src/team/types.ts`
- Modify: `src/team/store.ts`
- Modify: `src/team/postgres-store.ts`
- Modify: `src/team/service.ts`
- Modify: `src/team/routes.ts`
- Modify: `src/shared/team-management.ts`
- Modify: `src/team/management-routes.ts`
- Modify: `src/client/team/api.ts`
- Test: `tests/team-management-client.spec.ts`
- Test: `tests/team-routes.spec.ts`

- [x] Add failing contract tests for last-24-hour account totals and seven UTC-day member buckets.
- [x] Add store aggregation that returns exact attempt count plus the sum of measured Credits; unmeasured attempts remain in request count but not Credits.
- [x] Restrict contribution-account aggregates to Team members and keep every projected field JSON-safe and credential-free.
- [x] Return events and aggregates from the existing usage endpoint so the Browser needs one request.
- [x] Validate the remote projection again at the local Host proxy and again before React state.

### Task 5: Render the Wodex-style usage UI

**Files:**

- Modify: `src/client/team/TeamSettings.tsx`
- Modify: `src/client/team/TeamSettings.module.css`
- Modify: `src/client/team/locales.ts`
- Test: `tests/team-settings-contract.spec.ts`
- Test: `tests/team-management-client.spec.ts`

- [x] Add failing locale/contract assertions for “最近 1 天”, request count, Credits, daily shared cap, Credits v1 disclaimer, and “近 7 天”.
- [x] Refresh usage once per minute while Team mode is connected; keep the existing faster OAuth poll only during authorization.
- [x] Show per-account one-day request count and settled Credits, and expose the configured daily cap only in the contribution owner's controls.
- [x] Add a button opening a seven-day per-member bar-chart modal; omit the contributor's own usage from “其他成员使用”.
- [x] Keep the existing contributor label, pause/resume, revoke, reserve, model, and capacity controls intact.

### Task 6: Verify the plugin boundary and stock DSH behavior

**Files:**

- Modify only if a verification failure reveals a scoped defect.
- Evidence: `artifacts/ui/<run-id>/` only if a browser-visible run is executed.

- [x] Run all focused Team Credits, Gateway, route, management, settings, and PostgreSQL-shape suites.
- [ ] Run the expanded six-case suite against real PostgreSQL 17 (not available on this workstation; CI remains the release gate).
- [x] Run `pnpm run build` and `pnpm run verify:package`.
- [x] Run `rg -n --hidden --glob '!node_modules/**' --glob '!lib/**' '(refresh_token|access_token|Authorization: Bearer|dsh_team_|dsh_invite_)' .` and review every match as fixture/documentation or a defect.
- [x] Pack the tarball and install it into an isolated `DSH_HOME` using published DSH `0.1.0-rc.8`; do not disturb the user's current port 3181 session until the isolated smoke is green.
- [ ] If visual behavior is exercised, run the DSH machine assertions first and capture a short redacted GIF only for the chart/pause interaction; include result/provenance/cleanup evidence.
- [ ] Report changed files, exact commands, failures or unverified risks, and final Git state without claiming a commit.
