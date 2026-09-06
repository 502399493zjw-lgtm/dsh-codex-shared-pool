# Docker member admission and usage verification

## Change and reproduced causes

The first-session body and automatic title compete for one shared slot. In a real Chrome run against the existing public Team gateway, they started 7 ms apart. The title lasted about 8.45 seconds; the body received HTTP 429 before the title finished. The previous five-second admission window was too short. Admission now waits up to 60 seconds, remains abortable, preserves the concurrency limit, and never replays a Provider request.

Real Provider responses contained valid input, cached-input, and output usage but had no Content-Type header. The gateway previously ignored those bytes for usage observation. Missing-header responses now use the existing bounded SSE and JSON parsers. Explicit unsupported media types, invalid counters, and missing cache counters remain unmeasured. Response bytes and headers are forwarded unchanged.

The public deployment was inspected read-only: its gateway, admission, and credit source matched the corresponding baseline source. It was not changed by this task. Invitation-conflict UX is outside this change.

## Automated and package evidence

- Regression tests failed before implementation for admission beyond five seconds and usage without Content-Type.
- Focused Vitest run: admission, gateway, credits, remote credentials; 4 files and 59 tests passed.
- `pnpm test`: 85 Vitest files passed, 1 skipped; 1,174 tests passed, 28 skipped. The additional Node test suite passed all 33 tests.
- `pnpm run build` and `pnpm run verify:package` passed.
- Tests cover an eight-second occupied slot, 60-second deadline, cancellation, chunk-split SSE and JSON with/without headers, malformed usage, missing cache counters, unsupported media types, oversized payloads, and unchanged forwarding bytes.
- `pnpm pack --pack-destination artifacts/member-fix` produced the unpublished 0.1.1 tarball, SHA-256 `644da5f904f84b70122c5b4c8cf30ace0c1a38bac942ad699f27635f813bf865`.

## Isolated stock installation and real Provider evidence

The tarball was installed with the pinned published stock DSH rc.8 CLI in the existing isolated Docker member on loopback port 3182. The first installation attempt encountered pnpm's store-directory mismatch; repeating with the existing store directory succeeded. The installed Host bundle matched the built bundle, SHA-256 `d18d48baf6804a497bd39373d0909511ad7e8dd835a5b2495e70e9a3d4b87d67`.

Because the public gateway was not deployed, a temporary test preload exercised the installed gateway with an in-memory member, synthetic quota and one local shared slot. Its broker forwarded real requests through the existing public member identity to the real Provider. It created no remote member or credential. This verifies the installed gateway with real response streams, not the public deployment's new behavior or its persistent ledger.

- Chrome body/title started 5 ms apart, both received HTTP 200, and maximum upstream concurrency stayed at 1. The body displayed `DOCKER_FIXED_OK`; the automatic title displayed successfully.
- The body supplied 6,140 input and 56 output tokens (6,196 total) to settlement. The title client closed its stream early; its settlement was cancelled and unmeasured. It is not counted as a complete usage-verification sample.
- A separate pair of fully drained real streams both returned HTTP 200. The first held the local slot for about 5.6 seconds; the second started upstream only after release. Maximum upstream concurrency was 1.
- First complete stream: Provider input 24, cached input 0, output 178, total 202; local ledger total 202, weighted Credits 736.
- Second complete stream: Provider input 18, cached input 0, output 5, total 23; local ledger total 23, weighted Credits 38.

The original member entry point was restored and only the isolated member container was restarted. Chrome retained the successful session and title after restart. The installed tarball remains; the temporary gateway is no longer active. Existing identity, configuration, and volumes were retained. No Docker daemon, port 3197, public deployment, or npm release was changed.

## Remaining limits

The public server still requires deployment of this Host fix. Installing the member tarball alone cannot change server-side admission or public ledger observation. No new OAuth flow was performed; existing Provider authentication was reused. Real title cancellation remains unmeasured when the client closes before final usage. A request may still receive a capacity error after the bounded 60-second wait.
