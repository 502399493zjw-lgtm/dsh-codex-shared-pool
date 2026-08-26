# Team Invitation Envelope Sweeper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Execute this plan inline with focused TDD because the parent task explicitly assigns implementation to the current worker.

**Goal:** Ensure an expired invitation's encrypted token envelope is removed by the Host no later than 24 hours after `expiresAt`, without deleting the invitation summary record.

**Architecture:** Add one Host-internal sweep operation to `TeamStore`. Memory storage clears expired in-memory envelopes; PostgreSQL first discovers candidate Team IDs without locks, sorts them by `teamId`, then uses one transaction per Team to lock the Team row once and lock all currently expired invitations in `inviteId` order before clearing only envelope columns. `TeamService` owns an immediately-started, bounded periodic timer, coalesces concurrent sweeps, and waits for an active sweep during disposal; runtime configuration supplies the interval.

**Tech Stack:** TypeScript, node-postgres, pg-mem, Vitest fake timers, Schemastery configuration.

## Global Constraints

- An envelope must be cleared no later than `expiresAt + 24h` while the Host is running.
- PostgreSQL candidate discovery must not take row locks.
- PostgreSQL processing order is deterministic by `teamId`, then `inviteId`.
- Each PostgreSQL Team transaction locks the Team once, then locks that Team's invitations in ID order while rechecking the current clock and envelope presence.
- Sweeping clears only envelope material; it does not delete or terminalize the invitation record.
- The interval is configurable, at most 24 hours, and the timer is `unref()`'d.
- Concurrent service sweeps share one in-flight store operation; disposal clears the timer and awaits that operation.
- Preserve concurrent user/agent changes, avoid editing `createInvite` and `revealInvite`, do not commit.

---

### Task 1: Store sweep contract and implementations

**Files:**
- Modify: `src/team/store.ts`
- Modify: `src/team/postgres-store.ts`
- Test: `tests/team.spec.ts`
- Test: `tests/team-postgres.spec.ts`

**Interfaces:**
- Produces: `TeamStore.sweepExpiredInviteEnvelopes(): Promise<number>` where the result is the number of envelopes actually cleared.

- [x] **Step 1: Write failing Memory and PostgreSQL tests**

```ts
await expect(store.sweepExpiredInviteEnvelopes()).resolves.toBe(1)
expect(storedInvite).toMatchObject({ status: 'pending', label: 'Expired' })
expect(storedInvite).not.toHaveProperty('envelope')
```

The PostgreSQL test seeds invitations across two Teams, captures query order, and asserts candidate discovery has no `FOR UPDATE`, while every mutation observes `teams ... FOR UPDATE` before `team_invites ... FOR UPDATE`.

- [x] **Step 2: Run focused tests and verify the missing method fails**

Run: `./node_modules/.bin/vitest run tests/team.spec.ts tests/team-postgres.spec.ts`

- [x] **Step 3: Implement the Memory operation**

Iterate invitations, clear `envelope` only when `expiresAt <= this.now()`, and return the count. Leave status, token hash, label, creator, and timestamps intact.

- [x] **Step 4: Implement the PostgreSQL operation**

Use an unlocked candidate query equivalent to:

```sql
SELECT DISTINCT team_id
FROM team_invites
WHERE expires_at <= $1
  AND envelope_version IS NOT NULL
ORDER BY team_id
```

For each sorted Team, start one transaction, lock `teams` by id once, then select all currently expired `team_invites` with envelope material using `ORDER BY id FOR UPDATE`. Batch-clear all eight envelope columns. Do not change `status`, `token_hash`, or other columns.

- [x] **Step 5: Run focused tests**

Run: `./node_modules/.bin/vitest run tests/team.spec.ts tests/team-postgres.spec.ts`

### Task 2: Host-owned periodic lifecycle

**Files:**
- Modify: `src/team/service.ts`
- Test: `tests/team.spec.ts`

**Interfaces:**
- Produces: `TeamService.startInviteEnvelopeSweeping({ intervalMs })`.
- Produces: `TeamService.sweepExpiredInviteEnvelopes(): Promise<number>`.

- [x] **Step 1: Write failing fake-timer tests**

Use a deferred Store spy to prove an immediate start plus a timer tick result in one in-flight Store call, the interval is bounded to 24 hours, and `dispose()` clears the timer and waits for the deferred sweep.

- [x] **Step 2: Run the focused service tests and verify failure**

Run: `./node_modules/.bin/vitest run tests/team.spec.ts`

- [x] **Step 3: Implement service lifecycle**

Store the timer and in-flight promise. Start an immediate best-effort sweep, schedule subsequent best-effort sweeps, call `unref?.()`, return the current promise to concurrent callers, clear the interval on disposal, then await the active sweep before disposing Store.

- [x] **Step 4: Run focused service tests**

Run: `./node_modules/.bin/vitest run tests/team.spec.ts`

### Task 3: Runtime configuration and startup wiring

**Files:**
- Modify: `src/team/config.ts`
- Modify: `src/team/runtime.ts`
- Test: `tests/team-runtime.spec.ts`

**Interfaces:**
- Produces: `TeamConfig.inviteEnvelopeSweepIntervalMs?: number`.
- Runtime starts sweeping for both Memory and PostgreSQL services after initialization.

- [x] **Step 1: Write failing configuration/runtime tests**

Assert the schema default is at most `86_400_000`, configured intervals reach `startInviteEnvelopeSweeping`, and runtime disposal stops future Store calls.

- [x] **Step 2: Run runtime tests and verify failure**

Run: `./node_modules/.bin/vitest run tests/team-runtime.spec.ts`

- [x] **Step 3: Add schema and runtime wiring**

Add an integer interval with a maximum of `86_400_000` ms and pass it to the service start method on both runtime construction paths. An immediate sweep handles records already overdue at process startup.

- [ ] **Step 4: Run all focused checks**

Run:

```bash
./node_modules/.bin/vitest run tests/team.spec.ts tests/team-postgres.spec.ts tests/team-postgres.integration.spec.ts tests/team-runtime.spec.ts
./node_modules/.bin/tsc -p tsconfig.json --noEmit
pnpm run build
pnpm run verify:package
git diff --check
```

## Self-Review

- Spec coverage: 24-hour bound, startup cleanup, lock-free discovery, deterministic ordering, Team-to-invite lock order, locked recheck, envelope-only mutation, configurable/unref timer, coalescing, disposal, and Memory/PG/runtime tests are all assigned.
- Placeholder scan: no deferred behavior or unspecified error handling remains.
- Type consistency: `sweepExpiredInviteEnvelopes(): Promise<number>` is identical across Store, Memory, PostgreSQL, and TeamService.
