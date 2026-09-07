# Changelog

## 0.1.4 — 2026-09-07

- 适配官方 DSH `0.1.2-rc.1` / Cordis `4.0.2`，修复新版设置与浏览器服务接口变化导致的加载失败，迁移模型请求准备与图片访问流程。
- 增加 Windows、Linux 的官方 DSH 安装、启动、插件路由和浏览器资源验证。
- 突出账号名称，统一本机与共享账号的额度、订阅信息和刷新位置；本地额度显示重置时间。
- 区分每周共享用量 / 上限与账号 API 等价金额估算；共享上限校验或保存失败时显示就地反馈并保留输入。
- 支持从成员页创建邀请；侧边栏额度刷新失败时保留上次成功数据，并显示过期状态及最后更新时间。

安装：`npx @deepseek-ai/dsh@0.1.2-rc.1 plugin --profile web add dsh-codex-shared-pool@0.1.4`。升级前备份 DSH 数据并退出旧进程，自托管团队还需更新匹配的 Host/Broker 并执行数据库迁移，见 [README](README.md#额度订阅与升级排障)。

[兼容性验证](docs/compatibility/dsh-0.1.2-rc.1.md) · [公开包真实测试](docs/acceptance/0.1.4-published-package.md) · [变更范围](https://github.com/502399493zjw-lgtm/dsh-codex-shared-pool/compare/b28ccecaa3abb610791d740cce05315e91a1f390...6ceecada09c958447b4e434c484f8fd2e0e60d96)

## 0.1.3 — 2026-09-06

- 邀请码在过期或撤销前可供多名成员使用；简化邀请列表，改善成员操作菜单与长名称布局。
- 将所有者恢复入口与创建团队分开，改善加入团队后的返回操作。
- 共享授权前可查看、编辑上限；按已结算的每周共享用量判断是否接纳新请求，达到预算后拒绝新请求。
- 调整账号、共享操作、订阅档位与近期用量的布局，统一未共享账号的额度显示与刷新入口。
- 继续适配 DSH `0.1.0-rc.8` / Cordis `4.0.1`，是旧基线对应的最后一个插件版本。

[变更范围](https://github.com/502399493zjw-lgtm/dsh-codex-shared-pool/compare/v0.1.2...b28ccecaa3abb610791d740cce05315e91a1f390)

## 0.1.2 — 2026-09-06

- 同一账号的并发槽位被占用时，支持最多 60 秒、可取消的接纳等待，改善标题请求与正文请求竞争；保留并发上限，不重放请求。
- 上游缺少 Content-Type 时，仍可从有效 SSE / JSON 中计量用量；无效或不完整计数保持未计量。
- 继续适配 DSH `0.1.0-rc.8` / Cordis `4.0.1`。

[发布说明与验证](https://github.com/502399493zjw-lgtm/dsh-codex-shared-pool/releases/tag/v0.1.2)

## 0.1.1 — 2026-09-06

- 新增自托管 Team 共享服务，支持创建与恢复团队、邀请码加入、成员密钥及本机团队切换。
- 展示共享账号额度、共享上限和近期用量，支持手动刷新额度；统一贡献者与使用者的账号详情布局，空的本周使用量显示为 0。
- 修复共享用量结算、占用槽位等待、额度刷新及数据库兼容性问题。
- 在本地与共享模型目录中提供 GPT-6-Astra。
- 继续固定兼容 stock DeepSeek Harness 0.1.0-rc.8 / Cordis 4.0.1。

安装或升级：`dsh plugin --profile web add dsh-codex-shared-pool@0.1.1`，然后重启对应 Web profile。

历史版本：[v0.1.0](https://github.com/502399493zjw-lgtm/dsh-codex-shared-pool/releases/tag/v0.1.0)。
