import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { calculateTrend, calculateTrends } from '../workers/trends.mjs';
import { collectRepository, createGithubClient, assertAllowedUrl, validateRepository, isPublicAddress, retryAfter, SourceError } from '../workers/github.mjs';
import { initializeWorkerSchema, scheduleRepositories, claimJob, finishJob, reserveBudget, processCollectionJob } from '../workers/jobs.mjs';
import { prepareOutbox, processOutbox, buildEmail, purgePreviewFiles, findUnrecordedEvents, recordDigestVersions } from '../workers/delivery.mjs';
import { openDatabase } from '../server/db.mjs';
import { applyCollection } from '../server/store.mjs';
import { runWorker } from '../workers/run.mjs';
import { deleteEvidence } from '../server/privacy.mjs';

const NOW = Date.parse('2026-09-22T10:00:00.000Z');
const now = () => NOW;
const source = () => ({ status: 'approved', permission_status: 'approved' });
const fixture = (overrides = {}) => ({ id: 12345, private: false, name: 'radar', owner: { login: 'example' }, description: 'A public repository', stargazers_count: 1000, language: 'TypeScript', topics: ['automation'], license: { spdx_id: 'MIT' }, homepage: 'https://example.com', created_at: '2020-01-01T00:00:00Z', ...overrides });
const release = (overrides = {}) => ({ id: 6789, name: 'Version 2', tag_name: 'v2', body: 'Fixes a compatibility issue.', draft: false, published_at: '2026-09-21T01:00:00Z', ...overrides });
const response = (body, headers = {}, status = 200) => new Response(status === 304 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const fixtureFetch = ({ repository = fixture(), releases = [release()] } = {}) => async url => response(url.includes('/releases') ? releases : repository, { etag: url.includes('/releases') ? '"release-v1"' : '"repo-v1"' });
const snap = (hours, stars, overrides = {}) => ({ entity_id: 'gh:12345', source_id: 'github', metric_version: 'github.stargazers_count.v1', scope: 'public', observed_at: new Date(NOW - hours * 3_600_000).toISOString(), stars, ...overrides });

function database(t, mode = 'production') {
  const db = openDatabase({ dbPath: ':memory:', mode });
  initializeWorkerSchema(db);
  db.prepare("UPDATE sources SET status='approved',permission_status='approved' WHERE id='github'").run();
  t.after(() => db.close());
  return db;
}

async function populated(t) {
  const db = database(t);
  const data = await collectRepository({ owner: 'example', repo: 'radar', source: source(), now, fetchImpl: fixtureFetch() });
  applyCollection(db, data);
  db.prepare("UPDATE evidence SET review_status='published',reviewed_at=?").run(new Date(NOW).toISOString());
  db.prepare("UPDATE events SET review_status='published',reviewed_at=?").run(new Date(NOW).toISOString());
  db.prepare('INSERT INTO users(id,name,email,email_opt_in,unsubscribe_token,created_at) VALUES(?,?,?,?,?,?)')
    .run('user-1', '测试账户', 'reader@example.com', 1, 'token-1', '2026-09-01T00:00:00.000Z');
  db.prepare('INSERT INTO watches(id,user_id,entity_id,reason,event_types,frequency,created_at) VALUES(?,?,?,?,?,?,?)')
    .run('watch-1', 'user-1', data.repository.id, '兼容性', '["release","correction"]', 'daily', '2026-09-01T00:00:00.000Z');
  return db;
}

function previews(t) {
  const directory = mkdtempSync(join(tmpdir(), 'radar-mail-test-'));
  t.after(() => {
    // The generated directory is checked before recursive cleanup.
    const resolved = resolve(directory), root = resolve(tmpdir());
    assert.ok(resolved.startsWith(`${root}\\`) || resolved.startsWith(`${root}/`));
    rmSync(resolved, { recursive: true, force: true });
  });
  return directory;
}

test('trend windows preserve negative changes, zero bases and missing history', () => {
  assert.deepEqual(calculateTrend(snap(0, 990), []), { delta: null, rate: null, status: 'insufficient', interval_hours: null, baseline_at: null });
  assert.equal(calculateTrend(snap(0, 990), [snap(24, 1000)]).delta, -10);
  assert.equal(calculateTrend(snap(0, 5), [snap(24, 0)]).rate, null);
  for (const hours of [23, 25]) assert.equal(calculateTrend(snap(0, 990), [snap(hours, 1000)]).status, 'comparable');
  for (const hours of [22.999, 25.001]) {
    const trend = calculateTrend(snap(0, 990), [snap(hours, 1000)]);
    assert.equal(trend.status, 'incomparable'); assert.equal(trend.delta, null); assert.equal(trend.interval_hours, hours);
  }
  assert.equal(calculateTrends(snap(0, 990), [snap(167, 900)]).delta_7d, 90);
  assert.equal(calculateTrends(snap(0, 990), [snap(169, 900)]).delta_7d, 90);
  assert.equal(calculateTrends(snap(0, 990), [snap(166, 900)]).delta_7d, null);
});

test('trend never combines different source scopes or metric definitions', () => {
  for (const change of [{ source_id: 'stars-history' }, { metric_version: 'star-events' }, { scope: 'private' }, { entity_id: 'gh:999' }]) {
    assert.equal(calculateTrend(snap(0, 1000), [snap(24, 1, change)]).status, 'incomparable');
  }
  assert.equal(calculateTrend(snap(0, 1000), [snap(24, 1, { source_id: 'other' }), snap(24.5, 990)]).delta, 10);
});

test('URL and DNS controls reject SSRF, credentials, alternate ports and arbitrary paths', () => {
  for (const url of ['http://api.github.com/repos/a/b', 'https://127.0.0.1/repos/a/b', 'https://169.254.169.254/latest/meta-data', 'https://api.github.com.evil.test/repos/a/b', 'https://api.github.com:8443/repos/a/b', 'https://token@api.github.com/repos/a/b', 'https://api.github.com/repos/a/b?url=http://127.0.0.1', 'https://api.github.com/repos/a/b/contents', 'https://api.github.com/repos/a/../b']) {
    assert.throws(() => assertAllowedUrl(url), { code: 'UNSAFE_URL' });
  }
  for (const ip of ['127.0.0.1','10.1.1.1','172.16.2.3','169.254.169.254','192.168.1.1','100.64.0.1','::1','fc00::1','fe80::1','::ffff:127.0.0.1','2001:db8::1','2001::1','2002:a00:1::1','2::1']) assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress('140.82.114.6'), true);
  assert.equal(isPublicAddress('2606:4700::1111'), true);
  for (const [owner, repo] of [['x/y','repo'], ['ok','..'], ['ok','a?url=evil'], ['ok','a%2fb']]) assert.throws(() => validateRepository(owner,repo));
});

