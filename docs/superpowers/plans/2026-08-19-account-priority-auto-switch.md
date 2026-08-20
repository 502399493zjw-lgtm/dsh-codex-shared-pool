# Codex Account Priority and Auto-Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the previously developed account-priority and quota failover semantics into the standalone DSH Codex plugin without changing DSH core or exposing account homes and tokens to the browser.

**Architecture:** Keep the existing ordered `CODEX_HOME` account configuration and `activeAccountId` setting as the priority order's first candidate. Add a Host-only allocator that checks the configured account's primary Codex quota before each request, keeps a healthy session bound to its current account, and moves an exhausted session to the first healthy account. Make the adapter select the account at request time and preserve the selected stable id in replay evidence; the browser continues to receive only the existing display-safe account/quota projections.

**Tech Stack:** TypeScript, DSH Cordis, `@deepseek-ai/dsh-llm-pi-ai`, official Codex app-server stdio quota reader, Vitest.

## Global Constraints

- Do not add product code to a sibling `deepseek-harness` checkout; this standalone package is the install and publication boundary.
- Do not expose `CODEX_HOME`, auth files, access tokens, or provider credentials through routes, settings, replay metadata, or diagnostics.
- Keep the stock pi-ai Codex provider and DSH `llm` contracts; account routing belongs in the plugin Host adapter.
- A quota-read failure must not make every account unavailable; the allocator keeps the current/priority account when quota metadata is unavailable.
- Primary-window quota is the only quota signal currently available from the standalone app-server reader; model-specific Spark/individual-limit buckets remain a separate follow-up.

---

### Task 1: Add a Host-only account allocator

**Files:**
- Create: `src/codex/allocation.ts`
- Test: `tests/codex-allocation.spec.ts`

**Interfaces:**
- Consumes: `CodexAccount` and an injected `readQuota(account, model, signal)` callback.
- Produces: `CodexAccountAllocator`, `CodexAccountQuotaReader`, and an `AllocationResult` containing the selected account and whether a session changed accounts.

- [x] **Step 1: Write failing tests** for priority order, exhausted preferred account failover, sticky healthy session binding, quota-read failure fallback, and all-exhausted fallback.
- [x] **Step 2: Run `pnpm vitest run tests/codex-allocation.spec.ts`** and verify the new tests fail because the allocator does not exist.
- [x] **Step 3: Implement the allocator** with an ordered candidate list that moves the preferred account to the front, a per-session binding map, per-session promise serialization, and the following selection rules:
  - retain a bound account when its quota is missing or has remaining percentage above zero;
  - otherwise scan candidates in priority order and choose the first account whose quota is missing or above zero;
  - when all candidates are proven exhausted, retain the bound account or use the priority account as a conservative fallback;
  - mark `switched: true` only when a previously bound session receives a different account.
- [x] **Step 4: Run the focused allocator tests** and verify they pass.

### Task 2: Expose per-account quota reads without changing the browser contract

**Files:**
- Modify: `src/quota/provider.ts`
- Modify: `src/quota/types.ts`
- Test: `tests/quota.spec.ts`

**Interfaces:**
- Consumes: Existing `CodexQuotaProvider` configuration, subprocess options, and `readCodexAccountQuota`.
- Produces: `CodexQuotaProvider.readAccountQuota(accountId, signal?)`, returning the Host-only `CodexAccountQuota | undefined` with a short-lived cache keyed by account id.

- [x] **Step 1: Add failing tests** proving an id resolves to the matching home, unknown ids return `undefined`, and repeated reads within `refreshIntervalMs` reuse the per-account result.
- [x] **Step 2: Run the focused quota tests** and verify the new cases fail.
- [x] **Step 3: Implement the per-account reader/cache** using the existing app-server reader and the same timeout/disposal policy as aggregate reads; keep the existing `/quota` JSON shape unchanged.
- [x] **Step 4: Run `pnpm vitest run tests/quota.spec.ts`** and verify all quota tests pass.

### Task 3: Route each model request through the allocator

**Files:**
- Modify: `src/codex/adapter.ts`
- Modify: `src/index.ts`
- Test: `tests/codex-adapter.spec.ts`

**Interfaces:**
- Consumes: `CodexAccountAllocator`, `CodexQuotaProvider.readAccountQuota`, and the existing token resolver.
- Produces: Request-scoped account selection for `createOpenAICodexAdapter`; the existing `activeAccountId` remains the first-priority candidate, and the selected account id remains in successful replay evidence.

- [x] **Step 1: Add a failing adapter test** with two accounts where the preferred account reports zero remaining quota and the secondary account reports remaining quota; assert the request uses the secondary token and replay evidence names the secondary stable id.
- [x] **Step 2: Run the focused adapter test** and verify it fails because the adapter currently captures one account at construction.
- [x] **Step 3: Refactor the adapter** so metadata calls delegate to a catalog adapter, while `stream(options)` allocates an account from `options.model` and `options.sessionId`, creates the selected-account pi-ai delegate, and decorates only that request's finish chunk.
- [x] **Step 4: Pass the quota reader from `apply()`** through a Host-only closure over the initialized `CodexQuotaProvider`; when the provider is not yet available, return `undefined` so startup remains usable.
- [x] **Step 5: Run `pnpm vitest run tests/codex-adapter.spec.ts`** and verify all adapter tests pass.

### Task 4: Keep account projections and settings semantics honest

**Files:**
- Modify: `src/client/index.tsx`
- Modify: `README.md`

**Interfaces:**
- Consumes: Existing account directory and quota routes plus `activeAccountId` settings.
- Produces: Copy that describes the selected account as the priority/default candidate while explaining that a running session may fail over when quota is exhausted; no fake live-switch claim.

- [x] **Step 1: Review the existing account projection contract** for the priority/default copy and the absence of home/token fields.
- [x] **Step 2: Implement the copy-only adjustment** and show the selected account as “优先账号” while leaving the existing DSH visual structure intact.
- [x] **Step 3: Run client tests, TypeScript, build, and package verification.**

### Task 5: Full verification and handoff

**Files:**
- No new product files.

- [x] **Step 1: Run `pnpm test`**.
- [x] **Step 2: Run `pnpm exec tsc -p tsconfig.json --noEmit`**.
- [x] **Step 3: Run `pnpm run build` and `pnpm run verify:package`**.
- [x] **Step 4: Inspect `git diff` and `git status --short --branch`; confirm no DSH-core files or secrets were added.
