# Team MVP Phase Two Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the invitation-only Team MVP with repeatable two-contributor live-routing evidence, a stock-DSH Team-client acceptance run on port 3181, and release-quality security, packaging, and cleanup evidence.

**Architecture:** Keep one central server for many tenant-isolated Teams. The central Team Host owns control-plane operations, PostgreSQL owns durable routing and metadata-only usage state, and the private Credential Broker alone owns contributed OAuth credentials and fixed-endpoint provider access. Each member's local DSH holds only that member's Team API key and sends Codex model traffic to the Team gateway. Phase two validates and closes this existing architecture; it does not replace it.

**Tech Stack:** TypeScript, Node.js 24, React 18, Cordis 4.0.1, stock `@deepseek-ai/dsh@0.1.0-rc.8`, Vitest, PostgreSQL 17, Docker Compose, pnpm 11.7.0.

## Global Constraints

- Keep the package on published DSH/Cordis extension points; do not patch DSH core or a DSH fork.
- Keep local Shared Pool and Team Pool semantics distinct: the three local profiles already accepted on port 3181 are not automatically Team contributions.
- Require a separate device-code OAuth for every contributed account. Never import or copy `auth.json` and never expose access/refresh tokens to the Browser, Team Owner, test artifacts, or logs.
- Preserve the fixed Team MVP policy: requester-owned account first, then healthy Team capacity; session stickiness; contributor reserve/request-cap/model controls; fixed RPM/concurrency/circuit safeguards; Team emergency pause; metadata-only audit.
- Do not add per-member daily/weekly consumption budgets, cash settlement, contribution credits, stranger matching, or cross-Team scheduling.
- Treat provider percentage/reset signals and local request counts as conservative capacity evidence, not token, price, or exact subscription-consumption measurement.
- Use `http://127.0.0.1:3181` for every browser-facing stock-DSH acceptance run. A private Team Edge/Broker/PostgreSQL listener may use its deployment port because two processes cannot bind the same socket, but user-visible browser evidence must stay on 3181.
- Human OAuth completion is an explicit pause point. Automation may display the device URL/code and poll status, but must not read browser cookies, copy provider tokens, or claim an account was authorized before the Broker confirms it.
- Every live gate must use fixed low-volume prompts, bounded timeouts, deterministic cleanup, sanitized screenshots/GIFs, and machine-readable evidence. Cleanup of the Pool credential is not a claim of provider-wide revocation.
- Write a focused failing test before behavior changes. Run focused tests, then the full suite, PostgreSQL gate, build, package verification, tarball installation, and stock-DSH smoke in that order.
- Do not commit, push, publish, or merge without separate user authorization.

---

## Existing Baseline (Do Not Rebuild)

- Team/member/invite/API-key control plane, one-time hashed secrets, ownership transfer, member departure, and emergency pause.
- Contributor-owned `active`/`paused`/`revoked`/`reauth_required` lifecycle with start, cancel, reauthorize, drain, and cleanup reconciliation.
- Own-account-first, shared fallback, session affinity, model allow-list, personal reserve, reset-window request cap, shared concurrency, hard-limit retry, and bounded provider attempts.
- Metadata-only usage events containing Team, consumer, upstream owner/account, model, unit, status, and timestamps without prompt/response/file/token content.
- PostgreSQL migrations, real lock-scheduler tests, distributed per-key traffic guard, envelope-encrypted credentials, isolated Broker protocol, distinct database roles, and multi-Team Compose smoke.
- Same-origin Team Settings UI and remote Team-client adapter for stock DSH.

## Task 1: Lock the phase-two live acceptance contract

**Files:**

- Create: `docs/acceptance/team-mvp-phase-two.md`
- Create: `tests/team-live-sharing.spec.ts`
- Modify: `tests/deployment-assets.spec.ts`
- Modify: `package.json`

**Interfaces and behavior:**

- Define machine-checkable acceptance cases for two members and two contributed accounts:
  1. a request from Member B uses B's own active account;
  2. after B pauses that contribution, a new session falls back to A's active shared account;
  3. repeated requests in one session remain on the admitted upstream account while it stays available;
  4. Team pause rejects every new admission while already admitted work may settle;
  5. contribution revoke stops new selection, drains admitted work, removes only the Pool credential, and leaves an auditable terminal contribution record;
  6. every admitted attempt produces metadata-only ownership/routing/status/timestamp evidence;
  7. no response or artifact contains Team keys, invite tokens, OAuth tokens, prompts, or model output.
