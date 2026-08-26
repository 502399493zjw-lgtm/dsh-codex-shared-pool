# Team 永久解散 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为当前 Team Owner 提供可恢复确认、不可逆且并发安全的 Team 永久解散能力，并让所有已连接 Host 最终显示明确的已解散终态。

**Architecture:** 中央 Team Host 在单个数据库事务内持久化 `dissolved` 终态、撤销 Team 内访问与容量并保存幂等结果；外部 Broker 清理由事务后的可重试任务完成。本机 Host 在发请求前密封保存操作 ID 与恢复秘密，面对响应丢失时查询同一次操作，先保存无秘密终态、再 ACK，最后独立清理本机 Team Key。Browser 只接收最小终态投影，普通成员旧 Key 通过粗粒度诊断得到 `410 team_dissolved`。

**Tech Stack:** TypeScript、Cordis/DSH 插件路由、React、Node test runner、Memory TeamStore、PostgreSQL/pg-mem、CSS Modules。

## Global Constraints

- 不修改 DSH core；Host 单独持有 Team Key、恢复秘密、凭据文件和远端访问。
- 不把恢复秘密、API Key、邀请明文、账号凭据或全 Team 私密明细投影到 Browser、日志、审计和普通错误。
- 所有改变 Team 生命周期的写入先锁 Team，再锁成员、邀请、Key、贡献和操作记录；不得出现解散后创建新 Key、新邀请或新贡献的竞态。
- `active | paused → dissolved` 只递增一次 `lifecycleRevision`；`dissolved` 永不恢复。
- 数据库终态不依赖外部 Broker 成功；Broker 清理失败进入现有可重试队列。
- 先写失败测试，再写实现；保持现有未提交改动，不执行提交、推送、发布或破坏性 Git 清理。
- 验收依次运行聚焦测试、全量测试、`pnpm run build`、`pnpm run verify:package`；真实 stock DSH tarball 安装 smoke 单独报告。

---

## Task 1：冻结生命周期与解散协议

**Files:**

- Modify: `src/team/types.ts`
- Modify: `src/team/index.ts`
- Modify: `src/shared/team-management.ts`
- Test: `tests/team.spec.ts`
- Test: `tests/team-routes.spec.ts`

- [ ] 在 Memory Store 测试中先覆盖：初始化 revision 为 1；暂停/恢复携带操作 ID 与 expected revision；ABA 陈旧写返回 409；同操作同绑定幂等；同操作不同绑定冲突。
- [ ] 在解散测试中先覆盖：仅当前 Owner；`active` 与 `paused` 均可解散；Team 名称严格逐字符匹配；一次事务后成员、邀请、Key 与贡献全部不可用；重复恢复返回同一结果；终态不能恢复。
- [ ] 将共享模型收敛为以下无秘密协议，并为所有 Browser 可见解析器补严格字段校验：

```ts
export type TeamStatus = 'active' | 'paused' | 'dissolved'

export interface TeamSummary {
  readonly id: string
  readonly name: string
  readonly status: TeamStatus
  readonly lifecycleRevision: number
  readonly createdAt: number
}

export interface TeamLifecycleTransitionInput {
  readonly operationId: string
  readonly expectedLifecycleRevision: number
  readonly status: 'active' | 'paused'
}

export interface TeamDissolutionInput {
  readonly operationId: string
  readonly expectedLifecycleRevision: number
  readonly confirmationName: string
  readonly recoverySecretHash: string
}

export interface TeamDissolutionResult {
  readonly operationId: string
  readonly teamId: string
  readonly teamName: string
  readonly status: 'dissolved'
  readonly lifecycleRevision: number
  readonly dissolvedAt: number
  readonly terminatedMemberCount: number
  readonly revokedInviteCount: number
  readonly revokedKeyCount: number
  readonly revokedContributionCount: number
}
```

- [ ] 增加中央路径 `POST /team/dissolve`、`POST /team/dissolve/result`、`POST /team/dissolve/ack` 与 `POST /team/connection-terminal`；恢复与 ACK 使用操作 ID 加原始恢复秘密，不依赖已撤销 Owner Key。
- [ ] 增加本机管理路径 `POST /team-client/dissolve`、`POST /team-client/dissolution/recover`、`POST /team-client/dissolution/clear`，结果只允许 `confirming` 或无秘密 `confirmed` 投影。
- [ ] 运行 `./node_modules/.bin/tsx --test tests/team.spec.ts tests/team-routes.spec.ts`。

## Task 2：实现 Memory 参考状态机与审计

**Files:**

- Modify: `src/team/store.ts`
- Test: `tests/team.spec.ts`

