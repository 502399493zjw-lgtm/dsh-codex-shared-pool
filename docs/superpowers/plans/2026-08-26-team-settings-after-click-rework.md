# Team Settings After-Click Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the existing Team settings button the sole entry into Team administration, then place account sharing, usage, member, and invitation management inside that post-click workspace.

**Architecture:** Keep `CodexSubscriptionPoolSettings` as the Local/Team scope switch. The Team scope renders a compact connected-Team summary first; clicking Team settings replaces that summary with an in-page workspace. The workspace owns four task views—Accounts, Usage, Members, and Owner-only Invitations—while Host routes continue to own OAuth, credentials, usage events, and quota enforcement. Browser code receives only secret-free projections and one-time OAuth ceremony fields.

**Tech Stack:** React 18, TypeScript, CSS modules, Vitest, Testing Library, DeepSeek Harness rc.8 / Cordis 4.0.1.

## Global Constraints

- Work only on `codex/team-settings-after-click-rework`; do not modify the old `codex/team-phase-two` worktree.
- Preserve the committed phase-two Host security, invitation, ownership, and lifecycle behavior.
- Do not merge the old Team page wholesale. Port only the account-sharing contracts and behavior that are still required.
- Keep OAuth credentials, account files, pricing, request events, and quota enforcement on the Host.
- The Browser may receive account labels/status, aggregate usage, request metadata, and one-time device-code ceremony fields; it must never receive credentials or prompt content.
- Use focused failing tests before each behavior change. Finish with focused tests, full build, package verification, tarball installation into an isolated `DSH_HOME`, and screenshots of the real stock-DSH runtime.

---

### Task 1: Lock the Team-settings entry boundary

**Files:**
- Modify: `tests/team-settings-workspace.client.spec.tsx`
- Modify: `src/client/team/TeamSettings.tsx`
- Modify: `src/client/team/locales.ts`
- Modify: `src/client/team/TeamSettings.module.css`

**Step 1: Write the failing interaction test**

Add a test that renders a connected Team and asserts:

```tsx
expect(screen.queryByRole('region', { name: zh.teamSettingsTitle })).toBeNull()
const trigger = await screen.findByRole('button', { name: zh.teamSettings })
fireEvent.click(trigger)
expect(screen.getByRole('region', { name: zh.teamSettingsTitle })).toBeDefined()
fireEvent.click(screen.getByRole('button', { name: zh.backToTeam }))
expect(screen.queryByRole('region', { name: zh.teamSettingsTitle })).toBeNull()
expect(document.activeElement).toBe(trigger)
```

Also update the shared `openTeamSettings()` helper so existing workspace tests explicitly click the trigger.

**Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/team-settings-workspace.client.spec.tsx -t "opens only after"`

Expected: FAIL because a successful refresh currently calls `setTeamSettingsOpen(true)` and no trigger/back control is rendered.

**Step 3: Implement the connected-Team summary and return path**

- Remove automatic workspace opening from successful refreshes.
- Render Team identity, status, role, active-member count, and a `teamSettings` button in the closed state.
- Add a `backToTeam` control to the workspace header.
- Store the trigger element in a ref and restore focus after leaving the workspace.
- Reset transient menus and secret reveal state when leaving, without disconnecting or refetching the Team.

**Step 4: Run focused tests**

Run: `pnpm vitest run tests/team-settings-workspace.client.spec.tsx -t "opens only after|document reading order|does not expose local-only disconnect"`

Expected: PASS.

### Task 2: Put account sharing inside the post-click workspace

**Files:**
- Modify: `tests/team-settings-workspace.client.spec.tsx`
- Modify: `src/client/team/TeamSettings.tsx`
- Modify: `src/client/team/TeamSettings.module.css`
- Modify: `src/client/team/locales.ts`
- Reference only: the corresponding `TeamSettings.tsx` in the old `codex/team-phase-two` worktree

**Step 1: Write failing information-architecture tests**

Assert that after the trigger is clicked:

```tsx
const nav = screen.getByRole('navigation', { name: zh.workspaceNavigation })
expect(within(nav).getByRole('button', { name: zh.accountsTitle })).toBeDefined()
expect(within(nav).getByRole('button', { name: zh.usageSectionTitle })).toBeDefined()
expect(within(nav).getByRole('button', { name: zh.membersTitle })).toBeDefined()
expect(within(nav).getByRole('button', { name: zh.invitationsTitle })).toBeDefined()
```

The account view must show only contributions owned by the current member, expose Add account, and keep Team lifecycle actions out of the account cards.

**Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/team-settings-workspace.client.spec.tsx -t "account sharing"`

Expected: FAIL because the current workspace has only Usage, Members, and Invitations.

**Step 3: Implement the Accounts task view**

- Add `accounts` to `TeamWorkspaceView` and make it the first/default task.
- Render a responsive account directory/detail layout from `overview.contributions`.
- Show safe state, sharing policy, capacity, and aggregate usage only.
- Add OAuth start/reauthorize/cancel, pause/resume, policy edit, revoke, and recent-request actions using the existing management API methods.
- Keep each mutation bound to the current expected Team/member context.

