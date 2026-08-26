# 团队设置与成员流程实施方案

> 本方案在 `codex/team-phase-two-split` 分支实施。所有行为变更必须先写聚焦失败测试；未经明确授权不提交、不推送、不发布。

## 目标

把“团队设置”建设成完整、可恢复的成员管理入口，覆盖：

- 创建、查看和撤销邀请；
- 加入前预览邀请；
- 加入团队与中断恢复；
- Owner、Admin、Member 三种角色；
- 成员升降级、移除、退出和所有权转让；
- 当前设备断开；
- Team Key、邀请令牌和 OAuth 凭证的安全边界。

页面只解决一个问题：**让用户始终清楚谁拥有团队访问权、访问权如何获得、每个退出动作会撤销什么。**

## 架构边界

- 浏览器只调用插件自己的同源、强类型管理路由。
- 原始 Team Key、待完成加入凭证、认证文件和文件系统访问只存在于本地 Host。
- 中央 Team Store 负责邀请、成员、角色和密钥的原子状态变更。
- 浏览器永远不能读取或导出其他成员的 Team Key、OAuth 凭证或 Codex 认证数据。
- 邀请令牌是一次性 bearer secret，不进入 URL、查询参数、日志、截图、概览接口或浏览器持久化存储。

## 信息架构

团队设置按以下顺序展示：

1. **团队访问**：团队状态、服务地址、当前角色、刷新、暂停/恢复和当前设备断开。
2. **成员**：成员列表、角色管理、所有权转让、移除成员和退出团队。
3. **邀请**：创建带备注和有效期的一次性邀请、查看待使用邀请、撤销邀请。

使用量继续留在现有活动区域，不混入成员管理流程。

## 视觉与交互方向

- 沿用 DSH 现有字体、间距、圆角和语义色。
- Team 主色使用 `#3964fe`，成功 `#168f61`，警告 `#b76800`，危险 `#c83b50`，正文 `#1f2329`。
- 唯一强调元素是加入过程中的三段访问轨道：

  `邀请 → 当前设备 → 团队权限`

- 该轨道表达真实的状态顺序，并使用 `aria-current="step"`。
- 只在“邀请预览 → 确认加入”之间使用轻微过渡；尊重 `prefers-reduced-motion`。
- 操作文案直接描述结果，例如“检查邀请”“加入团队”“移除成员”“断开此设备”。

## 邀请流程

### 创建邀请

Owner 和 Admin 可以创建邀请，字段为：

- 邀请备注：必填，用于说明邀请对象或设备，例如“米娅 · 工作电脑”；
- 有效期：1 天、7 天或 30 天，默认 7 天。

创建成功后：

- 原始邀请令牌只在结果弹窗中显示一次；
- 可复制的是说明文本和令牌，不生成含令牌的 URL；
- 关闭弹窗或卸载组件后，浏览器内存中的令牌立即丢弃；
- 待使用邀请列表只显示备注、邀请人、创建时间和过期时间。

### 邀请状态

```text
pending ──接受成功──> accepted
   │
   ├──管理员撤销──> revoked
   └──超过有效期──> expired
```

- 预览邀请不会消耗令牌。
- 暂停状态的团队允许预览，但拒绝加入。
- 接受邀请必须使用数据库行锁；两个并发接受请求只能有一个成功。
- 已接受、已撤销或已过期的邀请不能恢复为 pending。

### 加入前预览

用户先输入邀请令牌并选择“检查邀请”。服务端返回无秘密信息：

```ts
interface TeamInvitePreview {
  readonly teamName: string
  readonly label: string
  readonly expiresAt: number
  readonly teamStatus: 'active' | 'paused'
}
```

预览成功后，才显示姓名输入框和“加入团队”按钮。

## 可恢复的加入流程

当前实现先在远端消耗邀请并创建成员，再在本地保存返回的 Team Key。如果本地写入失败，会遗留无法恢复的成员和密钥。

新流程如下：

