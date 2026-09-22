import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { openDatabase } from '../server/db.mjs';
import { initializeWorkerSchema } from '../workers/jobs.mjs';
import { runWorker } from '../workers/run.mjs';
import { summarizeLocalCollection } from './collection-summary.mjs';

// Explicit, single-cycle public-data preview. Never use a customer or demo database.
const dbPath = resolve('data/radar-local-live.sqlite');
const repositories = ['microsoft/playwright', 'puppeteer/puppeteer', 'browser-use/browser-use',
  'browserbase/stagehand', 'SeleniumHQ/selenium', 'cypress-io/cypress',
  'robotframework/robotframework', 'g1879/DrissionPage'];
const dayParts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(part => [part.type, part.value]));
const day = `${dayParts.year}-${dayParts.month}-${dayParts.day}`;
const path = `artifacts/collection-${day}.json`;
const previous = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
const startedAt = previous?.started_at || new Date().toISOString();
const scope = '按用户要求单次采集 8 个浏览器自动化公开仓库，仅在本机查看公开元数据和待审版本记录；不代表商业使用权限核定，不启用持续采集或邮件外发。';
const db = openDatabase({ dbPath, mode: 'production' });
initializeWorkerSchema(db);
const purpose = db.prepare("SELECT value FROM database_meta WHERE key='purpose'").get()?.value;
if ((purpose && purpose !== 'local_public_preview') || db.prepare('SELECT COUNT(*) AS n FROM users').get().n) {
  db.close(); throw new Error('Local preview must use its own database without customer accounts');
}
db.prepare("INSERT OR IGNORE INTO database_meta(key,value) VALUES('purpose','local_public_preview')").run();
const source = db.prepare("SELECT * FROM sources WHERE id='github'").get();
if (source.status === 'blocked') { db.close(); throw new Error('Source is blocked; local preview cannot override revocation'); }
const audit = (action, reason) => db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?)')
  .run(`audit-${randomUUID()}`, null, action, 'github', reason, new Date().toISOString());
db.prepare("UPDATE sources SET status='active',permission_status='approved',reason=? WHERE id='github'").run(scope);
audit('local_collection_started', scope);
const cycles = [];
try {
  await runWorker({ argv: ['--once', '--collect'], env: {
    ...process.env, RADAR_MODE: 'production', RADAR_DB_PATH: dbPath,
    RADAR_GITHUB_REPOSITORIES: repositories.join(','), RADAR_EMAIL_MODE: 'outbox',
    RADAR_GITHUB_TIMEOUT_MS: process.env.RADAR_GITHUB_TIMEOUT_MS || '45000',
    RADAR_EMAIL_DELIVERY_ENABLED: 'no', RADAR_DAILY_REQUEST_LIMIT: '40', RADAR_MONTHLY_REQUEST_LIMIT: '200',
  }, logger: value => { console.log(value); cycles.push(JSON.parse(value)); } });
} finally {
  db.prepare("UPDATE sources SET status=?,permission_status=?,reason=? WHERE id='github'")
    .run(source.status, source.permission_status, `${scope} 本次结束后恢复原来源状态。`);
  audit('local_collection_finished', '单轮结束，已恢复来源原状态；版本和证据仍需审核。');
}
const rows = db.prepare('SELECT * FROM entities WHERE is_demo=0 ORDER BY stars DESC').all();
const report = {
  started_at: startedAt, completed_at: new Date().toISOString(), scope, is_demo: false,
  database: dbPath, scheduled_continuously: false, cycles: [...(previous?.cycles || []), ...cycles],
  ...summarizeLocalCollection(db, { startedAt }),
  totals: {
    repositories: rows.length, snapshots: db.prepare('SELECT count(*) n FROM snapshots').get().n,
    release_drafts: db.prepare("SELECT count(*) n FROM events WHERE review_status='pending'").get().n,
    evidence: db.prepare('SELECT count(*) n FROM evidence').get().n,
  },
  repositories: rows.map(row => {
    const raw = db.prepare('SELECT body_json FROM github_http_cache WHERE url=?').get(`https://api.github.com/repos/${row.slug}/releases?per_page=30`);
    const rawReleases = raw ? JSON.parse(raw.body_json) : [];
    const releases = db.prepare(`SELECT e.id,e.title,e.published_at,e.review_status,ev.url
      FROM events e JOIN event_evidence ee ON ee.event_id=e.id JOIN evidence ev ON ev.id=ee.evidence_id
      WHERE e.entity_id=? ORDER BY e.published_at DESC`).all(row.id).map(event => ({
        title: event.title, url: event.url, published_at: event.published_at, review_status: event.review_status,
        prerelease: !!rawReleases.find(release => `gh:release:${release.id}` === event.id)?.prerelease,
      }));
    return { id: row.id, slug: row.slug, name: row.name, stars: row.stars, language: row.language,
      license: row.license, url: row.repository_url, observed_at: row.observed_at,
      delta_24h: row.delta_24h, delta_7d: row.delta_7d, release_count: releases.length, releases };
  }),
};
mkdirSync('artifacts', { recursive: true });
writeFileSync(path, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ report: path, ...report.totals, failures: report.failures }));
db.close();
if (report.failures.length || rows.length !== repositories.length || cycles.some(cycle => cycle.failures)) process.exitCode = 1;
