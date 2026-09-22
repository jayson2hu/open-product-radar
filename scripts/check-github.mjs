import { collectRepository } from '../workers/github.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

// An explicit read-only integration check, not a commercial permission approval.
// It never opens the application database or publishes acquired release drafts.
const slug = process.argv[2] || 'microsoft/playwright';
const [owner, repo, extra] = slug.split('/');
if (extra !== undefined) throw new Error('Expected owner/repository');
const report = { checked_at: new Date().toISOString(), repository: slug, mode: 'read-only public API integration test', commercial_source_activation: 'unchanged; remains pending', is_demo: false };
try {
  const result = await collectRepository({ owner, repo, timeoutMs: 15000,
    source: { status: 'active', permission_status: 'approved', allowed_operations: ['fetch_metadata', 'store_evidence'], reason: 'Explicit one-repository public API development test; no publication or production enablement' } });
  Object.assign(report, { status: 'success', stable_id: result.repository.id, stars: result.repository.stars,
    observed_at: result.snapshot.observed_at, created_at: result.repository.created_at,
    source: result.repository.repository_url, trend_status: result.repository.trend_status,
    delta_24h: result.repository.delta_24h, release_drafts: result.events.length,
    all_events_pending_review: result.events.every(event => event.review_status === 'pending'),
    source_permissions_reviewed_for_commercial_use: false,
    note: '真实单次接口响应；无历史基准，不推算趋势；未进入演示或正式数据库。' });
} catch (error) {
  Object.assign(report, { status: 'failed', code: error.code || 'NETWORK_ERROR', message: error.message, note: '连通性未通过，不得称为已成功实采。' });
  process.exitCode = 1;
}
mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/github-live-check.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
