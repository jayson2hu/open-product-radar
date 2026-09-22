import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from '../server/index.mjs';

const app = createApp({ dbPath: ':memory:', mode: 'demo' });
const { port } = await app.listen(0);
const base = `http://127.0.0.1:${port}`;
const executablePath = [process.env.RADAR_BROWSER_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find(existsSync);
mkdirSync('artifacts', { recursive: true });
let browser, page;
const checks = [], errors = [];
function passed(name) { checks.push(name); console.log(`PASS ${name}`); }
try {
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, locale: 'zh-CN' });
  await context.addInitScript(() => {
    const reduce = () => { const sheet = document.createElement('style'); sheet.textContent = '*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important}'; document.head.append(sheet); };
    if (document.head) reduce(); else document.addEventListener('DOMContentLoaded', reduce, { once: true });
  });
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  const unexpectedApiErrors = [];
  page.on('response', response => { if (response.url().includes('/api/v1/') && response.status() >= 400) unexpectedApiErrors.push({ url: response.url(), status: response.status() }); });
  await page.goto(base);
  await page.getByRole('heading', { name: '发现值得研究的下一步。' }).waitFor();
  await page.locator('.repo-name').filter({ hasText: 'Playwright' }).first().waitFor();
  assert.equal(await page.locator('.repo-row').count(), 8);
  assert.ok(await page.getByText('演示数据 · 非实时榜单', { exact: true }).isVisible());
  assert.ok(await page.locator('.repo-row').filter({ hasText: 'Cypress' }).getByText('-13', { exact: true }).isVisible());
  assert.ok(await page.locator('.repo-row').filter({ hasText: 'DrissionPage' }).getByText('待对比', { exact: true }).isVisible());
  await page.screenshot({ path: 'artifacts/discovery-desktop.png', fullPage: true });
  passed('Anonymous discovery clearly identifies demo, negative growth and missing history');

  await page.getByLabel('筛选编程语言').selectOption('Python');
  await page.waitForFunction(() => document.querySelectorAll('.repo-row').length === 3);
  await page.getByLabel('筛选编程语言').selectOption('');
  await page.waitForFunction(() => document.querySelectorAll('.repo-row').length === 8);
  passed('Language filter requests and displays filtered data');

  await page.getByRole('button', { name: '登录工作区', exact: true }).click();
  await page.getByRole('button', { name: '进入演示工作区', exact: true }).click();
  await page.getByRole('link', { name: /演示访客/ }).waitFor();
  await page.goto(`${base}/#research`);
  await page.getByRole('button', { name: '新建研究任务', exact: true }).click();
  await page.getByLabel('任务名称', { exact: true }).fill('内部业务系统浏览器选型');
  await page.getByLabel('必须满足', { exact: true }).fill('能够自托管，支持 TypeScript；所有判断可追溯');
  await page.getByLabel('当前最不确定的问题', { exact: true }).fill('登录会话与失败恢复需要实测');
  await page.getByRole('button', { name: '创建研究任务', exact: true }).click();
  await page.getByRole('heading', { name: '内部业务系统浏览器选型', exact: true }).waitFor();
  const taskRoute = page.url();
  passed('Explicit login and private task creation persist through the API');

  for (const candidate of ['Playwright', 'Puppeteer']) {
    await page.getByRole('button', { name: '添加候选', exact: true }).first().click();
    await page.getByLabel('搜索候选').fill(candidate);
    await page.locator('.candidate-option').filter({ hasText: candidate }).getByRole('button', { name: '加入', exact: true }).click();
    await page.getByRole('button', { name: `移除候选 ${candidate}`, exact: true }).waitFor();
  }
  assert.equal(await page.locator('.comparison-table thead th').count(), 3);
  await page.locator('.comparison-table').getByRole('button', { name: '证据', exact: true }).first().click();
  await page.getByRole('heading', { name: '回到原始证据', exact: true }).waitFor();
  await page.getByRole('link', { name: '打开原始出处' }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByLabel('私有笔记内容').fill('先在自有测试环境验证登录态保持，当前暂不采用。');
  await page.getByRole('button', { name: '保存笔记', exact: true }).click();
  await page.locator('.note-item').getByText('先在自有测试环境验证登录态保持，当前暂不采用。').waitFor();
  await page.getByLabel('更新研究判断').selectOption('trial');
  await page.reload();
  await page.locator('.note-item').waitFor();
  assert.equal(await page.getByLabel('更新研究判断').inputValue(), 'trial');
  await page.screenshot({ path: 'artifacts/research-desktop.png', fullPage: true });
  passed('Two-candidate comparison, original evidence, private note and decision survive reload');

  await page.goto(`${base}/#discover`);
  await page.getByRole('button', { name: '跟踪 Playwright', exact: true }).click();
  await page.getByLabel('关注原因', { exact: true }).fill('关注浏览器兼容性与自托管条件');
  await page.getByRole('button', { name: '开始跟踪', exact: true }).click();
  await page.goto(`${base}/#watches`);
  await page.getByText('关注浏览器兼容性与自托管条件', { exact: true }).waitFor();
  await page.getByRole('button', { name: '暂停跟踪', exact: true }).click();
  await page.getByRole('button', { name: '恢复跟踪', exact: true }).click();
  await page.getByRole('button', { name: '标为已读', exact: true }).click();
  await page.getByText('0 条未读', { exact: true }).waitFor();
  passed('Watch reason, pause, resume and read state work');

  await page.goto(`${base}/#digests`);
  await page.getByRole('button', { name: '整理本期摘要', exact: true }).click();
  await page.waitForTimeout(200);
  const digestResponse = await context.request.get(`${base}/api/v1/digests`);
  assert.equal(digestResponse.status(), 200);
  passed('Digest generation completes without fabricating an empty update');

  await page.goto(`${base}/#admin`);
  await page.getByRole('heading', { name: '让研究持续可靠地运行。', exact: true }).waitFor();
  const sessionInfo = await (await context.request.get(`${base}/api/v1/session`)).json();
  app.db.prepare("UPDATE users SET role='editor' WHERE id=?").run(sessionInfo.user.id);
  await page.reload();
  await page.getByRole('heading', { name: '让研究持续可靠地运行。', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '成本与试点', exact: true }).count(), 0);
  for (const button of await page.getByRole('button', { name: /^(审核并启用|暂停来源|重试)$/ }).all()) {
    assert.equal(await button.isEnabled(), false);
  }
  app.db.prepare("UPDATE users SET role='admin' WHERE id=?").run(sessionInfo.user.id);
  await page.reload();
  await page.getByRole('button', { name: '成本与试点', exact: true }).waitFor();
  passed('Editor operations do not offer administrator-only finance or source controls');
  await page.screenshot({ path: 'artifacts/admin-desktop.png', fullPage: true });
  passed('Authorized operations dashboard loads source and review data');

  await page.getByRole('button', { name: '录入研究资料', exact: true }).click();
  await page.getByLabel('对象类型', { exact: true }).selectOption('product');
  await page.getByLabel('名称', { exact: true }).fill('E2E Pilot Product');
  await page.locator('input[name="slug"]').fill('e2e-pilot-product');
  await page.getByLabel('研究方向', { exact: true }).fill('浏览器自动化');
  await page.getByLabel('一句话描述', { exact: true }).fill('仅用于测试产品建档流程的演示产品。');
  await page.getByRole('button', { name: '保存资料', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  const productResult = await context.request.get(`${base}/api/v1/products?q=E2E%20Pilot`);
  const product = (await productResult.json()).data[0];
  assert.ok(product?.id);

  await page.getByRole('button', { name: '录入研究资料', exact: true }).click();
  await page.getByRole('button', { name: '原始证据', exact: true }).click();
  await page.getByLabel('对应项目或产品', { exact: true }).selectOption(product.id);
  await page.getByLabel('数据来源', { exact: true }).selectOption('demo');
  await page.getByLabel('证据标题', { exact: true }).fill('E2E 官方说明（演示）');
  await page.getByLabel('原始出处 URL', { exact: true }).fill('https://example.com/e2e-pilot');
  await page.getByLabel('相关原文摘录', { exact: true }).fill('仅用于界面测试的演示原文；不代表真实产品能力。');
  await page.getByRole('button', { name: '保存资料', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '内容审核', exact: true }).click();
  await page.locator('.admin-row').filter({ hasText: 'E2E 官方说明（演示）' }).getByRole('button', { name: '核查通过', exact: true }).click();
  await page.getByLabel('操作原因 / 核查依据', { exact: true }).fill('演示流程核查，真实经营前需要原始资料复核。');
  await page.getByRole('button', { name: '确认并记录', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });

  await page.getByRole('button', { name: '录入研究资料', exact: true }).click();
  await page.getByRole('button', { name: '变化事件', exact: true }).click();
  await page.getByLabel('对应项目或产品', { exact: true }).selectOption(product.id);
  await page.getByLabel('变化标题', { exact: true }).fill('E2E 演示产品发布记录');
  await page.getByLabel('发生了什么 / 影响与未知', { exact: true }).fill('此事件验证证据关联、待审和发布，不代表真实发布。');
  await page.locator('.editorial-evidence label').filter({ hasText: 'E2E 官方说明（演示）' }).locator('input[type="checkbox"]').check();
  await page.getByRole('button', { name: '保存资料', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  const beforePublish = await context.request.get(`${base}/api/v1/entities/${product.id}/changes`);
  assert.equal((await beforePublish.json()).data.length, 0);
  await page.locator('.review-row').filter({ hasText: 'E2E 演示产品发布记录' }).getByRole('button', { name: '核查发布', exact: true }).click();
  await page.getByLabel('操作原因 / 核查依据', { exact: true }).fill('已核对演示证据与适用范围，仅发布演示内容。');
  await page.getByRole('button', { name: '确认并记录', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  const afterPublish = await context.request.get(`${base}/api/v1/entities/${product.id}/changes`);
  assert.equal((await afterPublish.json()).data.length, 1);
  passed('Editorial product, evidence approval and event publication work end to end; draft stays private');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/#discover`);
  await page.locator('.repo-row').first().waitFor();
  await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().right <= 1);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.equal(overflow, false, '390px discovery must not overflow horizontally');
  await page.screenshot({ path: 'artifacts/discovery-mobile.png', fullPage: true });
  await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await page.locator('.sidebar').getByRole('link', { name: /^我的研究/ }).click();
  await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().right <= 1);
  await page.getByRole('link', { name: '内部业务系统浏览器选型', exact: true }).waitFor();
  await page.goto(taskRoute);
  await page.getByLabel('当前对比对象').selectOption('puppeteer');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false);
  await page.screenshot({ path: 'artifacts/research-mobile.png', fullPage: true });
  passed('390px mobile navigation and single-candidate comparison are readable without page overflow');

  assert.deepEqual(errors, [], 'No browser runtime errors');
  assert.deepEqual(unexpectedApiErrors, [], 'No unexpected API errors during user flows');
  writeFileSync('artifacts/e2e-report.json', JSON.stringify({ passed: checks, browser_errors: errors, api_errors: unexpectedApiErrors, mode: 'isolated demo fixture', at: new Date().toISOString() }, null, 2));
  console.log(`Completed ${checks.length} browser scenarios; screenshots: ${resolve('artifacts')}`);
} catch (error) {
  if (page) await page.screenshot({ path: 'artifacts/e2e-failure.png', fullPage: true }).catch(() => {});
  writeFileSync('artifacts/e2e-report.json', JSON.stringify({ passed: checks, error: error.message, browser_errors: errors, at: new Date().toISOString() }, null, 2));
  throw error;
} finally { await browser?.close(); await app.close(); }
