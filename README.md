# DSH Codex Shared Pool

在 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/DeepSeek-Harness) 中管理多个 Codex 订阅账号，并通过团队功能把愿意贡献的账号额度分享给其他成员。

[怎么用](#怎么用) · [安装](#安装) · [最新发布](https://github.com/502399493zjw-lgtm/dsh-codex-shared-pool/releases/latest) · [更新日志](CHANGELOG.md)

## 它解决什么问题

这个插件解决两种使用问题：

- **本地多账号**：你有多个自己的 ChatGPT/Codex 订阅时，可以分别登录到同一个本机账号池。插件在请求发出前读取当前模型的可用额度；当前账号明确耗尽时，自动切换到其他可用账号，并记录选择原因。
- **团队共享**：你愿意贡献某个账号的额度时，可以只授权它用于团队请求，并设置每周共享上限。其他成员通过邀请码使用共享账号，成员不需要登录贡献者的 OpenAI 账号，也看不到贡献者的 OAuth 凭据。

你可以只使用自己的本机账号池，也可以创建或加入团队，共享账号额度。

## 怎么用

### 只使用本地账号池

1. 安装插件并启动 DSH Web。
2. 打开 **设置 → Codex 订阅池 → 本机**，点击“添加账号”，为每个自己的订阅账号分别完成浏览器登录。
3. 在会话中选择 **OpenAI Codex** Provider 和模型。插件会优先使用当前账号；如果明确读到当前模型额度为 `0%`，就切换到额度可用且重置时间更早的账号。
4. 想优先使用某个账号时，在账号卡片上点击“使用此账号”；在“最近请求”中可以查看实际使用的账号别名和路由原因。

### 使用团队共享额度

成员和贡献者都在自己的 DSH 中安装插件。全新安装 `0.1.5` 默认提供云端团队入口，无需配置服务地址，直接通过团队页面操作：

1. **创建团队**：打开 **设置 → Codex 订阅池 → 团队**，点击 **创建团队**，填写团队名称和昵称，创建后你就是团队所有者。已有团队时，从团队名称菜单中选择 **创建团队**。
2. **邀请成员**：在团队面板创建邀请码并分享。成员打开自己的团队页面，粘贴邀请码、确认团队名称并填写昵称，即可加入。
3. **贡献账号**：贡献者在团队页面选择要共享的本机账号，通过浏览器完成共享授权，并设置每周共享上限。
4. **开始使用**：成员在 DSH 会话中选择 **OpenAI Codex** Provider 和模型，即可使用团队里的可用共享账号，无需登录贡献者的 OpenAI 账号。

创建后按页面提示私密保存团队恢复码，方便以后恢复管理身份。恢复码不能当作邀请码分享。

默认连接模式下，尚未加入团队时，会话继续使用本机账号池；创建或加入成功后，下一次请求开始使用团队共享账号。断开本机团队连接后，下一次请求恢复使用本机账号池。团队请求遇到权限、限额或网络错误时会显示错误，不会自动转用本机账号。

## 场景速览

| 场景 | 使用方式 |
| --- | --- |
| 一个人有多个订阅账号 | 在本机账号池分别登录；请求前按模型额度选择账号，明确耗尽时自动切换，并留下路由流水。 |
| 把账号贡献给团队 | 在团队面板选择账号，通过浏览器完成独立的共享授权，设置每周共享上限，也可随时终止共享。 |
| 成员使用共享额度 | 通过邀请码加入团队，选择 Codex 模型即可使用共享账号；成员无需登录贡献者的 OpenAI 账号。 |
| 管理多个团队 | 在团队名称菜单切换本机已保存的团队；所有者可保存恢复码，用于在同一服务器上恢复管理身份。 |
| 创建自己的团队 | 在团队页面点击“创建团队”，填写团队名称和昵称，即可成为所有者并邀请成员。 |

Web 中添加账号和贡献账号都使用浏览器登录流程。贡献账号需要单独确认共享授权；已有的本机登录不会自动把凭据交给团队。当前版本仍保留设备码相关路径，尚未移除 `device_code`。

## 最近上新

**0.1.5：安装后直接创建或加入云端团队，继续适配官方 DSH `0.1.2-rc.1` / Cordis `4.0.2`。**

- **默认云端入口**：全新安装无需填写 Team 服务地址，即可在页面创建团队或使用邀请码加入。
- **本机与团队按连接状态使用**：默认模式下，未加入时使用本机账号池；加入、切换或断开连接从下一次请求生效。
- **连接失败有恢复说明**：页面显示实际服务地址，区分本机测试服务与远端服务；网络失败保留成员凭据，可在连接恢复后重试。
- **保留已有连接**：原本正常的云端团队无需重建或重新加入；显式配置的服务地址和禁用状态继续生效。

已安装 `0.1.4` 且指向 `localhost` 或 `127.0.0.1` 的用户，升级后仍需修正原连接配置；创建新团队不能修复地址错误或服务停机。详见 [0.1.5 发布说明](docs/releases/0.1.5.md) 和 [团队连接与恢复](docs/team-connection.md)。

## 界面与操作

以下素材来自公开 npm `0.1.4` 安装到官方 DSH `0.1.2-rc.1` 后的实际页面。账号、团队和成员名称已在浏览器显示层脱敏；额度与用量未改写，图片未展示邀请码、恢复码或登录凭据。

### 贡献者：账号、共享上限和近期用量放在一起

<p align="center">
  <img src="https://raw.githubusercontent.com/502399493zjw-lgtm/dsh-codex-shared-pool/main/docs/assets/v0.1.4/team-owner.png" alt="贡献者查看共享账号、本周共享金额与上限、账号剩余额度和近期请求" width="800" />
</p>

### 共享保护：打开上限编辑，再取消返回

<p align="center">
  <img src="https://raw.githubusercontent.com/502399493zjw-lgtm/dsh-codex-shared-pool/main/docs/assets/v0.1.4/sharing-limit.gif" alt="在实际 DSH 页面打开每周共享金额上限编辑框，查看说明并取消返回" width="800" />
</p>

GIF 展示实际编辑入口，本次录制没有保存上限。金额按标准 API 等价值估算，不是订阅账单，也不保证精确限制上游消耗；已接纳的请求结算后可能超过预算。

### 成员：查看共享账号，无需导入贡献者的凭据

<p align="center">
  <img src="https://raw.githubusercontent.com/502399493zjw-lgtm/dsh-codex-shared-pool/main/docs/assets/v0.1.4/team-member.png" alt="独立 DSH 实例中的团队成员查看贡献者账号及共享额度" width="800" />
</p>

`0.1.4` 公开包的真实测试已覆盖浏览器共享授权、成员调用、每周共享预算达限拒绝，以及解除限制后的恢复。测试使用同一电脑上的独立 DSH 实例和浏览器配置，尚未覆盖第二台物理设备、跨网络访问或上游订阅额度真正耗尽。这些截图与授权记录保留为 `0.1.4` 历史证据，详见 [公开包测试记录与素材说明](docs/acceptance/0.1.4-published-package.md)。

## 自动切换规则

一次本地请求按下面的顺序选择账号：

1. 读取账号优先顺序和当前会话绑定。
2. 检查各账号针对当前模型的可读额度。
3. “使用中”账号仍可用时继续使用。
4. 它明确为 `0%` 时，跳过该账号，从有可用额度的账号中选择重置时间更早者。
5. 选中的账号成为新的“使用中”账号，并尽量保持会话连续性。
6. 如果所有额度都无法读取，安全地退回现有绑定或首个账号，让 Provider 给出最终结果。

这里的切换发生在请求发往 Provider 之前，并不是先让已耗尽账号失败一次再重试。

## 最近请求

设置页只展示 metadata-only 的路由流水：

- 请求时的账号序号别名；
- 模型；
- 选择原因，例如优先账号、额度回退或并发绑定；
- 请求状态和时间。

它不会记录 prompt、response、文件、OAuth token 或会话正文。每条流水表示一次请求尝试，不代表 token、费用或精确订阅消耗。流水最多在 Host 进程内保留 100 条，Host 重启后清空。

## 安装

当前安装版本为 `0.1.5`，适配官方 DSH `0.1.2-rc.1` / Cordis `4.0.2`。npm `0.1.3` 仍适用于旧基线 DSH `0.1.0-rc.8`。

安装到新版 DSH Web profile：

```bash
npx @deepseek-ai/dsh@0.1.2-rc.1 plugin --profile web add dsh-codex-shared-pool@0.1.5
npx @deepseek-ai/dsh@0.1.2-rc.1 web
```

升级已有实例前请备份 `DSH_HOME`（默认 `~/.dsh`），并退出旧 DSH 进程。现有账号文件和团队配置沿用原位置，不需要重新导入；其他社区插件需要分别确认新版兼容性。仓库的 `pnpm run test:stock` 和 CI 会使用固定依赖快照验证此版本的实际安装及启动。

已有正常云端连接的用户直接升级即可，原团队、成员和共享账号保留。若旧配置指向本机测试服务，升级不会覆盖它：先按 [团队连接与恢复](docs/team-connection.md) 修正服务地址及对应凭据，再连接原云端团队。本机测试服务的邀请码和成员身份不能直接用于云端。

然后启动同一个 Web profile，进入：

```text
设置 → Codex 订阅池 → 本机
```

点击“添加账号”会发起一条独立 OAuth 授权链。授权等待期间可以手动取消；超时或 Host 重启后不会残留永久等待状态。

安装 patch 只挂载插件，不会把现有默认模型或搜索 Provider 改成
`openai-codex`。添加账号后，请在 DSH 中按需选择 OpenAI Codex Provider、模型，
并仅在希望搜索也走 Codex 时手动选择对应 Search Provider。

官方 SDK protocol 与 schema 包仍按社区目录规则声明为 peer；Host 构建会内联它们实际使用的轻量运行时代码，避免 stock DSH profile 还要重复安装官方包。

## 模型能力

模型目录兼容：插件为固定版本 DSH 的 Codex 目录补充 `gpt-6-astra`（GPT-6-Astra），本地账号和 Team 共享模式均可选择，并支持 Fast。推理档位为 `low`、`medium`（默认）、`high`、`xhigh`、`max`。目录可选不代表每个共享账号都有该模型的上游权限。Astra 尚未加入 Team 的已验证价格表，费用沿用未知价格处理，不套用其他模型的单价。

Codex 模型菜单提供中文模式与推理等级说明；保留 Responses、搜索、图片生成和 `read_image` 能力。目录可选和界面展示不等于每个账号都获得了对应模型权限。

## TUI 管理

本地命令和设置页共用同一个 Host 账号池：

```text
/codex status
/codex login
/codex profiles
/codex add
/codex cancel
/codex activate <profile-id>
/codex rename <profile-id> <label>
/codex remove <profile-id>
/codex usage
/codex config
```

## 安全边界

- OAuth credential、refresh token、认证文件、Codex 子进程和文件系统访问只属于 Host。
- Browser 仅通过插件自己的 same-origin 路由读取经过类型约束的最小脱敏数据。
- 不提供 OpenAI/OAuth 凭据导出接口，也不要求上传或复制正在使用的 `auth.json`。团队所有者可显式导出本机保存的团队恢复码，用于换设备恢复身份。
- 账号别名和最近请求记录不包含原始 profile id、prompt、response 或 token。
- 本项目通过公开 Cordis/DSH 扩展点安装，不修改或 fork DSH 核心。

<a id="团队共享与自托管"></a>

## 团队管理

团队页面提供创建、加入、切换和恢复管理身份的入口。

在 **设置 → Codex 订阅池 → 团队** 使用邀请码：尚未连接时直接粘贴邀请码并查看邀请；已连接时点击 **团队名称** 展开下拉菜单，在底部选择 **加入团队**，核对团队名称后填写成员名称并加入。成功加入前，本机仍使用原团队；网络中断时可通过页面的恢复入口继续处理。

在团队面板或团队设置页点击 **团队名称**，可以直接选择本机保存的其他团队；当前团队带有选中标记。切换只改变这台 DSH Host 当前使用的团队，保留其他团队的成员身份和共享账号；团队密钥保存在 Host 凭据存储，页面只显示团队和成员名称。当前仅支持同一配置服务器上的团队，其他设备需要单独加入或使用所有者恢复码连接；有待恢复的创建、加入、授权或团队终止清理时，先完成对应流程再切换。

下拉菜单底部的 **创建团队** 支持匿名自助创建：填写团队名称和昵称，创建成功后自动成为所有者并切换到新团队。无需注册账号，原团队的连接只在创建成功后切换；网络中断后点击 **继续完成** 确认同一次操作，不会重复建队。此功能需要团队服务端更新到支持自助创建的版本；旧服务端会显示尚不支持的提示。

创建后，页面提示保存恢复码，点击 **显示恢复码** 再复制私密保存。已有所有者也可在 **团队设置 → 团队管理 → 保存团队恢复码** 导出本机保存的恢复码。恢复码等同于团队管理钥匙，不能作为邀请码分享；它只在显式请求时展示，不出现在普通状态或团队概览里。换设备时，在未连接页或团队下拉菜单选择 **使用恢复码**，即可在同一服务器上恢复所有者身份。旧版本创建或从其他设备加入的团队可能没有本机可导出的恢复码。

## 高级选项：团队服务配置与自托管

以下供 DSH 维护者配置其他服务连接，或供希望自己维护团队后端、数据和网络入口的人使用。全新安装 `0.1.5` 的普通成员无需执行这些配置，默认即可使用云端创建、加入入口。

### 连接已有团队服务

需要连接自托管服务，或恢复已有显式连接配置时，请由 DSH 维护者在现有 `dsh-codex-shared-pool` 插件条目的 `config` 下设置：

```yaml
teamClient:
  enabled: true
  baseUrl: https://team.example.com/plugins/dsh-codex-shared-pool/team
  apiKeyRef: DSH_CODEX_SHARED_POOL_TEAM_API_KEY
```

将示例地址替换为实际团队服务地址，重启 DSH 后即可在团队页面创建或加入团队。`baseUrl` 必须完整包含 `/plugins/dsh-codex-shared-pool/team`；公网或跨设备使用必须是 HTTPS，只有回环地址的本地测试允许 HTTP。

显式设置 `teamClient.enabled: false` 会继续禁用团队连接；已有地址和凭据名称也不会被默认云端入口覆盖。改变服务地址时应使用对应服务的成员凭据，不能沿用另一台测试服务的密钥，具体恢复方式见 [连接指南](docs/team-connection.md)。

创建或加入成功后，插件会在本机保存当前成员自己的 Team API key；成员无需手动复制贡献者的凭据。`apiKeyRef` 指定成员密钥在 Host 凭据存储中的名称。

### 自己运行团队服务

自托管用于维护一套自己的团队后端。使用已有团队服务创建团队时，无需执行下面的 Docker 命令。

自托管模板在一台中央服务器上运行四个常驻服务：PostgreSQL、仅监听回环地址的 stock DSH Team Host、Credential Broker，以及窄接口的 Team API Edge；另有一次性数据库迁移器在应用负载启动前完成迁移并退出：

```sh
node deploy/self-hosted/init-secrets.mjs
docker compose -f deploy/self-hosted/compose.yml up --build -d
```

初始化器会在被忽略的 `deploy/self-hosted/.secrets/` 下创建四个权限为 `0600` 的文件：

- `postgres.env`：初始化数据库和不同运行身份的密码；
- `team-migrations.env`：只向一次性迁移器提供 schema-owner 数据库 URL；
- `team-host.env`：向 Team Host 提供控制面所需配置，但不提供凭据解密密钥；
- `credential-broker.env`：只向 Broker 提供 envelope master key、数据库 URL 和内部 API key。

需要让上游请求经过代理时，另行创建被 Git 忽略的
`deploy/self-hosted/.secrets/outbound-network.env`，并将权限设为 `0600`。这个文件不由初始化器生成；按需只填写标准的 `HTTP_PROXY`、`HTTPS_PROXY` 和 `NO_PROXY`，不要把代理地址或凭据写入 Compose、镜像或仓库。`NO_PROXY` 必须包含 `127.0.0.1` 和 `localhost`，以免回环上的 Host/Broker 请求绕远。

Compose 会把同一份可选代理文件交给 Team Host 和 Credential Broker。修改 `outbound-network.env` 后，必须重建或重启 Team Host 与 Credential Broker 才会生效：

```sh
docker compose -f deploy/self-hosted/compose.yml up -d --force-recreate team-host credential-broker
```

数据库按权限拆分为 `dsh_team_host_login` 和 `dsh_team_broker_login`。Team Host 不能读取 `team_contribution_credentials`；Credential Broker 不能读取团队控制面表。DSH Web/Remote API 不对公网暴露，Team API Edge 只转发 `/plugins/dsh-codex-shared-pool/team/...`。

完整部署说明与早期阶段验收见 [第二期验收文档](docs/acceptance/team-mvp-phase-two.md)；[0.1.4 公开包测试记录](docs/acceptance/0.1.4-published-package.md) 保留当时的真实授权与页面证据，默认云端连接修复的回归和隔离安装验证见 [验收记录](docs/acceptance/cloud-team-onboarding.md)。

## 额度、订阅与升级排障

本地额度和订阅档位来自同一次 ChatGPT 用量请求。直连超时会让两项一起不可用，不代表账号额度为零，也不应据此要求重新登录。设置页的高级选项会显示代理是否启用。

- macOS：未设置代理环境变量时，插件启动时自动读取系统已启用的 HTTP/HTTPS 代理；重启 DSH 后仍会重新读取，无需把代理端口写进插件代码。自动发现的代理始终绕过 localhost、127.0.0.1 和 ::1，并带上系统代理例外列表。
- 手动设置的 `HTTP_PROXY` / `HTTPS_PROXY`（小写优先）优先于系统发现；显式设置为空会禁用系统发现。仅支持 HTTP/HTTPS 代理，不执行 PAC 脚本，也不把 SOCKS 地址当成 HTTP 代理。使用 PAC/SOCKS 时，请为 DSH 配置代理软件提供的 HTTP 监听地址。
- Linux、Windows、容器或后台服务：将代理环境变量持久化在启动服务的配置中，而不是只在当前终端临时 export。`NO_PROXY` 至少包含 `localhost,127.0.0.1,[::1]`。容器里的 127.0.0.1 指容器本身，应使用容器能访问到的代理地址。
- Team 模式的请求由远端 Credential Broker 发出，本机代理无法修复远端网络。Host 和 Broker 应使用匹配版本；只升级本地插件不会为旧 Broker 补上订阅字段。订阅未知时不猜测档位或金额。

Team 的额度来自 overview，金额和最近用量来自 usage；后者失败不再覆盖前者。数据库报缺列时，应由 Team 管理者备份数据库并执行迁移，普通团队成员不需要修改数据库。

自托管升级必须先构建匹配的 Host/Broker，再使用 schema-owner 运行迁移，成功后启动服务：

```sh
docker compose -f deploy/self-hosted/compose.yml build team-host credential-broker team-edge
docker compose -f deploy/self-hosted/compose.yml run --rm team-migrations
docker compose -f deploy/self-hosted/compose.yml up -d --force-recreate team-host credential-broker team-edge
```

非 Compose 部署使用同版本包的 `dsh-codex-team-migrate`，通过管理员的私密配置提供 `DSH_CODEX_SHARED_POOL_DATABASE_URL`，不要给运行中的 Host/Broker 增加 schema-owner 权限。迁移 22 会为缺失 `team_invites.label` 的旧库补回字段，并将缺失的邀请说明设为 `Team invitation`；保留已有说明、邀请码摘要和加密内容，不会重发或撤销邀请。它不会恢复已经丢失的原说明。迁移 24 会解除旧用量表 `last_heartbeat_at` 的必填约束，保留已有时间戳，避免成员请求在写入用量记录时因该遗留字段返回 `Team upstream request failed`。请求存活状态由路由租约维护，新用量记录不再填写旧心跳字段。初始化会检查用量表和邀请码表的实际字段，而不只信任迁移版本记录；若迁移记录齐全但字段仍缺失，说明数据库结构与迁移历史不一致，应停止升级、检查备份/恢复过程并修复结构，不要清空数据库或删除迁移记录来绕过检查。

## 开发与验证

```bash
pnpm test
pnpm run build
pnpm run verify:package
pnpm pack
```

`verify:package` 只验证 npm 包结构，不等于真实 DSH 安装验证。兼容性结论还需要把打包后的 tarball 安装进隔离的 stock DSH，再完成启动和路由探测。

本项目当前固定验证基线：

- DSH `0.1.2-rc.1`
- Cordis `4.0.2`
- Node.js `^22.19.0` 或 `>=24.0.0`

## 已知限制

- 上游额度取决于 Provider 当前可观测信号，插件不虚构精确 token 或订阅成本。
- 额度读取暂时失败时会 fail-open；只有明确读取到模型额度耗尽才会在请求前跳过账号。
- 本地最近请求流水是进程内观察数据，不是持久化账本。
- 更换 DSH/Cordis 版本前需要重新执行 stock 安装验证。

## 许可证

[MIT](LICENSE)
