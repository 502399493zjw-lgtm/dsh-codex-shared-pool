# Team Settings Production UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将已经确认的中文 Team 设置 spec 和交互原型落到正式 React 插件页面，形成清晰的`用量 / 成员 / 邀请码`工作区，并完成 stock DSH 中的真实界面验收。

**Architecture:** 保留现有 Host 同源 API、角色塑形 DTO、邀请秘密生命周期和生命周期事务；只重组已加入 Team 后的 Browser 信息架构。`TeamSettings` 以角色感知的顶层导航选择一个任务页，Team 级操作统一由页头菜单触发；个人账号共享继续归 Codex 账号管理区，不在 Team 工作区重复渲染。

**Tech Stack:** TypeScript、React 18、CSS Modules、DSH Client UI primitives、Vitest、stock DeepSeek Harness `0.1.0-rc.8`、Cordis `4.0.1`。

## Global Constraints

- 只在`codex/team-phase-two-split` worktree 中工作，保留全部已有未提交改动。
- 不修改 DSH core；Browser 不接收 Team Key、Provider 凭据、内部 Credits 或其他成员的账号明细。
- 行为变更先写失败测试，再做最小实现；本任务不 commit、push、publish。
- 邀请主列表只展示当前仍有效且未使用的邀请；撤销、过期和已使用状态只保留在服务端审计中。
- 完整邀请码只在显式创建/查看弹窗中短暂存在，并继续遵守关闭、页面隐藏、上下文变化和 60 秒清除规则。

---

### Task 1: 锁定正式 Team 工作区信息架构

**Files:**
- Modify: `tests/team-settings-workspace.client.spec.tsx`
- Modify: `src/client/team/TeamSettings.tsx`
- Modify: `src/client/team/TeamSettings.module.css`
- Modify: `src/client/team/locales.ts`

**Interfaces:**
- Consumes: 现有 `TeamManagementOverview`、`TeamManagementUsageResult` 和管理 mutation。
- Produces: `用量 / 成员 / Owner-only 邀请码`三个顶层任务；每次只渲染一个任务页。

- [ ] **Step 1: 写失败的正式 IA 测试**

  断言 Owner 可见三个工作区入口，Member 只见用量和成员；Team 页面不再出现共享账号、未共享账号、个人导航、容量、Credits 或说明卡。

- [ ] **Step 2: 运行测试并确认 RED**

  Run: `pnpm exec vitest run tests/team-settings-workspace.client.spec.tsx --reporter=dot`

  Expected: FAIL，指出正式页面尚无三个顶层入口且仍渲染个人账号模块。

- [ ] **Step 3: 重组正式 React 页面**

  添加角色感知的工作区状态和语义导航；复用现有 `TeamUsageSection`、成员列表及邀请列表，每次只呈现当前任务。成员页 Owner 主按钮为`邀请成员`，点击后切换到邀请码页；邀请码页实际创建按钮保持`生成邀请码`。

- [ ] **Step 4: 同步最终中文用量文案**

  使用`Team 总用量`、`我的用量`、`预估费用（USD）`、`Token 用量`和`请求次数`；完整数据不显示状态标签。

- [ ] **Step 5: 运行聚焦测试**

  Run: `pnpm exec vitest run tests/team-settings-workspace.client.spec.tsx tests/team-settings-contract.spec.ts tests/team-usage-view-model.spec.ts --reporter=dot`

  Expected: PASS。

### Task 2: 收口 Team 管理与成员关系动作

**Files:**
- Modify: `tests/team-settings-workspace.client.spec.tsx`
- Modify: `src/client/team/TeamSettings.tsx`
- Modify: `src/client/team/TeamSettings.module.css`
- Modify: `src/client/team/locales.ts`

**Interfaces:**
- Produces: 页头`Team 管理`菜单；Owner 可暂停/恢复、发起所有权转让和解散，Member 只可退出。

