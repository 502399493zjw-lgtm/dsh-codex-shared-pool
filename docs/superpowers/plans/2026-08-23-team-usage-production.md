# Team 用量正式实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把已经定稿的 Team 用量 Demo 落到正式 Host API 与 Browser 设置页：只展示跨成员共享 attempt 的预估费用（USD）、Token、请求次数与数据状态，并从查询层保证 Owner/成员最小权限。

**Architecture:** Host 继续保留 Credits 作为内部准入保护单位，但新增只持久化聚合 Token、可空 micro-USD 和价格版本的账本字段。中央 Team API 与本地同源代理改为角色塑形的 aggregate-only DTO；Browser 只接收十进制字符串汇总并在纯 view-model 中推导六种状态。当前运行链路尚不能证明实际响应模型和服务档位，因此本轮金额字段可空且生产默认安全降级为 `—`；非空金额必须留到可信 Provider 定价键与不可变价格目录具备后启用。

**Tech Stack:** TypeScript、React、Cordis 4.0.1、DSH 0.1.0-rc.8、Vitest、PostgreSQL、CSS。

## 全局约束

- 只在仓库工作树的 `codex/team-phase-two-split` 分支工作，保留全部既有未提交改动。
- 行为改动先写失败测试，再实现；不得提交、推送、发布或改写历史。
- Browser DTO 不得含 events、Credits、成员 ID、账号 ID、model、status、Provider 错误或输入/缓存/输出 Token 拆分。
- Owner 响应包含 Team 总用量与自己的子集；成员响应在 store/SQL 查询处按 `consumer_member_id` 裁剪，且结构中根本不存在 Team 总量。
- `totalTokens` 与 `estimatedCostUsdMicros` 以十进制字符串或 `null` 过线；Browser 不把它们转成 JS `number`。
- `requestCount = 0` 时 Token 与费用都是可靠的 `"0"`；有请求而覆盖为零时对应总量为 `null`；部分覆盖只返回已有小计并标记部分数据。
- self-use 不计入；重试按每个准入 attempt 分别计数；晚结算仍按 `startedAt` 归入原窗口；暂停 Team 时仍可读取用量。
- 不用 Credits、客户端请求 model、默认 tier 或近似模型价格生成金额；旧 Credits-only 行保持未计量。

---

### Task 1：锁定 Token 校验与账本字段

**Files:**
- Modify: `tests/team-credits.spec.ts`
- Modify: `src/team/credits.ts`
- Modify: `tests/team-postgres.spec.ts`
- Modify: `src/team/postgres-store.ts`
- Modify: `src/team/store.ts`
- Modify: `src/team/types.ts`

- [ ] **Step 1：先写严格 Token 失败测试**

覆盖缺失 `cached_tokens`、非整数、负数、超过 10 亿、`cached_tokens > input_tokens`；所有非法输入均返回未计量，`calculateTeamCredits` 对非法关系抛错。

- [ ] **Step 2：运行失败测试**

Run: `pnpm exec vitest run tests/team-credits.spec.ts`

Expected: FAIL，当前实现会把缺失缓存 Token 猜成 0，并接受 `cached > input`。

- [ ] **Step 3：实现严格校验**

只有 Provider 返回完整且满足 `0 ≤ cached ≤ input ≤ 1_000_000_000`、`0 ≤ output ≤ 1_000_000_000` 的整数三元组才计量；`totalTokens = input + output`，不重复累加 cached Token。

- [ ] **Step 4：先写 migration 11 与持久化失败测试**

新增前向迁移，追加 `total_tokens bigint null`、`estimated_cost_usd_micros bigint null`、`pricing_catalog_version text null` 与一致性约束；旧迁移不得修改，旧行保持 `NULL`，原始 Token 拆分不得重新落库。

- [ ] **Step 5：实现 Memory/PostgreSQL 账本字段**

合法结算写 `totalTokens`；可信价格结果缺失时金额与版本保持空；内部 Credits 继续写旧字段用于准入保护。为后续可信价格目录保留 Host-only、成对出现的金额/版本写入边界，不从 Browser 接收。

