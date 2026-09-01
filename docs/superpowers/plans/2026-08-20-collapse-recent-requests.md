# Collapsible Recent Requests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the recent-request monitor as a collapsed single row by default and show no more than the three newest request receipts when expanded.

**Architecture:** Keep the existing Host ledger and Browser polling contract unchanged. Add local disclosure state to the existing settings component, conditionally mount the explanatory and receipt content, and cap the newest-first Browser projection at three items.

**Tech Stack:** React 18, TypeScript, Vitest, Testing Library, DSH client UI primitives.

## Global Constraints

- Preserve all existing uncommitted user changes on `codex/bootstrap`.
- Do not expose Host profile ids, request content, credentials, token data, or upstream errors to Browser code.
- Keep compatibility pinned to DSH `0.1.0-rc.8` and Cordis `4.0.1`.
- Do not commit, push, publish, or create a remote repository without explicit user authorization.

---

### Task 1: Recent-request disclosure behavior

**Files:**
- Modify: `src/client/OpenAICodexSettings.tsx`
- Test: `tests/settings-routing-events.client.spec.tsx`

**Interfaces:**
- Consumes: `routingEvents: readonly LocalRoutingEventSummary[]`, already ordered newest-first by the Host route.
- Produces: an accessible `button` with `aria-expanded`, a conditionally mounted panel, and `routingEvents.slice(0, 3)` as the visible receipt list.

- [x] **Step 1: Write the failing interaction test**

Render four distinct routing receipts, assert that the disclosure button starts with `aria-expanded="false"`, assert that receipt details are absent while collapsed, click the button, then assert that receipts 1–3 are visible and receipt 4 is absent.

- [x] **Step 2: Run the focused test to verify it fails**

Run: `pnpm exec vitest run tests/settings-routing-events.client.spec.tsx`

Expected: FAIL because the current recent-request section is always expanded and renders up to five receipts.

- [x] **Step 3: Implement the disclosure**

Add `routingOpen` component state initialized to `false`. Replace the static two-line heading with a full-width single-line button containing the localized title and chevron, set `aria-expanded={routingOpen}` and `aria-controls="dsh-codex-routing-content"`, and mount the explanation plus error/empty/list content only when `routingOpen` is true. Render `routingEvents.slice(0, 3)`.

- [x] **Step 4: Run the focused test to verify it passes**

Run: `pnpm exec vitest run tests/settings-routing-events.client.spec.tsx`

Expected: PASS for default collapse, expansion, newest-three rendering, existing alias rendering, and degraded states.

- [x] **Step 5: Run project gates**

Run: `pnpm run build`

Run: `pnpm run verify:package`

Run: `git diff --check`

Expected: all commands exit with status 0. This Browser-only presentation change does not alter installation, entry points, package layout, or the Cordis patch, so a stock-DSH install smoke is not required for the claim.