- [ ] **Step 1: 写角色菜单失败测试**

  验证 Owner 与 Member 的菜单项、成员行菜单、Owner 首位、无头像，以及所有权待处理提示。

- [ ] **Step 2: 实现页头管理菜单**

  将旧页面底部敏感操作移入分组菜单，继续复用现有确认弹窗、revision 绑定、busy 防重和焦点恢复逻辑。

- [ ] **Step 3: 验证邀请秘密和危险操作回归**

  Run: `pnpm exec vitest run tests/team-settings-workspace.client.spec.tsx tests/team-management-client.spec.ts tests/team-management-routes.spec.ts --reporter=dot`

  Expected: PASS；Member DOM 中没有 Owner 邀请元数据或管理操作。

### Task 3: 响应式、可访问性与 Browser 边界

**Files:**
- Modify: `src/client/team/TeamSettings.module.css`
- Modify: `tests/team-settings-workspace.client.spec.tsx`
- Create: `artifacts/validation/20260825-team-settings-production-ui/*`（ignored evidence only）

**Interfaces:**
- Produces: 320px、375px、768px 和桌面宽度均可用的正式 DSH 页面；导航、菜单和弹窗具备当前态及焦点语义。

- [ ] **Step 1: 增加导航与焦点测试**

  覆盖 `aria-current`、菜单展开态、弹窗初始焦点、关闭后返回触发点，以及切换工作区时秘密弹窗清理。

- [ ] **Step 2: 完成响应式 CSS**

  768px 以下先呈现 Team 上下文再呈现横向可换行导航；320px 与 375px 无页面级横向滚动，主要触控目标最小 44px，指标不截断。

- [ ] **Step 3: 运行完整本地质量门**

  Run: `pnpm test`

  Run: `pnpm run build`

  Run: `pnpm run verify:package`

  Run: `git diff --check`

  Expected: 全部 PASS。

- [ ] **Step 4: exact tarball stock DSH 验收**

  打包当前工作树并安装到隔离 `DSH_HOME`，固定 DSH `0.1.0-rc.8`；在正式页面分别验证 Owner/Member 导航、管理菜单、用量状态、邀请生成/再次查看/撤销和响应式布局，保存 trace、截图、`result.json`、`provenance.json`与`resources.json`。

### Task 4: 发布前独立门槛

**Files:**
- Modify: `docs/acceptance/team-mvp-phase-two.md`

**Interfaces:**
- Produces: 可审计地区分 UI 已完成、真实 PostgreSQL 已证明、以及仍未完成的加入/退出恢复协议。

- [ ] **Step 1: 运行真实 PostgreSQL 套件**

  Run: `DSH_TEAM_POSTGRES_TEST_URL=<postgres-17-url> pnpm run test:postgres`

  Expected: 23 个 PostgreSQL 顶层用例 PASS；若环境仍不可用则保持 `NOT_PROVEN`，不能用 pg-mem 替代。

- [ ] **Step 2: 单独实现最终加入/退出恢复协议**

  后续计划必须覆盖 `attemptId / operationId / recoverySecret / joinLocator`、单 attempt 槽、结果查询、取消、ACK 和永久提交标记；当前 `preview + accept + pending key`只能作为已有实现，不能宣称通过最终网络不确定性 spec。

- [ ] **Step 3: 明确费用状态**

  在可信版本化价格目录接入前，生产可以如实显示`费用未计量`和`—`，不得把 Token 或内部 Credits 临时换算成 USD。

## Self-Review

- Spec coverage: 顶层 IA、Owner/Member 权限、无头像、邀请码秘密、用量文案、响应式、stock 安装和真实 PG 均有明确任务。
- Boundary check: Team 设置删除重复个人模块，但不删除 Host 的当前成员专属 contribution API；个人共享入口的既有 Codex 账号区域保持产品归属。
- Placeholder scan: 无 TBD/TODO、伪命令或未定义验收结果。
- Execution note: 当前环境没有 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans` skill；本轮使用原生 subagent 只读审计并由主代理按测试先行执行。
