# 容器运行与验证边界

已提供 Docker 多阶段构建和 Compose 配置。本机没有 Docker，当前页面使用 Node.js 运行；2026-09-22 已在 GitHub Actions 的 Ubuntu 环境实际完成独立容器验证，见 [运行记录](https://github.com/jayson2hu/open-product-radar/actions/runs/35708116908)（代码提交 `48ef3cf`）。云端验证与正式服务器部署分别验收。

已通过：无凭据 Compose 配置校验、生产镜像构建、非 root 进程、空生产库、演示登录拒绝、容器健康、进程重启及命名卷中的 SQLite 数据保留。测试容器禁用外部网络、没有发布宿主端口，不启动采集或外发邮件；结束后删除专用测试容器和卷。未验证目标服务器的 TLS/OAuth、真实采集网络、邮件或生产恢复。

## 配置内容

- 构建阶段使用固定版本 `node:24.20.0-bookworm-slim`，通过锁文件安装依赖并构建前端；运行阶段只带前端构建结果及服务端、worker、运行脚本。
- 镜像使用 `node` 非 root 用户。应用数据和备份目录已赋予该用户权限，新建命名卷会采用镜像目录内容和权限；已存在且权限不符的旧卷需要运营核查，不能假定一定可写。
- `web` 固定监听容器内 `4188`，只向宿主 `127.0.0.1` 绑定；通过 `RADAR_HOST_PORT` 更换宿主端口，避免与本机服务冲突。
- `worker` 通过显式 `collection` profile 启动，等待网页服务健康。网页使用 HTTP 健康检查，worker 不监听 HTTP，已禁用其继承的网页探针；任务进度需查看日志和后台任务记录，不能把容器进程存在当作采集成功。
- 两个服务共享独立命名数据卷，不挂载宿主项目的 `data` 目录，不会自动读入本机演示库或实采库。不同 Compose 项目名使用不同命名卷。
- 容器强制使用 `production` 数据库。来源默认未获准采集；仅启动 worker 不会绕过来源审核。请求日/月预算、请求超时和轮询间隔从 Compose 环境明确传入。
- Compose 固定邮件模式为 `outbox`，不传邮件供应商密钥，也不启用外发。来源元数据、用户资料、密钥、SQLite 文件和邮件预览不应进入镜像构建上下文。

## 在已安装 Docker 的机器启动

以下命令从项目根目录运行。先准备 `.env`；正式登录需要真实 HTTPS `RADAR_PUBLIC_URL` 与 GitHub OAuth 配置。开发 `.env` 中的 `RADAR_MODE` 和 `PORT` 不会覆盖容器的生产模式及内部端口。

```powershell
docker compose --env-file .env -p radar -f infra/compose.yml config --quiet
docker compose --env-file .env -p radar -f infra/compose.yml up --build -d web
docker compose --env-file .env -p radar -f infra/compose.yml ps
```

`config --quiet` 只校验配置，不输出可能含凭据的展开结果。上面的命令尚未在当前机器实测。镜像下载与构建依赖网络，需要目标环境能够访问镜像仓库和 npm registry。

在来源用途、允许保留的内容和权限核查完成后，才启动采集：

```powershell
docker compose --env-file .env -p radar -f infra/compose.yml --profile collection up -d worker
docker compose --env-file .env -p radar -f infra/compose.yml logs --tail 50 worker
```

`RADAR_GITHUB_TIMEOUT_MS` 默认为 30000，应用接受 1000～45000 毫秒；本机单次实采脚本使用 45000 毫秒。请求预算默认为每日 1000、每月 20000 次，且仍受数据库中的成本预算约束。来源限流后等待记录的重试时间，不以重启容器绕过限流。

## 隔离健康验证

验证时选独立项目名、独立宿主端口，只启动 `web`，不启用采集 profile。下面使用 4288；执行前确认该端口未占用，并保存、恢复原有环境变量。独立项目产生的数据库初始为空。

```powershell
$env:RADAR_HOST_PORT = '4288'
$env:RADAR_PUBLIC_URL = 'http://127.0.0.1:4288'
docker compose --env-file .env -p radar-container-check -f infra/compose.yml config --quiet
docker compose --env-file .env -p radar-container-check -f infra/compose.yml up --build -d web
docker compose --env-file .env -p radar-container-check -f infra/compose.yml ps
Invoke-RestMethod http://127.0.0.1:4288/api/v1/health
docker compose --env-file .env -p radar-container-check -f infra/compose.yml down
```

健康响应应包含 `status: ok`、`mode: production`，Docker 应将 `web` 标为 healthy。使用 HTTP 的隔离验证只用于匿名页面和健康接口，不代表生产登录、TLS、采集网络或邮件已验证。停止命令保留测试卷；仅在核对项目名和卷归属后单独清理测试卷，勿对日常项目误用删除卷选项。

## 数据与运维

容器内使用 `/app/data/radar-production.sqlite`。网页卷 `radar-backups` 挂载到 `/app/backups`，可在网页容器中运行 `node scripts/backup.mjs /app/backups/唯一名称.sqlite`。备份与删除台账的保留、异地保存及恢复规则仍按 `docs/RUNBOOK.md` 执行；命名卷不是异地备份。

容器没有自动导入本机实采数据的步骤。若以后迁移实采库，应先做一致性备份、校验和检查及删除台账核对，再按受控恢复流程导入；不要把正在写入的 SQLite 主文件直接复制进去，也不要挂载同一数据库给多个独立写入副本。
