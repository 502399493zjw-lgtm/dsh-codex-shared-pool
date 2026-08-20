# Team 自托管部署

这里是第二阶段 Team 共享能力的单机 Docker Compose 入口。一台服务器可以承载多个相互隔离的 Team；它不是当前一期本地多账号功能的安装前提。

## 进程与网络边界

Compose 包含四个长期运行的进程和一个一次性数据库迁移器：

- `postgres`：保存 Team 控制面、使用流水和加密凭据；
- `team-host`：运行 stock DSH 与 Team 控制面，只监听内部/回环边界；
- `credential-broker`：单独持有凭据解密能力，不公开端口；
- `team-edge`：唯一面向外部的 Team API 入口；
- `team-migrations`：启动时运行一次，完成 schema 与数据库角色迁移后退出。

默认只把 Team Edge 暴露到 `127.0.0.1:3080`。正式公网部署仍需要在外层配置 TLS、认证入口、WAF、速率限制、备份和监控。

## 密钥文件

先运行：

```bash
node deploy/self-hosted/init-secrets.mjs
```

它会在 `deploy/self-hosted/.secrets/` 生成四个权限为 mode-`0600` 的文件：

- `postgres.env`
- `team-migrations.env`
- `team-host.env`
- `credential-broker.env`

这些文件不得提交到 Git。脚本拒绝覆盖已有文件，避免误换生产密钥。

## 数据库权限隔离

- `dsh_team_migrator` 只供一次性迁移器使用，持有 schema 变更权限；
- `dsh_team_host_login` 供 Team Host 使用，不能读取 `team_contribution_credentials`；
- `dsh_team_broker_login` 供 Credential Broker 使用，不能读取 Team 控制面表；
- envelope master key 只进入 `credential-broker.env`，不会进入 Team Host 或 Browser。

加密存储不等于零知识：有 Broker 执行权限的恶意管理员或服务 RCE 仍可能代发请求。正式部署应继续使用 KMS envelope encryption、短期 workload identity、出站限制、审计和异常告警。

## 启动

```bash
docker compose -f deploy/self-hosted/compose.yml up --build --wait
```

停止并删除容器：

```bash
docker compose -f deploy/self-hosted/compose.yml down
```

不要在仍需保留数据时加 `--volumes`。

当前 Team 能力仍属于第二阶段实验实现，不应把 Compose 能启动等同于生产安全验证。
