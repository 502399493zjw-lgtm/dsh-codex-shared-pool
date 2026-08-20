# Sidebar Quota Open Settings Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the sidebar Codex quota card open the OpenAI Codex settings section for both zero-account and populated-account states on stock DSH `0.1.0-rc.8`.

**Architecture:** Keep the Host, quota route, top-level Browser entry, and optional fallback behavior unchanged. Declare the stock rc.8 `settingsNavigation` service on the quota Browser child entry so Cordis injects the service before `apply()` reads it; retain the existing conditional projection so direct/unit benches without the service still degrade safely.

**Tech Stack:** TypeScript, React, Vitest/jsdom, Cordis `4.0.1`, DeepSeek Harness `0.1.0-rc.8`, pnpm `11.7.0`.

## Global Constraints

- Do not read or mutate the live `3181` DSH profile, accounts, credentials, or auth files.
- Do not modify DSH core or generated DSH catalogs.
- Keep `CLIENT_INJECT` equal to `['slots', 'locale', 'sessions']`; scope the new dependency to `QUOTA_CLIENT_INJECT`.
- Write and run a focused failing test before the behavior change.
- Run focused tests, `pnpm run build`, and `pnpm run verify:package` in order.
- Pack the plugin and install that tarball into a fresh isolated `DSH_HOME` using stock `@deepseek-ai/dsh@0.1.0-rc.8`.
- Initial implementation delivery was local-only. The user subsequently authorized a focused commit, push, and PR; publishing, merging, releasing, and history rewrites remain out of scope.

---

### Task 1: Quota Browser Injection Contract

**Files:**
- Modify: `tests/client-runtime-contract.spec.ts`
- Modify: `tests/quota-browser-plugin.client.spec.tsx`
- Modify: `src/client/runtime-contract.ts`

**Interfaces:**
- Consumes: Cordis Browser child-plugin `inject: readonly string[]` and `Context.settingsNavigation.openSection(sectionId: string): void`.
- Produces: `QUOTA_CLIENT_INJECT = ['slots', 'locale', 'settingsNavigation'] as const`; `CLIENT_INJECT` remains unchanged.

- [x] **Step 1: Write the failing contract and integration assertions**

```ts
expect(CLIENT_INJECT).toEqual(['slots', 'locale', 'sessions'])
expect(QUOTA_CLIENT_INJECT).toEqual(['slots', 'locale', 'settingsNavigation'])
expect(inject).toEqual(['slots', 'locale', 'settingsNavigation'])
```

- [x] **Step 2: Cover zero-account and populated-account projections**

```ts
it.each([
  ['zero accounts', { ...SNAPSHOT, currentAccountName: null, currentRemainingPercent: null, poolAccountCount: 0, poolRemainingPercent: null }],
  ['populated accounts', SNAPSHOT],
])('opens settings from the %s quota projection', async (_name, snapshot) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(snapshot), { status: 200 })))
  const b = bench()
  apply(b.ctx as never)
  b.entry()?.inject().openSettings?.()
  expect(b.openSection).toHaveBeenCalledWith('openai-codex')
  await expect(b.entry()?.inject().read()).resolves.toEqual(snapshot)
  await b.dispose()
})
```

- [x] **Step 3: Run the focused tests and confirm the injection assertion fails**

Run: `pnpm exec vitest run tests/client-runtime-contract.spec.ts tests/quota-browser-plugin.client.spec.tsx tests/quota-component.client.spec.tsx`

Expected: FAIL because `QUOTA_CLIENT_INJECT` and quota `inject` omit `settingsNavigation`.

- [x] **Step 4: Add the minimum quota-only injection dependency**

```ts
/** Services required by the quota Browser child plugin on pinned stock DSH. */
export const QUOTA_CLIENT_INJECT = ['slots', 'locale', 'settingsNavigation'] as const
```

- [x] **Step 5: Re-run the focused tests and confirm they pass**

Run: `pnpm exec vitest run tests/client-runtime-contract.spec.ts tests/quota-browser-plugin.client.spec.tsx tests/quota-component.client.spec.tsx`

Expected: PASS for the runtime contract, both account-state projections, click routing, and the existing no-service degradation test.

### Task 2: Package and Stock DSH Verification

**Files:**
- Verify: `lib/client.js`, `lib/index.js`, `lib/style.css`, packed tarball contents
- Create only under gitignored/local evidence paths: `artifacts/package/20260820T103500Z-sidebar-quota-nav/`, `artifacts/security/20260820T103500Z-sidebar-quota-nav/`, `artifacts/smoke/20260820T103500Z-sidebar-quota-nav-short-path/`

**Interfaces:**
- Consumes: the built npm package, trusted stock DSH stable entry digest `sha256:c0226687bb20f45c603ec6fe50f3de16d1c3510c3a803304ec575ef9bc366c62`.
- Produces: package-format verification plus a distinct real stock-DSH install/start/boot-manifest smoke result.

- [x] **Step 1: Run the required project gates in order**

Run:

```sh
pnpm run build
pnpm run verify:package
```

Expected: both commands exit `0`.

- [x] **Step 2: Scan the worktree for sensitive material**

Run:

```sh
node "$DSH_PLUGIN_SKILL_DIR/scripts/scan-sensitive.mjs" --project . --result "artifacts/security/$dsh_run_id/result.json" --provenance "artifacts/security/$dsh_run_id/provenance.json"
```

Expected: no error-level credential, auth, or secret findings.

- [x] **Step 3: Pack the exact worktree and inspect the tarball**

Run: `pnpm pack --pack-destination artifacts/package/20260820T103500Z-sidebar-quota-nav`

Expected: the tarball contains the built Host entry, Browser entry, styles, declarations, `cordis.patch.yml`, README, and LICENSE.

- [x] **Step 4: Install and smoke the tarball with pinned stock DSH**

Run:

```sh
node "$DSH_PLUGIN_SKILL_DIR/scripts/smoke-stock-dsh.mjs" --project . --tarball "$short_tarball" --dsh-entry artifacts/stock-dsh/install/node_modules/@deepseek-ai/dsh/lib/bin.js --execution real --dsh-source npm:@deepseek-ai/dsh@0.1.0-rc.8 --expected-dsh-sha256 sha256:c0226687bb20f45c603ec6fe50f3de16d1c3510c3a803304ec575ef9bc366c62 --expected-dsh-version 0.1.0-rc.8 --probe /plugins/dsh-openai-codex/quota --artifacts artifacts/smoke/20260820T103500Z-sidebar-quota-nav-short-path
```

Expected: exact version/digest verification, tarball installation into a fresh temporary `DSH_HOME`, config dump, Web start, homepage/plugin route probe, and Browser boot-manifest presence all pass without live account credentials.

Execution note: on macOS, `$short_tarball` was an ownership-tracked `/tmp` copy whose SHA-256 matched the packed artifact. This avoided pnpm's `ERR_PNPM_ENAMETOOLONG` store-index filename limit; both the copy and smoke `DSH_HOME` were cleaned afterward.

- [x] **Step 5: Audit cleanup and final Git state**

Run: `git diff --check && git status --short --branch`

Expected before the later PR request: only the plan, focused tests, and quota runtime contract are modified; no credentials, live profile files, or generated evidence are tracked.

Delivery update: after the implementation and isolated stock smoke completed, the user explicitly requested a PR. Deliver this focused diff from a `codex/` branch with `codex/phase-one-routing` as its base so that the base branch's existing automatic-routing work is not duplicated or presented as part of this fix.
