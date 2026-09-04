# Account Loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show locally stored accounts without waiting for remote quota or OAuth refresh, and bound the loading lifecycle.

**Architecture:** Load the existing `/plugins/dsh-openai-codex/profiles/directory` first and hydrate quota independently through `/plugins/dsh-openai-codex/profiles`. Preserve the directory as authoritative for membership and order; stale quota responses must not resurrect removed accounts. Bound the entire quota operation, including credential resolution, and cancel browser requests on disposal.

**Tech Stack:** TypeScript, React, Vitest/jsdom, official DSH `0.1.0-rc.8`, Cordis `4.0.1`.

## Global Constraints

- Work in `codex/fix-account-loading`, based on `d0b6c9b`; protect other worktrees.
- Host alone owns credentials and OAuth operations. Browser receives only existing safe projections.
- No dependency additions, Core changes, compatibility expansion, npm publishing, or shared-instance restart.
- A directory record alone is not proof of successful authentication: render unverified health neutrally.
- Add failing tests before behavior changes. Build and package verification are mandatory.
- PR requires independent sub-agent review. Merge and deployment require separate user confirmation.

---

### Task 1: Decouple account rendering from quota

**Files:**
- Modify: `src/client/OpenAICodexSettings.tsx`, `src/client/locales.ts`
- Create: `tests/account-loading.client.spec.tsx`
- Test compatibility: `tests/client-profile-settings.spec.ts`, `tests/openai-codex-settings.client.spec.tsx` if present; discover the existing direct component fixture with `rg -l 'render.*OpenAICodexSettings|<OpenAICodexSettings' tests`.

**Interfaces:**
- Consume the existing directory response and `OpenAICodexProfilesStatus<AccountProfile>` quota response.
- Keep shared connection-status types unchanged. Make UI-only `connectionStatus` optional until quota hydration and add `quotaState: 'loading' | 'ready' | 'error'` to the UI projection.
- Maintain a monotonically increasing refresh generation and an AbortController. Only the active generation may update state.

- [ ] Write a jsdom test with directory resolving immediately and quota deliberately unresolved. Use this exact deferred primitive and assert the account appears before resolving quota:

```ts
let resolveQuota!: (response: Response) => void
const quota = new Promise<Response>(resolve => { resolveQuota = resolve })
const directory = { status: 'ready', profiles: [
  { id: 'local-1', label: 'Local account', createdAt: 1, updatedAt: 1 },
] }
// In the component fixture's fetch mock, return Response.json(directory)
// for /profiles/directory and quota for /profiles.
expect(await screen.findByRole('button', { name: /Local account/ })).toBeDefined()
expect(screen.queryByText('正在加载账户信息…')).toBeNull()
resolveQuota(Response.json({ status: 'ready', profiles: [] }))
```

- [ ] Run `pnpm exec vitest run tests/account-loading.client.spec.tsx`; record the initial failure before editing production code.
- [ ] Start directory and quota requests independently. After directory success, construct profiles with empty usage and pending quota, preserving matching prior quota where available:

```ts
const previousById = new Map(previousProfiles.map(profile => [profile.id, profile]))
const nextProfiles = directory.profiles.map(profile => ({
  ...previousById.get(profile.id),
  ...profile,
  usage: previousById.get(profile.id)?.usage ?? { rateLimits: [] },
  quotaState: 'loading' as const,
}))
```

Store early quota results until directory arrives. Merge quota only by IDs in the current directory, preserving directory labels/order and checking generation before every state update. On quota failure preserve accounts and existing usage, show a localized quota warning, and never replace the page with an account-list error. On directory failure show a bounded, retryable directory error. Render unknown connection status neutrally rather than green or red.
- [ ] Add tests for quota timeout with visible accounts, quota completing before directory, stale results after account removal/rename, no duplicate quota poll while pending, and component unmount aborting requests. Use deferred responses to control order, and `vi.useFakeTimers()`/`vi.advanceTimersByTimeAsync(20_000)` for the browser deadline.
- [ ] Run the new tests plus the existing account settings and quota tests. Commit only focused UI/test/locale changes after all pass: `git commit -m "fix(ui): load account directory independently of quota"`.

### Task 2: Bound credential resolution and quota lifecycle

**Files:**
- Modify: `src/usage.ts`
- Test: `tests/usage.spec.ts`

**Interfaces:**
- Preserve `readOpenAICodexRateLimits(store, signal?): Promise<OpenAICodexUsage>`.
- One 15,000 ms deadline covers getAuth, credential read, fetch, and response body. Caller cancellation participates in the same signal. Timeout remains a telemetry error, not an authentication error.
- Underlying getAuth may lack abort support: do not claim it is cancelled; suppress unhandled late rejection and avoid overlapping refreshes for the same credential identity.