test('source approval and operation permission are checked before networking', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return response(fixture()); };
  await assert.rejects(collectRepository({ owner: 'example', repo: 'radar', fetchImpl, source: { status: 'paused', permission_status: 'approved' } }), { code: 'SOURCE_NOT_APPROVED' });
  await assert.rejects(collectRepository({ owner: 'example', repo: 'radar', fetchImpl, source: { ...source(), allowed_operations: ['fetch_metadata'] } }), { code: 'SOURCE_SCOPE_DENIED' });
  assert.equal(calls, 0);
});

test('GitHub metadata/release normalization uses stable IDs and keeps published and observed time separate', async () => {
  const data = await collectRepository({ owner: 'example', repo: 'radar', source: source(), now,
    fetchImpl: fixtureFetch({ releases: [release(), release(), release({ id: 88, draft: true }), release({ id: 89, published_at: null })] }) });
  assert.equal(data.repository.id, 'gh:12345'); assert.equal(data.repository.delta_24h, null);
  assert.equal(data.events.length, 1); assert.equal(data.events[0].id, 'gh:release:6789');
  assert.equal(data.events[0].review_status, 'pending');
  assert.equal(data.events[0].published_at, '2026-09-21T01:00:00.000Z');
  assert.equal(data.events[0].observed_at, '2026-09-22T10:00:00.000Z');
  assert.equal(data.evidence[0].published_at, null);
  assert.equal(data.repository.is_demo, false);
});

