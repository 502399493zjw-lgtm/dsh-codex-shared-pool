# Full DSH Codex plugin independent packaging

## Objective

Package the complete DSH Codex bundle as an independently publishable Cordis
plugin. The standalone package must preserve the original bundle's behavior
while keeping DSH core untouched: OAuth profile login/refresh/activation,
quota reads, global priority and automatic failover, Codex Responses streaming,
web search, image tools, network diagnostics, settings persistence, sidebar,
and TUI commands.

## Baseline and boundaries

- Source of truth: `deepseek-harness/packages/bundle/dsh-codex_shared_pool`.
- Target: this standalone `dsh-codex-shared-pool` repository.
- DSH core is not edited; only public DSH runtime contracts are peer
  dependencies of the standalone package.
- Workspace-only quota code is replaced by a vendored/adapted implementation
  with the same observable API, so publishing does not depend on a monorepo
  workspace package.

## Implementation sequence

1. Inventory the complete bundle and map every import to a public peer, a
   bundled dependency, or a vendored adapter. Record unsupported imports as
   explicit blockers instead of silently dropping features.
2. Migrate Host runtime modules: profile credential store, OAuth orchestration,
   usage parsing, quota service, network status, Responses runtime, model
   capabilities, web search, image generation/read-image tools, and TUI.
3. Integrate ordered account allocation into the profile store and adapter:
   preferred profile first, session stickiness, model-level quota checks, and
   automatic rotation after quota/auth exhaustion with auditable selected
   profile metadata.
4. Migrate the complete browser settings UI and sidebar. Keep the original DSH
   visual primitives and flows; add only the standalone route prefix and
   priority/failover controls required by this package.
5. Update package exports, peer/dev dependencies, Cordis patch, README, and
   AGENTS instructions. Ensure no source import points at a workspace-only
   package or the DSH core repository.
6. Verify with typecheck, unit tests, package verification, packed-tarball
   inspection, and a runtime DSH smoke test covering login/profile routes,
   quota display, priority selection, failover, search/image registration,
   and settings persistence.

## Acceptance checklist

- [x] Every complete-bundle source capability is present or explicitly
      replaced with a documented public-contract adapter. The standalone test
      inventory now covers every complete-bundle baseline test filename;
      browser and Loader tests use published DSH `0.1.0-rc.7` contracts instead
      of importing unpublished monorepo source modules.
- [x] OAuth login, refresh, logout, profile rename/remove/activate, and
      concurrent-login cancellation work through HTTP and TUI surfaces.
      Evidence: `src/auth-routes.ts`, `src/tui.ts`, and `tests/tui.spec.ts`;
      refresh is provider-driven and atomically persisted by the scoped store.
- [x] Usage exposes Codex, Spark, individual-limit, reset-time, and per-model
      buckets; quota errors do not make an exhausted account appear healthy.
      Evidence: `tests/usage.spec.ts`, `tests/quota.spec.ts`, and
      `tests/quota-component.client.spec.tsx` cover provider projection,
      conservative model buckets, reset evidence, unavailable metadata, and
      the Browser projection.
- [x] Priority and automatic failover are global to all Codex requests, with
      session stickiness and model-level quota awareness. Evidence:
      `tests/account-allocation.spec.ts`, `tests/store.spec.ts`, and
      `tests/model-capabilities.spec.ts` cover ordered selection, Codex/Spark
      separation, session rebinding, explicit priority, and model eligibility.
- [x] Search, imagegen, read_image enhancement, Responses compaction/context
      reuse, Fast mode, network diagnostics, and TUI are registered. Evidence:
      `tests/search.spec.ts`, `tests/imagegen.spec.ts`,
      `tests/read-image-enhancement.spec.ts`, `tests/codex-compaction.spec.ts`,
      `tests/response-runtime.spec.ts`, `tests/network.spec.ts`, and
      `tests/tui.spec.ts` exercise those Host/runtime surfaces; Browser Fast and
      response preferences are covered by their client tests.
- [x] Browser settings and sidebar retain the original DSH structure and
      visual primitives, including account management and advanced toggles.
      Account rename is wired through the exact-profile Host route and covered
      by `tests/client-profile-settings.spec.ts`. A packed tarball installed in
      a fresh stock DSH `0.1.0-rc.7` Web profile passed the Settings flow and
      persisted-label assertions; the local 960×540 GIF under
      `artifacts/ui/2026-08-20-profile-rename/` passed independent visual
      review. The evidence uses a test-only OAuth-shaped profile and does not
      claim a real OpenAI request or model turn.
- [x] Standalone package builds and packs without a monorepo workspace
      dependency; DSH core remains outside this repository and was not edited.
      Evidence: `tests/project.spec.ts` and `tests/loader-composition.spec.ts`
      pass; the complete 2026-08-20 gate passed 51 test files (352 tests, plus
      the separately gated PostgreSQL suite), build, package verification, and
      packed-tarball inspection. That tarball installed into a fresh stock DSH
      `0.1.0-rc.7` Web profile, composed the `codex-shared-pool` Loader row,
      started successfully, and passed the root, auth-status, profiles, and
      quota HTTP smoke. This evidence does not claim a real OpenAI OAuth or
      model request.
