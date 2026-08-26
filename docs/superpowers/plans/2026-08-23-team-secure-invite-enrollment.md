# Team Secure Invite Enrollment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Browser 在预览邀请码后仅持有短时本机加入句柄，并移除所有从 Browser 导入原始 Team API Key 的产品与路由入口。

**Architecture:** Browser 首次提交邀请码到同源 Team Host；Host 向 Team Server 校验后，把原始邀请码保存在进程内、限时且有上限的预览会话中，只返回安全预览与不可猜测的 `joinHandle`。确认加入时 Browser 只提交 `joinHandle + displayName`，Host 原子消费会话并沿用现有待加入凭据恢复机制。该切片不宣称完成邀请码持久化再次查看、远端签名 `joinLocator` 或完整 CSRF capability；三者分别作为后续独立安全切片。

**Tech Stack:** TypeScript 5、React、Cordis WebServer、Node.js `crypto`、Vitest、Testing Library、pnpm。

## Global Constraints

- 只在 `codex/team-phase-two-split` worktree 工作，不提交、推送或改写历史。
- Host 独占凭据、原始邀请码、认证文件与远程 Team 调用；Browser 只接收最小 JSON-safe 投影。
- `joinHandle` 使用 `randomBytes(32)`，有效期不超过 15 分钟；进程内会话最多 64 个，过期或最旧会话必须清理。
- Browser 预览成功后立即清空邀请码输入；加入请求体不得出现 `inviteToken` 或 `apiKey`。
- 保留现有 `PENDING_JOIN` 持久化与不确定结果恢复语义；候选 Team API Key 仍由 Host 生成。
- 兼容已验证的 stock DeepSeek Harness rc.8 / Cordis 4.0.1，不修改 DSH core。
- 行为变更先写失败测试；完成后运行聚焦测试、`pnpm run build` 与 `pnpm run verify:package`。

---

### Task 1: Browser-safe enrollment contract

**Files:**
- Modify: `src/shared/team-management.ts`
- Modify: `src/client/team/api.ts`
- Test: `tests/team-management-client.spec.ts`

**Interfaces:**
- Consumes: `TeamInvitePreview`、现有同源 JSON 请求器。
- Produces: `TeamManagementInvitePreview { teamName, label, expiresAt, teamStatus, joinHandle }`；`TeamManagementApi.join(joinHandle: string, displayName: string)`。

- [ ] **Step 1: Write the failing Browser contract tests**

```ts
it('joins with the opaque local handle returned by preview', async () => {
  const preview = await api.previewInvite('dsh_invite_secret-1234567890')
  await api.join(preview.joinHandle, 'Edison')
  expect(fetchMock).toHaveBeenLastCalledWith(
    TEAM_MANAGEMENT_JOIN_PATH,
    expect.objectContaining({ body: JSON.stringify({ joinHandle: preview.joinHandle, displayName: 'Edison' }) }),
  )
})

it('does not expose a raw Team key connection method', () => {
  expect('connect' in api).toBe(false)
})
```

- [ ] **Step 2: Run the contract tests and verify RED**

Run: `pnpm exec vitest run tests/team-management-client.spec.ts`

Expected: FAIL because the preview parser does not return `joinHandle`, join still posts `inviteToken`, and `connect` exists.

- [ ] **Step 3: Implement the minimum Browser-safe contract**

```ts
export interface TeamManagementInvitePreview extends TeamInvitePreview {
  readonly joinHandle: string
}

join(joinHandle: string, displayName: string): Promise<TeamManagementConnectionResult> {
  return this.request(TEAM_MANAGEMENT_JOIN_PATH, { method: 'POST', body: { joinHandle, displayName } }, parseConnection)
}
```

Delete `TEAM_MANAGEMENT_CONNECT_PATH` and `TeamManagementApi.connect`; validate `joinHandle` as a bounded `dsh_join_` capability in the response parser.

- [ ] **Step 4: Run the contract tests and verify GREEN**

Run: `pnpm exec vitest run tests/team-management-client.spec.ts`

Expected: PASS.

### Task 2: Host-owned short-lived preview sessions

**Files:**
- Modify: `src/team/management-routes.ts`
- Test: `tests/team-management-routes.spec.ts`

**Interfaces:**
- Consumes: `TeamManagementInvitePreview` from Task 1 and the existing remote preview/accept endpoints.
- Produces: `TeamManagementProxy.previewInvite(inviteToken)` returning a handle; `TeamManagementProxy.join(joinHandle, displayName)` resolving and consuming it.

- [ ] **Step 1: Write failing Host route tests**

```ts
it('keeps the invite token Host-only between preview and join', async () => {
  const preview = await post(TEAM_MANAGEMENT_INVITES_PREVIEW_PATH, { inviteToken })
  expect(preview.body).not.toHaveProperty('inviteToken')
  await post(TEAM_MANAGEMENT_JOIN_PATH, { joinHandle: preview.body.joinHandle, displayName: 'Edison' })
  expect(remoteAcceptBody).toEqual(expect.objectContaining({ inviteToken, displayName: 'Edison' }))
})

it('rejects expired and replayed join handles before a remote accept call', async () => {
  // inject a short TTL/clock, consume once, then assert the next call is 400 and fetch count is unchanged
})
```