test('ETag 304 reuses known values without publishing pending releases or duplicating IDs', async t => {
  const db = database(t);
  const first = await collectRepository({ owner: 'example', repo: 'radar', source: source(), now, fetchImpl: fixtureFetch() });
  applyCollection(db, first);
  const requests = [];
  const second = await collectRepository({ owner: 'example', repo: 'radar', source: source(), now: () => NOW + 24 * 3_600_000, cache: first.http_cache,
    fetchImpl: async (url, options) => { requests.push(options.headers['If-None-Match']); assert.equal(options.redirect, 'error'); return response(null, {}, 304); } });
  applyCollection(db, second); applyCollection(db, second);
  assert.deepEqual(requests, ['"repo-v1"', '"release-v1"']); assert.equal(second.unchanged, true);
  assert.equal(db.prepare('SELECT count(*) n FROM events').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM snapshots').get().n, 2);
  assert.equal(db.prepare('SELECT review_status FROM events').get().review_status, 'pending');
  assert.equal(db.prepare('SELECT delta_24h FROM entities').get().delta_24h, 0);
});

test('repository rename preserves identity, history, first-seen time and watches', async t => {
  const db = await populated(t), first = db.prepare('SELECT first_seen_at FROM entities').get().first_seen_at;
  const renamed = await collectRepository({ owner: 'new-owner', repo: 'new-name', source: source(), now: () => NOW + 24 * 3_600_000,
    fetchImpl: fixtureFetch({ repository: fixture({ owner: { login: 'new-owner' }, name: 'new-name', stargazers_count: 990 }) }) });
  applyCollection(db, renamed);
  assert.equal(db.prepare('SELECT count(*) n FROM entities').get().n, 1);
  const entity = db.prepare('SELECT * FROM entities').get();
  assert.equal(entity.slug, 'new-owner/new-name'); assert.equal(entity.delta_24h, -10); assert.equal(entity.first_seen_at, first);
  assert.equal(db.prepare('SELECT entity_id FROM watches').get().entity_id, 'gh:12345');
});

test('rate failures distinguish primary/secondary limits and honor numeric/date Retry-After', async () => {
  assert.equal(retryAfter(new Headers({ 'retry-after': '120' }), NOW), '2026-09-22T10:02:00.000Z');
  assert.equal(retryAfter(new Headers({ 'retry-after': 'Tue, 22 Sep 2026 10:03:00 GMT' }), NOW), '2026-09-22T10:03:00.000Z');
  const limited = createGithubClient({ source: source(), now, fetchImpl: async () => response({}, { 'retry-after': '120' }, 429) });
  await assert.rejects(limited.get('https://api.github.com/repos/a/b'), { code: 'RATE_LIMITED', retryable: true, retryAt: '2026-09-22T10:02:00.000Z' });
  const secondary = createGithubClient({ source: source(), now, fetchImpl: async () => response({ message: 'You have exceeded a secondary rate limit.' }, {}, 403) });
  await assert.rejects(secondary.get('https://api.github.com/repos/a/b'), { code: 'RATE_LIMITED', retryable: true });
  const denied = createGithubClient({ source: source(), now, fetchImpl: async () => response({ message: 'Resource not accessible' }, {}, 403) });
  await assert.rejects(denied.get('https://api.github.com/repos/a/b'), { code: 'ACCESS_DENIED', retryable: false });
});

test('requests are serial, successful last-quota response stops the next request', async () => {
  let active = 0, maximum = 0;
  const fetchImpl = async () => { active++; maximum = Math.max(active, maximum); await new Promise(resolve => setTimeout(resolve, 5)); active--; return response({}); };
  const a = createGithubClient({ source: source(), fetchImpl }), b = createGithubClient({ source: source(), fetchImpl });
  await Promise.all([a.get('https://api.github.com/repos/a/a'), b.get('https://api.github.com/repos/a/b')]);
  assert.equal(maximum, 1);
  let count = 0;
  const client = createGithubClient({ source: source(), now, fetchImpl: async () => { count++; return response({}, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(NOW / 1000 + 3600) }); } });
  await client.get('https://api.github.com/repos/a/a');
  await assert.rejects(client.get('https://api.github.com/repos/a/b'), { code: 'RATE_LIMITED' });
  assert.equal(count, 1);
});

