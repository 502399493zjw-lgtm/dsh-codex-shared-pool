# Subscription estimates implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show account subscription tiers and simple estimated weekly dollar capacity.

**Architecture:** Normalize provider plan metadata at the Host boundary. A shared pure projection computes estimates from the main Codex seven-day window, independent of routing and real spend accounting. Local and contribution-owner views display the same compact projection.

**Tech Stack:** TypeScript, React, Vitest; stock DSH 0.1.0-rc.8 and Cordis 4.0.1.

## Global Constraints

- Plus = US$100/week; Pro 5x = US$600/week; Pro 20x = US$2,100/week.
- No sample timestamps, provenance labels, calibration, or invented estimates for unsupported tiers.
- Credentials remain Host-only. No shared deployment, package publishing, or merge.
- Missing weekly windows never fall back to five-hour or Spark windows.
- Optional fields preserve compatibility with older peers.
- The execution subskills are unavailable; execute inline with repository TDD gates.

### Task 1: Safe subscription projection and transport

Files: create `src/shared/subscription.ts` and `tests/subscription.spec.ts`; modify `src/shared/types.ts`, `src/usage.ts`, `src/team/remote-credentials.ts`, `src/team/capacity.ts`, `src/team/routing.ts`, `src/team/types.ts`, `src/team/service.ts`, `src/team/management-routes.ts`, `tests/usage.spec.ts`.

Interface: `projectSubscription(planType: unknown, weeklyRemainingPercent?: number): CodexSubscription | undefined`; `subscriptionFromUsage(usage: OpenAICodexUsage): CodexSubscription | undefined`. `CodexSubscription` contains a normalized `planType`, optional `weeklyEstimatedUsd`, and optional `weeklyRemainingEstimatedUsd`.

- [ ] Add tests before code, including `expect(projectSubscription('plus', 75)).toEqual({ planType: 'plus', weeklyEstimatedUsd: 100, weeklyRemainingEstimatedUsd: 75 })`; cover unsupported/missing plans, zero, fractional percentages, and weekly versus short/Spark windows.
- [ ] Run `pnpm exec vitest run tests/subscription.spec.ts tests/usage.spec.ts` and confirm failure.
- [ ] Implement allowlisted plans and `Math.round(weeklyEstimatedUsd * weeklyRemainingPercent) / 100`; propagate only normalized data through the existing Host projections.
- [ ] Re-run focused projection and Team tests; do not change routing decisions.

### Task 2: Compact account display and delivery

Files: create `src/client/SubscriptionEstimate.tsx` and `tests/subscription-estimate.client.spec.tsx`; modify `src/client/OpenAICodexSettings.tsx`, `src/client/team/TeamSettings.tsx`, and relevant locale files.

Interface: React `SubscriptionEstimate` consumes optional `CodexSubscription` and localized labels, renders tier and estimated weekly remaining/total separately from credit balances.

- [ ] Add a DOM test asserting a Plus account shows `Plus` and `US$75.00 / US$100.00`, and an unsupported plan has no dollar value.
- [ ] Run the DOM test red, implement compact reusable display, and carry its optional projection through local-profile refresh/merge.
- [ ] Run focused tests, `pnpm run build`, `pnpm run verify:package`, and regression tests.
- [ ] Package and attempt isolated stock UI verification with mock provider data; report unavailable evidence as NOT_PROVEN, never as live-provider proof.
- [ ] Commit only task files, push and open a draft PR against main, obtain independent change-scoped review, fix blockers and re-review. Do not merge.

Acceptance: AC-SUB-001 uses synthetic Plus/Pro profiles to assert correct tier and weekly estimates; AC-SUB-002 asserts unsupported/missing plans and short-only windows never fabricate remaining dollars. Unit/DOM tests own no external accounts or shared services. Any isolated stock smoke owns only its temporary runtime and browser resources and must clean them up.

## Execution results

- Tasks 1 and 2 implementation and TDD checks completed. Final regression: 995 tests passed, 23 skipped; 33 prototype tests passed. Build and package verification passed.
- Independent review identified missing subscription display for Spark-only contributions without Spark quota telemetry. Added a failing DOM regression and separated subscription metadata selection from quota bucket selection; regression now passes.
- Isolated official DSH 0.1.0-rc.8 tarball installation and HTTP/browser-bundle smoke passed. This is not interactive browser or live OAuth evidence; those remain NOT_PROVEN. No shared instance was installed into or restarted.
- Repository-wide sensitive-data scanner reported existing fixture/code-name matches and local worktree metadata, so its gate is not clean; task diff manually checked for credentials.
- Initial implementation committed on `codex/subscription-estimates`. Git push timed out; no remote branch or draft PR was created. No merge or deployment performed.
