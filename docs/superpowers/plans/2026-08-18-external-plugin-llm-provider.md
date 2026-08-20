# Standalone DSH Codex provider migration

> Execution note: this plan is for the standalone `dsh-codex-shared-pool`
> repository. It must not edit or depend on
> unpublished workspace packages in `deepseek-harness`.

## Goal

Add the smallest useful LLM slice to the standalone bundle: register the
`openai-codex` route through published DSH LLM extension packages, read the
currently selected Codex CLI access token from the Host-owned `CODEX_HOME`, and
prove that a Harness request reaches the Codex Responses stream. Keep account
selection, OAuth refresh/login, search, image tools, native compaction, and
browser model settings out of this slice.

## Evidence and boundaries

- Reuse `@deepseek-ai/dsh-llm@0.1.0-rc.7` and
  `@deepseek-ai/dsh-llm-pi-ai@0.1.0-rc.7`; do not copy their source.
- Reuse `openaiCodexProvider()` from `@earendil-works/pi-ai@0.82.1` for the
  model catalog and Responses wire implementation.
- Add a narrow API-key auth facade around that provider so the Host can pass a
  request-scoped bearer token without exposing credentials to the browser.
- Read only the standard Codex CLI `auth.json` `tokens.access_token` field;
  never return token material through the HTTP routes or client bundle.
- Treat an absent/malformed token as an actionable unavailable provider state;
  do not leave the LLM route pending forever.

## Files

- `package.json`: add published DSH LLM peers/dev dependencies and pi-ai.
- `src/codex/auth.ts`: validate and read the current Codex access token from
  the first resolved account home.
- `src/codex/adapter.ts`: construct the public `PiAiAdapter` profile, preserve
  the Codex model catalog, and resolve the token per request.
- `src/index.ts`: inject the published `llm` service and register/dispose the
  adapter alongside the existing Host routes.
- `tests/codex-auth.spec.ts`: lock down safe parsing, size bounds, and missing
  token behavior.
- `tests/codex-adapter.spec.ts`: use a mocked SSE response to prove the adapter
  sends a bearer token and emits Harness stream chunks.
- `README.md`: document the new provider route, token ownership, current
  limitations, and the exact focused checks.
- `docs/superpowers/plans/2026-08-18-external-plugin-llm-provider.md`: record
  execution evidence as each task completes.

## Tasks

### 1. Add published runtime contracts

- Add `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-llm-pi-ai`, and
  `@earendil-works/pi-ai` as peer dependencies and development dependencies.
- Keep them external in the bundle so the stock DSH loader supplies one shared
  LLM runtime and the package does not duplicate pi-ai.
- Update the lockfile using the repository's existing pnpm policy.
- Run the current quota tests before changing provider behavior; this is the
  baseline.

### 2. Implement credential-safe token reading (test first)

- Write failing tests for a valid `auth.json`, missing file, malformed JSON,
  missing `tokens`, missing `access_token`, non-string token, and a document
  larger than the bounded read limit.
- Implement `readCodexAccessToken(accountHome)` with no logging of file contents,
  token values, or account paths.
- Implement `resolveCodexAccessToken(accountHomes)` so the first resolved home
  is the active request source and an unavailable token returns `undefined`.

### 3. Construct the `openai-codex` adapter (test first)

- Write a failing adapter test that injects a fake token and mocked SSE fetch,
  then asserts the request uses the Codex Responses endpoint and
  `Authorization: Bearer <token>` while emitted chunks contain the assistant
  text and terminal finish.
- Add `requestProvider()` with an API-key auth resolver over the stock Codex
  provider. This keeps the provider's model catalog and wire code while making
  the Host-owned token an explicit per-request override.
- Build the minimal `ResolvedPiAiProviderProfile` with a stable display name,
  stream timeout, retry policy, empty configured output-cap map, and the wrapped
  provider. Pass no attachment resolver in this slice.
- Export `createOpenAICodexAdapter(accountHomes)` and keep token resolution
  request-scoped so a later account-management slice can replace only that
  resolver.

### 4. Register the adapter in the Host plugin

- Extend the plugin injection contract with `llm` and register the adapter at
  the Cordis effect commit point for `openai-codex`.
- Dispose the registration with the same effect that owns it.
- Preserve the existing quota/status route behavior and ensure missing auth
  does not prevent the Host web service from becoming ready.
- Add a real-composition test or focused loader smoke once the published LLM
  peers are installed; a hand-built adapter test alone is insufficient for
  product-visible registration.

### 5. Update docs and validate the slice

- Document model route `openai-codex`, current-account token ownership, and the
  fact that refresh/login/account switching are deliberately deferred.
- Run focused tests, TypeScript, bundle build, package verification, and an
  isolated stock DSH profile install whose dumped configuration contains the
  external bundle layer; the real-composition registration test checks the
  provider lifecycle separately.
- Append the exact commands and results here; do not claim a real API request
  unless the mocked contract and, when credentials are available, a live
  request both settle.

## Execution evidence

- [x] Published dependency and lockfile update.
- [x] Credential parser tests and implementation.
- [x] Adapter SSE/bearer test and implementation.
- [x] Host registration and real-composition smoke.
- [x] README update.
- [x] Focused checks and package/stock-DSH verification.

Commands and results:

- `./node_modules/.bin/vitest run` — 5 files, 23 tests passed.
- `./node_modules/.bin/tsc -p tsconfig.json --noEmit` — passed.
- `./node_modules/.bin/tsdown` — Host ESM and browser CJS artifacts built.
- `node scripts/verify-package.mjs` — passed.
- `npm pack --ignore-scripts` — package tarball contained the Host/client
  artifacts, declarations, README, license, and `cordis.patch.yml`.
- Published `@deepseek-ai/dsh@0.1.0-rc.7` CLI tarball with an isolated
  `DSH_HOME`: `dsh plugin --profile smoke add <plugin-tarball>` succeeded and
  `dsh --profile smoke --dump-config` exited 0 with the
  `dsh-codex-shared-pool` layer present.

The environment's `pnpm install`/`prepare` path reports
`ERR_PNPM_IGNORED_BUILDS` for pre-existing third-party build scripts, so the
focused checks above use the already-installed direct binaries. No API key or
live Codex request was used.