test('redirects, oversized bodies, malformed JSON and non-JSON responses fail safely', async () => {
  for (const [res, code] of [[new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } }), 'REDIRECT_BLOCKED'], [response({ long: 'x'.repeat(1000) }), 'RESPONSE_TOO_LARGE'], [new Response('{', { headers: { 'content-type': 'application/json' } }), 'INVALID_JSON'], [new Response('<html/>', { headers: { 'content-type': 'text/html' } }), 'INVALID_CONTENT_TYPE']]) {
    const client = createGithubClient({ source: source(), fetchImpl: async () => res, maxBytes: 100 });
    await assert.rejects(client.get('https://api.github.com/repos/a/b'), { code });
  }
  const timeout = createGithubClient({ source: source(), timeoutMs: 5, fetchImpl: (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))) });
  await assert.rejects(timeout.get('https://api.github.com/repos/a/b'), { code: 'TIMEOUT', retryable: true });
});

test('leases prevent duplicate scheduling and concurrent jobs; expiry permits recovery', t => {
  const db = database(t), date = new Date(NOW);
  assert.equal(scheduleRepositories(db, ['example/radar', 'example/other'], { now: date }), 2);
  assert.equal(scheduleRepositories(db, ['example/radar'], { now: date }), 0);
  const first = claimJob(db, { now: date, workerId: 'first', leaseMs: 1000 });
  assert.ok(first); assert.equal(claimJob(db, { now: date, workerId: 'second' }), null);
  const recovered = claimJob(db, { now: new Date(NOW + 1001), workerId: 'second' });
  assert.equal(recovered.id, first.id); assert.equal(recovered.attempts, 2);
  assert.throws(() => finishJob(db, first), { code: 'LEASE_LOST' });
  finishJob(db, recovered, null, { now: new Date(NOW + 1002) });
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(first.id).status, 'completed');
});

test('persisted rate pause blocks all source jobs until retry time', t => {
  const db = database(t);
  scheduleRepositories(db, ['example/radar','example/other'], { now: new Date(NOW) });
  const job = claimJob(db, { now: new Date(NOW) });
  finishJob(db, job, new SourceError('RATE_LIMITED', '限流', { retryable: true, retryAt: new Date(NOW + 60_000).toISOString() }));
  assert.equal(claimJob(db, { now: new Date(NOW + 59_999) }), null);
  assert.ok(claimJob(db, { now: new Date(NOW + 60_000) }));
});

test('request and monetary budget exhaustion preserve snapshots and make no network request', async t => {
  const db = database(t);
  scheduleRepositories(db, ['example/radar'], { now: new Date(NOW) });
  const job = claimJob(db, { now: new Date(NOW) });
  let calls = 0;
  const result = await processCollectionJob(db, job, { now, applyCollection, dailyRequestLimit: 1, fetchImpl: async () => { calls++; return response(fixture()); } });
  assert.equal(result.code, 'BUDGET_EXHAUSTED'); assert.equal(calls, 0); assert.equal(db.prepare('SELECT count(*) n FROM snapshots').get().n, 0);
  db.prepare('UPDATE budget SET daily_limit=0').run();
  assert.throws(() => reserveBudget(db, { ...job, attempts: 2 }, { now: new Date(NOW) }), { code: 'BUDGET_EXHAUSTED' });
});

test('worker collection saves an idempotent result and source failures do not replace prior counts with zero', async t => {
  const db = database(t);
  scheduleRepositories(db, ['example/radar'], { now: new Date(NOW) });
  const job = claimJob(db, { now: new Date(NOW) });
  assert.equal((await processCollectionJob(db, job, { now, applyCollection, fetchImpl: fixtureFetch() })).status, 'completed');
  assert.equal(db.prepare('SELECT stars FROM entities').get().stars, 1000);
  const later = NOW + 6 * 3_600_000;
  scheduleRepositories(db, ['example/radar'], { now: new Date(later) });
  const next = claimJob(db, { now: new Date(later) });
  const failed = await processCollectionJob(db, next, { now: () => later, applyCollection, fetchImpl: async () => response({}, {}, 503) });
  assert.equal(failed.code, 'UPSTREAM_UNAVAILABLE');
  assert.equal(db.prepare('SELECT stars FROM entities').get().stars, 1000);
  assert.equal(db.prepare('SELECT count(*) n FROM snapshots').get().n, 1);
  assert.match(db.prepare('SELECT last_error FROM sources WHERE id=?').get('github').last_error, /UPSTREAM_UNAVAILABLE/);
});