- [ ] 为 Team 记录增加 `lifecycleRevision`、`dissolvedAt`；为 Key 增加 `revokedReason`，仅使用 `member_removed | member_left | device_revoked | team_dissolved`。
- [ ] 为生命周期操作保存请求绑定摘要、原 expected revision、结果、恢复秘密摘要与 ACK 时间；操作 ID 重放只有绑定完全一致才返回原结果。
- [ ] 将 `setTeamStatus(auth, input)` 改为 Owner-only 原子转换：目标与当前状态相同且 expected revision 为当前值时无变更成功；真实转换恰好递增一次 revision 并写一条无秘密审计。
- [ ] 实现 `dissolveTeam(auth, input)`：先重验 Team/Owner/revision/名称，再按稳定 ID 顺序撤销待用邀请并清空 envelope、终止所有成员、撤销所有 Key、撤销所有贡献、写终态与审计，最后返回需执行外部清理的贡献列表。
- [ ] 实现 `recoverTeamDissolution(operationId, recoverySecret)` 与可重复 `ackTeamDissolution(...)`；未知操作、错误秘密和错误绑定返回统一不可用错误，不能泄露 Team 是否存在。
- [ ] 保留已撤销 Key 摘要与 `team_dissolved` 原因至少 365 天；诊断接口只返回粗粒度终态，不返回成员、Team 内部或操作信息。
- [ ] 运行 `./node_modules/.bin/tsx --test tests/team.spec.ts`。

## Task 3：用 Team-first 锁实现 PostgreSQL 原子终态

**Files:**

- Modify: `src/team/postgres-store.ts`
- Modify: `src/team/postgres-routing.ts`
- Test: `tests/team-postgres.spec.ts`
- Test: `tests/team-postgres.integration.spec.ts`

- [ ] 先添加 pg-mem 与真实 Postgres 测试：Owner 与新 Key/邀请/贡献并发、Owner 与暂停/恢复并发、两次解散并发、响应重放、错误秘密、数据库回滚；任何成功解散后都不能留下可认证成员或可路由贡献。
- [ ] 新增 migration：扩展 Team 状态约束为 `active | paused | dissolved`；加入正整数 `lifecycle_revision` 与 `dissolved_at`；Key 加 `revoked_reason`；新增无秘密 `team_lifecycle_operations` 和 `team_lifecycle_audit_events` 表及唯一索引。
- [ ] 把所有会创建或恢复访问能力的写入统一为 `Team FOR UPDATE → 重新认证/授权 → 子资源锁`，至少覆盖邀请创建/接受、Key 创建、贡献注册/授权、生命周期写入与所有权变更。
- [ ] 在一个事务内完成解散：锁 Team；重验 Owner 与 revision；写 `dissolved` 和 revision；撤销转让请求（当前无持久化待处理请求时保持空操作）；撤销邀请并覆盖摘要/清空密文；终止成员；撤销 Key 并写原因；撤销贡献；写操作结果与审计。
- [ ] 恢复查询只比较恒定时间的恢复秘密摘要；ACK 可重复，并且不改变终态与审计次数。
- [ ] 所有摘要构造和 SQL row parser 都要求有效 `lifecycleRevision`；迁移前 Team 得到 revision 1。
- [ ] 运行 `./node_modules/.bin/tsx --test tests/team-postgres.spec.ts`；仅在设置 `DSH_TEAM_POSTGRES_TEST_URL` 时运行真实 Postgres integration。

## Task 4：接入中央路由、事务后清理与终态诊断

**Files:**

- Modify: `src/team/service.ts`
- Modify: `src/team/routes.ts`
- Modify: `src/team/runtime.ts`
- Test: `tests/team-routes.spec.ts`
- Test: `tests/team-runtime.spec.ts`
- Test: `tests/team-request-service.spec.ts`

- [ ] 先添加路由失败测试：多余字段、错误格式、非 Owner、错误名称、revision 冲突、已解散写入、恢复秘密错误、`Cache-Control: no-store`、错误体不含秘密。
- [ ] `POST /team/dissolve` 仅在事务成功后调用现有 revoked-contribution 清理机制；清理失败记录重试，不回滚或把解散响应改成失败。
- [ ] 恢复与 ACK 路由不要求 Bearer Key，只接受严格的操作 ID 与恢复秘密请求体，成功响应强制 `no-store`。
- [ ] 普通用户写入在 Team 已解散后全部终止；晚到 OAuth/容量回调不得把 revoked 贡献改回可路由状态。
- [ ] 旧 Key 诊断命中 `team_dissolved` 时返回 `410` 与固定代码；未知、其他 Team 或未撤销 Key 不泄露可枚举信息。
- [ ] 运行 `./node_modules/.bin/tsx --test tests/team-routes.spec.ts tests/team-runtime.spec.ts tests/team-request-service.spec.ts`。

## Task 5：实现本机 Host 的响应丢失恢复协议

**Files:**

- Modify: `src/team/management-routes.ts`
- Modify: `src/shared/team-management.ts`
- Test: `tests/team-management-routes.spec.ts`

