# External DSH Plugin Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a standalone `dsh-codex-shared-pool` community repository that stock DeepSeek Harness `0.1.0-rc.7` can install as one Cordis bundle with working Host and browser entries.

**Architecture:** One npm package owns the public installation boundary. Its Host entry registers a secret-free same-origin status endpoint, its browser entry contributes a diagnostic Settings section through the official slot system, and `cordis.patch.yml` mounts the package without changing DeepSeek Harness source.

**Tech Stack:** Node.js `^22.19.0 || >=24`, TypeScript `^6.0.3`, tsdown `^0.22.2`, Vitest `^4.1.8`, Cordis `^4.0.1`, DeepSeek Harness packages `^0.1.0-rc.7`, React `^18.2.0`, pnpm `11.7.0`.

## Global Constraints

- Keep one public repository and one installable npm package named `dsh-codex-shared-pool` during the prototype; publishing may replace it with an npm scope owned by the user.
- Do not modify the `deepseek-harness` fork, its worktrees, or official package sources.
- The Host owns credentials and filesystem access; this bootstrap exposes only a static, secret-free readiness document.
- The browser entry must use the official lazy-CJS module-loader artifact and official `settings.section` slot.
- Pin compatibility to DeepSeek Harness `0.1.0-rc.7` until a stock-install smoke test proves a wider range.
- Do not commit, push, publish, or create a remote repository without a later explicit user request.

---

## File Structure

- `package.json`: package exports, DSH bundle/client declarations, runtime compatibility, build and verification commands.
- `cordis.patch.yml`: inserts the Host plugin into a DSH profile.
- `tsconfig.json`: strict type checking and declaration emission for Host and browser sources.
- `tsdown.config.ts`: Node ESM build plus browser lazy-CJS wrapper expected by DSH's client module loader.
- `src/status.ts`: shared JSON-safe status path, type, and projection.
- `src/index.ts`: Cordis Host plugin and same-origin GET route.
- `src/client/index.tsx`: browser Settings contribution that fetches and renders Host readiness.
- `tests/status.spec.ts`: unit coverage for the shared status projection.
- `scripts/clean-build.mjs`: removes only this package's build output before declaration and runtime compilation.
- `scripts/verify-package.mjs`: verifies built exports, lazy-CJS wrapper, and bundle metadata.
- `README.md`: architecture, local installation, validation, security ownership, and migration status.
- `AGENTS.md`: standalone project workflow and prohibition on edits to the DSH fork.

### Task 1: Establish the standalone package contract

**Files:**
- Create: `package.json`
- Create: `cordis.patch.yml`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `AGENTS.md`

**Interfaces:**
- Consumes: stock `@deepseek-ai/dsh@0.1.0-rc.7` profile plugin management.
- Produces: package exports `.`, `./client`, `./cordis.patch.yml`, and the `dsh.bundle`/`dsh.client` manifest declarations.

- [x] **Step 1: Write the manifest verification script before the manifest**

Create `scripts/verify-package.mjs` to assert that the package name is `dsh-codex-shared-pool`, the bundle patch is `./cordis.patch.yml`, the browser export is `./lib/client.js`, and the built client begins with `window.__ModuleLoader__.load`.

- [x] **Step 2: Run the verifier to establish the failing state**

Run: `node scripts/verify-package.mjs`

Expected: failure because `package.json`, `cordis.patch.yml`, and built artifacts do not exist.

- [x] **Step 3: Add package metadata and compiler configuration**

Declare the exact compatibility versions from Global Constraints, a `prepare` script that builds Git-installed sources, and a `dsh.client.inject` dependency on the stock runtime and Settings UI packages. Configure strict NodeNext TypeScript with DOM support and declaration-only output under `lib/types`.

- [x] **Step 4: Add the bundle patch**

Insert one Loader row with id `codex-shared-pool` and package name `dsh-codex-shared-pool`; do not override the stock model or search provider during this bootstrap.

- [x] **Step 5: Install dependencies**

Run: `pnpm install --ignore-scripts`

Expected: exit 0 with a lockfile and no workspace protocol dependencies; `prepare` remains deferred until the source entries exist in Task 2.

- [x] **Step 6: Review future commit paths**

Review only `package.json`, `pnpm-lock.yaml`, `cordis.patch.yml`, `tsconfig.json`, `.gitignore`, `AGENTS.md`, and `scripts/verify-package.mjs`; do not commit without explicit user authorization.

### Task 2: Prove Host and Client loading surfaces

