# External Plugin Host Quota Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only Host-owned Codex account-pool quota projection to the standalone plugin without adding DSH-specific source patches or exposing credentials to the browser.

**Architecture:** The plugin will reuse the published DSH subprocess service and SDK JSON-RPC line transport, but own the Codex app-server client, account-home selection, quota aggregation, and same-origin HTTP route. The existing browser Settings section will read the safe projection from that route; no `api/remotes` or session-log changes are part of this slice.

**Tech Stack:** TypeScript, Cordis, `@deepseek-ai/dsh-subprocess` `0.1.0-rc.7`, `@deepseek-ai/dsh-sdk-protocol` `0.1.0-rc.7`, `@deepseek-ai/schemastery` `3.18.1`, Node.js `^22.19.0 || >=24.0.0`, Vitest.

## Global Constraints

- Credentials, auth files, Codex-home paths, and subprocess handles stay in Host code.
- Browser JSON contains only account label, percentages, reset time, pool count, and refresh time.
- Account-home order is active-account order; failed accounts remain in the pool count and never become the current account.
- Codex subprocesses use the DSH subprocess service and terminate through its managed handle.
- The quota route is read-only, same-origin, no-store, and returns a safe unavailable projection instead of credential-shaped errors.
- Do not modify a sibling `deepseek-harness` checkout, commit, push, publish, or create a remote repository.

## File Structure

- `src/quota/types.ts`: browser-safe snapshot and Host-only account projection types.
- `src/quota/account-name.ts`: bounded, credential-safe OAuth display-name extraction.
- `src/quota/wire.ts`: minimal Codex app-server JSON-RPC handshake and rate-limit projection.
- `src/quota/provider.ts`: account-home resolution, bounded subprocess reads, aggregation, and cache.
- `src/status.ts`: shared status and quota route paths/types.
- `src/index.ts`: Config schema, Host service injection, status route, and quota route.
- `src/client/index.tsx`: Settings section that displays the safe quota projection.
- `tests/quota.spec.ts`: aggregation, path resolution, token-claim parsing, and JSON-RPC projection tests.
- `package.json`: published runtime and peer dependencies.
- `README.md`: quota configuration, data ownership, and current limitations.

### Task 1: Add quota types and deterministic projection logic

**Files:**
- Create: `src/quota/types.ts`
- Create: `src/quota/account-name.ts`
- Create: `src/quota/wire.ts`
- Create: `tests/quota.spec.ts`

**Interfaces:**
- Produces `CodexQuotaSnapshot`, `CodexAccountQuota`, `openAICodexAccountName`, and `projectCodexAccountQuota`.

- [x] **Step 1: Write failing tests**

Cover ordered deduplicated homes, name-then-email JWT claims, malformed/oversized auth documents, clamped `usedPercent`, `resetsAt` conversion, successful-read averaging, and the rule that an unavailable first account does not become another account.

- [x] **Step 2: Run the focused test**

Run `pnpm exec vitest run tests/quota.spec.ts` and confirm it fails because the quota modules do not exist.

- [x] **Step 3: Implement the pure quota modules**

Port only the display-safe parts of the existing DSH implementation. Keep the app-server wire limited to `initialize`, `account/read`, and `account/rateLimits/read`; reject malformed responses and never return raw JSON-RPC payloads.

- [x] **Step 4: Run the focused test**

Run `pnpm exec vitest run tests/quota.spec.ts`; all quota tests must pass.

### Task 2: Own Host lifecycle and HTTP projection

**Files:**
- Modify: `package.json`
- Modify: `src/status.ts`
- Modify: `src/index.ts`
- Create: `src/quota/provider.ts`

**Interfaces:**
- Consumes the pure quota modules and injected `ctx.subprocess`/`ctx.webServer`.
- Produces `GET /plugins/dsh-codex-shared-pool/quota` with a display-safe `CodexQuotaSnapshot`.

- [x] **Step 1: Add published package dependencies and config schema**

Add `@deepseek-ai/dsh-sdk-protocol` as a runtime dependency, `@deepseek-ai/schemastery` as a runtime dependency, and `@deepseek-ai/dsh-subprocess` as a peer/dev dependency. Add validated `accountHomes`, `refreshIntervalMs`, `requestTimeoutMs`, `disposeGraceMs`, and `codexCommand` fields to the function-plugin `Config`.