- [ ] **Step 6：运行账本聚焦测试**

Run: `pnpm exec vitest run tests/team-credits.spec.ts tests/team.spec.ts tests/team-postgres.spec.ts tests/team-gateway.spec.ts`

Expected: PASS。

### Task 2：用角色塑形的聚合 DTO 替换旧事件接口

**Files:**
- Modify: `src/team/types.ts`
- Modify: `src/team/store.ts`
- Modify: `src/team/postgres-store.ts`
- Modify: `src/team/service.ts`
- Modify: `src/team/routes.ts`
- Modify: `src/shared/team-management.ts`
- Modify: `src/team/management-routes.ts`
- Modify: `tests/team.spec.ts`
- Modify: `tests/team-postgres.spec.ts`
- Modify: `tests/team-routes.spec.ts`
- Modify: `tests/team-management-routes.spec.ts`

- [ ] **Step 1：先写 Owner/成员响应失败测试**

Owner 精确得到 `{ role: 'owner', window, team, mine }`；成员精确得到 `{ role: 'member', window, mine }`。断言序列化结果没有 `events`、Credits、成员/账号/model/status/error 等字段。

- [ ] **Step 2：先写六种聚合语义失败测试**

覆盖完整、部分、Token 可用但未计价、完全未计量、零请求、查询失败；覆盖计数必须满足 `0 ≤ priced ≤ tokenMeasured ≤ requestCount`。

- [ ] **Step 3：实现 Memory store 聚合**

新增固定 24 小时时间窗口的 `readUsageProjection(auth)`；只统计跨成员 attempt。Owner 生成 Team 总量与本人子集，成员循环前先按本人 consumer 过滤。

- [ ] **Step 4：实现 PostgreSQL 角色查询**

成员 SQL 必须显式包含 `consumer_member_id = $memberId`，不得先取全 Team 再过滤；Owner 才执行 Team 总量查询。SQL 不把有请求但无计量的汇总 `COALESCE` 成零，bigint 结果转十进制字符串。

- [ ] **Step 5：替换中央与本地管理路由**

移除 `/usage` 的 `events + aggregates` 响应，中央 Host 和本地同源代理只返回新 DTO；两层均保持 `Cache-Control: no-store` 与 runtime validation。

- [ ] **Step 6：运行 Host/API 聚焦测试**

Run: `pnpm exec vitest run tests/team.spec.ts tests/team-postgres.spec.ts tests/team-routes.spec.ts tests/team-management-routes.spec.ts tests/team-request-service.spec.ts`

Expected: PASS。

### Task 3：收紧同级 Browser 数据权限

**Files:**
- Modify: `src/team/store.ts`
- Modify: `src/team/postgres-store.ts`
- Modify: `src/team/routes.ts`
- Modify: `src/team/management-routes.ts`
- Modify: `src/shared/team-management.ts`
- Modify: `tests/team.spec.ts`
- Modify: `tests/team-postgres.spec.ts`
- Modify: `tests/team-routes.spec.ts`
- Modify: `tests/team-management-routes.spec.ts`

- [ ] **Step 1：先写成员不可见数据失败测试**

普通成员 overview 不得含邀请元数据；`我的共享`只返回 `owner_member_id = 当前成员` 的来源；Owner-only 邀请接口保持 403 边界。legacy admin 在这套新视图中按普通成员塑形，不能拿到 Team 总量或 Owner 控件。

- [ ] **Step 2：把过滤下沉到 store/SQL**

不得依赖 React 隐藏或在代理取回全量后过滤。保留 Host 内部生命周期所需的独立全量查询，但不把它接到 Browser route。

- [ ] **Step 3：运行权限聚焦测试**

Run: `pnpm exec vitest run tests/team.spec.ts tests/team-postgres.spec.ts tests/team-routes.spec.ts tests/team-management-routes.spec.ts`

Expected: PASS。

### Task 4：实现正式 Browser 用量页

