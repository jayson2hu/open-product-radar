# 运行、故障与恢复手册

## 1. 环境与启动

Node.js 24，固定前端依赖见 lockfile。`npm ci` 后执行 `npm run build` 与 `npm start`；开发执行 `npm run dev`。健康检查 `/api/v1/health`。默认仅绑定 127.0.0.1:4188，不向公网暴露。

数据库会自动应用 `schema_migrations`。`RADAR_MODE=demo` 是合成样例库；`production` 从空库启动。修改模式必须同时选用独立数据库路径，否则拒绝启动。不要把演示库用于客户资料或经营统计。

## 2. 登录和角色

生产配置 GitHub OAuth 应用；回调为 `${RADAR_PUBLIC_URL}/api/v1/auth/github/callback`，只取公开身份，不申请 repo 权限。必须通过 HTTPS 部署，生产会话使用 Secure/HttpOnly/SameSite，写请求校验 Origin 和 CSRF。管理员配置 `RADAR_ADMIN_GITHUB_IDS` 的数值 ID。普通用户不能调用后台；任务、笔记、摘要均校验归属。

运营启用真实账户之前验证两账户隔离、权限降级和退出登录。不要在反向代理上关闭这些校验，或将开发 Origin 加到正式允许列表。

## 3. 采集

1. 在正式后台核对 GitHub 来源范围及条款，记录审核原因，设置权限和启用状态。
2. 配置 `RADAR_GITHUB_REPOSITORIES=owner/repo,...`；独立采集令牌可选，与用户 OAuth 分开。
3. 单轮 `npm run worker -- --once --collect`；持续调度 `npm run worker -- --collect`。
4. 查看后台任务状态、原始证据、待审版本、来源最近成功/错误。只有审核通过的事件进入公开流。

默认每 6 小时调度同一仓库的唯一窗口，串行访问；同一来源租约避免并发。读取主限额、次级限流、Retry-After 与 ETag。请求预算 `RADAR_DAILY_REQUEST_LIMIT` / `RADAR_MONTHLY_REQUEST_LIMIT` 与成本预算共同约束。数据源关闭或预算耗尽保持历史可读；首次采集不能显示伪造的 24h 增长。

`RADAR_GITHUB_TIMEOUT_MS` 默认 30000，范围 1000～45000 毫秒；每仓库两个请求须在 120 秒租约内完成。发现页与汇总任务按各仓库最新结果区分全部成功、部分失败及全部失败。空轮询不会将等待重试的错误清成成功；来源启用状态不等于后台进程正在运行。

常见错误：`SOURCE_NOT_APPROVED` 要核对来源；`RATE_LIMITED` 等待记录的重试时间；`BUDGET_EXHAUSTED` 核对支出和预算；`INVALID_JSON`/`RESPONSE_TOO_LARGE` 查官方返回，不覆盖历史；`LEASE_LOST` 查重复进程；HTTP 401/403 不无限重试。

## 4. 邮件

默认 `RADAR_EMAIL_MODE=preview`，只在 `data/mail-preview` 写 `.eml`；此目录可能包含用户研究信息，应受访问控制。`outbox` 只入队。生产外发使用 `resend`，还需 `RADAR_EMAIL_DELIVERY_ENABLED=yes`、`RADAR_RESEND_API_KEY`、已验证 `RADAR_EMAIL_FROM` 和 HTTPS `RADAR_PUBLIC_URL`。

账户登录不等于订阅；每个关注对象选择 daily/weekly/in_app。发送前再次检查订阅、暂停状态、事件当前版本、证据权限。空摘要不发送，同一摘要版本不会重复投递。

`uncertain` 表示供应商可能已经受理，必须先对账；禁止直接改回 queued。退出订阅会取消待发邮件。复核真实收件、退订链接、垃圾邮件投诉与发送域名之后才能开通正式外发。

## 5. 备份与恢复

`npm run backup -- backups/unique-name.sqlite` 使用 SQLite 一致性快照，包含已提交 WAL 数据，生成校验和与删除记录 manifest。默认不覆盖已有文件。备份涉及私有资料，需要独立访问控制、加密存储和适当保留期。

恢复必须使用新目标文件，禁止覆盖正在工作的数据库：

```powershell
npm run restore -- backups/unique-name.sqlite data/restored-demo.sqlite --current data/radar-demo.sqlite
```

重放当前数据库的最新证据/账户删除记录，撤回派生判断，清除旧会话和缓存，将可能已经发送的旧队列改为需人工核对。验证后停机并更改 `RADAR_DB_PATH` 指向恢复库；保留旧文件供调查，不自动删除。

若当前数据库损坏或丢失，必须提供独立保留的最新删除台账 `--deletions ledger.json`。只有旧备份无法证明覆盖备份之后的新删除；不允许跳过台账恢复。生产需要将删除台账定期保存在独立受控介质，试点脚本不能替代异地备份系统。恢复演练不等于已验证 RPO 24h / RTO 8h。

## 6. 部署

`docker compose --env-file .env -f infra/compose.yml up --build -d web`，反向代理终止 TLS，保留 localhost 服务端口。需要采集时明确启用 `--profile collection`。容器限制权限、使用非 root 用户、固定 Node 镜像版本和持久卷。邮件默认为 outbox，不会因打开采集 profile 开始外发。

Docker 配置已提供但需要目标环境实测。当前没有 PostgreSQL、多实例写入、自动模型服务或完整可观测平台。发布前逐项核查来源权限、真实登录/邮件、隐私条款、备份、DNS/TLS、备案/经营主体及退款流程。
