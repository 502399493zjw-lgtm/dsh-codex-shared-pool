# DSH 0.1.2-rc.1 compatibility

This migration targets the published DSH `0.1.2-rc.1` and Cordis `4.0.2`. It does not change DSH core or publish a new npm plugin release. The plugin on npm at `0.1.3` still targets the previous DSH baseline; use a tarball built from this source until a release is published.

## Failure and changes

The Windows startup failure is an API compatibility failure: the old Host bundle imports `settingsNamespace`, which the new `dsh-settings` package does not export. The same incompatible bundle can fail on other operating systems.

- Replace that import with the plugin-owned settings namespace.
- Migrate to `LlmRuntime.prepareCall`, retaining the prepared model/profile snapshot while applying account allocation, cancellation, compaction and request receipts.
- Resolve prepared image attachments through the Host filesystem boundary and preserve the request image limits.
- Replace removed browser package entry points and declare the remote services used by the model-directory resolver.
- Pin official dependencies, update the Docker host runtime and preserve executable metadata for fresh frozen installs.
- Add Windows and Linux stock-install CI using the official CLI and an isolated `DSH_HOME`.

## Reproducible checks

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm run build
pnpm run verify:package
pnpm pack --out artifacts/stock-plugin.tgz
npm install --prefix artifacts/stock-dsh --registry https://registry.npmjs.org/ --before 2026-09-04T00:00:00.000Z --ignore-scripts --no-audit --no-fund @deepseek-ai/dsh@0.1.2-rc.1
node scripts/smoke-stock-compat.mjs --tarball artifacts/stock-plugin.tgz --dsh-entry artifacts/stock-dsh/node_modules/@deepseek-ai/dsh/lib/bin.js --artifacts artifacts/stock-smoke-evidence
```

The snapshot bounds upstream sibling dependencies in addition to pinning the CLI release. The smoke verifies anonymous HTTP 401, the official launch-token exchange, its HttpOnly cookie, plugin routes, boot manifest dependencies and the served client bundle. Tokens and cookies are not retained in evidence. It cleans up its own processes and home directory.

## Acceptance evidence

Validation was performed on 2026-09-06; CI evidence is attached to [PR #99](https://github.com/502399493zjw-lgtm/dsh-codex-shared-pool/pull/99).

| Level | Evidence |
| --- | --- |
| Unit and DOM | Full suite, including prepared calls, explicit authentication, image access, cancellation and browser contracts. |
| Package | Build, format verification and packed artifact installation. |
| Stock installation | macOS / Node 26 and Windows + Linux / Node 24: official DSH installation, startup, authentication, manifest and routes passed. |
| Local Web instance | Port 3181 upgraded; stored accounts, live quota, historical sessions and Team settings remained accessible. |
| Real Team request | Existing Team configuration completed a browser request with GPT-5.4 mini and returned the requested acceptance text; no tools were called. |
| Real local pool | Published `LlmRuntime.prepareCall` completed a GPT-5.4 mini request through local credentials. An exhausted account triggered `quota_fallback` and a successful receipt; a follow-up returned `LOCAL_POOL_OK`. |

New provider OAuth authorization was not repeated. Existing authorized credentials were reused. The Windows stock job verifies installation and startup; interactive Windows browser and provider login are separate acceptance levels.

The local upgrade retained a rollback backup. Old DSHMarket, Model Retry and Chat Fold bundles were temporarily disabled while their installed packages and configuration were preserved; their upgrades are outside this plugin migration.

The credential scanner reported variable-reference matches in source and sourcemaps. Manual change-scoped review found no added credential literals or machine paths; this is not recorded as an automated scanner pass.