- Add a package script named `smoke:team-live-routing` that requires an explicit destructive/live-data confirmation flag.
- Add deployment-asset assertions so the live runner is shipped in the npm tarball and cannot silently lose its confirmation guard.

**TDD steps:**

- [ ] Write the acceptance matrix with explicit `pass`, `fail`, `blocked`, and `not-run` evidence rules; distinguish live provider proof from simulated router proof.
- [ ] Write failing tests for the live runner's confirmation flag, bounded model/session inputs, secret-free error path, cleanup order, and packaged-file presence.
- [ ] Run `pnpm exec vitest run tests/team-live-sharing.spec.ts tests/deployment-assets.spec.ts` and record the expected RED result.
- [ ] Add the package script and minimal runner seam needed by the tests; do not contact OpenAI in unit tests.
- [ ] Re-run the focused tests and record GREEN.

## Task 2: Add a repeatable two-contributor live-routing runner

**Files:**

- Create: `deploy/host/smoke-live-team-routing.mjs`
- Modify: `tests/team-live-sharing.spec.ts`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces and behavior:**

- The runner bootstraps one disposable Team, creates a one-time invite, joins Member B, and pauses at two separate device-code challenges so A and B authorize isolated contributions.
- It sends fixed, minimal Responses requests with Member B's Team key and explicit session identifiers.
- It proves B-own selection first, pauses B's contribution through B's authenticated route, proves A-shared fallback on a new session, then proves session affinity with a second request while A remains available.
- It fetches usage rows and requires exact `consumerMemberId`, `upstreamOwnerMemberId`, `upstreamAccountId`, `model`, `unit = request`, terminal status, and ordered timestamps. It must reject any unexpected content-bearing field.
- It pauses the Team and proves a new admission is rejected without creating a usage row.
- Cleanup runs in `finally`: stop new admission, cancel incomplete OAuth, drain/revoke both contributions, remove B, revoke all disposable Team keys, and leave only metadata rows plus a paused disposable Team. Cleanup failures produce a bounded secret-free summary and non-zero exit.

**TDD steps:**

- [ ] Build a fake Team/Responses transport in `tests/team-live-sharing.spec.ts` and prove the exact own -> pause -> shared -> sticky -> Team-pause call order.
- [ ] Add failure-path tests for timeout, declined OAuth, incorrect upstream ownership, missing usage settlement, content leakage, and partial cleanup.
- [ ] Run the new focused test and confirm RED before creating the runner.
- [ ] Implement the live runner using the existing Team HTTP contracts; reuse validation/redaction helpers instead of printing raw response bodies.
- [ ] Run the focused test until GREEN, then run `pnpm exec vitest run tests/team-gateway.spec.ts tests/team-request-service.spec.ts tests/team-routing.spec.ts tests/team-postgres-routing.spec.ts` to guard routing semantics.
- [ ] Update README with the exact command, two human OAuth pauses, expected request count, data retained after cleanup, and the distinction between Pool deletion and OpenAI-side revoke.

## Task 3: Run the real central-server and PostgreSQL gates

**Files:**

- Verify: `deploy/self-hosted/compose.yml`
- Verify: `deploy/postgres/runtime-roles.sql`
- Verify: `.github/workflows/ci.yml`
- Verify: `tests/team-postgres.integration.spec.ts`
- Evidence output: `artifacts/team-phase-two/<timestamp>/infrastructure/`

**Steps:**

- [ ] Initialize fresh ignored Compose secrets and start PostgreSQL 17, migrator, Team Host, Broker, and Edge with no reused disposable database volume.
- [ ] Require the migrator to exit successfully and all four long-running services to become healthy.
- [ ] Run the packaged multi-Team smoke and prove one-time invite use, distinct member keys, tenant isolation, and Host/Broker table-privilege denial paths.
- [ ] Run `DSH_TEAM_POSTGRES_TEST_URL=<redacted-url> pnpm run test:postgres` and preserve only secret-free test output proving pause/admission, credential mutation/rewrap, and distributed traffic-lock scheduling.
- [ ] Run `pnpm run smoke:team-live-routing -- --confirm-two-contributor-live-openai-test-data`; pause for the user at each device-code authorization.
- [ ] Record provider attempt count and metadata-only routing ownership without recording prompts, model output, device codes, email addresses, account labels, Team keys, or database URLs.
- [ ] Stop the stack without deleting a non-disposable volume; remove only resources created by this acceptance run.

## Task 4: Prove the Team client in stock DSH on port 3181

**Files:**

