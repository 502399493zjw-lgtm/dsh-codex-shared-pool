# Team Display-Name Migration Notice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为被 v20 迁移自动改名的成员实现“首次进入 Team 显示一次、本人确认后永久消失”的安全闭环。

**Architecture:** PostgreSQL 迁移审计表继续作为权威状态源；Team overview 只向当前认证成员投影一个仅含迁移版本的最小 notice，界面显示名称复用 `currentMember.displayName`。确认动作经 Browser 同源 CSRF 路由代理到中央 Team API，并以当前 Team key 的实时成员身份、看到的迁移版本幂等写入 `acknowledged_at`；Memory store 没有迁移历史，因此认证后返回统一 unavailable。

**Tech Stack:** TypeScript、React、Cordis Web routes、Vitest、PostgreSQL 16、Testing Library、DSH `0.1.0-rc.8`、Cordis `4.0.1`。

## Global Constraints

- 严格实现 `docs/acceptance/team-owner-member-product-spec.zh-CN.md` §21.2：仅受影响成员首次进入时展示一次性说明。
- Browser 只接收 `{ migrationVersion: number }`；不返回旧/新显示名称、repair reason、audit ID、member ID、Team ID 或时间戳。界面当前名称只取已经存在的 `currentMember.displayName`。
- 文案必须明确“显示名称不是身份；改名不改变成员、凭据或共享容量归属”。
- ACK 必须认证当前活动成员、限定其当前 `teamId + memberId + migrationVersion`、支持重复提交，并只更新 `acknowledged_at`。
- Team Host 仅获得审计表 `SELECT` 与 `acknowledged_at` 列级 `UPDATE`；不得获得表级 `INSERT/UPDATE/DELETE`，Credential Broker 与 PUBLIC 保持零权限。
- 不改写已发布的 v20 migration；使用现有可空 `acknowledged_at` 列。
- 保持 DSH `0.1.0-rc.8` 与 Cordis `4.0.1` 的精确兼容基线。
- 先写聚焦失败测试，再实现；完成后运行 focused/full tests、真实 PostgreSQL、build、package verify 和 exact-tarball stock smoke。
- 本任务不 commit、push、publish，也不清理或覆盖用户已有改动。

---

### Task 1: 定义权威 notice 与幂等 ACK 存储契约

**Files:**
- Modify: `src/team/types.ts`
- Modify: `src/team/store.ts`
- Modify: `src/team/postgres-store.ts`
- Modify: `tests/team-postgres.spec.ts`
- Modify: `tests/team-postgres.integration.spec.ts`

**Interfaces:**
- Consumes: v20 `team_member_display_name_migration_audit_events` 中的 `migration_version` 与 `acknowledged_at`。
- Produces: `TeamDisplayNameMigrationNotice`、`TeamDisplayNameMigrationAcknowledgement`、`TeamOverview.displayNameMigrationNotice?`、`TeamStore.acknowledgeDisplayNameMigration(auth, migrationVersion)`。

- [ ] **Step 1: 写失败的 PostgreSQL 生命周期测试**

  在 v19 fixture 中插入一个会被 v20 修复的当前成员，执行 `store.initialize()` 后断言：

  ```ts
  expect((await store.overview(auth)).displayNameMigrationNotice).toEqual({
    migrationVersion: 20,
  })
  await store.acknowledgeDisplayNameMigration(auth, 20)
  await store.acknowledgeDisplayNameMigration(auth, 20)
  expect((await store.overview(auth)).displayNameMigrationNotice).toBeUndefined()
  ```

  同一测试直接查询数据库，断言当前成员行 `acknowledged_at` 非空，另一成员未确认行仍为 `NULL`。

- [ ] **Step 2: 运行测试确认 RED**

  Run: `./node_modules/.bin/vitest run tests/team-postgres.spec.ts tests/team-postgres.integration.spec.ts --reporter=dot`

  Expected: FAIL，指出 `displayNameMigrationNotice` 或 `acknowledgeDisplayNameMigration` 尚不存在；若缺少 `DSH_TEAM_POSTGRES_TEST_URL`，单元测试必须 RED，真实 PG 用例标记环境阻塞而不是伪报通过。

