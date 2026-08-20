# DSH Codex Shared Pool

在 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/DeepSeek-Harness) 里自由使用 Codex 订阅额度：把多个 ChatGPT/Codex 订阅账号放进同一个本地账号池，并在请求前根据模型额度自动选择可用账号。

当前版本收口“一期”的本地多账号体验。

## 它解决什么问题

- 在 DSH 设置中分别完成 OAuth，添加多个 Codex 账号；不复制 `auth.json`。
- 每次请求前读取所选模型的上游额度；当前账号明确耗尽时，自动选择仍有额度的账号。
- 多个候选账号都可用时，优先选择上游重置时间更早的账号。
- 自动切换后，新账号会成为全局“使用中”账号；也可以点击“使用此账号”手动切换。
- 在设置页查看最近请求走了哪个账号、为什么切换、使用的模型以及成功/失败状态。
- 保留 Codex Responses、搜索、图片生成、`read_image`、TUI 管理等原有能力。

## 真实操作

以下两段展示一期最核心的产品操作：先看真实账号池和各账号额度，再看优先账号额度不足时如何自动切换并留下请求流水。第二段只模拟“首账号额度不足”的输入信号，账号选择、Provider 请求、响应和最近请求流水都由插件实际完成。

### 多账号池与额度概览

<p align="center">
  <img src="https://raw.githubusercontent.com/502399493zjw-lgtm/dsh-codex-shared-pool/assets/phase-one-routing/account-pool-and-quota.gif" alt="在 DSH 中查看 Codex 多账号池和各账号额度" width="900" />
</p>

### 额度不足时自动路由并留下最近请求流水

<p align="center">
  <img src="https://raw.githubusercontent.com/502399493zjw-lgtm/dsh-codex-shared-pool/assets/phase-one-routing/automatic-routing-and-receipts.gif" alt="演示额度信号触发 Codex 自动路由，并显示真实响应和最近请求流水" width="779" />
</p>

> 第二段明确标注为混合演示：只把原使用中账号的额度信号临时投影为 `0%`，用于稳定触发回退；插件在请求发出前跳过它，并由下一可用账号完成真实 Provider 请求。流水中的“1 次请求”不代表 Token、费用或精确订阅消耗。

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

当前为 alpha 版本，发布在 npm 的 `next` tag。安装到 DSH Web profile：

```bash
dsh plugin --profile web add dsh-codex-shared-pool@0.1.0-alpha.1
```

如需跟随后续预发布版本，可将精确版本替换为 `dsh-codex-shared-pool@next`。

然后启动同一个 Web profile，进入：

```text
设置 → OpenAI Codex
```

点击“添加账号”会发起一条独立 OAuth 授权链。授权等待期间可以手动取消；超时或 Host 重启后不会残留永久等待状态。

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
- 不提供凭据导出接口，也不要求上传或复制正在使用的 `auth.json`。
- 账号别名和最近请求记录不包含原始 profile id、prompt、response 或 token。
- 本项目通过公开 Cordis/DSH 扩展点安装，不修改或 fork DSH 核心。

## 开发与验证

```bash
pnpm test
pnpm run build
pnpm run verify:package
```

`verify:package` 只验证 npm 包结构，不等于真实 DSH 安装验证。兼容性结论还需要把打包后的 tarball 安装进隔离的 stock DSH，再完成启动和路由探测。

本项目当前固定验证基线：

- DSH `0.1.0-rc.8`
- Cordis `4.0.1`
- Node.js `^22.19.0` 或 `>=24.0.0`

## 已知限制

- 上游额度取决于 Provider 当前可观测信号，插件不虚构精确 token 或订阅成本。
- 额度读取暂时失败时会 fail-open；只有明确读取到模型额度耗尽才会在请求前跳过账号。
- 本地最近请求流水是进程内观察数据，不是持久化账本。
- 更换 DSH/Cordis 版本前需要重新执行 stock 安装验证。

## 许可证

[MIT](LICENSE)