**Files:**
- Create: `src/status.ts`
- Create: `src/index.ts`
- Create: `src/client/index.tsx`
- Create: `tsdown.config.ts`
- Create: `tests/status.spec.ts`
- Create: `scripts/clean-build.mjs`

**Interfaces:**
- Consumes: Cordis `Context`, optional `webServer` service, browser `ClientContext`, and the official `settings.section` slot.
- Produces: `PLUGIN_STATUS_PATH`, `PluginStatus`, `createPluginStatus()`, Host `apply(ctx)`, and browser `apply(ctx)`.

- [x] **Step 1: Write the status projection test**

Assert that `createPluginStatus()` returns exactly `{ status: 'ready', plugin: 'dsh-codex-shared-pool', host: true }` and produces a fresh object on each call.

- [x] **Step 2: Run the focused test to establish the failing state**

Run: `pnpm exec vitest run tests/status.spec.ts`

Expected: failure because `src/status.ts` does not exist.

- [x] **Step 3: Implement the shared projection and Host route**

Register a GET-only exact route at `/plugins/dsh-codex-shared-pool/status`. Return JSON with `cache-control: no-store` and `x-content-type-options: nosniff`; return status 405 for other methods. Own registration disposal through `ctx.effect()`.

- [x] **Step 4: Implement the browser Settings section**

Register `settings.section` id `codex-shared-pool`. Render explicit loading, ready, unavailable, and recoverable-error states; fetch only `PLUGIN_STATUS_PATH`; abort the request on component unmount.

- [x] **Step 5: Reproduce the official client artifact format**

Build Host code as Node ESM. Build the browser entry as CJS with React, React JSX runtime, Cordis, and official platform modules external, then wrap it with:

```js
window.__ModuleLoader__.load({ id: "dsh-codex-shared-pool", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
// bundled client
return module.exports; } });
```

- [x] **Step 6: Run focused tests and build**

Run: `pnpm exec vitest run tests/status.spec.ts`

Expected: PASS.

Run: `pnpm run build`

Expected: exit 0 and produce `lib/index.js`, `lib/client.js`, `lib/types/index.d.ts`, and `lib/types/client/index.d.ts`.

- [x] **Step 7: Verify package artifacts**

Run: `node scripts/verify-package.mjs`

Expected: `package verification passed`.

- [x] **Step 8: Review future commit paths**

Review only the Task 2 source, test, build configuration, and generated lockfile changes; do not commit without explicit user authorization.

### Task 3: Verify installation against stock DSH

**Files:**
- Create: `README.md`
- Modify: `scripts/verify-package.mjs`

**Interfaces:**
- Consumes: built local package and published `@deepseek-ai/dsh@0.1.0-rc.7` CLI.
- Produces: reproducible installation commands and an evidence-backed bootstrap handoff.

- [x] **Step 1: Check the publish payload**

Run:

```sh
PLUGIN_SMOKE_ROOT="$(mktemp -d)"
pnpm pack --pack-destination "$PLUGIN_SMOKE_ROOT"
```

Expected: one tarball containing only README, license, patch, package metadata, Host/Client JS, source maps, and declarations.

- [x] **Step 2: Install into an isolated stock profile**

Create a validated temporary `DSH_HOME`, then run the published CLI with:

```sh
DSH_HOME="$PLUGIN_SMOKE_ROOT/dsh-home" pnpm dlx @deepseek-ai/dsh@0.1.0-rc.7 plugin --profile web add "$PLUGIN_SMOKE_ROOT/dsh-codex-shared-pool-0.1.0-alpha.0.tgz"
```

Expected: exit 0 and the profile manifest lists `dsh-codex-shared-pool` as a bundle.

- [x] **Step 3: Inspect the composed profile without booting it**

Run:

```sh
DSH_HOME="$PLUGIN_SMOKE_ROOT/dsh-home" pnpm dlx @deepseek-ai/dsh@0.1.0-rc.7 --profile web --dump-config
```

Expected: output contains Loader row id `codex-shared-pool` with package name `dsh-codex-shared-pool`.

- [x] **Step 4: Document the verified workflow**

Document local checkout installation, tarball installation, GitHub `prepare` behavior, architecture, current bootstrap limitation, and the rule that credentials never cross to the browser.

- [x] **Step 5: Final checks**

Run: `pnpm test && pnpm run build && pnpm run verify:package`

Expected: all commands exit 0.

- [x] **Step 6: Report state without publishing**

Report the standalone repository path, current branch, uncommitted files, commands run, stock-install result, and the next migration slice. Do not commit, push, publish, or create a GitHub repository without explicit user authorization.
