# Default cloud Team onboarding implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. These skills are unavailable in this session; execute with the available collaboration tools under the user's authorization to continue.

**Goal:** Fresh installations can create or join a cloud Team without editing a server URL, and connection failures identify the configured destination and useful recovery steps.

**Architecture:** Resolve one effective Host-only Team configuration for management and model routing. An omitted configuration selects the existing public cloud with a separate, endpoint-scoped credential reference; local inference continues until that reference holds a Team credential. Explicit configurations retain their existing behavior. Select and freeze the local or Team adapter and credential per request without retrying a failed Team request through local OAuth.

**Tech Stack:** TypeScript, Cordis 4.0.2, stock DSH 0.1.2-rc.1, React, Vitest, pnpm 11.7.0.

## Global Constraints

- Work on `codex/cloud-team-onboarding`; preserve unrelated README work.
- Host owns endpoints, credentials, filesystem access and network requests. Browser receives only the existing safe server-origin projection.
- Preserve explicit disabled and self-hosted configuration. Team server mode does not implicitly become a cloud client.
- Never reuse the legacy unscoped Team credential or pending journals for the newly selected default endpoint.
- Do not publish npm packages or deploy the shared cloud as part of this implementation.
- Required verification: focused failing tests, focused passing tests, build, package verification, packed installation in isolated stock DSH, independent change-scoped review and CI before merge.

### Task 1: Resolve default configuration and preserve credential boundaries

**Files:** `src/team/client.ts`, `src/index.ts`, `tests/team-client.spec.ts`, `tests/team-management-routes.spec.ts`, `tests/team-client-composition.spec.ts`.

**Interfaces:** `resolveTeamClientConfig(config?: TeamClientConfig, teamHostEnabled?: boolean): { config: TeamClientConfig; automatic: boolean }`; `resolveOptionalTeamClientApiKey(config, credentials): Promise<string | undefined>`. Only an absent credential returns undefined; invalid values and read failures reject. `resolveTeamClientApiKey` keeps strict behavior.

- [x] Write regression assertions for schema-parsed omitted configuration, explicit disabled/custom configuration, server mode, and scoped credentials:
  ```ts
  const resolved = resolveTeamClientConfig(TeamClientConfigSchema({}))
  expect(resolved.automatic).toBe(true)
  expect(resolved.config.enabled).toBe(true)
  expect(resolved.config.apiKeyRef).not.toBe(String(DEFAULT_TEAM_CLIENT_API_KEY_REF))
  expect(resolveTeamClientConfig({ enabled: false }).automatic).toBe(false)
  expect(resolveTeamClientConfig(undefined, true).config.enabled).not.toBe(true)
  ```
- [x] Run `pnpm exec vitest run tests/team-client.spec.ts` and confirm the new contract fails before implementation.
- [x] Keep schema fields optional; only a wholly omitted configuration and a non-Team-Host select `https://47.84.77.193/plugins/dsh-codex-shared-pool/team`. Derive a new cloud credential ref from its canonical URL. Pass the same effective configuration to management routes and the adapter.
- [x] Test status/create/join using the effective configuration and controlled transport; assert the legacy credential survives unchanged and is never forwarded.
- [x] Run focused client and management tests. Deliver the configuration and routing changes together after Task 2 passes.

### Task 2: Request-scoped automatic local/Team routing

**Files:** `src/adapter.ts`, `tests/auto-team-adapter.spec.ts`, relevant existing Team/local-routing/prepared-call tests.

**Interfaces:** Extend `OpenAICodexTeamClientAdapterOptions.resolveApiKey` to `() => Promise<string | undefined>` and add `useLocalWhenUnconfigured?: boolean`. Only implicit cloud configuration sets the latter to true.

- [x] Add failing direct/prepared-call tests that select local for undefined and Team for a real bearer, then change the resolver between requests to cover join/disconnect. Verify local allocation occurs only on local requests.
- [x] Add concurrent request tests: freeze each selected bearer; a key change cannot pair one request's key with another route. Assert invalid/read-error/HTTP 401/429/transport errors do not trigger local fallback.
- [x] Run `pnpm exec vitest run tests/auto-team-adapter.spec.ts` to record the expected failure.
- [x] Compose the existing local and Team adapters with independent Responses runtimes. At stream start resolve once; `undefined` selects local, otherwise use the Team adapter with that request's bearer. Preserve prepared model and image policy, compaction, local WebSocket continuation, and Team SSE.
- [x] Run Team adapter, local-routing, prepared-image and compaction regression tests. Deliver the focused Host behavior with Task 1.

### Task 3: Actionable connection display

**Files:** `src/client/team/TeamSettings.tsx`, `src/client/team/locales.ts`, `tests/team-settings-workspace.client.spec.tsx`.

**Interfaces:** Consume existing `TeamManagementStatus.serverOrigin` only. Do not introduce a browser endpoint setter or send keys to the browser.

- [x] Add DOM regressions for unavailable loopback and HTTPS destinations; verify destination and recovery copy are visible, retry preserves the credential, and errors do not suggest creating a replacement Team.
- [x] Run the changed DOM tests and confirm failure before implementation.
- [x] Display the configured origin on joining/connection-failure states. Explain a loopback endpoint belongs to this computer and needs its local service; cloud users must correct the Host endpoint. Explain that creating another Team does not repair connectivity. Correct the Chinese disabled hint to `teamClient.baseUrl` and include the explicit enable flag.
- [x] Run the Team settings DOM/contract/responsive tests and include the focused UI changes with the Host fix.

### Task 4: Stock install and delivery

**Files:** `scripts/smoke-stock-compat.mjs`, `tests/stock-compat-smoke.spec.ts`, `docs/acceptance/cloud-team-onboarding.md`.

- [x] Extend the stock HTTP probe to check authenticated same-origin `/plugins/dsh-codex-shared-pool/team-client/status`; default installation must report enabled, no configured key, and the expected cloud origin. Update probe mocks and prove the regression fails first.
- [x] Run focused tests, `pnpm run build`, `pnpm run verify:package`, then pack and run the existing isolated stock smoke script with the resulting tarball and pinned published DSH CLI.
- [x] Record actual evidence and limits: unit/DOM tests, package checks and stock HTTP smoke are distinct from browser/OAuth/cloud inference acceptance.
- [ ] Push a focused branch, create a draft PR against main, obtain an independent diff review, fix blocking findings and rerun affected checks. Mark ready and merge only once review and required CI pass.
- [ ] Report merge state and that published 0.1.4 remains unchanged until a separately authorized release.
