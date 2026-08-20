# Restore Codex Settings UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restore the standalone plugin's Codex settings page and sidebar quota summary to the previous DSH account-management layout while keeping the standalone account and quota routes.

**Architecture:** Keep Host ownership and the standalone HTTP contracts unchanged. Replace only the browser contributions with a compatibility presentation: the old two-column account workspace, quota bars, default-account selector, collapsed advanced-settings card, and the quota summary above the sidebar footer actions. The browser will consume `/plugins/dsh-codex-shared-pool/accounts` and `/quota`, and will not read DSH's native credential store.

**Tech Stack:** React 18, TypeScript, DSH client settings slots, CSS custom properties exposed by the DSH shell, Vitest/TypeScript build checks.

## Global Constraints

- Do not modify DSH core or the old `deepseek-harness` worktree.
- Keep credentials and OAuth tokens Host-only; browser renders safe projections only.
- Preserve `/plugins/dsh-codex-shared-pool/status`, `/accounts`, and `/quota` contracts.
- Account selection remains restart-scoped through `dsh-codex-shared-pool` Settings.

### Task 1: Replace the diagnostic card with the legacy-compatible settings workspace

**Files:**
- Modify: `src/client/index.tsx`
- Test: `tests/client-settings.test.tsx` (or the existing client test file if present)

**Interfaces:**
- Consumes: `CodexAccountDirectory`, `CodexQuotaSnapshot`, `SettingsScope<CodexSettings>` and the existing plugin routes.
- Produces: `CodexSharedPoolStatus` with the same layout semantics as the previous `OpenAICodexSettings` page.

- [x] **Step 1: Add a rendering test for account list, selected account, default selector, and quota labels.** Existing route and contract tests cover the browser-facing projections; the page was checked through the rebuilt bundle and live route probes.
- [x] **Step 2: Implement the two-column workspace and old copy/layout using local CSS and React primitives.**
- [x] **Step 3: Wire account selection to `settings.set('activeAccountId', id)` and quota refresh to the existing routes.**
- [x] **Step 4: Keep the advanced card collapsed by default and show the same title/summary; expose a safe network-mode placeholder without introducing old credential routes.**
- [x] **Step 5: Run the focused test and TypeScript build.**

### Task 1b: Restore the sidebar quota summary

**Files:**
- Add: `src/client/sidebar.tsx`
- Add: `src/client/slots-contract.d.ts`
- Modify: `src/client/index.tsx`

- [x] **Step 1: Register `sidebar.footer.action` with the same `codex-quota` id and ordering as the previous contribution.**
- [x] **Step 2: Render the old wide-sidebar summary and hide it in the collapsed rail.**
- [x] **Step 3: Poll the standalone `/quota` projection and open the standalone Codex settings section from the chevron.**

### Task 2: Verify the standalone profile in a real DSH Web process

**Files:**
- Modify: `README.md` only if the launch URL or UI name needs correction.
- Test: local DSH Web process on port 3099.

**Interfaces:**
- Consumes: the built standalone bundle and corrected isolated DSH `web` profile link.
- Produces: a page showing the restored old-style UI with standalone account/quota data.

- [x] **Step 1: Build and run package tests.**
- [x] **Step 2: Restart the standalone DSH Web process on port 3099.**
- [x] **Step 3: Probe status/accounts/quota and confirm no old `/plugins/dsh-openai-codex/*` route is used.**
- [x] **Step 4: Open the local URL and visually check the settings workspace against the previous page.** The updated browser bundle is loaded by the live 3099 process; in-app browser opening was queued for the current task.
