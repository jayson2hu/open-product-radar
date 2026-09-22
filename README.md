# 开源产品雷达 · Open Product Radar

面向开发者和自动化交付团队，将开源发现、产品变化、证据、任务比较与持续跟踪放在一个工作区。当前是可运行的本地试点版本。

**默认是明确标识的演示模式。** 可实际创建任务、比较候选、保存私有笔记、跟踪变化、审核资料并持久保存；种子库中的指标、事件和判断不是实时事实。正式模式使用独立数据库，不载入演示数据。

## 快速运行

需要 Node.js 24 或更新兼容版本。

```powershell
git clone https://github.com/jayson2hu/open-product-radar.git
cd open-product-radar
npm ci
npm run build
npm start
```

打开 [本地页面](http://127.0.0.1:4188)。点击「登录工作区 → 进入演示工作区」创建一个独立本机账户。首次进入没有私人任务，按自己的场景创建即可；演示账户可体验后台。

开发方式 `npm run dev`，页面 http://127.0.0.1:5188 ，接口端口 4188。数据默认保存在 `data/radar-demo.sqlite`。退出账户后再进入会生成新的演示身份；浏览器会话有效期内刷新和重启服务会保留原账户。

## 已实现的使用路径

- 发现：24 小时 / 7 天仓库样本，搜索、主题和语言筛选，负增长与待对比说明，实际排序口径、产品事件和来源范围。
- 档案：项目/产品、版本套餐、范围化能力与限制、关联关系、原始证据、核查时间。
- 研究：私有任务与条件、2–5 项候选对比、逐格证据、未知状态、私有笔记与采用判断。
- 跟踪：关注原因、事件偏好、频率、暂停/已读/取消，站内摘要与邮件预览队列。
- 运营：来源启停、采集失败重试、产品/证据/事件/能力/套餐/关系录入及审核、纠错、撤回、预算和成本、人工订单退款、审计。
- 工程：SQLite 迁移、GitHub OAuth 接口、服务端权限与私有隔离、独立采集 Worker、幂等、限额、删除传播、备份恢复与自动测试。

## 正式模式配置

复制 `.env.example` 为 `.env`，将 `RADAR_MODE` 改为 `production`，使用新的数据库路径及 HTTPS `RADAR_PUBLIC_URL`。配置 GitHub OAuth Client ID/Secret、回调 `/api/v1/auth/github/callback` 和管理员 GitHub 数值 ID。缺少配置时页面提供登录说明和公开浏览入口，不开放演示登录。

在后台核对来源条款并批准权限后，设置 `RADAR_GITHUB_REPOSITORIES`，执行：

```powershell
npm run worker -- --once --collect
```

实际采集只访问 GitHub 官方公开仓库与版本 API。快照持久保存，版本事件等待人工审核；第一轮显示“待对比：缺少早期记录”。24h/7d 增长需要后续记录和对应时间的历史基准。持续调度使用 `npm run worker -- --collect`，须由运行环境保持进程；只执行一轮后等待不会自动补齐数据。Worker 不由用户页面请求触发。

邮件默认 `preview`，只写本地预览；`outbox` 只保留队列。真实发信需明确配置供应商、发件域名、HTTPS 地址与开关，并取得用户独立订阅。开发过程中不会发外部邮件。详见运行手册。

## 验证与交付资料

```powershell
npm run check
npm run test:e2e
npm run benchmark
npm run worker -- --once
npm run backup
```

端到端测试使用已安装的 Chrome/Edge、Playwright Chromium，或通过 `RADAR_BROWSER_PATH` 指定浏览器。测试在独立内存/临时数据库运行，不覆盖日常数据。部署材料位于 `infra`；Docker 构建、健康和重启持久性已通过云端独立检查，真实第三方登录、发信和目标服务器仍需对应环境实测。

- [产品范围和数据说明](docs/PRODUCT_SCOPE.md)
- [实施决策和技术边界](docs/DECISIONS.md)
- [数据字典](docs/DATA_DICTIONARY.md)、[接口契约](docs/API_CONTRACT.md)
- [来源权限](docs/SOURCE_POLICY.md)、[运行与恢复手册](docs/RUNBOOK.md)
- [测试记录与范围](docs/TEST_PLAN.md)、[交付状态](docs/DELIVERY_STATUS.md)
- [运营流程](docs/OPERATIONS.md)、[访谈、试用、成本与付费验证](docs/VALIDATION_PLAN.md)
- [容器配置与验证边界](docs/CONTAINERS.md)
- [开发与提交约定](CONTRIBUTING.md)
- [2026-09-22 全面产品检查与修复](docs/reviews/PRODUCT_REVIEW_2026-09-22.md)

未接入自动 AI 研究、自动支付、任意 URL 爬虫、团队共享或全网发现。没有完成公开商业上线，也没有虚构访谈、付款、续费和商业验证结果。
