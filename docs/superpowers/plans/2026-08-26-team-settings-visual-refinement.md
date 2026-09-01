# Team Settings Visual Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Execute this plan task-by-task with focused test gates. Do not commit unless the user explicitly requests it.

**Goal:** Make the post-click Team management workspace visually compact and native to the stock DSH settings surface without changing Team behavior or crossing the plugin boundary.

**Architecture:** Keep the existing `TeamSettings` state and API flows. Replace the nested desktop rail with one horizontal task navigation, combine return/context/actions into a compact header, and drive all responsive behavior from the plugin container width. Preserve semantic regions, navigation, focus restoration, and 44px interactive targets.

**Tech Stack:** React, TypeScript, CSS Modules, Vitest, Testing Library, stock DSH Cordis settings slot.

## Global Constraints

- Default Team panel continues to own account management.
- Clicking “团队设置” opens only 用量 / 成员 / 邀请码 and defaults to 用量.
- Do not patch stock DSH core or its settings modal.
- Use existing DSH theme tokens and existing Button components.
- Preserve unrelated worktree changes; do not commit or push.

---

### Task 1: Lock the compact workspace contract

**Files:**
- Modify: `tests/team-settings-responsive-css.spec.ts`
- Modify: `tests/team-settings-workspace.client.spec.tsx`

- [ ] Add a failing CSS contract that rejects the nested 190–226px rail and requires a three-column top navigation at the normal workspace width.
- [ ] Add a component assertion that the management region has no duplicated `SETTINGS / Team` brand rail while retaining the Team name, return control, navigation, and Team management menu.
- [ ] Run the focused tests and confirm they fail against the current rail layout.

### Task 2: Recompose the management workspace

**Files:**
- Modify: `src/client/team/TeamSettings.tsx`
- Modify: `src/client/team/TeamSettings.module.css`

- [ ] Remove the `workspaceRail`, `workspaceBrand`, `workspaceKicker`, and `workspaceTitle` presentation from the post-click workspace.
- [ ] Use a compact header with the return control, Team name, metadata, and an icon-style Team actions button.
- [ ] Place 用量 / 成员 / 邀请码 in a single top navigation row at desktop and tablet widths with an underline selected state.
- [ ] Remove the redundant workspace breadcrumb from the post-click header.
- [ ] Flatten the outer workspace surface so the data panels, rather than nested shells, carry the visual hierarchy.
- [ ] Run the focused component and CSS tests until green.

### Task 3: Consolidate responsive behavior

**Files:**
- Modify: `src/client/team/TeamSettings.module.css`
- Test: `tests/team-settings-responsive-css.spec.ts`

- [ ] Remove duplicated viewport media-query copies of workspace layout rules and keep container-query behavior as the plugin-owned contract.
- [ ] At extremely narrow container widths, stack the task navigation and reduce type/padding without hiding controls.
- [ ] Preserve 44px targets, visible focus rings, and reduced-motion handling.
- [ ] Run the responsive CSS contract and the full Team workspace component suite.

### Task 4: Verify and record

**Files:**
- Modify: `DESIGN_REVIEW.md`
- Update: `screenshots/team-settings-rework-runtime-*.png` when a real stock DSH runtime is available.

- [ ] Run `pnpm test`, `pnpm run build`, and `pnpm run verify:package`.
- [ ] Install the packed tarball into isolated stock `@deepseek-ai/dsh@0.1.0-rc.8` profiles.
- [ ] Capture desktop, tablet, and mobile screenshots of the corrected management workspace.
- [ ] Record plugin improvements separately from unresolved stock DSH shell constraints.
- [ ] Run `git diff --check` and report the exact branch and uncommitted state.