**Files:**
- Modify: `src/client/team/api.ts`
- Modify: `src/client/team/TeamSettings.tsx`
- Create: `src/client/team/TeamWorkspace.tsx`
- Create: `src/client/team/TeamUsagePage.tsx`
- Create: `src/client/team/TeamUsageSummary.tsx`
- Create: `src/client/team/team-usage-view-model.ts`
- Modify: `src/client/team/team-settings.css`
- Modify: `src/client/team/locales.ts`
- Modify: `src/client/CodexSubscriptionPoolSettings.tsx`
- Modify: `tests/team-management-client.spec.ts`
- Create: `tests/team-usage-view-model.spec.ts`
- Modify: `tests/team-settings-workspace.client.spec.tsx`
- Modify: `tests/codex-subscription-pool.client.spec.tsx`

- [ ] **Step 1：先写严格 Browser parser 失败测试**

拒绝负数、指数/小数十进制、非法 USD、`priced > measured`、`measured > requests`、空值与覆盖率冲突及旧 `events + aggregates` 形状。

- [ ] **Step 2：先写 view-model 六态失败测试**

完整、部分、未计价、未计量、零请求、获取失败分别锁定金额、Token、请求次数、状态短文案；微小非零费用显示 `< US$0.01`，不伪装成零。

- [ ] **Step 3：实现纯解析与格式化层**

用 `BigInt` 格式化 Token 和 micro-USD；不显示 Credits，不放“这些数字是什么”解释块，不显示逐请求或排名。

- [ ] **Step 4：实现正式工作区与用量组件**

Owner 显示 `Team 总用量`和`我的用量`；成员只显示`我的用量`。用量加载失败立即清空旧值并显示重试；Team 暂停时仍能读取。成员列表只显示文字姓名和 `Team Owner/成员`，无头像。

- [ ] **Step 5：收口导航与语义**

已加入状态从旧 account-first 长页切到任务式工作区；嵌入模式使用 `<section>`，补齐外层 tabs 的 `aria-controls/aria-labelledby` 与方向键交互。

- [ ] **Step 6：运行 Browser 聚焦测试**

Run: `pnpm exec vitest run tests/team-management-client.spec.ts tests/team-usage-view-model.spec.ts tests/team-settings-workspace.client.spec.tsx tests/team-settings-contract.spec.ts tests/codex-subscription-pool.client.spec.tsx`

Expected: PASS。

### Task 5：运行正式验收门禁

**Files:**
- Modify only if a test reveals a scoped defect.

- [ ] **Step 1：运行原型辅助回归**

Run: `pnpm run test:prototype`

Expected: PASS。此证据只证明 Demo fixture，不代替正式 React/Host 验收。

- [ ] **Step 2：运行完整测试与 PostgreSQL 集成测试**

Run: `pnpm test`

Run when isolated PostgreSQL is configured: `pnpm run test:postgres`

Expected: PASS；若 PostgreSQL 环境不可用，必须明确报告未验证。

- [ ] **Step 3：运行构建与包格式校验**

Run: `pnpm run build`

Run: `pnpm run verify:package`

Expected: PASS。

- [ ] **Step 4：打包并执行 stock DSH rc.8 安装 smoke**

Run: `mkdir -p artifacts/package && pnpm pack --pack-destination artifacts/package`

Run: DSH 插件规范中的 `smoke-stock-dsh.mjs`，固定 `@deepseek-ai/dsh@0.1.0-rc.8`、真实执行模式和预期 SHA-256。

Expected: 安装、加载和同源状态路由 PASS；此 smoke 不证明真实 Team 请求、真实 Provider payload 或非空金额计价。

## 后续独立阶段：启用可信非空金额

只有取得生产 Provider payload 证据后再实施：捕获并验证终态响应中的 Provider、实际模型和实际 service tier；建立不可变且保留历史版本的 Host-only 价格目录；准入时冻结版本；用 bigint micro-USD 单位一次性舍入；未知 tuple 保持金额为空。该阶段必须新增 `tests/team-pricing.spec.ts`，且不得复用客户端请求 model 或 Credits。
