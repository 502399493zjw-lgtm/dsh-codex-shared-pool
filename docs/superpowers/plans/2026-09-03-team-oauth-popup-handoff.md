# Team OAuth Popup Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Team browser OAuth survive authorization-tab adoption by the Codex in-app browser and report navigation failure without leaving an unmanaged popup.

**Architecture:** Reuse the existing same-origin authorization popup bridge already used by the local Codex account flow. Keep Team credential capture and transfer on the Host; only replace the browser-side popup handoff and retain the existing Team polling and error paths.

**Tech Stack:** React, TypeScript, Vitest, Testing Library, pnpm

## Global Constraints

- Base the change on merged PR #27 at `fc6c3f85487e443bfc742bdffeb3f1d28691a87d` on a `codex/` branch.
- Do not expose OAuth URLs, tokens, credentials, authentication files, or machine-specific paths to the browser beyond the existing minimum typed projection.
- Do not restart or overwrite the shared DSH services on ports 3181 and 3197.
- Run focused tests only, followed by `pnpm run build` and `pnpm run verify:package`.
- Create focused commits, push the branch, open a draft pull request, and obtain an independent change-scoped subagent review before presenting it for merge approval.

---

### Task 1: Adopt the authorization popup bridge in Team settings

**Files:**
- Modify: `src/client/team/TeamSettings.tsx`
- Test: `tests/team-settings-workspace.client.spec.tsx`

**Interfaces:**
- Consumes: `openAuthorizationPopupBridge(): AuthorizationPopupController | null` from `src/client/authorization-popup.ts`
- Produces: Team browser OAuth navigation that treats `AuthorizationPopupController.window === null` as a successfully adopted tab when `navigate(url)` resolves `true`

- [x] **Step 1: Write the failing adopted-tab test**

Add a test controller whose `window` is `null`, whose `navigate` resolves `true`, and whose `close` is observable. Start Team browser OAuth and assert that `navigate` receives the authorization URL, the waiting presentation remains visible, and `browserPopupBlocked` is not shown.

```ts
const adoptedPopup = {
  window: null,
  navigate: vi.fn().mockResolvedValue(true),
  close: vi.fn(),
}
authorizationPopupBridge.open.mockReturnValueOnce(adoptedPopup)

expect(adoptedPopup.navigate).toHaveBeenCalledWith(challenge.authorizationUrl)
expect(screen.getByRole('region', { name: '等待浏览器授权' })).toBeDefined()
expect(screen.queryByText(zh.browserPopupBlocked)).toBeNull()
```

- [x] **Step 2: Run the focused test and confirm the regression**

Run: `pnpm exec vitest run tests/team-settings-workspace.client.spec.tsx -t "continues Team authorization when the in-app browser adopts the popup"`

Expected: FAIL because Team settings calls `window.open` and cannot use the adopted-tab controller.

- [x] **Step 3: Replace raw popup manipulation with the bridge**

Import `openAuthorizationPopupBridge` and `AuthorizationPopupController`; store the controller in `oauthPopup`. Open it synchronously before the Team start request, await `controller.navigate(challenge.authorizationUrl)`, show the existing blocked warning on a `false` result, and release the controller reference without closing it when `controller.window === null` after successful adoption.

```ts
const pendingPopup = method === 'browser' ? openAuthorizationPopupBridge() : null
if (method === 'browser' && pendingPopup === null) {
  setError(t('browserPopupOpenFailed'))
  return Promise.resolve()
}
if (challenge.method === 'browser' && pendingPopup !== null) {
  const navigated = await pendingPopup.navigate(challenge.authorizationUrl)
  if (!navigated) {
    pendingPopup.close()
    setOAuthNavigationBlocked(true)
  } else if (pendingPopup.window === null && oauthPopup.current === pendingPopup) {
    oauthPopup.current = null
  }
}
```

- [x] **Step 4: Run focused browser and Team tests**

Run: `pnpm exec vitest run tests/team-settings-workspace.client.spec.tsx tests/authorization-popup-ack.client.spec.ts tests/auth-routes.spec.ts`

Expected: PASS.

- [x] **Step 5: Verify the package**

Run: `pnpm run build`

Expected: PASS.

Run: `pnpm run verify:package`

Expected: PASS.

- [ ] **Step 6: Deliver through the repository workflow**

Review the diff for secrets and unrelated changes, commit only the plan, Team settings change, and focused test, push `codex/fix-team-oauth-callback`, open a draft pull request against `main`, then request an independent change-scoped subagent review. Resolve blocking findings and repeat the focused checks before reporting the pull request for user merge approval.

### Task 2: Repair inherited OAuth failure-code assertions

**Files:**
- Modify: `tests/team-management-routes.spec.ts`

**Interfaces:**
- Consumes: PR #27 cancellation body `{ accountId, discardInitial, failureCode }`
- Produces: regression expectations aligned with `TEAM_AUTHORIZATION_FAILED_CODE`

- [x] **Step 1: Confirm the inherited failure on `main`**

Compare PR CI with the CI run for `main@fc6c3f8`; both must fail only because two cancellation-body assertions omit `failureCode`.

- [x] **Step 2: Correct the two stale expectations**

```ts
expect(cancelRequest.body).toBe(JSON.stringify({
  accountId: 'account-1',
  discardInitial: true,
  failureCode: TEAM_AUTHORIZATION_FAILED_CODE,
}))
```

- [x] **Step 3: Run only the two inherited failing tests**

Run: `pnpm exec vitest run tests/team-management-routes.spec.ts -t "discards the initial contribution when the provider emits an unsafe browser authorization URL|discards the initial browser OAuth contribution when the local routes are disposed"`

Expected: PASS.

- [ ] **Step 4: Commit and push the assertion repair**

Commit the two expectation changes separately, push the existing PR branch, and wait for CI plus the independent review conclusion.

### Task 3: Preserve popup opener isolation

**Files:**
- Modify: `src/auth-routes.ts`
- Test: `tests/auth-routes.spec.ts`

**Interfaces:**
- Consumes: the same-origin authorization bridge HTML returned by `authorizationPopup`
- Produces: a bridge page that clears both `window.opener` and `window.name` before navigating toward the provider

- [x] **Step 1: Add and run the failing security assertion**

Assert that the bridge response body contains `window.opener=null` before its `window.location.replace` call, then run `pnpm exec vitest run tests/auth-routes.spec.ts -t "hands an adopted popup the provider URL and records acknowledgement"` and confirm failure.

- [x] **Step 2: Clear the opener in the bridge document**

```html
<script nonce="...">try{window.opener=null}catch{}try{window.name=''}catch{}window.location.replace(...)</script>
```

- [ ] **Step 3: Repeat focused verification and independent review**

Run the three browser/Team test files, both corrected Host cleanup tests, `pnpm run build`, and `pnpm run verify:package`; push the fix and request another change-scoped subagent review.
