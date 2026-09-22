# 开发与提交

主分支 `main` 保存已验证版本；日常改动在 `develop` 进行。一个可验证的改动完成后提交并推送，检查通过后以快进方式同步主分支。

## 本地验证

```text
npm ci
npm run check
npm run test:e2e
```

端到端测试需要 Chrome/Edge 或 Playwright Chromium。没有现成浏览器时执行 `npx playwright install chromium`。测试使用隔离数据库，不要将演示身份或合成样本写入真实数据环境。

新增行为应有针对性的验证：权限边界、删除传播、采集失败、数据口径和用户操作优先；仅调整文字或间距时优先做页面检查。

## 公开内容检查

在提交前暂存目标文件，再执行 `node scripts/check-publication.mjs`。脚本检查 Git 暂存区中的路径和常见凭据特征，失败时只输出文件位置，不输出匹配内容。它不能替代人工检查所有敏感信息。

数据库、备份、日志、采集产物、个人配置和原始需求附件由 `.gitignore` 排除。不要强制加入忽略文件；使用 `.env.example` 描述配置项，真实凭据留在本地环境。

GitHub Actions 在 `main`、`develop` 的推送及 Pull Request 上验证公开内容、构建、自动测试和隔离浏览器流程。云端检查不代表 Docker、真实 OAuth、邮件或正式部署已经通过验收。