- Modify only if a defect is found: `src/client/team/TeamSettings.tsx`
- Modify only if a defect is found: `src/client/team/TeamSettings.module.css`
- Modify only if a defect is found: `src/client/team/api.ts`
- Modify only if a defect is found: `src/client/team/locales.ts`
- Modify only if a defect is found: `src/team/management-routes.ts`
- Tests for any fix: `tests/team-settings-contract.spec.ts`, `tests/team-management-client.spec.ts`, `tests/team-management-routes.spec.ts`, `tests/team-web-smoke.spec.ts`
- Evidence output: `artifacts/team-phase-two/<timestamp>/stock-dsh-3181/`

**Steps:**

- [ ] Pack the current plugin and install that tarball into a fresh isolated `DSH_HOME` with pinned stock `@deepseek-ai/dsh@0.1.0-rc.8`; do not link the worktree.
- [ ] Start the browser-facing stock DSH process only on `127.0.0.1:3181`, connect it to the accepted Team Edge through `teamClient`, and verify `--dump-config` contains the packaged Host/browser entries.
- [ ] In **Codex Team**, verify connect/join, member and pending-invite views, two contribution statuses, device-code wait/cancel, reserve/cap/model edit, pause/resume, reauthorize eligibility, Team pause/resume, ownership labels, and metadata-only recent activity.
- [ ] Send a real DSH Codex request through Team-client mode and prove the corresponding Team usage row identifies the selected upstream owner/account. Confirm local Shared Pool routing is skipped for that request.
- [ ] Capture sanitized screenshots plus a short GIF for the own-account -> paused -> shared-fallback -> usage-row story. Review every encoded frame and record media checksums, source state, runtime integrity, cleanup, and limitations.
- [ ] Confirm a clean browser console. Record desktop-first/mobile limitation without claiming the stock Settings shell is phone-ready.
- [ ] If any behavior fails, write a focused failing test before fixing it, repeat only the affected acceptance step, then re-run the focused suite.

## Task 5: Close security, package, and release evidence

**Files:**

- Modify if needed: `scripts/verify-package.mjs`
- Modify: `README.md`
- Create: `artifacts/team-phase-two/<timestamp>/result.json`
- Create: `artifacts/team-phase-two/<timestamp>/provenance.json`
- Create: `artifacts/team-phase-two/<timestamp>/gif-review.md`

**Steps:**

- [ ] Run all focused Team suites, then `pnpm test`.
- [ ] Run `pnpm run build`, `pnpm run verify:package`, and `pnpm pack --pack-destination <fresh-temporary-directory>`.
- [ ] Inspect the tarball file list and scan the publish payload for credential filenames, exact known local secret values, machine-specific paths, raw account identifiers, and temporary artifacts.
- [ ] Install the exact tarball in a second fresh isolated `DSH_HOME`; run stock rc.8 config, Host-route, Browser-bundle, and one non-provider Team-management smoke. Distinguish this from package-format verification.
- [ ] Confirm Team Owner cannot read/export another member's token and no token-export/arbitrary-upstream route exists.
- [ ] Document the remaining non-MVP hardening items: managed cloud-KMS adapter selection, workload identity or mTLS, broker egress policy, TLS/WAF/backup operations, and stock-shell mobile layout.
- [ ] Mark the acceptance matrix and machine result accurately. A missing live OAuth or Responses request is `blocked/not-run`, never a simulated PASS.
- [ ] Run `git diff --check` and report exact branch/worktree state. Do not commit, push, publish, or merge without explicit approval.

## Definition of Done

- The two-contributor live runner proves own-account priority and shared fallback with real provider requests and exact metadata-only ownership rows.
- Stock DSH rc.8 runs the packed plugin on port 3181 and sends at least one real Codex request through Team-client mode.
- Multi-Team isolation, PostgreSQL locking, distributed safety guards, credential Broker isolation, and cleanup gates pass.
- Sanitized visual and machine-readable evidence support every user-visible claim.
- The README names all unverified/non-MVP security limits without presenting them as completed.
- The worktree contains only intentional phase-two source, test, documentation, and sanitized evidence changes.

## Self-Review

- The plan extends existing Team code instead of duplicating completed control-plane, router, Broker, and deployment work.
- Every behavior change begins with a focused failing test and names exact files.
- Live and simulated evidence are explicitly separated.
- The Browser and Team Owner never gain raw credential access.
- The plan respects the user's port-3181 browser convention while preserving the separate central-server topology.
- Managed cloud KMS and complex consumer allocation remain outside the Team MVP.
