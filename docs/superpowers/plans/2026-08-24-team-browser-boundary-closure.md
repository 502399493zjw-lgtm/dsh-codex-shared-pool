# Team Browser Boundary Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除 Team 的通用角色修改能力，并确保内部 Credits 限额永远不进入 Browser DTO、页面或同源写请求。

**Architecture:** Team Host 继续读取历史 `admin`/`role_changed`，并继续在内部使用 `dailySharedCreditLimit` 执行准入保护；Browser 边界改用专用 contribution summary/patch 类型，显式省略 Credits。旧角色写路由直接不注册，Owner 变更只经双阶段所有权转移。

**Tech Stack:** TypeScript、React、Cordis Web routes、Vitest、Memory/PostgreSQL Team stores。

## Global Constraints

- 保持 `TeamRole.admin`、历史 `role_changed` 读取和 active Admin → Member migration 兼容。
- 不新增 `role_changed`；不保留任何成功的通用 role mutation。
- Host 内部 Credits ledger、数据库列、准入限制和远端 Host API 保持不变。
- Browser DTO、同源路由、客户端、Team Settings 和 Team locale 不出现 Credits。
- 既有 Credits 限额在 Browser 风格 patch 省略该字段时保持不变。
- 精确兼容 DSH `0.1.0-rc.8` 与 Cordis `4.0.1`。
- 本任务不 commit、push、publish，也不清理用户已有改动。

---

### Task 1: 删除通用角色写能力

**Files:**
- Modify: `tests/team-routes.spec.ts`
- Modify: `tests/team-management-routes.spec.ts`
- Modify: `tests/team-management-client.spec.ts`
- Modify: `tests/team-settings-workspace.client.spec.tsx`
- Modify: `tests/team.spec.ts`
- Modify: `tests/team-postgres.spec.ts`
- Modify: `src/team/types.ts`
- Modify: `src/team/routes.ts`
- Modify: `src/team/store.ts`
- Modify: `src/team/postgres-store.ts`
- Modify: `src/shared/team-management.ts`
- Modify: `src/team/management-routes.ts`
- Modify: `src/client/team/api.ts`
- Modify: `src/index.ts`
- Modify: `src/client/team/locales.ts`

**Interfaces:**
- Consumes: 现有 ownership-transfer、member removal、legacy-role normalization。
- Produces: 不含 `/members/role` 的公共/同源路由集合；无 `updateMemberRole` 的 Store 与 Browser API。

- [ ] **Step 1: 写失败测试**

  断言公共路由和同源路由均不注册字面路径 `/plugins/dsh-codex-shared-pool/team/members/role` 与 `/plugins/dsh-codex-shared-pool/team-client/members/role`，Browser API 不暴露 `updateMemberRole`。

- [ ] **Step 2: 验证测试先失败**

  Run: `./node_modules/.bin/vitest run tests/team-routes.spec.ts tests/team-management-routes.spec.ts tests/team-management-client.spec.ts --reporter=dot`

  Expected: FAIL，指出旧路由/方法仍存在。

- [ ] **Step 3: 删除能力，不删除历史兼容**

  删除两层 path 常量、route registration、proxy/client method、Store interface/mutator 和公共导出；调整固化 member→member `role_changed` 的测试。保留 `TeamRole.admin`、migration、旧角色投影和 audit enum。

- [ ] **Step 4: 验证角色边界**

  Run: `./node_modules/.bin/vitest run tests/team-routes.spec.ts tests/team-management-routes.spec.ts tests/team-management-client.spec.ts tests/team.spec.ts tests/team-postgres.spec.ts --reporter=dot`

  Expected: PASS；legacy Admin 仍只能作为普通成员读取/使用自身能力。

### Task 2: 从 Browser contract 移除 Credits

