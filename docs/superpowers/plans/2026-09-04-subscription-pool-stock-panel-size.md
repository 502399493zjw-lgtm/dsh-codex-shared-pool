# Subscription Pool Stock Panel Size Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the complete “Codex subscription pool” Settings dialog use the same stock shell width and height as “Agent presets” while keeping the plugin content usable at common viewport sizes.

**Architecture:** Remove the subscription-page-specific mutation of the host Settings dialog and let the pinned stock DSH `settings.section` shell remain the single owner of dialog geometry. Keep responsiveness inside the plugin page through its existing width cap, container queries, and minimum-width safeguards; lock the host-boundary rule with a focused source/CSS contract test.

**Tech Stack:** React, TypeScript, CSS Modules, Vitest, pnpm, stock DeepSeek Harness `0.1.0-rc.8`.

## Global Constraints

- Do not modify a DeepSeek Harness fork, generated catalog, or shared DSH instance.
- Do not add a page-specific desktop width or height for the host Settings dialog.
- Preserve usable plugin content at desktop, tablet, and phone widths by relying on stock shell behavior and plugin-owned responsive layout rules.
- Write and observe a focused failing test before the behavior change.
- Required verification: focused tests, `pnpm run build`, and `pnpm run verify:package`.
- Create a focused commit, push the branch, open a draft PR, and obtain an independent change-scoped subagent review; do not merge.

---

### Task 1: Return Settings shell geometry to the host

**Files:**
- Modify: `tests/team-settings-responsive-css.spec.ts`
- Modify: `src/client/CodexSubscriptionPoolSettings.module.css`
- Modify: `src/client/team/TeamSettings.module.css`

**Interfaces:**
- Consumes: the stock `settings.section` dialog geometry and the page marker `data-dsh-codex-subscription-pool`.
- Produces: a plugin stylesheet that sizes only `.page` and its descendants, never the ancestor Settings dialog or navigation.

- [x] **Step 1: Write the failing CSS boundary test**

Replace the current assertion for the page-specific `1280px` shell with assertions that the stylesheet contains no `role='dialog'`, `aria-modal`, or `:has([data-dsh-codex-subscription-pool])` ancestor selectors, while `.page` retains `width: min(100%, 960px)`, `max-width: 960px`, and `min-width: 0`.

- [x] **Step 2: Run the focused test to verify it fails**

Run: `pnpm exec vitest run tests/team-settings-responsive-css.spec.ts`

Expected: FAIL because the current stylesheet widens the desktop dialog to `1280px` and replaces the host shell/navigation geometry at desktop and phone breakpoints.

- [x] **Step 3: Remove the host-shell overrides**

Delete both global media-query blocks that target the ancestor dialog and its `nav`. Retain plugin-owned `.page`, header, tabs, and content rules, including the narrow-screen typography adjustment.

Keep the embedded local/Team tabs shrinkable in the stock phone content slot, stop subtracting the host navigation width a second time from the Team page, and allow long configuration keys to wrap.

- [x] **Step 4: Run focused responsive and component tests**

Run: `pnpm exec vitest run tests/team-settings-responsive-css.spec.ts tests/codex-subscription-pool.client.spec.tsx tests/client-profile-settings.spec.ts`

Expected: PASS, proving the host boundary and the embedded local/Team tab behavior remain intact.

### Task 2: Verify and deliver the isolated change

**Files:**
- Modify: `docs/superpowers/plans/2026-09-04-subscription-pool-stock-panel-size.md` only to check completed steps if useful.
- Modify: PR metadata after verification; no installation files.

**Interfaces:**
- Consumes: the focused CSS change and test evidence.
- Produces: build/package evidence, a draft PR against `main`, and an independent review conclusion limited to the PR diff.

- [x] **Step 1: Run required repository verification**

Run: `pnpm run build`

Run: `pnpm run verify:package`

Expected: both PASS without lockfile or generated-source changes.

- [x] **Step 2: Perform DOM and visual checks at common sizes**

Inspect the built stock Settings page at desktop, tablet, and phone sizes if an isolated runtime is available. Verify that “Codex subscription pool” and “Agent presets” resolve to identical dialog rectangles, the plugin page does not create horizontal overflow, and local/Team content remains reachable by scrolling. If runtime capture is unavailable, report the CSS/DOM evidence separately and identify live visual parity as unverified.

- [ ] **Step 3: Commit, push, and open a draft PR**

Commit only the plan, focused test, and stylesheet change on `codex/fix-subscription-pool-panel-size`; push it and open a draft PR targeting `main` with exact evidence boundaries.

- [ ] **Step 4: Obtain independent change-scoped review**

Have an independent subagent review only the PR diff against `main`, including stock-shell ownership, test quality, responsive behavior, compatibility risk, and accidental unrelated changes. Fix every blocking finding in the same PR and request a fresh scoped review. Do not merge.