```text
输入邀请
   ↓
Host 生成 Team Key
   ↓
Host 保存为 pending 凭证
   ↓
中央服务原子接受邀请、创建成员并登记该 Key 的哈希
   ↓
本地 pending 凭证升级为 configured
   ↓
加入完成
```

规则：

- Team Key 在本地 Host 生成，浏览器不接触原始值。
- 中央服务只保存 Key 哈希。
- 明确的 4xx 业务拒绝或远端身份不存在时，会删除 pending 凭证。
- 超时、429 或 5xx 保留 pending 凭证，并进入恢复界面。
- “完成加入”使用 pending Key 请求概览；验证成功后升级为正式凭证。
- “放弃未完成的加入”先验证 pending Key：若远端成员已创建，则先执行远端离队；远端不可达时保留 pending，避免产生无法自助清理的幽灵成员。只有本地 pending 格式损坏或远端身份确定不存在时，才直接删除本地 pending。

管理状态增加：

```ts
interface TeamManagementStatus {
  readonly configured: boolean
  readonly pendingJoinConfigured: boolean
}
```

加入响应不再向浏览器返回 `apiKey`。

## 权限矩阵

| 操作 | Owner | Admin | Member |
|---|---:|---:|---:|
| 查看成员和邀请 | 是 | 是 | 是 |
| 创建/撤销邀请 | 是 | 是 | 否 |
| 暂停/恢复团队 | 是 | 是 | 否 |
| Member 升为 Admin | 是 | 否 | 否 |
| Admin 降为 Member | 是 | 否 | 否 |
| 移除 Member | 是 | 是 | 否 |
| 移除 Admin | 是 | 否 | 否 |
| 转让所有权 | 是 | 否 | 否 |
| 退出团队 | 转让后 | 是 | 是 |
| 断开当前设备 | 是 | 是 | 是 |

补充规则：

- Owner 不能直接退出或移除自己，必须先转让所有权。
- Admin 不能修改或移除 Owner/Admin。
- 成员移除后，中央事务立即吊销所有 Team Key 并把贡献账户标记为 revoked，使其停止参与新路由；进行中的请求和代理凭据由幂等后台清理重试完成。
- 角色修改和成员移除必须写审计事件。

## 三种退出语义

### 断开此设备

- 只删除当前设备保存的本地 Team Key；
- 不改变中央成员关系；
- 用户之后可以用其他有效 Team Key 重新连接。

### 退出团队

- 当前成员中央状态变为 removed；
- 吊销该成员全部 Team Key；
- 将该成员贡献账户标记为 revoked，并触发可恢复的路由与代理凭据清理；
- 最后删除当前设备的本地凭证。

### 移除成员

- 由 Owner/Admin 对其他成员执行；
- 使用与退出团队相同的“中央事务提交 + 幂等后台清理”原语；
- 权限遵守上表；
- 成功后成员立即无法继续使用团队服务。

## 错误处理

- 输入格式错误：指出需要什么格式，不向服务端发送请求。
- 邀请无效：说明可能已使用、撤销或过期，并允许输入新邀请。
- 团队暂停：显示团队名称，但禁用加入并提示联系 Owner/Admin。
- 加入请求结果不确定：进入恢复状态，不要求用户重新索取邀请。
- 当前 Team Key 失效：显示“此设备的团队访问已失效”，提供清除本地连接入口。
- 权限冲突或成员状态变化：刷新概览并提示重新检查最新状态。
- 所有错误必须给出下一步操作，不使用笼统的“出现错误”。

## 实施任务

### 任务一：邀请备注和预览

涉及文件：

- `src/team/types.ts`
- `src/team/store.ts`
- `src/team/postgres-store.ts`
- `src/team/routes.ts`
- `src/team/management-routes.ts`
- `src/shared/team-management.ts`
- `src/client/team/api.ts`
- `tests/team.spec.ts`
- `tests/team-postgres.spec.ts`
- `tests/team-routes.spec.ts`
- `tests/team-management-routes.spec.ts`

步骤：