- [ ] Add a test whose credential store read never settles and abort the caller signal before any fetch. Assert bounded rejection and no fetch:

```ts
const controller = new AbortController()
const store = await authenticatedStore()
vi.spyOn(store, 'read').mockImplementation(() => new Promise(() => {}))
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)
const pending = readOpenAICodexRateLimits(store, controller.signal)
const assertion = expect(pending).rejects.toThrow()
controller.abort(new Error('cancelled'))
await assertion
expect(fetchMock).not.toHaveBeenCalled()
```

- [ ] Run `pnpm exec vitest run tests/usage.spec.ts` and record the failing timeout/cancellation case.
- [ ] Introduce one deadline/controller at function entry and race the complete operation against its abort. Ensure cleanup in `finally` removes listeners and clears timer. Check `signal.throwIfAborted()` after getAuth and credential reads, before fetch. Attach rejection handlers to every raced promise. Keep existing typed authentication classification intact.
- [ ] Test credential-resolution timeout, already-aborted caller, fetch/body deadline, successful cleanup, late getAuth settlement not starting fetch, and existing 401/403/OAuth classification. Run `pnpm exec vitest run tests/usage.spec.ts tests/auth-routes.spec.ts`.
- [ ] Commit focused Host and test changes: `git commit -m "fix(usage): bound the complete quota read lifecycle"`.

### Task 3: Verify and deliver

**Files:** Existing package scripts and isolated smoke tooling; no shared configuration edits.

**Interfaces:** Deliver a draft PR against `main`, exact commit/tarball identification, test outcomes and scoped review conclusion.

- [ ] Run `pnpm test`, `pnpm run build`, and `pnpm run verify:package`.
- [ ] Pack the verified tree and run the skill's official rc.8 smoke against the exact tarball in an isolated `DSH_HOME`. Read tooling/test-evidence references before execution.
- [ ] In an isolated target browser, delay only the quota response and verify the real settings component renders directory accounts first. Label remote provider data as mocked; this does not prove live OAuth. If unavailable, report target UI behavior as `NOT_PROVEN`.
- [ ] Run `git diff --check`; inspect the full branch diff for credentials and unrelated changes. Push `codex/fix-account-loading` and create a draft PR describing test evidence and limitations.
- [ ] Ask an independent sub-agent to review only this PR's diff, tests, security boundaries and compatibility. Fix blockers and request another scoped review. Read CI status and report the PR without merging or deploying.

## Plan self-review

The plan covers immediate local rendering, independent quota loading, bounded credential resolution, request cancellation, race protection, neutral unverified health, regression coverage, package verification, isolated runtime evidence and independent PR review. No change to shared 3181/3197 or account credentials is included. Referenced execution helper skills are unavailable in this session; use the existing repository workflow as fallback after the execution-method handoff.

## Execution record

The checklist above records the original proposal; this record describes the implemented variation.

- Reused the existing settings-routing-events client fixture rather than introducing a duplicate fixture. Confirmed red tests for pending quota and stalled credential resolution before production changes.
- Directory loads first (5-second deadline), then quota hydrates independently (20-second browser deadline). A per-refresh AbortController guards generations; directory IDs, metadata and order remain authoritative. Because quota starts after directory, a quota-before-directory race is not possible. UI-only `quotaLoading` replaces the proposed enum.
- Unknown connection health stays neutral. Quota failures retain accounts; directory failures offer retry. Mutations return after directory refresh rather than waiting for telemetry.
- One Host deadline covers credential reads, OAuth, fetch and body parsing. The pinned provider does not cancel its refresh network request: started credential transactions finish and persist rotated tokens; expired queued transactions cannot initiate new refreshes. Late operations cannot start quota fetches.
- Added deadline, stale hydration, unmount cancellation, timeout and late successful credential-rotation coverage. Independent review found no blocking issues; its suggested successful-rotation regression test was added and passed.
- Type checking, full tests, build and package verification passed. Official stock DSH 0.1.0-rc.8 exact-tarball install/config/start/boot-manifest/directory-route smoke passed in an isolated home; its server and home were cleaned up by the runner.
- Verified tarball SHA-256: `ddf879076a4307f3e6fa88533d937e60dd364d18711a928ce46b628f9511df53`.
- Generic sensitive scan does not pass globally: existing credential-handling source, generated bundles and synthetic test fixtures match its broad assignment rules. Reviewed task additions contain only synthetic credentials; smoke evidence scan passes. This is not a clean global scanner result.
- Real target-browser slow-quota interaction/GIF, real provider OAuth and shared 3181/3197 behavior remain NOT_PROVEN. DOM tests and HTTP smoke do not substitute for those levels. No shared instance was changed.
- Deliver as one focused commit and draft PR; no merge, deployment or package publication in this implementation turn.
