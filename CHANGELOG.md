# Changelog

## 0.1.1 — 2026-09-06

- 新增自托管 Team 共享服务，支持创建与恢复团队、邀请码加入、成员密钥及本机团队切换。
- 展示共享账号额度、共享上限和近期用量，支持手动刷新额度；统一贡献者与使用者的账号详情布局，空的本周使用量显示为 0。
- 修复共享用量结算、占用槽位等待、额度刷新及数据库兼容性问题。
- 在本地与共享模型目录中提供 GPT-6-Astra。
- 继续固定兼容 stock DeepSeek Harness 0.1.0-rc.8 / Cordis 4.0.1。

安装或升级：`dsh plugin --profile web add dsh-codex-shared-pool@0.1.1`，然后重启对应 Web profile。

历史版本：[v0.1.0](https://github.com/502399493zjw-lgtm/dsh-codex-shared-pool/releases/tag/v0.1.0)。