- [ ] **Step 3: 添加最小 JSON-safe 类型和 Store 方法**

  在 `src/team/types.ts` 定义并挂入 overview：

  ```ts
  export interface TeamDisplayNameMigrationNotice {
    readonly migrationVersion: number
  }

  export interface TeamDisplayNameMigrationAcknowledgement {
    readonly migrationVersion: number
    readonly acknowledged: true
  }

  export interface TeamOverview {
    // existing fields
    readonly displayNameMigrationNotice?: TeamDisplayNameMigrationNotice
  }
  ```

  在 `TeamStore` 增加：

  ```ts
  acknowledgeDisplayNameMigration(
    auth: TeamAuthContext,
    migrationVersion: number,
  ): Promise<TeamDisplayNameMigrationAcknowledgement>
  ```

  Memory 实现通过现有实时 auth/member 校验后返回统一 unavailable，不伪造 notice。

- [ ] **Step 4: 实现 PostgreSQL 当前成员投影与 ACK**

  `overview()` 在同一事务内查询且只选择当前 `team_id/member_id` 的最早未确认行，仅投影 `migration_version`。ACK 先通过 `requireAuthContext` 校验活动成员，再执行：

  ```sql
  UPDATE team_member_display_name_migration_audit_events
  SET acknowledged_at = COALESCE(acknowledged_at, $4)
  WHERE team_id = $1
    AND member_id = $2
    AND migration_version = $3
  RETURNING migration_version
  ```

  重复 ACK 不覆盖首次时间；没有匹配记录时返回不泄露成员信息的统一 unavailable，且不能确认未来迁移。

- [ ] **Step 5: 运行存储聚焦测试确认 GREEN**

  Run: `./node_modules/.bin/vitest run tests/team-postgres.spec.ts tests/team-postgres.integration.spec.ts --reporter=dot`

  Expected: PASS；notice 只属于当前成员，ACK 不影响其他成员，重复 ACK 不报错。

### Task 2: 建立中央 API 与 Browser 同源最小投影

**Files:**
- Modify: `src/team/types.ts`
- Modify: `src/team/routes.ts`
- Modify: `src/team/index.ts`
- Modify: `src/index.ts`
- Modify: `src/shared/team-management.ts`
- Modify: `src/team/management-routes.ts`
- Modify: `src/client/team/api.ts`
- Modify: `tests/team-routes.spec.ts`
- Modify: `tests/team-management-routes.spec.ts`
- Modify: `tests/team-management-client.spec.ts`

**Interfaces:**
- Consumes: Task 1 的 `TeamOverview.displayNameMigrationNotice?` 与 `acknowledgeDisplayNameMigration(auth, migrationVersion)`。
- Produces: `TEAM_DISPLAY_NAME_MIGRATION_ACK_PATH`、`TEAM_MANAGEMENT_DISPLAY_NAME_MIGRATION_ACK_PATH`、`TeamManagementApi.acknowledgeDisplayNameMigration(migrationVersion)`。

- [ ] **Step 1: 写两层路由与严格解析的失败测试**

  覆盖以下行为：

  ```ts
  expect(ownerOverview.body.displayNameMigrationNotice).toEqual({
    migrationVersion: 20,
  })
  expect(JSON.stringify(ownerOverview.body)).not.toMatch(/previous|nextDisplayName|reason|auditId/iu)
  expect(await postAckWithoutKey()).toMatchObject({ status: 401 })
  expect(await postLocalAckWithoutCapability()).toMatchObject({ status: 403 })
  expect(await postLocalAckWithCapability({ migrationVersion: 20 })).toEqual({
    status: 200,
    body: { migrationVersion: 20, acknowledged: true },
  })
  ```

  Client parser 必须拒绝 notice 的额外字段、非正整数或超出安全整数的 `migrationVersion`。

- [ ] **Step 2: 运行路由/client 测试确认 RED**

  Run: `./node_modules/.bin/vitest run tests/team-routes.spec.ts tests/team-management-routes.spec.ts tests/team-management-client.spec.ts --reporter=dot`

  Expected: FAIL，指出 ACK 常量/方法/路由或 notice parser 尚不存在。

- [ ] **Step 3: 实现中央认证 ACK 路由**

  新增中央路径 `${TEAM_PATH_PREFIX}/display-name-migration/ack`。只接受 `POST` 与精确 `{ migrationVersion }` JSON object，使用 Bearer Team key 实时认证，调用 Store ACK，返回：

  ```json
  { "migrationVersion": 20, "acknowledged": true }
  ```

  不返回审计状态，未认证返回 401，失效成员沿用现有终态/认证错误语义。