- [ ] 先写失败测试覆盖顺序：生成一次 operation ID 和至少 256-bit recovery secret；远端请求前持久化 pending；超时保留原 Key/同一操作；成功后先持久化无秘密 terminal，再 ACK，再删除 pending 秘密，最后独立清理 Key。
- [ ] pending 凭据只保存在 Host credential store，包含操作 ID、恢复秘密、Team ID/名称、expected revision 与发起时间；Browser 投影不得包含操作 ID、恢复秘密、Key 或贡献凭据。
- [ ] `dissolveTeam()` 对确定的 `403/409` 返回可重试表单错误并刷新身份/revision；对超时、断连与未知 5xx 返回 `confirming`，不能生成第二个操作。
- [ ] `recoverDissolution()` 总是复用 pending：先查询原结果；仍未知且 Owner Key 可用时重放原始解散请求；确认后执行 terminal → ACK → pending 清理 → Key 清理顺序。
- [ ] Key 删除失败时返回 `cleanup_retry_required`；只读 Key 来源返回 `cleanup_manual_required`；两者都不得把中央终态显示成失败。
- [ ] 本机重启后 `status()` 优先投影 pending/terminal；terminal 存在时不再调用普通 overview。
- [ ] 将远端 `410 team_dissolved` 映射为无秘密 terminal 投影，使其他成员设备进入相同终态页。
- [ ] 运行 `./node_modules/.bin/tsx --test tests/team-management-routes.spec.ts`。

## Task 6：实现严格 Browser API 与 Owner-only 解散交互

**Files:**

- Modify: `src/client/team/api.ts`
- Modify: `src/client/team/TeamSettings.tsx`
- Modify: `src/client/team/TeamSettings.module.css`
- Modify: `src/client/team/locales.ts`
- Test: `tests/team-management-client.spec.ts`
- Test: `tests/team-settings-workspace.client.spec.tsx`

- [ ] 先写客户端测试：Owner 在 active/paused 可见，成员无入口；弹窗四条后果与 Team 名称；精确匹配才启用；提交期间不可关闭或重复提交；`403/409`保留输入并刷新；confirming/confirmed 不回 overview。
- [ ] typed API 严格拒绝多余字段，并仅暴露以下无秘密状态：

```ts
type TeamDissolutionView =
  | { readonly state: 'confirming'; readonly teamName: string; readonly requestedAt: number }
  | {
      readonly state: 'confirmed'
      readonly teamName: string
      readonly dissolvedAt: number
      readonly localCleanup: 'completed' | 'retry_required' | 'manual_required'
    }
```

- [ ] 在 Owner 生命周期危险区增加“永久解散 Team”；弹窗明确：全部成员失去访问、邀请码失效、设备连接失效、共享账号停止承接新请求，不展示 Browser 无法准确知道的全 Team 设备或账号数量。
- [ ] 输入与 Team 名称严格逐字符相等才允许提交；提交后锁定输入、取消、关闭与按钮，并显示“正在永久解散…”。
- [ ] 未知结果切换到独立“正在确认 Team 解散结果”页，只允许继续确认；确认成功后展示不可逆终态，不再获取 overview。
- [ ] 本机清理分别展示已完成、可重试和只读来源手动清理；`410 team_dissolved` 的普通成员也进入终态页。
- [ ] 运行 `./node_modules/.bin/tsx --test tests/team-management-client.spec.ts tests/team-settings-workspace.client.spec.tsx`。

## Task 7：端到端并发、安全与回归验收

**Files:**

- Modify: `tests/team-postgres.integration.spec.ts`
- Modify: `tests/team-live-sharing.spec.ts`
- Modify: `docs/acceptance/team-owner-member-product-spec.zh-CN.md` only if implementation exposes a proven ambiguity

- [ ] 运行生命周期、Host、Browser、路由和实时共享聚焦测试并修复失败。
- [ ] 检查响应、快照、日志和 diff 中不含恢复秘密、API Key、邀请明文与 machine-specific path。
- [ ] 运行全量测试、`./node_modules/.bin/tsc --noEmit`、`pnpm run build` 与 `pnpm run verify:package`。
- [ ] 若环境存在 `DSH_TEAM_POSTGRES_TEST_URL`，运行真实 Postgres 并发测试；否则明确记录未验证风险。
- [ ] 若磁盘和已发布 pinned DSH CLI 可用，pack 后装入隔离 `DSH_HOME` 做真实 stock-install smoke；否则只把 `verify:package` 报告为包格式校验。
- [ ] 让独立 subagent 只读复审产品覆盖、Team-first 锁序、秘密边界、恢复顺序与 UI 终态；修复所有 P0/P1 后重跑受影响测试。
- [ ] 最终执行 `git status --short --branch` 与 `git diff --check`，按 AGENTS.md 报告用户可见结果、改动文件、实际命令、失败/跳过项和精确 Git 状态，不创建提交。