- [x] **Step 2: Add the quota provider**

Resolve explicit `accountHomes`, then `DSH_CODEX_ACCOUNT_HOMES`, then `CODEX_HOME`, then `~/.codex`. Cache successful and unavailable snapshots for the configured interval, coalesce concurrent reads, and terminate each managed app-server child in a `finally` path.

- [x] **Step 3: Add the route and safe error behavior**

Register the exact GET route through `ctx.effect()`. Return `200` with the snapshot, `405` for non-GET methods, and a `200` null-valued projection when every configured account is unavailable. Do not include caught error messages in the response.

- [x] **Step 4: Build and inspect the Host artifact**

Run `pnpm run build` and verify that `lib/index.js` imports only published DSH runtime packages and contains no auth-file contents or account-home literals.

### Task 3: Render the safe projection in the browser

**Files:**
- Modify: `src/client/index.tsx`
- Modify: `README.md`
- Modify: `scripts/verify-package.mjs`

**Interfaces:**
- Browser fetches only `PLUGIN_QUOTA_PATH` and renders loading, ready, unavailable, and retry states.

- [x] **Step 1: Extend the Settings component**

Fetch status and quota independently, validate all JSON fields, and display the active account, primary remaining percentage, pool count, total-remaining-over-total-pool percentage, and reset time. Do not render raw Host errors.

- [x] **Step 2: Extend artifact verification and documentation**

Assert the quota path appears in the built Host and Client artifacts. Document `DSH_CODEX_ACCOUNT_HOMES`, `CODEX_HOME`, and the fact that quota is read-only and primary-window-only.

- [x] **Step 3: Run package checks**

Run `pnpm test && pnpm run build && pnpm run verify:package`.

### Task 4: Re-run stock DSH smoke tests

**Files:**
- Modify: `docs/superpowers/plans/2026-08-18-external-plugin-quota.md`

- [x] **Step 1: Pack the standalone tarball**

Run `PLUGIN_SMOKE_ROOT="$(mktemp -d)"; pnpm pack --pack-destination "$PLUGIN_SMOKE_ROOT"` and inspect that quota sources are not included, only built artifacts and declarations.

- [x] **Step 2: Install into a fresh DSH profile**

Use the pinned `@deepseek-ai/dsh@0.1.0-rc.7` CLI and a fresh `DSH_HOME`, then confirm `--dump-config` still contains the bundle row.

- [x] **Step 3: Boot and probe both routes**

Start Web on port `0` with `DSH_CODEX_ACCOUNT_HOMES` pointing at an empty temporary directory and `codexCommand` configured to a missing executable through the profile patch. Confirm status is ready and quota returns a safe null projection without credentials or filesystem paths.

- [x] **Step 4: Record evidence without publishing**

## Execution evidence

- `pnpm exec vitest run tests/quota.spec.ts`: 9 tests passed.
- `pnpm test`: 2 files and 11 tests passed.
- `pnpm run build`: Host ESM, browser lazy-CJS, and declarations built successfully.
- `pnpm run verify:package`: passed; both artifacts contain the quota route and the tarball contains no source files.
- `pnpm pack --pack-destination <temporary-directory>` produced `dsh-codex-shared-pool-0.1.0-alpha.0.tgz`.
- Pinned stock `@deepseek-ai/dsh@0.1.0-rc.7` installed the tarball into an isolated `DSH_HOME`; `--dump-config` showed the `codex-shared-pool` bundle row.
- Stock Web boot on port `55079` with `DSH_CODEX_ACCOUNT_HOMES` pointing to an empty temporary Codex home returned `200` for `/status`, `200` for `/quota` with null account fields and `poolAccountCount: 1`, and `405` for `POST /quota`. No credentials, account-home paths, or caught error text appeared in the response.
- The stock smoke emitted the environment's existing `NODE_TLS_REJECT_UNAUTHORIZED=0` warning and the DSH install reported expected peer warnings for the app's host-provided packages. No DSH source file or worktree was modified.

Update this plan and the final handoff with commands run, output, temporary smoke path, warnings, and the next migration slice. Do not commit or publish.