- [ ] **Step 4: 实现 local Host projector 与同源 ACK 代理**

  `projectOverview` 只允许并复制：

  ```ts
  { migrationVersion }
  ```

  local POST 路由复用现有 capability/Origin 校验，body 只能包含正安全整数 `migrationVersion`；proxy 将当前 Host-held Team key 和该版本转发至中央 ACK，并校验响应版本一致。

- [ ] **Step 5: 实现 Browser API 严格 parser**

  `parseTeamManagementOverview` 对 notice 做 exact-key 与正安全整数校验。`acknowledgeDisplayNameMigration(migrationVersion)` 对 `{ migrationVersion, acknowledged: true }` 做 exact-key 与请求版本一致性校验。

- [ ] **Step 6: 运行边界测试确认 GREEN**

  Run: `./node_modules/.bin/vitest run tests/team-routes.spec.ts tests/team-management-routes.spec.ts tests/team-management-client.spec.ts --reporter=dot`

  Expected: PASS；任何旧名称、审计字段、API key 或跨成员记录均未进入 Browser JSON。

### Task 3: 实现一次性中文界面与失败恢复

**Files:**
- Modify: `src/client/team/TeamSettings.tsx`
- Modify: `src/client/team/locales.ts`
- Modify: `tests/team-settings-workspace.client.spec.tsx`

**Interfaces:**
- Consumes: Task 2 的 `overview.displayNameMigrationNotice?` 和 `api.acknowledgeDisplayNameMigration(migrationVersion)`。
- Produces: Team 首页顶部的一次性 migration Notice，以及 `知道了 / Got it` 确认动作。

- [ ] **Step 1: 写 Browser DOM/交互失败测试**

  fixture 带 notice 时断言：

  ```ts
  expect(await screen.findByText(zh.displayNameMigrationTitle)).toBeDefined()
  expect(screen.getByText('Edison · 2')).toBeDefined()
  expect(document.body.textContent).not.toContain('Bad\u200BName')
  fireEvent.click(screen.getByRole('button', { name: zh.acknowledgeDisplayNameMigration }))
  await waitFor(() => expect(managementApi.acknowledgeDisplayNameMigration).toHaveBeenCalledWith(20))
  await waitFor(() => expect(screen.queryByText(zh.displayNameMigrationTitle)).toBeNull())
  ```

  再覆盖 ACK 失败：说明保持可见、按钮可重试、页面显示安全错误；无 notice 时不渲染说明。

- [ ] **Step 2: 运行 Browser 测试确认 RED**

  Run: `./node_modules/.bin/vitest run tests/team-settings-workspace.client.spec.tsx --reporter=dot`

  Expected: FAIL，指出说明或 ACK 方法尚未渲染/调用。

- [ ] **Step 3: 实现紧凑一次性 Notice**

  在 Team workspace header 后、用量区前渲染现有 `Notice` 组件：标题“你的成员名称已更新”，正文只使用当前 `displayName`，说明“显示名称不是身份；成员关系、凭据和共享容量归属均未改变”。按钮文案“知道了”。

  点击后：先等待服务端 ACK 成功，再从本地 overview 移除 notice；失败则保留 notice 并允许重试。进程内记录已成功确认的版本，过滤 ACK 前发出、ACK 后才返回的同版本旧 overview，防止提示复现；不得使用 `localStorage`、session-only dismiss 或乐观隐藏。

- [ ] **Step 4: 运行 Browser 测试确认 GREEN**

  Run: `./node_modules/.bin/vitest run tests/team-settings-workspace.client.spec.tsx --reporter=dot`

  Expected: PASS；DOM 能显示、成功后消失、失败时保持、页面不含旧名称。

### Task 4: 收紧 PostgreSQL 运行角色

**Files:**
- Modify: `src/team/postgres-roles.ts`
- Modify: `deploy/postgres/runtime-roles.sql`
- Modify: `tests/team-migrate-bin.spec.ts`
- Modify: `tests/team-postgres.integration.spec.ts`

**Interfaces:**
- Consumes: Task 1 的单列 ACK SQL。
- Produces: Host 对 audit 表的 `SELECT` + `UPDATE (acknowledged_at)`；Broker/PUBLIC 零权限；`verifyTeamDatabaseRoleBoundary()` 对列级权限 fail closed。

- [ ] **Step 1: 写角色边界失败测试**

  断言 Host 能更新 `acknowledged_at`，但不能更新 `previous_display_name`、插入或删除；Broker/PUBLIC 不能读写。验证器必须检查：

  ```sql
  has_column_privilege(
    'dsh_team_host_login',
    'public.team_member_display_name_migration_audit_events',
    'acknowledged_at',
    'UPDATE'
  )
  ```

