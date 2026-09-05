# Quota installation reliability implementation plan

**Goal:** Restore local quota reads without machine-specific plugin configuration, keep Team quota independent of usage reporting, and catch incompatible Team schemas before serving requests.

**Architecture:** Keep proxy discovery and database validation on the Host. Use the operating system's explicit HTTP/HTTPS proxy settings only when no proxy environment override exists. Render capacity from the overview response independently of the usage ledger.

**Tech Stack:** TypeScript, Undici, React, PostgreSQL, Vitest; stock DSH 0.1.0-rc.8.

## Constraints

- No credentials or machine-specific paths in committed files.
- Do not change runtime database role permissions or invent subscription data.
- Existing environment proxy settings, including explicit empty settings, take priority.
- Keep local connections out of automatically discovered proxies.

## Steps

- [ ] Add failing network tests in `tests/network.spec.ts`: macOS discovery without overrides; explicit empty and nonempty environment overrides; other platforms; malformed/disabled proxy settings; bypass localhost.
- [ ] Implement bounded macOS `scutil --proxy` discovery in `src/system-proxy.ts`, consumed by `src/network.ts`. Update proxy labels and installation documentation to describe system proxy fallback and server environment configuration.
- [ ] Add a failing DOM test in `tests/team-settings-workspace.client.spec.tsx` with a rejected usage API and a valid Codex capacity. Change `src/client/team/TeamSettings.tsx` to preserve the capacity and subscription.
- [ ] Add a failing PostgreSQL test where migration history is current but the usage columns are absent. Validate required usage columns in `src/team/postgres-store.ts` after initialization and give an actionable schema error. Document migration-first upgrades of Host and Broker together.
- [ ] Run focused Vitest tests, build, and package verification; pack and install into an isolated DSH home. Obtain an independent change-scoped review, push a draft PR, and merge only after checks pass.
- [ ] Back up 3181, warn before restart, deploy the verified package, and verify actual quota responses. Inspect the remote Team service where access permits; report any remote access blocker precisely.
