# Sidebar Quota Open Settings Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the sidebar Codex quota card open the OpenAI Codex settings section for both zero-account and populated-account states on stock DSH `0.1.0-rc.8`.

**Architecture:** Keep the Host, quota route, and top-level Browser entry unchanged. Stock rc.8 has no external `settingsNavigation` service and invokes the quota registration from the top-level Browser plugin, so quota keeps only its real `slots`/`locale` requirements. The action always exists: compatible newer shells use the optional navigation service, while rc.8 opens the Settings dialog and selects the Codex section through stable accessible roles and labels, without generated CSS class names or DSH core changes.

**Tech Stack:** TypeScript, React, Vitest/jsdom, Cordis `4.0.1`, DeepSeek Harness `0.1.0-rc.8`, pnpm `11.7.0`.

## Global Constraints

- Do not read or mutate the live `3181` DSH profile, accounts, credentials, or auth files.
- Do not modify DSH core or generated DSH catalogs.
- Keep `CLIENT_INJECT` equal to `['slots', 'locale', 'sessions']` and `QUOTA_CLIENT_INJECT` equal to `['slots', 'locale']`; do not hard-wait on a service absent from stock rc.8.
- Write and run a focused failing test before the behavior change.
- Run focused tests, `pnpm run build`, and `pnpm run verify:package` in order.
- Pack the plugin and install that tarball into a fresh isolated `DSH_HOME` using stock `@deepseek-ai/dsh@0.1.0-rc.8`.
- Initial implementation delivery was local-only. The user subsequently authorized a focused commit, push, and PR; publishing, merging, releasing, and history rewrites remain out of scope.

---

### Task 1: Quota Browser Navigation Contract

**Files:**
- Modify: `tests/client-runtime-contract.spec.ts`
- Modify: `tests/quota-browser-plugin.client.spec.tsx`
- Modify: `src/client/runtime-contract.ts`
- Modify: `src/client/quota/index.ts`
- Modify: `src/client/quota/CodexQuotaFooter.tsx`
- Modify: `src/client/index.tsx`
- Modify: `src/client/compat-slots.d.ts`
- Create: `src/client/settings-section-navigation.ts`

**Interfaces:**
- Consumes: the optional `Context.settingsNavigation.openSection(sectionId)` face when present, plus stock rc.8's rendered Settings trigger/dialog/nav semantics.
- Produces: an always-present `openSettings` callback and `QUOTA_CLIENT_INJECT = ['slots', 'locale'] as const`; `CLIENT_INJECT` remains unchanged.

- [x] **Step 1: Write the failing contract and integration assertions**

```ts
expect(CLIENT_INJECT).toEqual(['slots', 'locale', 'sessions'])
expect(QUOTA_CLIENT_INJECT).toEqual(['slots', 'locale'])
expect(inject).toEqual(['slots', 'locale'])
```

- [x] **Step 2: Cover zero-account and populated-account projections**

```ts
it.each([
  ['zero accounts', { ...SNAPSHOT, currentAccountName: null, currentRemainingPercent: null, poolAccountCount: 0, poolRemainingPercent: null }],
  ['populated accounts', SNAPSHOT],
])('opens settings from the %s quota projection', async (_name, snapshot) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(snapshot), { status: 200 })))
  const shell = installStockSettingsShell()
  const b = bench(false)
  apply(b.ctx as never)
  const injected = b.entry()?.inject()
  render(<CodexQuotaFooter wide read={injected.read} openSettings={injected.openSettings} t={t} />)
  fireEvent.click(await screen.findByRole('button', { name: '打开' }))
  expect(shell.triggerClick).toHaveBeenCalledOnce()
  expect(shell.sectionClick).toHaveBeenCalledOnce()
  await b.dispose()
})
```

- [x] **Step 3: Run the focused tests and confirm the injection assertion fails**

Run: `pnpm exec vitest run tests/client-runtime-contract.spec.ts tests/quota-browser-plugin.client.spec.tsx tests/quota-component.client.spec.tsx`

Expected: FAIL because the production contract still hard-depends on `settingsNavigation`, the callback remains optional, and neither zero-account nor populated rendering exposes a working stock-shell action.

- [x] **Step 4: Add the minimum stock-shell compatibility bridge**

```ts
/** Quota registration has no hard dependency on optional Settings deep links. */
export const QUOTA_CLIENT_INJECT = ['slots', 'locale'] as const
```

Always project `openSettings`. Prefer the optional service when it exists; otherwise open the rendered Settings dialog and select the `OpenAI Codex` navigation row using accessible roles and normalized text.

- [x] **Step 5: Re-run the focused tests and confirm they pass**

Run: `pnpm exec vitest run tests/client-runtime-contract.spec.ts tests/quota-browser-plugin.client.spec.tsx tests/quota-component.client.spec.tsx`

Expected: PASS for the runtime contract, both account-state projections, optional-service routing, stock-shell click routing, and request-error behavior.

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
