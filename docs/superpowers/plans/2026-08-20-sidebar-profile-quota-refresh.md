# Sidebar Profile Quota Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the sidebar quota projection follow the stored Shared Pool profiles, their global order, and their live profile usage immediately and without stale-response races.

**Architecture:** The Host will assemble the existing JSON-safe quota snapshot from ordered profile summaries plus each profile's `OpenAICodexUsage`; configured Codex home slots remain a separate provider concern and no longer override the Shared Pool sidebar route. The Browser will publish a same-page invalidation event when Settings observes a profile/order/usage revision and the sidebar hook will refresh immediately, retain its 60-second timer, and accept only the newest request generation.

**Tech Stack:** TypeScript 6, React 18, Vitest 4, Testing Library, Cordis 4.0.1, stock DSH 0.1.0-rc.8.

## Global Constraints

- Preserve the completed empty-pool fix in `CodexQuotaProvider`: implicit homes do not count; explicit offline homes still count.
- Host alone may read credentials and profile-scoped usage; Browser receives only the existing `CodexQuotaSnapshot` and existing profile metadata.
- Never expose `auth.json`, tokens, account ids, credential paths, or raw provider failures through the quota route, logs, or tests.
- Do not patch DSH core or generated catalogs.
- Do not commit, push, publish, reset, clean, or overwrite unrelated untracked files.
- Validate in order: focused tests, build, package-format verification, pack, then isolated stock DSH rc.8 smoke when feasible.

---

### Task 1: Ordered profile quota projection

**Files:**
- Create: `src/quota/profiles.ts`
- Create: `tests/profile-quota.spec.ts`
- Modify: `src/auth-routes.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: ordered `{ label: string; usage: OpenAICodexUsage }` entries returned by `OpenAICodexWebAuth.profilesStatus()`.
- Produces: `assembleOpenAICodexProfileQuota(profiles, now?): CodexQuotaSnapshot`.

- [x] **Step 1: Write the failing projection tests**

  Cover empty, one-profile, three-profile, reordered priority, deletion, and one unreadable profile represented by empty `rateLimits`. Assert count always equals stored profile count, current fields follow the allocator's first-not-proven-exhausted scan, pool mean uses readable primary Codex windows, and reset time uses `resetsAt` rather than inventing one from window duration.

- [x] **Step 2: Run the test to verify RED**

  Run: `pnpm exec vitest run tests/profile-quota.spec.ts`

  Expected: fail because `src/quota/profiles.ts` does not exist.

- [x] **Step 3: Implement the pure projection**

  Add a small Host-safe function that selects `rateLimits.find(limit => limit.id === 'codex')?.windows[0]`, scans ordered profiles like the regular-Codex allocator, averages all readable primary windows, preserves total profile count, and emits no profile id or credential data.

- [x] **Step 4: Route the sidebar through profiles**

  Make `OpenAICodexWebAuth.quotaSnapshot()` assemble from `profilesStatus()`. Remove the `accountHomes` app-server reader from the Web route wiring in `src/index.ts` while retaining its exported provider and the preceding task's provider tests/semantics.

- [x] **Step 5: Run focused Host tests**

  Run: `pnpm exec vitest run tests/profile-quota.spec.ts tests/quota.spec.ts tests/auth-routes.spec.ts tests/composition.spec.ts`

  Expected: all pass, including the preceding task's empty/explicit-home regression cases.

### Task 2: Immediate Browser invalidation and newest-response wins

**Files:**
- Create: `src/client/quota/invalidation.ts`
- Create: `tests/quota-refresh.client.spec.tsx`
- Modify: `src/client/quota/useCodexQuota.ts`
- Modify: `src/client/OpenAICodexSettings.tsx`

**Interfaces:**
- Produces: `invalidateCodexQuota()`, `subscribeCodexQuotaInvalidation(listener)`, and `observeCodexQuotaProfiles(previousRevision, profiles, notify?)`.
- Consumes: the same Browser-safe profile array already returned by `/plugins/dsh-openai-codex/profiles`.

- [x] **Step 1: Write failing Browser tests**

  Assert profile revisions invalidate on 0→1→3, reorder, delete, and changed usage; no-op on identical data. Assert the hook reads on mount, immediately rereads after invalidation, still rereads at 60 seconds, ignores an older response that settles after the newer invalidated read, and removes listeners/timers on unmount.

- [x] **Step 2: Run the tests to verify RED**

  Run: `pnpm exec vitest run tests/quota-refresh.client.spec.tsx`

  Expected: fail because the invalidation module and race guard are not implemented.

- [x] **Step 3: Implement event ownership and revision tracking**

  Use one plugin-namespaced `window` event. Compute a JSON-safe revision from profile id, label, primary Codex window remaining/reset values, quota-error presence, and array order. The first observation establishes a baseline; later changes publish invalidation.

- [x] **Step 4: Make the hook race-safe**

  Increment a request generation before every mount, timer, or invalidation read. Apply success or failure only when its generation is still newest and the effect remains mounted. Keep `CODEX_QUOTA_POLL_INTERVAL_MS` at exactly `60_000`.

- [x] **Step 5: Connect Settings observations**

  After every ready profiles response—including OAuth completion, priority updates, removals, renames, and 60-second usage polling—feed the profile list to the revision observer. This remains same-origin and sends no new fields to Browser.

- [x] **Step 6: Run focused Browser tests**

  Run: `pnpm exec vitest run tests/quota-refresh.client.spec.tsx tests/quota-component.client.spec.tsx tests/quota-browser-plugin.client.spec.tsx tests/settings-auth-cancel.client.spec.tsx tests/client-profile-settings.spec.ts`

  Expected: all pass with fake timers restored after each test.

### Task 3: Package and stock validation

**Files:**
- Modify only if a validation failure identifies a task-scoped defect.

**Interfaces:**
- Consumes: built npm tarball and the exact public `@deepseek-ai/dsh@0.1.0-rc.8` CLI.
- Produces: separate package-format and stock-install conclusions.

- [x] **Step 1: Run the complete task gate**

  Run focused tests, `git diff --check`, `pnpm run build`, and `pnpm run verify:package`.

- [x] **Step 2: Scan and pack**

  Run the skill sensitive scanner on the task files/evidence, then `pnpm pack --pack-destination artifacts/package` and scan the unpacked tarball or rely on the project's verified package contents plus an explicit task-file scan.

- [x] **Step 3: Run isolated stock smoke when feasible**

  Reuse the already integrity-verified rc.8 installation method from the completed shared task. Install only the newly packed tarball into a fresh temporary `DSH_HOME`, start Web, probe boot/client and `/plugins/dsh-openai-codex/quota`, and clean only resources owned by this run.

- [x] **Step 4: Report exact state**

  Report user-visible behavior, files changed, every command and result, package-format versus real stock-smoke evidence, browser/provider limitations, and final `git status --short --branch`. Do not commit.