- [ ] **Step 2: 运行角色测试确认 RED**

  Run: `./node_modules/.bin/vitest run tests/team-migrate-bin.spec.ts tests/team-postgres.integration.spec.ts --reporter=dot`

  Expected: FAIL，因为 Host 尚无列级 ACK 权限。

- [ ] **Step 3: 授予并验证最小列级权限**

  两份运行角色 SQL 保持字节一致，新增：

  ```sql
  GRANT UPDATE (acknowledged_at)
    ON TABLE public.team_member_display_name_migration_audit_events
    TO dsh_team_host;
  ```

  验证器同时要求：表级 UPDATE 为 false、`acknowledged_at` 列 UPDATE 为 true、敏感列 UPDATE 为 false；Broker 所有表/列写权限为 false。

- [ ] **Step 4: 运行角色测试确认 GREEN**

  Run: `./node_modules/.bin/vitest run tests/team-migrate-bin.spec.ts tests/team-postgres.integration.spec.ts --reporter=dot`

  Expected: PASS；真实 PostgreSQL 证明 SQL 语法和权限实际生效。

### Task 5: 全量验收、包和独立复审

**Files:**
- Create: `artifacts/validation/20260824-team-display-name-migration-notice/*`（ignored evidence only）
- Modify: `docs/acceptance/team-owner-member-product-spec.zh-CN.md`（仅在验收编号需要落盘时添加，不改变产品语义）

**Interfaces:**
- Consumes: Tasks 1–4 的完整实现。
- Produces: AC-NAME-MIGRATION-001/002 的 DOM/API/PG 证据、package-format 证据、exact-tarball stock DSH smoke 与 subagent 复审结论。

- [ ] **Step 1: 运行 focused 与全量测试**

  Run: `./node_modules/.bin/vitest run tests/team-postgres.spec.ts tests/team-postgres.integration.spec.ts tests/team-migrate-bin.spec.ts tests/team-routes.spec.ts tests/team-management-routes.spec.ts tests/team-management-client.spec.ts tests/team-settings-workspace.client.spec.tsx --reporter=dot`

  Run: `./node_modules/.bin/vitest run --reporter=dot`

  Expected: PASS；真实 PG 若环境不可用则该主张标记 `NOT_PROVEN`。

- [ ] **Step 2: 构建与验证 package format**

  Run: `pnpm_config_verify_deps_before_run=false pnpm run build`

  Run: `pnpm_config_verify_deps_before_run=false pnpm run verify:package`

  Expected: PASS；这只证明构建与包格式，不等于 stock DSH 安装兼容。

- [ ] **Step 3: 打包 exact tarball 并运行隔离 stock DSH smoke**

  使用 `pnpm pack` 的同一 tarball、全新临时 `DSH_HOME` 和官方 DSH `0.1.0-rc.8`，记录 tarball SHA-256、version、plugin add、dump-config、Web start、Browser boot manifest/client bundle 与 Team 同源 route probe。不得调用真实 Provider/模型。

- [ ] **Step 4: 独立 subagent 安全与规格复审**

  审查重点：一次性语义是否真正由服务端持久化；ACK 是否跨成员；Browser 是否泄露旧名称/审计字段；列级权限是否被误放宽；失败状态是否可重试。

- [ ] **Step 5: 复核 Git 状态并交接**

  报告用户可见结果、改动文件、实际命令、失败/未验证风险、证据路径、exact tarball 摘要和精确 branch/status；不提交。

## Self-Review

- Spec coverage: §21.2 的受影响成员、首次进入、一次性说明、身份/凭据/容量不变均有对应 Store、API、Browser 和验收任务。
- Placeholder scan: 无 TBD/TODO、“类似前文”或未定义接口；所有 method、DTO、route 和权限名保持一致。
- Type consistency: central 与 Browser 都使用 `displayNameMigrationNotice`；notice 形状固定为 `{ migrationVersion }`；两层 ACK 方法统一为 `acknowledgeDisplayNameMigration(migrationVersion)`。
- Security coverage: Browser 不接收旧名称或审计元数据；ACK 仅限当前认证成员；Host 只有目标列级 UPDATE；Broker/PUBLIC 无权限。

用户已明确要求“继续”，因此本轮采用 Subagent-Driven 方式直接执行，不再暂停询问执行方式；仓库规则禁止未授权 commit，所以本计划有意省略 commit 步骤。
