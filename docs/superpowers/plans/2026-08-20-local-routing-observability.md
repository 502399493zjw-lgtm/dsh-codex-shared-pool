# Local Routing Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each real local Codex Shared Pool request observable through a Browser-safe metadata receipt so automatic quota fallback and request settlement can be proven without exposing credentials, identity, content, session IDs, or exact token usage.

**Architecture:** The allocator returns a Host-only decision containing raw profile IDs and a safe reason code. A bounded in-memory Host ledger converts those IDs to stable ordinal aliases at admission time and records one metadata-only event per DSH request. A same-origin read-only route projects only the alias, model, reason, request unit, status, and timestamps to the existing OpenAI Codex settings page.

**Tech Stack:** TypeScript 6, Cordis 4.0.1, DSH 0.1.0-rc.8 Host/Browser extension points, React 18, Vitest.

## Global Constraints

- Keep credentials, account labels, account IDs, auth paths, raw session IDs, prompts, responses, files, token counts, and provider error bodies Host-only.
- The Browser receives JSON-safe bounded metadata only; aliases are ordinal `账号 A`, `账号 B`, and so on.
- The unit is exactly `request`; do not represent it as token, cost, or exact subscription consumption.
- Keep at most 100 events in memory and return at most 50 newest events.
- Keep the feature local-only; OAuth credentials remain inside the current Host profile.
- Verify only against DSH `0.1.0-rc.8` and Cordis `4.0.1`.

---

### Task 1: Host-only allocation decision and request ledger

**Files:**
- Create: `src/local-routing-events.ts`
- Modify: `src/account-allocation.ts`
- Modify: `src/adapter.ts`
- Test: `tests/account-allocation.spec.ts`
- Test: `tests/local-routing-events.spec.ts`

**Interfaces:**
- Produces: `LocalProfileAllocation` with `profileId`, optional `previousProfileId`, and `reason`.
- Produces: `LocalRoutingEventLedger.begin()` returning an opaque event ID and `settle()` accepting `succeeded | failed | cancelled`.
- Browser-safe event fields are `id`, `profileAlias`, optional `previousProfileAlias`, `model`, `reason`, `unit`, `status`, `startedAt`, and optional `finishedAt`; Host-only IDs never appear in the summary.

- [x] **Step 1: Write failing allocator decision tests**

Add assertions that a 0% first profile returns the second profile with reason `quota_fallback`, a readable first profile returns reason `priority`, an unreadable quota returns `quota_unknown`, and all exhausted returns `all_exhausted`.

- [x] **Step 2: Run the allocator test and verify it fails**

Run: `pnpm exec vitest run tests/account-allocation.spec.ts`

Expected: FAIL because the allocator currently returns only a profile ID.

- [x] **Step 3: Implement the minimal Host-only decision**

Keep raw profile IDs internal and preserve the existing selection semantics. Record whether any earlier profile was proven exhausted and whether the selected quota was unreadable.

- [x] **Step 4: Write failing ledger tests**

Cover begin/settle, cancellation, newest-first order, 100-event retention, 50-event read limit, alias generation from current profile order, and absence of raw profile/session/content fields from JSON serialization.

- [x] **Step 5: Run the ledger tests and verify they fail**

Run: `pnpm exec vitest run tests/local-routing-events.spec.ts`

Expected: FAIL because the ledger does not exist.

- [x] **Step 6: Implement and wire the ledger into real adapter streaming**

Begin only after allocation succeeds. Settle `succeeded` after normal stream completion, `cancelled` when `options.signal` is aborted, and `failed` for every other thrown error. Do not persist or retain the provider error.

- [x] **Step 7: Run focused Host tests**

Run: `pnpm exec vitest run tests/account-allocation.spec.ts tests/local-routing-events.spec.ts tests/response-runtime.spec.ts`

Expected: PASS.

### Task 2: Same-origin Browser-safe projection and settings monitor

**Files:**
- Modify: `src/auth-routes.ts`
- Modify: `src/client/OpenAICodexSettings.tsx`
- Modify: `src/client/locales.ts`
- Modify: `src/client/OpenAICodexSettings.module.css` if the existing component uses a local stylesheet; otherwise modify its current style source only.
- Test: `tests/auth-routes.spec.ts`
- Test: `tests/client-profile-settings.spec.ts`

