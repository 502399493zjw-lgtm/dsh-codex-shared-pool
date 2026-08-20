# Account Routing Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the active Codex account an explicit, stable Host-owned routing decision, carry its non-secret account id in the standard LLM replay envelope, and expose a read-only browser account directory without introducing custom DSH session events.

**Architecture:** Keep `accountHomes` backward-compatible and ordered. Add optional stable `accountIds` plus `activeAccountId` to the Host config. Resolve and validate account ids beside absolute homes, select the configured active account (falling back to the first home), and pass only that account's token to the existing stock pi-ai Codex provider. Wrap the adapter stream at the terminal `finish` chunk and merge `{ codexAccountId }` into the standard `ReplayEnvelope.response`; no token, path, or credential data enters the browser or session content. Expose the selected id and safe display name in the existing Host status projection, with tests covering validation, selection, replay evidence, and package/build checks.

**Tech Stack:** TypeScript, Cordis, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-llm-pi-ai`, pi-ai, Vitest, pnpm.

## Global Constraints

- Work only in the standalone plugin repository and keep stock DSH core untouched.
- Preserve existing `accountHomes` behavior and the first-home default when no ids are configured.
- Never expose account home paths, OAuth tokens, auth-file contents, or account-pool scheduling state to the browser.
- Do not implement OAuth login/refresh, automatic failover, or process lifecycle ownership in this slice.
- Do not commit, push, publish, or create remotes.

---

## Task 1: Add pure account identity and selection helpers (TDD)

**Files:** `src/codex/accounts.ts`, `tests/codex-accounts.spec.ts`, `src/quota/provider.ts`

- [x] Write failing tests for default ordinal ids, explicit id validation, duplicate ids, and active-id fallback to the first configured account.
- [x] Implement a pure resolver returning frozen `{ id, home }` records from configured homes and optional ids.
- [x] Keep absolute-home/environment precedence in `resolveCodexAccountHomes`; only the identity layer decides ids and selection.
- [x] Run the focused account tests and typecheck.

## Task 2: Route the selected account and attach replay evidence (TDD)

**Files:** `src/codex/adapter.ts`, `tests/codex-adapter.spec.ts`, `src/index.ts`

- [x] Add an adapter account descriptor and a process-scoped selector.
- [x] Preserve the existing `openai-codex` provider id and model catalog while resolving the selected account's token.
- [x] Decorate only successful terminal `finish` chunks with a merged replay envelope response containing the stable account id; preserve existing pi-ai replay data and all non-finish chunks.
- [x] Extend tests to assert the selected account receives the bearer token and the finish chunk records only the stable id.
- [x] Wire config defaults through `apply` without changing the existing one-home install path.

## Task 3: Publish a safe status projection and documentation

**Files:** `src/status.ts`, `src/index.ts`, `tests/status.spec.ts`, `src/client/index.tsx`, `README.md`

- [x] Add nullable `currentAccountId` to the status projection; the existing quota projection continues to carry the safe `currentAccountName`, with no paths or secrets.
- [x] Update the browser panel to render the active account id/name while retaining graceful handling of older Host responses.
- [x] Document `accountIds` and `activeAccountId`, the fallback rules, and the fact that selection is process/config scoped rather than automatic pool scheduling.
- [x] Add focused projection tests and run the full validation suite.

## Task 4: Verification and handoff

**Files:** `package.json`, `pnpm-workspace.yaml`, `docs/verification/` only if a new report is needed

- [x] Run the repository's Vitest command, `tsc -p tsconfig.json --noEmit`, and `pnpm run build`.
- [x] Run `pnpm run verify:package` after making the dependency build policy explicit; retain the direct verifier as the package assertion source.
- [x] Inspect the final Git status and run an isolated pinned stock-DSH tarball install/config/Web route smoke.

## Task 5: Add a read-only account directory projection

**Files:** `src/codex/directory.ts`, `src/status.ts`, `src/index.ts`, `src/client/index.tsx`, `tests/codex-directory.spec.ts`, `README.md`

- [x] Project configured account ids and optional OpenAI profile names into a browser-safe Host response.
- [x] Mark the process-selected account without exposing account-home paths, auth files, or credentials.
- [x] Add graceful null-name and route-failure behavior plus browser rendering and focused tests.
- [x] Verify the new route in an isolated pinned stock DSH Web boot.

## Task 6: Persist the selected account through stock DSH Settings

**Files:** `src/codex/settings-contract.ts`, `src/codex/settings.ts`, `src/index.ts`, `src/quota/provider.ts`, `src/client/index.tsx`, `tests/codex-settings.spec.ts`, `README.md`

- [x] Register only `activeAccountId` in the Host Settings namespace; keep account homes, ids, tokens, and auth files in Host profile/config state.
- [x] Layer the user setting over the profile value and declare `applies: 'restart'`, so a saved browser choice is deterministic on the next process start.
- [x] Bind the browser selector through the stock `settingsScope` service and keep a graceful status-only fallback when Settings is unavailable.
- [x] Invalidate the quota current-account cache whenever the resolved startup selection changes, without introducing live runtime switching.
- [x] Add contract tests and rerun package/build/stock-Web verification.

## Execution evidence

- `pnpm test`: 8 files, 34 tests passed.
- `./node_modules/.bin/tsc -p tsconfig.json --noEmit`: passed after adding the restart-scoped Settings contract.
- `pnpm run build`: Host ESM, browser lazy-CJS, and declarations built successfully with the Settings namespace bundled only into the Host and browser contract.
- `pnpm run verify:package`: passed.
- A fresh pinned stock `@deepseek-ai/dsh@0.1.0-rc.7` Web boot at `127.0.0.1:3099` loaded the rebuilt tarball from `/tmp/dsh-codex-settings-persist.j6Syae`, retained the `codex-shared-pool` bundle row, and returned `200` for status, quota, and accounts. Before the update, status selected `account-1`; the stock `settings.update` API saved only `activeAccountId: account-2` in the plugin namespace and returned `applies: restart` with revision `1`. The same running process continued to report `account-1`, while a fresh process reported `account-2` in status and marked only that directory active in the accounts endpoint. The empty-home responses remained secret/path-free; Settings registration produced no Host startup error.
- The adapter test also feeds the stream through DSH's `BlockAssembler` and confirms the stable account id survives the canonical replay-state assembly.
- The quota test confirms an explicitly selected account supplies the current quota fields while pool count and aggregate percentage remain pool-wide.
- `npm pack --ignore-scripts`: tarball contained only package metadata, README/license, patch, built Host/client artifacts, source maps, and declarations; no source files or credentials.
- Final Git state: local branch `codex/bootstrap`, no commits and no remotes; the standalone project files remain untracked as initialized. No stock DSH core worktree was edited.
