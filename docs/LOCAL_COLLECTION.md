# 本地真实采集预览

用户已要求执行 2026-09-22 的一次真实采集。范围为产品当前浏览器自动化方向的 8 个公开仓库：Playwright、Puppeteer、Browser Use、Stagehand、Selenium、Cypress、Robot Framework、DrissionPage。

2026-09-22 15:43（北京时间）补采完成：8 个仓库全部成功，8 份快照、240 条待审版本、248 条证据。Stagehand 的版本列表本次耗时约 15.7 秒，超过原 15 秒上限；调整本机等待上限后已通过现有退避任务成功入库，原错误记录保留在报告历史轮次中。

发现页按各仓库最新任务显示采集结果，并将“持续采集未启用”单独展示。暂停采集仍保留已有数据的有效来源计数；旧失败记录不会覆盖之后的成功结果。

## 查看结果

- 单次采集报告：<http://127.0.0.1:4189/collection.html>
- 实采项目页面：<http://127.0.0.1:4189/#discover>
- 原演示环境：<http://127.0.0.1:4188/>，仍使用独立演示数据库。

当前报告和核对结果分别保存在 `artifacts/collection-2026-09-22.json`、`artifacts/collection-2026-09-22-verification.json`；截图同名保存在 artifacts 目录。

## 数据范围

`data/radar-local-live.sqlite` 是隔离的本地真实资料库，采用 production 数据标识，禁止演示种子和客户账户。GitHub 官方 API 的公开元数据、Star 快照和每仓库最近最多 30 条 Release 记录通过现有采集任务入库，原始响应保存在 `github_http_cache`，任务尝试和错误保存在 `jobs`。

报告显示每仓库最新 3 条版本链接，其余已采记录保存在 JSON 和数据库中。所有版本及证据保留待审核状态，没有为了展示效果直接发布。版本原发布时间与本次观察时间分开记录，不能将今天采到的历史版本称为今天新发布。没有历史基线的 24 小时、7 天净变化保持为空。

本次范围是按用户要求在本机读取和展示公开资料，不表示正式商业来源审批完成。脚本记录临时来源启用及恢复的审计，在单轮结束后恢复原来源状态。没有启用常驻 Worker、邮件外发、GitHub OAuth 或公网服务。

## 再次执行及恢复查看

在项目目录运行：

```powershell
node scripts/collect-local.mjs
$collectionDay = Get-Date -Format yyyy-MM-dd
node scripts/render-collection-report.mjs "artifacts/collection-$collectionDay.json" dist/collection.html
node scripts/preview-local.mjs
```

最后一条命令是本地网页服务，保持运行即可查看。若 4189 已经运行，无需重复启动。重新构建前端会清除 dist 中的报告，再执行报告生成命令即可恢复。

采集脚本复用现有 6 小时窗口去重和退避机制，重复执行不会强制重复采集成功任务；失败任务在 `next_run_at` 到期后才重试。当天报告会保留每轮结果；成功接口响应数不包含失败请求。是否全部成功以 JSON 的 `failures` 和任务状态为准。

请求等待时间通过 `RADAR_GITHUB_TIMEOUT_MS` 配置，标准 Worker 默认 30 秒、本机预览脚本默认 45 秒，允许 1～45 秒，确保两次请求在 120 秒任务租约内。超时错误记录区分仓库资料和版本列表请求。

当前采集的界面及数据核对命令为 `python scripts/verify-local-collection.py`，使用本机 Chrome，不再请求 GitHub。
