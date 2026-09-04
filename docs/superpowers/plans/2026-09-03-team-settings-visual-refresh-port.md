# Team Settings Visual Refresh Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reapply the approved final Team settings visual refinements from PR #17 onto current `main` without reverting the newer Team authorization, quota, availability, and OAuth behavior.

**Architecture:** Keep the current `TeamSettings` state and API flows unchanged. Port only the final workspace DOM placement and CSS presentation contracts, using focused DOM/CSS tests to prevent old branch code from replacing current behavior. Generate screenshots from the resulting current-main-based branch rather than reusing historical assets.

**Tech Stack:** React, TypeScript, CSS Modules, Vitest, Testing Library, pnpm.

## Global Constraints

- Preserve all Team behavior merged through PRs #21–#29.
- Do not cherry-pick the old PR wholesale; adapt only the approved visual behavior.
- Keep Owner-only actions and current accessibility names, focus restoration, and keyboard behavior intact.
- Do not restart shared DSH instances on ports 3181 or 3197.
- Required verification: focused Team settings tests, `pnpm run build`, and `pnpm run verify:package`.

---

### Task 1: Lock the final workspace interaction structure

**Files:**
- Modify: `tests/team-settings-workspace.client.spec.tsx`
- Modify: `src/client/team/TeamSettings.tsx`

**Interfaces:**
- Consumes: existing `teamSettingsOpen`, `workspaceView`, `workspaceBackRef`, `refreshUsage`, and Owner-role projection.
- Produces: an icon-only back action in the rail, an icon-only refresh action with accessible name, and section actions that remain in their heading row.

- [ ] **Step 1: Write failing DOM tests**

Add assertions that the Team settings region contains a navigation rail with a button named by `backToTeam`, that the button's visible text is only `←`, and that the usage refresh button retains the accessible name `refresh` without rendering that label as visible text. Keep the existing assertions that member and invitation actions are inside their section headers.

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `pnpm exec vitest run tests/team-settings-workspace.client.spec.tsx`

Expected: FAIL because the back action is currently in the content header with visible copy and the refresh control renders its label.

- [ ] **Step 3: Adapt the current component without replacing current behavior**

Move the existing back button into `workspaceRail` after the navigation, render only `<span aria-hidden="true">←</span>`, and add `aria-label={t('backToTeam')}` plus `title={t('backToTeam')}`. Render the usage refresh action as the existing icon with `aria-label={t('refresh')}` and `title={t('refresh')}`, omitting visible `{t('refresh')}` text. Do not change callbacks, busy state, focus restoration, role checks, or API calls.

- [ ] **Step 4: Run the focused test and confirm success**

Run: `pnpm exec vitest run tests/team-settings-workspace.client.spec.tsx`

Expected: PASS.

### Task 2: Port the approved compact visual hierarchy

**Files:**
- Modify: `tests/team-settings-responsive-css.spec.ts`
- Modify: `src/client/team/TeamSettings.module.css`

**Interfaces:**
- Consumes: existing CSS module class names and `data-owner` responsive usage-card state.
- Produces: a stable-height two-column workspace, restrained typography, two side-by-side Owner usage groups, and only structural separators.

- [ ] **Step 1: Write failing CSS contract tests**

Assert that `.workspaceShell` has `height: clamp(500px, 58vh, 580px)`, `.workspaceMain` scrolls vertically, `.workspaceBack` is a 36px borderless rail action anchored with `margin: auto 0 0`, `.workspaceTitle` is 18px/24px, navigation labels are 13px/19px, and `.usageHeading` is 19px/26px. Assert that the historical `SETTINGS` kicker is absent, Owner usage cards use two columns until the existing 520px container breakpoint, and non-structural card/metric borders are absent.

- [ ] **Step 2: Run the CSS contract test and confirm failure**

Run: `pnpm exec vitest run tests/team-settings-responsive-css.spec.ts`

Expected: FAIL on fixed height, compact type, back-action placement, and separator rules.

- [ ] **Step 3: Apply minimal CSS changes**

Adapt the values from commits `e0f63be` through `0072f92` to the current tokenized stylesheet. Preserve current dark-theme tokens and current responsive width caps from PR #23. Avoid restoring the removed `SETTINGS` kicker or any historical account/authorization styling.

- [ ] **Step 4: Run both focused suites**

Run: `pnpm exec vitest run tests/team-settings-responsive-css.spec.ts tests/team-settings-workspace.client.spec.tsx`

Expected: PASS.

### Task 3: Validate, capture, and deliver

**Files:**
- Create: `screenshots/team-settings-final-current-main-desktop.png`
- Create: `screenshots/team-settings-final-current-main-tablet.png`
- Create: `screenshots/team-settings-final-current-main-mobile.png`
- Modify: PR description only after screenshots are verified.

**Interfaces:**
- Consumes: built plugin and an isolated non-shared visual runtime.
- Produces: current screenshots that correspond to the exact PR commit.

- [ ] **Step 1: Run required verification**

Run: `pnpm run build`

Run: `pnpm run verify:package`

Expected: both PASS.

- [ ] **Step 2: Run visual acceptance outside shared ports**

Use an isolated runtime on a port other than 3181 or 3197. Verify desktop, tablet, and mobile layouts: no clipping, two-column Owner usage at supported widths, icon-only refresh, compact headings, fixed workspace height, and keyboard-visible controls.

- [ ] **Step 3: Capture and inspect screenshots**

Capture the three named PNG files from the actual current commit. Inspect each image before adding it to the PR; do not reuse `team-settings-rework-runtime-*.png` because those predate the final visual commits.

- [ ] **Step 4: Commit, push, and open a draft PR**

Commit only the focused tests, component/style changes, plan, and verified screenshots. Push `codex/port-team-settings-visual-refresh` and open a draft PR to `main` with exact validation boundaries.

- [ ] **Step 5: Request independent change-scoped review**

Have an independent sub-agent review the PR diff against `main`, including behavior preservation, tests, accessibility, responsive risks, and screenshot provenance. Fix blockers and request a second scoped review before asking the user to approve merge.
