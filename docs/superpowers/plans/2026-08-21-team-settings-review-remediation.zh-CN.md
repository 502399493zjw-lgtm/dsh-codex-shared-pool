# Team Settings Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复第二期 Team 邀请、Host 凭证切换、前端加入确认和成员离场清理中的高风险失败路径。

**Architecture:** Memory Store 使用 staged commit 保持与 PostgreSQL 事务相同的失败语义；Host 将所有 active/pending 凭证修改串行化，并把 pending Key 视为可恢复身份而不是可直接丢弃的缓存。浏览器显式区分未连接、凭证失效、服务不可用和已连接状态；成员离场则以已持久化的 revoked contribution 作为幂等清理标记并在失败后重试。

**Tech Stack:** TypeScript、React、Vitest、Cordis Host routes、Memory/PostgreSQL Team Store。

## Global Constraints

- 不修改 DSH core，只使用当前插件包和已发布 Cordis 扩展点。
- 浏览器不接收 Team Key；凭证读取、写入和远端验证只发生在 Host。
- 先写失败测试，再写最小实现；不提交、不推送、不发布。
- 保留当前 worktree 中全部用户未提交改动。

---

### Task 1: Memory 邀请接受 staged commit

**Files:**
- Modify: `src/team/store.ts`
- Test: `tests/team.spec.ts`

**Interfaces:**
- Consumes: `MemoryTeamStore.acceptInviteWithApiKey(token, displayName, apiKey)`
- Produces: Key 校验失败时成员、邀请、token hash 和 Key 集合均保持不变。

- [x] **Step 1: 写失败测试**

```ts
await expect(store.acceptInviteWithApiKey(invite.inviteToken, 'Mia', 'invalid')).rejects.toThrow('Team API key is invalid')
expect((await store.overview(ownerAuth)).members).toHaveLength(1)
await expect(store.previewInvite(invite.inviteToken)).resolves.toMatchObject({ teamName: 'Weekend' })
```

另加重复 supplied Key 用例，并断言失败后原邀请仍能使用新 Key 成功加入。

- [x] **Step 2: 运行测试并确认失败**

Run: `pnpm exec vitest run tests/team.spec.ts`

Expected: 无效 Key 后邀请预览失败或成员数量错误。

- [x] **Step 3: 拆分 Key 构造与提交**

```ts
const key = this.prepareKey(team.id, member.id, 'member', now, suppliedApiKey)
this.members.set(member.id, member)
team.memberIds.push(member.id)
this.commitKey(key)
invite.status = 'accepted'
```

`prepareKey` 只校验并返回记录，`commitKey` 才写入 `keys/keyHashes`；普通 `createKey` 复用两者。

- [x] **Step 4: 运行 Memory 与 PostgreSQL 聚焦测试**

Run: `pnpm exec vitest run tests/team.spec.ts tests/team-postgres.spec.ts`

Expected: PASS，失败语义一致。

### Task 2: Host 凭证转换状态机

**Files:**
- Modify: `src/team/management-routes.ts`
- Test: `tests/team-management-routes.spec.ts`

**Interfaces:**
- Produces: `withCredentialTransition<T>(operation)`，串行化 connect/join/recover/discard/disconnect/leave。
- Produces: recover 只可修复同一个 pending Key，不能覆盖不同 active Key。
- Produces: discard 在 pending 已获得远端身份时先远端离队，再删除本地 Key。

- [x] **Step 1: 写竞态与冲突失败测试**

```ts
const join = requestJoinWithDeferredRemote()
const discard = requestDiscard()
resolveRemoteJoin()
await expect(discard).rejects.toMatchObject({ status: 409 })
```

补充 connect 遇到 pending、recover 遇到不同 active、active 与 pending 相同时只清理残留 pending、discard 远端已接受时调用 leave 的测试。

- [x] **Step 2: 运行测试并确认失败**

Run: `pnpm exec vitest run tests/team-management-routes.spec.ts`

Expected: 当前 connect/recover 可覆盖，discard 可与 join 交错。

- [x] **Step 3: 实现串行转换与冲突检查**

```ts
private transitionTail: Promise<void> = Promise.resolve()

private async withCredentialTransition<T>(operation: () => Promise<T>): Promise<T> {
  const previous = this.transitionTail
  let release!: () => void
  this.transitionTail = new Promise(resolve => { release = resolve })
  await previous
  try { return await operation() } finally { release() }
}
```