Also assert the registered route list no longer contains `/team-client/connect` and unknown request fields fail closed.

- [ ] **Step 2: Run the Host route tests and verify RED**

Run: `pnpm exec vitest run tests/team-management-routes.spec.ts`

Expected: FAIL because join expects an invite token, preview creates no Host session, and the connect route remains registered.

- [ ] **Step 3: Implement bounded preview session storage**

```ts
interface InvitePreviewSession {
  readonly inviteToken: string
  readonly expiresAt: number
  readonly createdAt: number
}

const INVITE_PREVIEW_SESSION_TTL_MS = 15 * 60 * 1000
const MAX_INVITE_PREVIEW_SESSIONS = 64

const joinHandle = `dsh_join_${randomBytes(32).toString('base64url')}`
sessions.set(joinHandle, {
  inviteToken,
  createdAt: now,
  expiresAt: Math.min(preview.expiresAt, now + INVITE_PREVIEW_SESSION_TTL_MS),
})
```

Prune expired entries before insert/read, evict the oldest entry at the cap, consume the handle only after the pending join record is durably written, and unregister/delete the raw-key connect handler.

- [ ] **Step 4: Run the Host route tests and verify GREEN**

Run: `pnpm exec vitest run tests/team-management-routes.spec.ts`

Expected: PASS, including retry/recovery and credential-transition tests.

### Task 3: Join UI clears secrets and exposes one path

**Files:**
- Modify: `src/client/team/TeamSettings.tsx`
- Modify: `src/client/team/TeamSettings.module.css`
- Modify: `src/client/team/locales.ts`
- Test: `tests/team-settings-workspace.client.spec.tsx`

**Interfaces:**
- Consumes: `previewInvite(token) -> { joinHandle, ...preview }` and `join(joinHandle, displayName)`.
- Produces: a single invitation onboarding panel with no Team API Key field.

- [ ] **Step 1: Write failing UI tests**

```tsx
expect(inviteInput).toHaveValue('')
expect(managementApi.join).toHaveBeenCalledWith('dsh_join_local-handle-1234567890', 'Edison')
expect(screen.queryByLabelText(zh.teamKey)).toBeNull()
```

The assertions run after preview succeeds and after confirmation respectively.

- [ ] **Step 2: Run the UI tests and verify RED**

Run: `pnpm exec vitest run tests/team-settings-workspace.client.spec.tsx`

Expected: FAIL because the component retains the token, joins with it, and renders the key-import panel.

- [ ] **Step 3: Implement the single secure enrollment path**

```ts
const preview = await api.previewInvite(token)
setInviteToken('')
setInvitePreview(preview)

await api.join(invitePreview.joinHandle, displayName.trim())
```

Remove `teamKey`, `connectTeam`, the Team key input/card, and obsolete onboarding copy; make `.connectionGrid` a single-column container.

- [ ] **Step 4: Run the UI tests and verify GREEN**

Run: `pnpm exec vitest run tests/team-settings-workspace.client.spec.tsx`

Expected: PASS.

### Task 4: Integration verification and review

**Files:**
- Modify only if a failure identifies a defect in a file already listed above.
- Test: `tests/team-management-client.spec.ts`
- Test: `tests/team-management-routes.spec.ts`
- Test: `tests/team-settings-workspace.client.spec.tsx`

**Interfaces:**
- Consumes: the finished local enrollment contract.
- Produces: reproducible test/build/package evidence and a reviewer gate for the next security slice.

- [ ] **Step 1: Run the focused security regression set**

Run: `pnpm exec vitest run tests/team-management-client.spec.ts tests/team-management-routes.spec.ts tests/team-settings-workspace.client.spec.tsx`

Expected: PASS.

- [ ] **Step 2: Run repository gates**

Run: `pnpm run build`

Expected: PASS.

Run: `pnpm run verify:package`

Expected: PASS as a package-format check; do not report it as a stock-install smoke test.

- [ ] **Step 3: Ask a subagent for two-stage review**

Review criteria: first compare implementation with this plan and the Team product spec; then inspect code quality, replay/expiry behavior, Browser secret leakage, route registration, and regression risk. Resolve all P0/P1 findings before handoff.

- [ ] **Step 4: Record exact Git state without committing**

Run: `git status --short --branch` and `git diff --check`.

Expected: branch remains `codex/team-phase-two-split`; only intended files from this slice plus pre-existing user-owned changes are present; no whitespace errors.

## Self-review

- Spec coverage: this plan covers the Browser secret boundary and local preview-session portion of SPEC-TEAM-004. Persistent invite re-reveal envelopes, signed remote `joinLocator`, KEK rotation, terminal envelope clearing, and Host-issued CSRF/session capability remain explicitly outside this independently testable slice.
- Placeholder scan: no `TBD`, `TODO`, “similar to”, or unspecified error-handling steps remain.
- Type consistency: every Browser join call uses `joinHandle`; only Host session state and the existing pending-join record retain `inviteToken`; `TeamManagementInvitePreview` is the sole projection carrying the handle.
