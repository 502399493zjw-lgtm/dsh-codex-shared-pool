# DSH Codex Shared Pool

在 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/DeepSeek-Harness) 中管理多个 Codex 订阅账号，并通过自托管团队服务把愿意贡献的账号额度分享给其他成员。

[最新发布](https://github.com/502399493zjw-lgtm/dsh-codex-shared-pool/releases/latest) · [更新日志](CHANGELOG.md) · [安装](#安装) · [团队与自托管](#团队共享与自托管)

## 最近上新

**0.1.4 已发布到 npm，适配官方 DSH `0.1.2-rc.1` / Cordis `4.0.2`。**

- **新版 DSH 兼容**：修复新版 Host 与浏览器接口变化导致的加载问题，加入 Windows、Linux 的官方 DSH 安装与启动验证。
- **账号与额度更清楚**：突出账号名称，统一本机与共享账号的额度、订阅信息及刷新入口；本地额度显示重置时间。
- **共享保护更易懂**：区分“本周已共享 / 上限”、账号剩余额度和 API 等价金额估算；无效上限或保存失败时就地提示并保留输入。
- **团队操作更顺手**：可从成员页创建邀请；侧边栏额度刷新失败时保留上次成功数据，并显示过期状态和最后更新时间。

近期版本还加入了可复用邀请码、独立的所有者恢复入口，以及达到每周共享预算后拒绝新请求的保护。完整版本归属见 [CHANGELOG](CHANGELOG.md)。

## 它解决什么问题

DSH 本身一次只绑定一个 Codex 账号。这个插件解决两种使用问题：

- **本地多账号**：你有多个自己的 ChatGPT/Codex 订阅时，可以分别登录到同一个本机账号池。插件在请求发出前读取当前模型的可用额度；当前账号明确耗尽时，自动切换到其他可用账号，并记录选择原因。
- **团队共享**：你愿意贡献某个账号的额度时，可以只授权它用于团队请求，并设置每周共享上限。其他成员通过邀请码使用共享账号，成员不需要登录贡献者的 OpenAI 账号，也看不到贡献者的 OAuth 凭据。

本地模式和团队模式是两条独立路径：不部署团队服务时，插件仍然可以只作为本机多账号池使用；团队服务是需要时再增加的共享能力。

## 怎么用

### 只使用本地账号池

1. 安装插件并启动 DSH Web。
2. 打开 **设置 → Codex 订阅池 → 本机**，点击“添加账号”，为每个自己的订阅账号分别完成浏览器登录。
3. 在会话中选择 **OpenAI Codex** Provider 和模型。插件会优先使用当前账号；如果明确读到当前模型额度为 `0%`，就切换到额度可用且重置时间更早的账号。
4. 需要固定某个账号时，在账号卡片上点击“使用此账号”；在“最近请求”中可以查看实际使用的账号别名和路由原因。

### 使用团队共享额度

成员和贡献者都要在自己的 DSH 中安装插件，但只有团队管理员需要额外部署中央团队服务：

1. 管理员在自己控制的服务器运行仓库的 Docker Compose，得到一个团队地址；初始化数据库并保存好服务端密钥。
2. 管理员在团队面板创建团队，从 **设置 → Codex 订阅池 → 团队** 创建邀请码。
3. 贡献者在同一处选择要共享的本机账号，通过浏览器完成单独的共享授权，设置每周共享上限。
4. 成员粘贴邀请码加入团队。成员的请求由远端 Credential Broker 使用已授权的共享账号发出，成员本机不保存贡献者的 `auth.json`。

成员 DSH 需要把插件的 Team client 指向管理员提供的 HTTPS 地址，并把成员自己的 Team API key 存入 DSH 凭据存储：

```yaml
teamClient:
  enabled: true
  baseUrl: https://team.example.com/plugins/dsh-codex-shared-pool/team
  apiKeyRef: DSH_CODEX_SHARED_POOL_TEAM_API_KEY
```

启用后重启 DSH，再通过团队页面使用邀请码加入。`baseUrl` 必须完整包含 `/plugins/dsh-codex-shared-pool/team`；公网或跨设备使用必须是 HTTPS，只有回环地址的本地测试允许 HTTP。

## 场景速览

| 场景 | 使用方式 |
| --- | --- |
| 一个人有多个订阅账号 | 在本机账号池分别登录；请求前按模型额度选择账号，明确耗尽时自动切换，并留下路由流水。 |
| 把账号贡献给团队 | 在团队面板选择账号，通过浏览器完成独立的共享授权，设置每周共享上限，也可随时终止共享。 |
| 成员使用共享额度 | 在已配置团队服务的 DSH 中通过邀请码加入，选择 Codex 模型即可使用共享账号；成员无需登录贡献者的 OpenAI 账号。 |
| 管理多个团队 | 在团队名称菜单切换本机已保存的团队；所有者可保存恢复码，用于在同一服务器上恢复管理身份。 |
| 自己部署团队服务 | 使用仓库内的 Docker Compose 模板部署 Host、Credential Broker、Team API Edge 和 PostgreSQL。 |

Web 中添加账号和贡献账号都使用浏览器登录流程。贡献账号需要单独确认共享授权；已有的本机登录不会自动把凭据交给团队。当前版本仍保留设备码相关路径，尚未移除 `device_code`。

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

真实测试已覆盖浏览器共享授权、成员调用、每周共享预算达限拒绝，以及解除限制后的恢复。测试使用同一电脑上的独立 DSH 实例和浏览器配置，尚未覆盖第二台物理设备、跨网络访问或上游订阅额度真正耗尽。详见 [公开包测试记录与素材说明](docs/acceptance/0.1.4-published-package.md)。

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

当前版本适配官方 DSH `0.1.2-rc.1`，已发布到 npm `0.1.4`。npm `0.1.3` 仍适用于旧基线 DSH `0.1.0-rc.8`。

安装到新版 DSH Web profile：

```bash
npx @deepseek-ai/dsh@0.1.2-rc.1 plugin --profile web add dsh-codex-shared-pool@0.1.4
npx @deepseek-ai/dsh@0.1.2-rc.1 web
```

升级已有实例前请备份 `DSH_HOME`（默认 `~/.dsh`），并退出旧 DSH 进程。现有账号文件和团队配置沿用原位置，不需要重新导入；其他社区插件需要分别确认新版兼容性。仓库的 `pnpm run test:stock` 和 CI 会使用固定依赖快照验证此版本的实际安装及启动。

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

## 团队共享与自托管

同一个 npm 包提供邀请制 Team、成员额度共享、Team 请求路由和自托管部署。OAuth 凭据、数据库连接和团队连接密钥仍只存在于 Host；Browser 只读取插件 same-origin 路由返回的最小脱敏投影。所有者恢复码仅在显式导出时展示。

在 **设置 → Codex 订阅池 → 团队** 使用邀请码：尚未连接时直接粘贴邀请码并查看邀请；已连接时点击 **团队名称** 展开下拉菜单，在底部选择 **加入团队**，核对团队名称后填写成员名称并加入。成功加入前，本机仍使用原团队；网络中断时可通过页面的恢复入口继续处理。

在团队面板或团队设置页点击 **团队名称**，可以直接选择本机保存的其他团队；当前团队带有选中标记。切换只改变这台 DSH Host 当前使用的团队，保留其他团队的成员身份和共享账号；团队密钥保存在 Host 凭据存储，页面只显示团队和成员名称。当前仅支持同一配置服务器上的团队，其他设备需要单独加入或使用所有者恢复码连接；有待恢复的创建、加入、授权或团队终止清理时，先完成对应流程再切换。

下拉菜单底部的 **创建团队** 支持匿名自助创建：填写团队名称和昵称，创建成功后自动成为所有者并切换到新团队。无需注册账号，原团队的连接只在创建成功后切换；网络中断后点击 **继续完成** 确认同一次操作，不会重复建队。此功能需要团队服务端更新到支持自助创建的版本；旧服务端会显示尚不支持的提示。

创建后，页面提示保存恢复码，点击 **显示恢复码** 再复制私密保存。已有所有者也可在 **团队设置 → 团队管理 → 保存团队恢复码** 导出本机保存的恢复码。恢复码等同于团队管理钥匙，不能作为邀请码分享；它只在显式请求时展示，不出现在普通状态或团队概览里。换设备时，在未连接页或团队下拉菜单选择 **使用恢复码**，即可在同一服务器上恢复所有者身份。旧版本创建或从其他设备加入的团队可能没有本机可导出的恢复码。

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

完整部署说明与早期阶段验收见 [第二期验收文档](docs/acceptance/team-mvp-phase-two.md)；其中旧版本的验收状态保留为历史记录，当前基线与实测见 [0.1.4 测试记录](docs/acceptance/0.1.4-published-package.md)。

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
