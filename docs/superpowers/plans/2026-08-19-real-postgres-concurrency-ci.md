# Real PostgreSQL Concurrency CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove on a real PostgreSQL server that Team emergency pause is linearizable with metadata-only usage admission, and run that proof on every open-source CI change.

**Architecture:** Keep pg-mem unit coverage fast and add a separate opt-in Vitest integration suite driven by `DSH_TEAM_POSTGRES_TEST_URL`. The test creates a unique schema, blocks a usage insert inside PostgreSQL with an advisory-lock trigger, verifies a concurrent pause cannot return early, then verifies paused Teams reject later admissions. A GitHub Actions service container supplies disposable PostgreSQL while a small runner makes a missing database URL fail explicitly.

**Tech Stack:** TypeScript 6, Vitest 4, node-postgres 8, PostgreSQL 17, GitHub Actions, pnpm 11.7.0, Node.js 24.

## Global Constraints

- Keep `@deepseek-ai/dsh@0.1.0-rc.7` as the verified compatibility target.
- Do not change DSH core or generated catalogs; this remains one external plugin package.
- The integration test must never reuse or drop a user schema; create and remove only a random `dsh_team_it_<hex>` schema.
- No prompt, response, file, token, OAuth credential, API key, or connection URL may be printed.
- `pnpm test` must stay runnable without PostgreSQL; `pnpm run test:postgres` must fail clearly when `DSH_TEAM_POSTGRES_TEST_URL` is missing.
- Do not commit, push, or publish without explicit user authorization.

---

### Task 1: Real PostgreSQL pause/admission proof

**Files:**
- Create: `tests/team-postgres.integration.spec.ts`
- Create: `scripts/run-postgres-integration.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `PostgresTeamStore`, `TeamAuthContext`, and environment variable `DSH_TEAM_POSTGRES_TEST_URL`.
- Produces: `pnpm run test:postgres`, a required-URL runner, and a disposable-schema concurrency test.

- [x] **Step 1: Write the failing integration test**

  Add a Vitest suite which skips only during the normal no-database test run. With a URL present it must create a unique schema, bootstrap an owner and active contribution, install a `BEFORE INSERT` trigger that waits on a test-only advisory lock, and start `beginUsageEvent()`.

- [x] **Step 2: Run the new gate and verify it fails**

  Run: `pnpm run test:postgres`

  Expected: FAIL because the package script does not exist yet.

- [x] **Step 3: Add the explicit runner and package script**

  The runner must trim `DSH_TEAM_POSTGRES_TEST_URL`, exit non-zero with a safe error when absent, and otherwise spawn the local Vitest CLI for only `tests/team-postgres.integration.spec.ts`. Add `"test:postgres": "node scripts/run-postgres-integration.mjs"`.

- [x] **Step 4: Complete the concurrency assertions**

  Poll `pg_stat_activity` until the usage insert is waiting on the advisory lock, start `setTeamStatus(..., 'paused')`, assert pause remains pending, release the advisory lock, then assert the earlier usage commits before pause returns. Assert a later `beginUsageEvent()` rejects with `team is paused` and the usage table still contains exactly one row.

- [x] **Step 5: Run focused tests**

  Run with a disposable real PostgreSQL URL: `DSH_TEAM_POSTGRES_TEST_URL=postgres://… pnpm run test:postgres`

  Expected: 1 integration test passes and its random schema is removed in `finally`.

- [x] **Step 6: Review checkpoint**

  Inspect the test for secret-safe output, bounded polling, cleanup on failure, and random-schema-only destructive SQL. Do not commit.

### Task 2: Open-source CI gate and documentation

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-08-19-team-control-plane.md`

**Interfaces:**
- Consumes: `pnpm run test:postgres` from Task 1.
- Produces: a PostgreSQL-backed CI job and exact local reproduction instructions.

- [x] **Step 1: Add the CI workflow**

  On `push` and `pull_request`, use read-only contents permission, `ubuntu-latest`, a healthy `postgres:17-alpine` service, `pnpm/setup@v2` with Node.js 24, then run `pnpm test`, `pnpm run test:postgres`, `pnpm run build`, and `pnpm run verify:package`.

- [x] **Step 2: Document the evidence boundary**

  Replace the README statement that real lock contention is only a deployment check. State that normal unit tests use pg-mem, while `test:postgres` and CI exercise the actual PostgreSQL lock scheduler. Document the environment variable without including credentials.

- [x] **Step 3: Update the control-plane evidence list**

  Mark real PostgreSQL pause/admission contention as covered and list `pnpm run test:postgres` separately from pg-mem tests.

- [x] **Step 4: Validate workflow syntax and repository gates**

  Parse `.github/workflows/ci.yml` with an available YAML parser, run `pnpm test`, `pnpm run test:postgres` against the disposable database, `pnpm run build`, and `pnpm run verify:package`.

- [x] **Step 5: Independent review checkpoint**

  Ask a read-only reviewer to inspect PostgreSQL interleaving, cleanup safety, workflow correctness, and documentation claims. Do not commit.

## Self-Review

- Spec coverage: the plan covers real scheduler evidence, repeatable local execution, CI automation, missing-URL failure, cleanup, and documentation; OAuth E2E is intentionally a separate subsystem and plan.
- Placeholder scan: no TBD/TODO or unspecified implementation step remains.
- Type consistency: both tasks use `DSH_TEAM_POSTGRES_TEST_URL` and the same `test:postgres` script name.