**Interfaces:**
- Produces: `GET /plugins/dsh-openai-codex/routing-events` returning `{ events: LocalRoutingEventSummary[] }`.
- Consumes: the Host ledger from Task 1.

- [x] **Step 1: Write failing route tests**

Assert method `GET`, newest-first bounded events, and a response JSON scan that rejects raw profile IDs, labels, session IDs, prompts, responses, tokens, and errors.

- [x] **Step 2: Run route tests and verify they fail**

Run: `pnpm exec vitest run tests/auth-routes.spec.ts`

Expected: FAIL with an unregistered route.

- [x] **Step 3: Register the read-only same-origin route**

Return only the Browser-safe ledger summary. Do not accept profile IDs or mutation input.

- [x] **Step 4: Write failing Browser contract tests**

Assert the settings page polls while profiles exist and renders safe alias, model, reason, request status, and `1 request`, including empty and error states without blocking account management.

- [x] **Step 5: Run Browser tests and verify they fail**

Run: `pnpm exec vitest run tests/client-profile-settings.spec.ts`

Expected: FAIL because no routing monitor is rendered.

- [x] **Step 6: Implement the compact recent-request monitor**

Render the five newest events below the account detail. Use human-readable reasons: priority account, quota fallback, quota unknown, or all accounts exhausted fallback. Explicitly label the metric as request attempts, not tokens.

- [x] **Step 7: Run focused Host and Browser tests**

Run: `pnpm exec vitest run tests/auth-routes.spec.ts tests/client-profile-settings.spec.ts tests/settings-auth-cancel.client.spec.tsx`

Expected: PASS.

### Task 3: Documentation, package, stock smoke, and 3181 acceptance

**Files:**
- Modify: `README.md`
- Create under gitignored evidence root: `artifacts/ui/<run-id>/result.json`, `provenance.json`, `resources.json`, `validation.gif`, and `gif-review.md`.

**Interfaces:**
- Consumes: the Host route and Browser monitor from Tasks 1 and 2.
- Produces: an evidence set whose claim is limited to local quota preselection/fallback plus metadata-only request accounting.

- [x] **Step 1: Document exact semantics and limitations**

State that local events are process-memory metadata, one settled event per DSH request, and not token/cost accounting. Correct the local session-stickiness wording so it matches global-priority rescanning behavior.

- [x] **Step 2: Run the complete relevant suite**

Run the allocator, route, Browser, and package contract suites. Expected: PASS.

- [x] **Step 3: Build and verify the package**

Run: `pnpm run build && pnpm run verify:package`

Expected: PASS with Host and Browser entrypoints present and no credentials in artifacts.

- [x] **Step 4: Pack and install into isolated stock DSH rc.8**

Use the repository smoke tooling with a fresh run-owned `DSH_HOME`, verify the trusted rc.8 entry checksum, install the tarball, start loopback Web, probe the route and Browser bundle, then clean only run-owned resources.

- [x] **Step 5: Test the real 3181 flow without forcing exhaustion**

Snapshot the original profile order and current quota projection. If a profile is already provider-reported at exactly 0%, place it first, issue one bounded request in a fresh DSH session, assert a succeeded event with reason `quota_fallback` and a different safe alias, then restore the original order. Do not deliberately exhaust an account, and do not claim how the observed 0% state arose unless independent evidence proves it. If no profile is at 0%, record `NOT_PROVEN` instead of consuming quota to manufacture the condition.

- [x] **Step 6: Record and independently review the final validation GIF**

Show the provider-reported 0% first candidate, one bounded request with all content masked, and the new succeeded `1 request` event with safe alias and `quota fallback`. Prove restoration with a sanitized machine assertion when it is not visually included. The reviewer must judge the final encoded GIF against the machine assertions and provenance.

- [x] **Step 7: Report exact Git and evidence state**

Report files changed, commands actually run, real versus controlled claims, cleanup, and `git status --short --branch`. Do not commit, push, publish, or create a remote.