所有写凭证操作通过该入口；connect/join 要求 active、pending 均为空。recover 比较已配置 active 的值，只有与 pending 相同才允许完成清理。

- [x] **Step 4: 实现安全 discard**

```ts
const pending = await this.pendingJoin()
try {
  await this.overview(pending.apiKey)
  await this.remote(TEAM_MEMBERS_LEAVE_PATH, { method: 'POST', body: {}, key: pending.apiKey })
} catch (error) {
  if (!isMissingRemoteIdentity(error)) throw error
}
await this.credentials.unset(this.pendingJoinRef())
```

如果 active 已经等于 pending Key，则只清理重复 pending，不执行远端离队。

- [x] **Step 5: 运行 Host 路由测试**

Run: `pnpm exec vitest run tests/team-management-routes.spec.ts tests/team-management-client.spec.ts`

Expected: PASS。

### Task 3: 前端连接状态与邀请确认

**Files:**
- Modify: `src/client/team/api.ts`
- Modify: `src/client/team/TeamSettings.tsx`
- Modify: `src/client/team/locales.ts`
- Test: `tests/team-management-client.spec.ts`
- Test: `tests/team-settings-workspace.client.spec.tsx`

**Interfaces:**
- Produces: `TeamManagementRequestError`，保留 HTTP `status`。
- Produces: configured Key 的 `invalid` 与 `unavailable` 独立界面。
- Produces: 邀请预览结果绑定 token 快照，旧响应不能恢复已清除的预览。

- [x] **Step 1: 写失败测试**

```tsx
managementApi.status.mockResolvedValue({ keyConfigured: true, ...status })
managementApi.overview.mockRejectedValue(Object.assign(new Error('expired'), { status: 401 }))
expect(await screen.findByText(zh.teamAccessInvalidTitle)).toBeDefined()
expect(screen.queryByRole('button', { name: zh.previewInvitation })).toBeNull()
```

补充 usage 单独失败仍显示 Team、token A 迟到响应不覆盖 token B、recover 4xx 后自动刷新状态。

- [x] **Step 2: 运行测试并确认失败**

Run: `pnpm exec vitest run tests/team-settings-workspace.client.spec.tsx tests/team-management-client.spec.ts`

Expected: configured overview 失败仍进入 onboarding，旧预览仍会写回。

- [x] **Step 3: 保留客户端 HTTP 状态并拆分刷新流程**

```ts
if (!response.ok) throw new TeamManagementRequestError(response.status, message)

const nextOverview = await api.overview()
setOverview(nextOverview)
try { setUsageResult(await api.usage(50)) } catch (cause) { setError(message(cause)) }
```

overview 的 401/404 映射到失效凭证，其余错误映射到服务不可用；两者都不展示 onboarding。失效态提供 `disconnect(false)` 清除本地连接。

- [x] **Step 4: 绑定邀请 token 快照**

```ts
const requestId = ++previewRequestId.current
const token = inviteToken.trim()
const preview = await api.previewInvite(token)
if (requestId === previewRequestId.current) setInvitePreview({ token, preview })
```

输入变化递增 request id；join 只提交预览记录中的 token。

- [x] **Step 5: 运行前端聚焦测试**

Run: `pnpm exec vitest run tests/team-settings-workspace.client.spec.tsx tests/team-management-client.spec.ts tests/team-settings-contract.spec.ts`

Expected: PASS。

### Task 4: 可恢复的成员离场清理

**Files:**
- Modify: `src/team/service.ts`
- Test: `tests/team.spec.ts`
- Test: `tests/team-management-routes.spec.ts`

**Interfaces:**
- Consumes: Store 中持久化为 `revoked` 的 contribution 列表。
- Produces: leave/remove/revoke 在中央状态提交后返回成功；router/broker 清理失败进入幂等后台重试。

- [x] **Step 1: 写故障注入测试**

```ts
router.drainAccount.mockRejectedValueOnce(new Error('temporary drain failure'))
await expect(service.removeMember(ownerAuth, memberId)).resolves.toMatchObject({ member: { status: 'removed' } })
await vi.runOnlyPendingTimersAsync()
expect(router.drainAccount).toHaveBeenCalledTimes(2)
```

