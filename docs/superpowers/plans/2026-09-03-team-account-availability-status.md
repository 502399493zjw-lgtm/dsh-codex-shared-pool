# Team Account Availability Status Implementation Plan

> **Goal:** Keep durable local and Team account records manageable during transient provider failures while removing UI claims that those records are currently routable.

## Scope and invariants

- Work only in `codex/fix-team-unavailable-status`.
- Do not hide, revoke, or delete an account because a quota/provider observation failed.
- Do not change the Team-wide browser projection or expose another member's capacity details.
- Preserve the existing fail-closed Team routing behavior.
- Do not deploy to or restart the shared instances on ports 3181 or 3197.
- Run only focused tests for this PR, followed by the repository-required build and package verification.

## Task 1: Lock the misleading states down with focused DOM tests

**Files:**

- Modify: `tests/team-settings-workspace.client.spec.tsx`

1. Add a focused case where the current member's durable `active` contribution has a `provider_unavailable` capacity bucket.
2. Assert that the account remains in the directory and keeps its management action, but its detail header uses an error dot and does not say `Team available`.
3. Extend the local quota-refresh failure case to assert that the retained local account uses an error state rather than a green available state.
4. Update the teammate read-only case to require neutral “shared with Team” copy because teammate capacity is intentionally absent from the browser contract.
5. Run only these status-focused tests and confirm they fail before implementation:

   `pnpm exec vitest run tests/team-settings-workspace.client.spec.tsx -t "availability|quota refresh fails|teammate shared accounts"`

## Task 2: Derive honest UI state without expanding the data boundary

**Files:**

- Modify: `src/client/team/TeamSettings.tsx`
- Modify: `src/client/team/locales.ts`

1. Add localized neutral copy for a Team account that is configured as shared without claiming live availability.
2. Map an owned active contribution's capacity reason to the existing localized capacity labels and to a `done`, `warning`, or `error` state dot.
3. Treat absent owned-capacity projection conservatively as runtime unavailable rather than green/available.
4. Show local quota-refresh failures as an error in the account header and navigation while retaining the account and its Team authorization action.
5. Keep teammate entries visible, but label them as shared rather than currently available because the privacy-minimized teammate projection has no live health field.
6. Re-run the focused status tests and confirm they pass.

## Task 3: Verify and deliver the small PR

**Files:**

- Review: all files changed relative to `origin/main`

1. Run the whole affected DOM test file only:

   `pnpm exec vitest run tests/team-settings-workspace.client.spec.tsx`

2. Run the mandatory non-suite checks:

   `pnpm run build`

   `pnpm run verify:package`

3. Inspect the diff and worktree status, then create one focused commit.
4. Refresh the remote base if network access permits, push the branch, and open a draft PR targeting `main`.
5. Request an independent sub-agent review limited to this PR's diff, tests, browser boundary, and compatibility risk. Fix any blocking findings and repeat the focused validation/review.
6. Report separately: focused DOM evidence, build/package evidence, the absence of shared-3181 deployment or real OAuth validation, PR state, and remaining risks.