1. 先添加邀请备注、预览不消耗令牌、暂停团队预览、无效邀请错误的失败测试。
2. 扩展共享类型和 Store 接口。
3. 内存 Store 实现预览与备注。
4. PostgreSQL 增加 migration 9 和对应索引/锁定逻辑。
5. 添加中央预览路由和本地代理路由。

滚动升级采用“中央服务优先”的强约束：先执行数据库迁移并升级所有中央 Team 服务实例，再升级客户端 Host。migration 9 保留 `label` 的 `Team invitation` 默认值，使尚未退出的旧中央写入器仍可插入邀请；只有确认所有旧写入器退役后，才能在独立的 contract migration 中删除默认值。新 Host 会用 `Team invitation` 安全读取旧邀请记录，但不支持对旧中央服务创建邀请或加入，因为旧协议会拒绝新增的 `label` 与 Host 提供的 `apiKey` 字段。
6. 运行聚焦测试并确认通过。

### 任务二：可恢复加入

涉及文件：

- `src/shared/team-management.ts`
- `src/team/management-routes.ts`
- `src/team/store.ts`
- `src/team/postgres-store.ts`
- `src/team/routes.ts`
- `tests/team-management-routes.spec.ts`
- `tests/team-management-client.spec.ts`

步骤：

1. 先添加“浏览器看不到 Key”“写入前中断可恢复”“4xx 清理、5xx 保留 pending”的失败测试。
2. Host 生成并保存 pending Team Key。
3. 中央接受邀请时登记 Host 提供的 Key 哈希。
4. 增加恢复和放弃 pending 加入的同源路由。
5. 兼容既有正式 Team Key 连接路径。

### 任务三：角色和成员移除

涉及文件：

- `src/team/types.ts`
- `src/team/store.ts`
- `src/team/postgres-store.ts`
- `src/team/routes.ts`
- `src/team/management-routes.ts`
- `src/shared/team-management.ts`
- `tests/team.spec.ts`
- `tests/team-postgres.spec.ts`
- `tests/team-routes.spec.ts`

步骤：

1. 先写权限矩阵和原子清理失败测试。
2. 抽取供“自行退出”和“管理员移除”共用的原子离队逻辑。
3. 实现角色修改路由和成员移除路由。
4. 验证 Owner 保护、Admin 边界、密钥吊销和贡献清理。

### 任务四：团队设置界面

涉及文件：

- `src/client/team/TeamSettings.tsx`
- `src/client/team/TeamOnboarding.tsx`
- `src/client/team/TeamPeopleSettings.tsx`
- `src/client/team/TeamSettings.module.css`
- `src/client/team/locales.ts`
- `src/client/team/api.ts`
- `tests/team-settings-workspace.client.spec.tsx`
- `tests/team-settings-contract.spec.ts`

步骤：

1. 先写邀请检查、恢复加入、邀请备注、角色管理和成员移除的 UI 失败测试。
2. 抽出 `TeamOnboarding`，实现三段访问轨道和恢复界面。
3. 抽出 `TeamPeopleSettings`，使用单个成员操作菜单，避免并排堆叠危险按钮。
4. 添加完整中英文文案、键盘焦点、移动端适配和 reduced-motion。
5. 关闭邀请结果弹窗时清除令牌内存。

## 验证

聚焦测试：

```bash
pnpm exec vitest run \
  tests/team.spec.ts \
  tests/team-postgres.spec.ts \
  tests/team-request-service.spec.ts \
  tests/team-routes.spec.ts \
  tests/team-management-routes.spec.ts \
  tests/team-management-client.spec.ts \
  tests/team-settings-contract.spec.ts \
  tests/team-settings-workspace.client.spec.tsx \
  tests/quota-browser-plugin.client.spec.tsx
```

仓库门禁：

```bash
pnpm run build
pnpm run verify:package
git diff --check
```

有可丢弃 PostgreSQL 实例时再运行真实数据库测试；有安装授权时，把打包产物安装到隔离 `DSH_HOME`，使用固定版本 `@deepseek-ai/dsh@0.1.0-rc.8` 做真实 stock-DSH 冒烟验证。未执行的真实门禁必须明确报告为 `not-run`，不能用包格式检查代替。
