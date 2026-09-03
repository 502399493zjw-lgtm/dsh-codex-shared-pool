# Local Account OAuth Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use dsh-plugin-best-practices to implement and verify this plan.

## Goal

Make “添加账号” complete successfully when OpenAI returns an account already stored in the local pool: refresh that profile's OAuth credential in place instead of surfacing the generic account-request failure.

## Architecture

Keep the provider login isolated until the commit gate succeeds. Add a local-store-only atomic add-or-refresh operation keyed by the provider `accountId`; a new identity appends one profile, while an existing identity retains its internal profile id, label, priority order, creation time, and Session bindings. Team credential stores continue using strict `addProfile` semantics.

## Tech Stack

- TypeScript 6
- Vitest 4
- DSH `0.1.0-rc.8` / Cordis `4.0.1`
- Owner-only JSON storage with `@deepseek-ai/dsh-atomic-write`

## Global Constraints

- [x] Do not expose tokens or provider account identifiers to Browser code or test output.
- [x] Do not modify or restart the shared instances on ports 3181 or 3197.
- [x] Run only focused tests for this PR; do not run the full repository suite.
- [x] Preserve strict duplicate rejection for generic/Team `addProfile` callers.

## Task 1: Reproduce the post-OAuth duplicate commit failure

- [x] Add a focused regression test in `tests/auth-commit-gate.spec.ts` that starts with one stored local identity, completes OAuth for the same identity with new tokens, and expects one refreshed profile with stable metadata.
- [x] Run only that test and record the expected failure against the current implementation.

## Task 2: Commit local OAuth identities idempotently

- [x] Add an atomic local store operation that appends a new identity or refreshes the matching profile in place.
- [x] Route only local browser “添加账号” OAuth through this operation after the existing commit gate.
- [x] Keep generic and Team profile addition behavior unchanged.
- [x] Re-run the focused regression and adjacent auth/store tests.

## Task 3: Validate and deliver the focused PR

- [x] Run `pnpm run build`, `pnpm run verify:package`, `git diff --check`, and the sensitive-data scan. The repository-wide scanner retains its pre-existing findings; all added lines pass the same configured patterns.
- [ ] Commit and push the `codex/fix-local-add-account-request` branch, then open a draft PR to `main`.
- [ ] Request an independent sub-agent review limited to the PR diff; fix any blocking findings and re-run affected checks.
- [ ] Report that shared-instance and real OpenAI OAuth validation remain unproven because 3181/3197 must not be changed without explicit authorization.
