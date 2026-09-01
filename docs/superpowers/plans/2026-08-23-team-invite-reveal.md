# Team 邀请码安全再查看实施计划

**目标：** 让当前 Team Owner 在邀请码关闭后仍能显式再次查看尚未使用、未过期、未撤销的邀请码，同时保证普通投影、日志、Browser 持久化与 OAuth 凭据系统永远不持有明文。

## 交付契约

- 邀请摘要增加 `revealable`，但不包含完整邀请码。
- 新邀请码同时保存 SHA-256 摘要与 Host-only AES-256-GCM envelope；升级前只有摘要的记录保持 `revealable = false`。
- 增加 Owner-only `POST /invites/reveal`；成功只返回 `inviteId`、`inviteToken`、`expiresAt`，并强制 `Cache-Control: no-store`。
- Team 暂停时可以查看、撤销；不能创建或使用邀请码。
- 邀请接受、撤销、过期清理、所有权转让和 Team 终止时，同一事务清除 envelope；所有权转让同时撤销全部待用邀请码。
- Browser 仅在弹窗组件内存中保存结果，关闭、离页、隐藏页面、身份/连接变化或 60 秒到期时立即清除。
- 独立邀请 KEK 支持当前密钥写入与当前/上一把密钥读取；不复用 OAuth broker 或 OAuth master key。

## 实施顺序

1. 先添加 Memory Store、Postgres Store、路由、Browser API 与 UI 的失败测试。
2. 落共享类型、独立 KEK、envelope cipher 和 Store 接口。
3. 完成 Memory Store 规则，作为产品状态机的快速参考实现。
4. 增加 Postgres migration，并按 Team → invite 顺序加锁；KEK 调用不得发生在 Team 锁内。
5. 接入中央 Host 路由、本机 management proxy 和 Browser typed API。
6. 实现 Owner 邀请列表、不可查看旧记录和 60 秒临时查看弹窗。
7. 运行聚焦测试、全量测试、构建、包格式校验；单独报告是否完成真实 stock DSH 安装 smoke。

## 验收重点

- 普通 overview/list 响应、member 投影、日志与错误中搜索不到完整邀请码。
- 非 Owner、过期、已使用、已撤销、跨 Team 和旧摘要-only 记录全部无法查看。
- envelope 任一字段、AAD 上下文或 keyRef 被篡改都统一安全失败。
- 所有权转让后，旧码不能预览、使用或查看；新 Owner 看到空的有效邀请码列表。
- UI 的秘密清理测试使用 fake timer 与 `visibilitychange`，不依赖肉眼判断。