再验证 leave 返回成功后 Host 删除 active Key，以及 broker 首次失败后重试。

- [x] **Step 2: 运行测试并确认失败**

Run: `pnpm exec vitest run tests/team.spec.ts tests/team-management-routes.spec.ts`

Expected: 当前 API 直接抛出 cleanup 错误，Host 不删除 Key。

- [x] **Step 3: 以 revoked 状态作为幂等清理标记**

```ts
private async cleanupAfterCommit(accounts: readonly TeamContributionAccountSummary[]): Promise<void> {
  try { await this.cleanupRevokedContributions(accounts) }
  catch { this.scheduleRevokedCleanupRetry() }
}
```

定时器查询所有 revoked contributions 并重试；只有 drain 和 broker revoke 全部成功后停止。dispose 清除定时器，防止生命周期泄漏。

- [x] **Step 4: 运行服务与路由测试**

Run: `pnpm exec vitest run tests/team.spec.ts tests/team-management-routes.spec.ts tests/team-routes.spec.ts`

Expected: PASS。

### Task 5: 全量验证与方案同步

**Files:**
- Modify: `docs/superpowers/plans/2026-08-21-team-settings-membership-journeys.zh-CN.md`

- [x] **Step 1: 同步状态机和清理语义**

把“放弃只删除本地 pending”改为“已存在远端身份时先远端离队”；把“原子清理”改为“中央事务提交 + 幂等后台清理”。

- [x] **Step 2: 运行测试与构建**

Run: `pnpm exec vitest run tests/team.spec.ts tests/team-postgres.spec.ts tests/team-management-routes.spec.ts tests/team-management-client.spec.ts tests/team-settings-workspace.client.spec.tsx tests/team-settings-contract.spec.ts tests/team-routes.spec.ts`

Run: `pnpm run build`

Run: `pnpm run verify:package`

Expected: 全部 PASS。

- [x] **Step 3: 检查最终工作树**

Run: `git status --short --branch`

Expected: 仅出现用户原有改动和本计划列出的修复文件；不产生提交。

### Task 6: 成员关系追加式审计

**Files:**
- Modify: `src/team/types.ts`
- Modify: `src/team/store.ts`
- Modify: `src/team/postgres-store.ts`
- Test: `tests/team.spec.ts`
- Test: `tests/team-postgres.spec.ts`

- [x] **Step 1: 添加角色变更、所有权转移、移除与离队审计模型**
- [x] **Step 2: Memory 在状态变更完成后追加记录，PostgreSQL 在同一事务写入 migration 10 审计表**
- [x] **Step 3: 验证成功操作有审计、失败事务不留下幽灵审计**

### Task 7: 设置页复审收尾

**Files:**
- Modify: `src/client/team/TeamSettings.tsx`
- Modify: `src/client/team/locales.ts`
- Test: `tests/team-settings-workspace.client.spec.tsx`

- [x] **Step 1: 父级 Team 设置与创建邀请、转移所有权、移出、退出、断开弹窗改为单层状态流**
- [x] **Step 2: Member 可只读查看邀请；显示邀请人、创建与过期时间**
- [x] **Step 3: 本地校验邀请 Token，补预览 live region、账号选中语义和 403/409 刷新**
- [x] **Step 4: 子弹窗打开时交接键盘焦点，取消后恢复到原 Team 设置操作按钮**

### Task 8: 滚动升级与真实 PostgreSQL 并发门禁

**Files:**
- Modify: `src/team/management-routes.ts`
- Modify: `src/team/postgres-store.ts`
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-08-21-team-settings-membership-journeys.md`
- Modify: `docs/superpowers/plans/2026-08-21-team-settings-membership-journeys.zh-CN.md`
- Test: `tests/team-management-routes.spec.ts`
- Test: `tests/team-postgres.spec.ts`
- Test: `tests/team-postgres.integration.spec.ts`

- [x] **Step 1: 旧邀请缺少 label 时使用安全回退，migration 9 保留默认值**
- [x] **Step 2: 明确中央 Team 服务优先的升级顺序**
- [x] **Step 3: 添加同一邀请并发接受和成功审计唯一性的真实 PostgreSQL 测试**
- [x] **Step 4: 聚焦测试、全量测试、构建和包格式验证通过；真实 PostgreSQL 因未配置 URL 跳过**
