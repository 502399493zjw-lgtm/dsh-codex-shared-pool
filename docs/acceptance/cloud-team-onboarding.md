# Default cloud Team onboarding acceptance

Date: 2026-09-07. Target: stock DSH `0.1.2-rc.1`, Cordis `4.0.2`.

## Behavior

- A client with omitted `teamClient` configuration offers creation and joining at the public cloud endpoint.
- The default endpoint uses its own credential reference and pending journals; legacy credentials are neither migrated nor forwarded.
- Until a membership credential exists, model requests retain local account routing. Joining or disconnecting takes effect on the next request. Concurrent requests keep their selected route and bearer.
- Team credential errors, HTTP errors and connection errors do not trigger local fallback. A local-only Host can still run without the optional DSH credentials service; losing a previously available credentials service fails closed.
- Explicit client configuration and Team server mode retain their previous behavior.
- Connection screens show the configured origin and explain local versus remote service recovery. The configuration hint uses `teamClient.baseUrl`.

See [connection and recovery guidance](../team-connection.md) for existing installations.

## Local verification

Focused regression tests were run before their implementations, including configuration defaults, automatic adapter selection, connection UI and stock-install status. A later full integration run caught the optional credentials-service regression; that behavior now has real Cordis lifecycle coverage.

Executed successfully after the final runtime fix:

```sh
pnpm test
pnpm run build
pnpm run verify:package
pnpm pack --pack-destination artifacts/cloud-team-onboarding
node scripts/smoke-stock-compat.mjs \
  --tarball artifacts/cloud-team-onboarding/dsh-codex-shared-pool-0.1.4.tgz \
  --dsh-entry <published-dsh-install>/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --artifacts artifacts/cloud-team-onboarding/stock-smoke-final
git diff --check
```

- Vitest: **92 files passed, 1 skipped; 1,307 tests passed, 31 skipped**. The skipped tests require separately provisioned environments; they are not counted as passes.
- Prototype tests: **33 passed**.
- Build and package-format verification: passed. The upstream UI package's missing source-map warning does not fail tests.
- Packed installation: passed using the published CLI with the smoke script's pinned entry digest, an isolated home/profile and an ephemeral port. Authenticated HTTP probes verified four plugin routes, the client boot manifest, and fresh Team status: enabled, writable credentials, no existing membership or pending join, and the public cloud origin.
- Independent change-scoped review: the optional-service regression was the only blocking finding and was fixed; final source review found no blocking findings. The reviewer independently ran **440 tests across 9 files**.

## Evidence boundaries

Unit and DOM tests use controlled requests. The stock smoke validates package installation, configuration composition and authenticated HTTP/manifest behavior; it does not execute the browser UI or complete provider OAuth.

The existing 3181 environment's connection was separately restored to the cloud before this implementation. Authenticated Team management routes and a real cloud native Responses request passed during that recovery. That establishes the restored cloud connection, not acceptance of a new provider OAuth flow or newly created Team.

This candidate retains package version `0.1.4` for local verification only. It does not replace the immutable published npm `0.1.4`. Publication needs a separately authorized versioned release. No shared cloud deployment is part of this change.