test('a release timeout honors the worker timeout and preserves the previous repository snapshot', async t => {
  const db = database(t);
  const initial = await collectRepository({ owner: 'example', repo: 'radar', source: source(), now, fetchImpl: fixtureFetch() });
  applyCollection(db, initial);
  scheduleRepositories(db, ['example/radar'], { now: new Date(NOW) });
  const job = claimJob(db, { now: new Date(NOW) });
  let calls = 0;
  const result = await processCollectionJob(db, job, { now, applyCollection, timeoutMs: 10,
    fetchImpl: (url, { signal }) => {
      calls++;
      if (!url.includes('/releases')) return Promise.resolve(response(fixture({ stargazers_count: 2000 })));
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
    } });
  assert.equal(result.code, 'TIMEOUT'); assert.equal(calls, 2);
  const state = db.prepare('SELECT status,last_error FROM jobs WHERE id=?').get(job.id);
  assert.equal(state.status, 'retry'); assert.match(state.last_error, /版本列表请求超时/);
  assert.equal(db.prepare('SELECT stars FROM entities').get().stars, 1000);
  assert.equal(db.prepare('SELECT count(*) n FROM snapshots').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM worker_leases').get().n, 0);
});

test('real collection is rejected against demo databases before networking', async t => {
  const db = database(t, 'demo');
  scheduleRepositories(db, ['example/radar'], { now: new Date(NOW) });
  const job = claimJob(db, { now: new Date(NOW) });
  let calls = 0;
  const result = await processCollectionJob(db, job, { now, applyCollection, fetchImpl: async () => { calls++; } });
  assert.equal(result.code, 'DEMO_ISOLATION'); assert.equal(calls, 0);
});

test('digest preparation and mail preview are idempotent and no empty email is queued', async t => {
  const db = await populated(t), directory = previews(t);
  assert.equal(prepareOutbox(db, { now: new Date(NOW) }), 1);
  assert.equal(prepareOutbox(db, { now: new Date(NOW) }), 0);
  const result = await processOutbox(db, { now, previewDirectory: directory });
  assert.equal(result[0].status, 'previewed');
  const eml = readFileSync(result[0].path, 'utf8');
  assert.match(eml, /List-Unsubscribe: <http:\/\/127.0.0.1:4188\/api\/v1\/unsubscribe\?token=token-1>/);
  assert.match(Buffer.from(eml.split('\r\n\r\n')[1].replaceAll('\r\n',''), 'base64').toString(), /#entity\/gh%3A12345/);
  assert.deepEqual(await processOutbox(db, { now, previewDirectory: directory }), []);
  assert.equal(prepareOutbox(db, { now: new Date(NOW + 24 * 3_600_000) }), 0);
});

test('queued delivery rechecks opt-out, paused watch, and revoked evidence immediately before send', async t => {
  for (const change of ["UPDATE users SET email_opt_in=0", "UPDATE watches SET paused=1", "UPDATE evidence SET review_status='deleted'", "UPDATE sources SET status='revoked' WHERE id='github'"]) {
    const db = await populated(t); prepareOutbox(db, { now: new Date(NOW) }); db.exec(change);
    let sends = 0;
    const result = await processOutbox(db, { now, mode: 'external', allowExternalDelivery: true, transport: { send: async () => { sends++; return { id: 'receipt' }; } } });
    assert.equal(result[0].status, 'cancelled', change); assert.equal(sends, 0);
  }
});

test('a corrected event is delivered once for its reviewed version and a stale queued version is cancelled', async t => {
  const db = await populated(t), directory = previews(t);
  prepareOutbox(db, { now: new Date(NOW) }); await processOutbox(db, { now, previewDirectory: directory });
  const later = NOW + 24 * 3_600_000;
  db.prepare("UPDATE events SET review_status='corrected',title='更正：版本范围',reviewed_at=?").run(new Date(later).toISOString());
  assert.equal(prepareOutbox(db, { now: new Date(later) }), 1);
  assert.equal(prepareOutbox(db, { now: new Date(later) }), 0);
  db.prepare('UPDATE events SET reviewed_at=?').run(new Date(later + 1000).toISOString());
  const stale = await processOutbox(db, { now: () => later + 1000, previewDirectory: directory });
  assert.equal(stale[0].status, 'cancelled');
  assert.equal(prepareOutbox(db, { now: new Date(later + 24 * 3_600_000) }), 1);
  assert.equal((await processOutbox(db, { now: () => later + 24 * 3_600_000, previewDirectory: directory }))[0].status, 'previewed');
});

test('uncertain provider responses never cause blind resend', async t => {
  const db = await populated(t); prepareOutbox(db, { now: new Date(NOW) });
  let sends = 0;
  const options = { now, mode: 'external', allowExternalDelivery: true, transport: { send: async () => { sends++; throw new Error('connection lost after acceptance'); } } };
  assert.equal((await processOutbox(db, options))[0].status, 'uncertain');
  assert.deepEqual(await processOutbox(db, options), []); assert.equal(sends, 1);
});

test('email transport needs explicit enablement and headers reject injection', async t => {
  const db = await populated(t);
  await assert.rejects(processOutbox(db, { mode: 'external', transport: { send: async () => {} } }), /explicit delivery/);
  assert.throws(() => buildEmail({ user: { email: 'bad@example.com\r\nBcc: other@example.com' }, digest: { title: 'test', created_at: new Date(NOW).toISOString() }, events: [], evidence: [], baseUrl: 'http://127.0.0.1:4188', idempotencyKey: 'test' }), /Invalid email/);
});

test('account/evidence deletion purges associated preview files and rejects paths outside configured root', async t => {
  for (const selector of [{ userId: 'user-1' }, { evidenceId: null }]) {
    const db = await populated(t), directory = previews(t);
    if ('evidenceId' in selector) selector.evidenceId = db.prepare('SELECT evidence_id FROM event_evidence LIMIT 1').get().evidence_id;
    prepareOutbox(db, { now: new Date(NOW) });
    const [result] = await processOutbox(db, { now, previewDirectory: directory });
    assert.equal(existsSync(result.path), true);
    assert.throws(() => purgePreviewFiles(db, { ...selector, previewDirectory: join(directory,'wrong') }), /outside the configured/);
    assert.equal(existsSync(result.path), true);
    assert.equal(purgePreviewFiles(db, { ...selector, previewDirectory: directory }), 1);
    assert.equal(existsSync(result.path), false);
    assert.equal(purgePreviewFiles(db, { ...selector, previewDirectory: directory }), 0);
  }
});

test('worker CLI runs an offline cycle and refuses implicit collection or external delivery', async () => {
  const lines = [];
  await runWorker({ argv: ['--once'], env: { RADAR_MODE: 'production', RADAR_DB_PATH: ':memory:', RADAR_EMAIL_MODE: 'outbox' }, logger: line => lines.push(JSON.parse(line)) });
  assert.equal(lines[0].collection, 'disabled'); assert.deepEqual(lines[0].deliveries, []);
  await assert.rejects(runWorker({ argv: ['--once','--collect'], env: { RADAR_MODE: 'demo' } }), /isolated production/);
  await assert.rejects(runWorker({ argv: ['--once'], env: { RADAR_MODE: 'production', RADAR_DB_PATH: ':memory:', RADAR_EMAIL_MODE: 'resend' } }), /explicit|requires production/);
  const restricted = [];
  await runWorker({ argv: ['--once','--collect'], env: { RADAR_MODE: 'production', RADAR_DB_PATH: ':memory:', RADAR_EMAIL_MODE: 'outbox', RADAR_GITHUB_REPOSITORIES: 'example/radar' }, logger: line => restricted.push(JSON.parse(line)) });
  assert.equal(restricted[0].last_error, 'SOURCE_NOT_APPROVED'); assert.equal(restricted[0].completed, 0);
  for (const invalid of ['0', '999', '45001']) {
    await assert.rejects(runWorker({ argv: ['--once'], env: { RADAR_GITHUB_TIMEOUT_MS: invalid } }), /between 1000 and 45000/);
  }
});

test('an idle worker cycle preserves partial failures until the failed repository succeeds', async t => {
  const directory = previews(t), dbPath = join(directory, 'worker-status.sqlite');
  const db = openDatabase({ dbPath, mode: 'production' });
  initializeWorkerSchema(db);
  db.prepare("UPDATE sources SET status='approved',permission_status='approved' WHERE id='github'").run();
  scheduleRepositories(db, ['example/healthy', 'example/slow']);
  db.prepare("UPDATE jobs SET status='completed',last_run_at=? WHERE type='github_repository'").run(new Date().toISOString());
  db.prepare("UPDATE jobs SET status='retry',last_error='TIMEOUT: 请求超时',next_run_at=? WHERE id LIKE 'github:example/slow:%'")
    .run(new Date(Date.now() + 3_600_000).toISOString());
  const lines = [];
  const options = { argv: ['--once', '--collect'], env: { RADAR_MODE: 'production', RADAR_DB_PATH: dbPath,
    RADAR_EMAIL_MODE: 'outbox', RADAR_GITHUB_REPOSITORIES: 'example/healthy,example/slow' },
    logger: line => lines.push(JSON.parse(line)) };
  try {
    await runWorker(options);
    assert.equal(lines[0].completed, 0); assert.equal(lines[0].failures, 0);
    assert.equal(lines[0].result.success, 1); assert.equal(lines[0].result.failed, 1);
    const parent = db.prepare("SELECT status,last_error FROM jobs WHERE id='github-collect'").get();
    assert.equal(parent.status, 'partial_failure'); assert.match(parent.last_error, /example\/slow: TIMEOUT/);
    db.prepare("UPDATE jobs SET status='completed',last_error=NULL,next_run_at=NULL WHERE type='github_repository'").run();
    await runWorker(options);
    const recovered = db.prepare("SELECT status,last_error FROM jobs WHERE id='github-collect'").get();
    assert.equal(recovered.status, 'completed'); assert.equal(recovered.last_error, null);
  } finally { db.close(); }
});

test('real adapter metadata evidence links deletion to public description and forbids resurrection', async t => {
  const db = database(t);
  const data = await collectRepository({ owner: 'example', repo: 'radar', source: source(), now, fetchImpl: fixtureFetch() });
  applyCollection(db, data);
  const metadataId = data.evidence[0].id;
  assert.equal(db.prepare('SELECT evidence_id FROM entity_evidence WHERE entity_id=?').get(data.repository.id).evidence_id, metadataId);
  deleteEvidence(db, metadataId, '来源要求删除');
  assert.match(db.prepare('SELECT description FROM entities').get().description, /来源已删除/);
  assert.throws(() => applyCollection(db, data), { code: 'DELETED_SOURCE' });
  const changed = await collectRepository({ owner: 'example', repo: 'radar', source: source(), now: () => NOW + 3_600_000,
    fetchImpl: fixtureFetch({ repository: fixture({ stargazers_count: 2000, description: 'Changed text cannot evade source URL tombstone' }) }) });
  assert.throws(() => applyCollection(db, changed), { code: 'DELETED_SOURCE' });
  assert.match(db.prepare('SELECT description FROM entities').get().description, /来源已删除/);
});

test('manual and scheduled digests share event-version dedupe in both directions', async t => {
  const manualFirst = await populated(t);
  const events = manualFirst.prepare('SELECT * FROM events').all();
  manualFirst.prepare('INSERT INTO digests(id,user_id,title,created_at,status,is_demo,window_key) VALUES(?,?,?,?,?,?,?)')
    .run('manual-1','user-1','手动摘要',new Date(NOW).toISOString(),'ready',0,'manual-version');
  recordDigestVersions(manualFirst,'manual-1',events);
  assert.equal(prepareOutbox(manualFirst,{now:new Date(NOW)}),0);
  const scheduledFirst = await populated(t);
  assert.equal(prepareOutbox(scheduledFirst,{now:new Date(NOW)}),1);
  assert.deepEqual(findUnrecordedEvents(scheduledFirst,'user-1',events),[]);
  const corrected = events.map(event=>({...event,reviewed_at:new Date(NOW+1000).toISOString(),title:'更正后的事件'}));
  assert.equal(findUnrecordedEvents(scheduledFirst,'user-1',corrected).length,1);
});