**Step 4: Run the complete client workspace test**

Run: `pnpm vitest run tests/team-settings-workspace.client.spec.tsx`

Expected: PASS.

### Task 3: Port the confirmed weekly-limit and request-metadata contracts

**Files:**
- Modify: `src/team/types.ts`
- Modify: `src/shared/team-management.ts`
- Modify: `src/client/team/api.ts`
- Modify: `src/team/management-routes.ts`
- Modify: `src/team/store.ts`
- Modify: `src/team/postgres-store.ts`
- Modify: `src/team/service.ts`
- Modify: `src/team/gateway.ts`
- Add or modify: `src/shared/team-estimated-cost.ts`
- Add or modify: `src/team/estimated-cost.ts`
- Modify matching focused tests under `tests/`
- Reference only: matching files in the old `codex/team-phase-two` worktree

**Step 1: Write contract tests for the missing projections**

Cover:

- `weeklySharedEstimatedApiCostLimitMicros` round-trips only as a non-negative bounded integer or `null`.
- Usage event projections include time, member id, model, state, routed account id, token totals, and estimated API-equivalent amount, but no prompt or credential fields.
- Unknown/unpriced models do not silently bypass a configured monetary guard.
- Concurrent requests reserve budget before upstream dispatch and settle against actual usage.

**Step 2: Run focused tests to verify the gaps**

Run the affected client parser, route, store, PostgreSQL, gateway, and service specs explicitly.

Expected: FAIL on the fields or behavior that exist only in the old worktree.

**Step 3: Port and reconcile the smallest Host-side diff**

- Add the accepted fields to shared/server types and explicit browser allow-lists.
- Keep secret-bearing OAuth handling and pricing on the Host.
- Reconcile with the current envelope-encryption, role-shaped overview, display-name migration, ownership-transfer, dissolution, and aggregate-usage code rather than replacing those modules.
- Preserve null semantics when an amount cannot be reliably priced.

**Step 4: Run the focused backend suites**

Run: `pnpm vitest run tests/team-management-client.spec.ts tests/team-management-routes.spec.ts tests/team-postgres.spec.ts tests/team-request-service.spec.ts tests/team-gateway.spec.ts`

Expected: PASS.

### Task 4: Match the confirmed account-detail interaction

**Files:**
- Modify: `tests/team-settings-workspace.client.spec.tsx`
- Modify: `src/client/team/TeamSettings.tsx`
- Modify: `src/client/team/TeamSettings.module.css`
- Modify: `src/client/team/locales.ts`

**Step 1: Write failing UI tests for the confirmed copy and controls**

Verify:

- Weekly amount is displayed as `$used / $limit`, without a separate “shared limit” phrase.
- Approximate capacity uses a leading “约” only; it does not append “（估算）”.
- The weekly-limit edit icon sits beside the limit and opens a dialog.
- Recent requests shows metadata only and never conversation text.

**Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/team-settings-workspace.client.spec.tsx -t "weekly amount|recent requests|limit dialog"`

Expected: FAIL against the current absent Accounts view.

**Step 3: Implement the compact detail and dialogs**

Use real Team data, format missing/unpriced data explicitly, preserve focus on dialog close, and clear one-time OAuth presentation state on hide, timeout, context change, or unmount.

**Step 4: Run the client suites**

Run: `pnpm vitest run tests/team-settings-workspace.client.spec.tsx tests/team-settings-responsive-css.spec.ts tests/codex-subscription-pool.client.spec.tsx`

Expected: PASS.

### Task 5: Validate package and real stock-DSH behavior

**Files:**
- Modify: `DESIGN_REVIEW.md`
- Add/update screenshots under: `screenshots/`

**Step 1: Run repository checks**

Run:

```bash
pnpm test
pnpm run build
pnpm run verify:package
```

Expected: PASS.

**Step 2: Pack and install into isolated stock DSH**

Create a tarball, install it into a fresh isolated `DSH_HOME` using the pinned published DSH CLI, and start the stock DSH runtime. Do not reuse developer symlinks or local source resolution.

**Step 3: Capture the real interaction at required widths**

Using the in-app browser, capture:

- Team landing before clicking Team settings.
- Accounts view after clicking at 1280×800.
- Limit dialog at desktop width.
- Accounts view at 768×1024 and 375×812.
- Members and Owner Invitations views.

Verify keyboard focus, no horizontal overflow, readable labels, and role-shaped controls.

**Step 4: Update the design review**

Record actual screenshot paths, runtime URL/build identity, findings, fixes, and any remaining risk in `DESIGN_REVIEW.md`. Clearly distinguish component/package checks from the stock-DSH installation smoke test.

**Step 5: Inspect final Git state without committing**

Run: `git status --short --branch && git diff --check && git diff --stat`

Expected: only scoped files are modified/untracked; branch remains `codex/team-settings-after-click-rework`; no commit is created unless the user asks.