**Files:**
- Modify: `src/shared/team-management.ts`
- Modify: `src/team/management-routes.ts`
- Modify: `src/client/team/api.ts`
- Modify: `src/client/team/team-settings-contract.ts`
- Modify: `src/client/team/TeamSettings.tsx`
- Modify: `src/client/team/locales.ts`
- Modify: `tests/team-management-routes.spec.ts`
- Modify: `tests/team-management-client.spec.ts`
- Modify: `tests/team-settings-contract.spec.ts`
- Modify: `tests/team-settings-workspace.client.spec.tsx`

**Interfaces:**
- Consumes: 内部 `TeamContributionAccountSummary` / `TeamContributionAccountPatch`。
- Produces: `TeamManagementContributionSummary = Omit<TeamContributionAccountSummary, 'dailySharedCreditLimit'>` 与对应 Browser patch；Host projector 验证远端内部值但不序列化它。

- [ ] **Step 1: 写失败测试**

  远端 fixture 带 sentinel daily limit，断言 overview/OAuth 的 Browser JSON 与 client parse 结果不含该键；同源 update 带该键返回 400 且远端 fetch 为 0；正常设置保存 payload 只含 reserve、request cap 和 models。

- [ ] **Step 2: 验证测试先失败**

  Run: `./node_modules/.bin/vitest run tests/team-management-routes.spec.ts tests/team-management-client.spec.ts tests/team-settings-contract.spec.ts tests/team-settings-workspace.client.spec.tsx --reporter=dot`

  Expected: FAIL，指出 `dailySharedCreditLimit` 仍被投影或回传。

- [ ] **Step 3: 实现 Browser 专用 DTO/patch**

  改 overview/OAuth/contribution 返回类型；projector 不返回 daily limit；同源 parser 的 exact keys 拒绝该字段；client parser 不读取；编辑 draft/parser 不再生成该字段。

- [ ] **Step 4: 删除 Team Credits 与 Admin 死文案**

  仅删除 `src/client/team/locales.ts` 的 Team 专用死键；不修改非 Team 的 OpenAI Credits UI。

- [ ] **Step 5: 验证 Host 内部限额未受影响**

  Run: `./node_modules/.bin/vitest run tests/team-settings-contract.spec.ts tests/team-management-client.spec.ts tests/team-management-routes.spec.ts tests/team.spec.ts tests/team-postgres.spec.ts --reporter=dot`

  Expected: PASS；Memory/PG 的 existing daily cap 在省略字段 patch 后保持，现有 Credits admission 测试继续通过。

### Task 3: 全量构建、包和证据

**Files:**
- Create: `artifacts/validation/20260824-team-settings-continuation/*`（ignored evidence only）

**Interfaces:**
- Consumes: Tasks 1–2 的实现。
- Produces: focused/full test、build、package verification 和 stock-install 证据。

- [ ] **Step 1: 运行 focused 与全量测试**

  Run: `./node_modules/.bin/vitest run --reporter=dot`

  Expected: PASS；真实 PostgreSQL 16 并发测试若无环境则明确记为 NOT_PROVEN。

- [ ] **Step 2: 构建与验证包**

  Run: `pnpm_config_verify_deps_before_run=false pnpm run build && pnpm_config_verify_deps_before_run=false pnpm run verify:package`

  Expected: PASS。

- [ ] **Step 3: stock DSH 安装 smoke**

  对 exact tarball 使用短路径和独立 `DSH_HOME`；不得读取用户 npm token，也不得写共享 pnpm store。磁盘不足时停止并记为 NOT_PROVEN，不伪装成 package-format PASS。

- [ ] **Step 4: 复核 Git 状态并交接**

  报告用户可见结果、实际命令、失败/风险、证据路径和精确 branch/status；不提交。

## Self-Review

- Spec coverage: role mutation、Browser Credits、历史兼容、内部准入、测试和交接均有对应任务。
- Placeholder scan: 无 TBD/TODO 或未定义实现步骤。
- Type consistency: Browser summary/patch 均使用 `TeamManagementContribution*`，内部 Store 继续使用 `TeamContributionAccount*`。

用户已明确要求“开始开发/继续”，因此本轮直接按 Inline Execution 执行，不再暂停询问执行方式。
