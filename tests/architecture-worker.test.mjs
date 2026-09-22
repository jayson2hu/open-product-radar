import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { openDatabase } from '../server/db.mjs';
import { applyCollection } from '../server/store.mjs';
import { deleteEvidence } from '../server/privacy.mjs';
import { initializeWorkerSchema, scheduleRepositories, claimJob, finishJob, reserveBudget, processCollectionJob } from '../workers/jobs.mjs';
import { SourceError } from '../workers/github.mjs';
import { summarizeLocalCollection } from '../scripts/collection-summary.mjs';
import { backupDatabase, readDeletionLedger } from '../scripts/backup.mjs';
import { restoreDatabase } from '../scripts/restore.mjs';
import { prepareOutbox, processOutbox } from '../workers/delivery.mjs';

const NOW = Date.parse('2026-09-22T12:00:00.000Z');
const iso = value => new Date(value).toISOString();
function database(t) {
  const db = openDatabase({ dbPath: ':memory:', mode: 'production' }); initializeWorkerSchema(db);
  db.prepare("UPDATE sources SET status='approved',permission_status='approved' WHERE id='github'").run();
  t.after(() => db.close()); return db;
}
function schedule(db, at = NOW) { scheduleRepositories(db, ['example/radar'], { now: new Date(at) }); return claimJob(db, { now: new Date(at), workerId: 'same-process' }); }
const rawRepository = { id: 7654, name: 'radar', private: false, owner: { login: 'example' }, stargazers_count: 100, description: 'Official metadata', topics: [], created_at: '2020-01-01T00:00:00Z' };
const rawRelease = { id: 8765, name: 'Release 1', tag_name: 'v1', draft: false, published_at: '2026-09-21T00:00:00Z', body: 'Source text that must not return after deletion.' };
const fixtureFetch = async url => new Response(JSON.stringify(url.includes('/releases') ? [rawRelease] : rawRepository), { headers: { 'content-type': 'application/json' } });

test('an abandoned last attempt becomes a terminal failure after lease expiry', t => {
  const db = database(t), job = schedule(db);
  db.prepare('UPDATE jobs SET attempts=5 WHERE id=?').run(job.id);
  db.prepare('UPDATE worker_leases SET lease_until=? WHERE job_id=?').run(iso(NOW + 1000), job.id);
  assert.equal(claimJob(db, { now: new Date(NOW + 999) }), null);
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(job.id).status, 'running');
  assert.equal(claimJob(db, { now: new Date(NOW + 1001) }), null);
  const expired = db.prepare('SELECT * FROM jobs WHERE id=?').get(job.id);
  assert.equal(expired.status, 'failed'); assert.match(expired.last_error, /^ATTEMPTS_EXHAUSTED:/);
  assert.equal(db.prepare('SELECT 1 FROM worker_leases WHERE job_id=?').get(job.id), undefined);
});

test('manual attempt reset reserves a new request budget while the same lease remains idempotent', t => {
  const db = database(t), first = schedule(db);
  reserveBudget(db, first, { now: new Date(NOW), dailyRequestLimit: 4 });
  reserveBudget(db, first, { now: new Date(NOW), dailyRequestLimit: 4 });
  finishJob(db, first, new SourceError('ACCESS_DENIED', 'Fixture rejection'), { now: new Date(NOW) });
  db.prepare("UPDATE jobs SET attempts=0,status='queued',next_run_at=? WHERE id=?").run(iso(NOW), first.id);
  const retry = claimJob(db, { now: new Date(NOW), workerId: 'same-process' });
  assert.equal(retry.attempts, 1); assert.notEqual(retry.lease_owner, first.lease_owner);
  reserveBudget(db, retry, { now: new Date(NOW), dailyRequestLimit: 4 });
  assert.equal(db.prepare('SELECT SUM(requests) requests FROM worker_budget_usage').get().requests, 4);
  assert.throws(() => reserveBudget(db, { ...retry, lease_owner: 'another-execution' }, { now: new Date(NOW), dailyRequestLimit: 4 }), { code: 'BUDGET_EXHAUSTED' });
});

test('a deleted release cannot reappear through the raw HTTP cache on recollection', async t => {
  const db = database(t), first = schedule(db);
  assert.equal((await processCollectionJob(db, first, { now: () => NOW, applyCollection, fetchImpl: fixtureFetch })).status, 'completed');
  assert.equal(db.prepare('SELECT count(*) n FROM github_http_cache').get().n, 2);
  const evidenceId = db.prepare("SELECT id FROM evidence WHERE id LIKE 'evidence:gh:release:8765:%'").get().id;
  deleteEvidence(db, evidenceId, 'Fixture source deletion');
  assert.equal(db.prepare('SELECT count(*) n FROM github_http_cache').get().n, 0);
  const nextTime = NOW + 6 * 3600000, next = schedule(db, nextTime);
  const result = await processCollectionJob(db, next, { now: () => nextTime, applyCollection, fetchImpl: fixtureFetch });
  assert.equal(result.status, 'completed');
  assert.equal(db.prepare('SELECT count(*) n FROM github_http_cache').get().n, 0);
  assert.equal(db.prepare('SELECT excerpt FROM evidence WHERE id=?').get(evidenceId).excerpt, '');
  assert.equal(db.prepare("SELECT review_status FROM events WHERE id='gh:release:8765'").get().review_status, 'retracted');
});

test('a stale executor returns LEASE_LOST without throwing or overwriting its replacement', async t => {
  const db = database(t), job = schedule(db);
  const fetchImpl = async url => {
    if (url.includes('/releases')) db.prepare('UPDATE worker_leases SET owner=? WHERE job_id=?').run('replacement-executor', job.id);
    return fixtureFetch(url);
  };
  const result = await processCollectionJob(db, job, { now: () => NOW, applyCollection, fetchImpl });
  assert.deepEqual(result, { status: 'failed', code: 'LEASE_LOST' });
  assert.equal(db.prepare('SELECT owner FROM worker_leases WHERE job_id=?').get(job.id).owner, 'replacement-executor');
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(job.id).status, 'running');
  assert.equal(db.prepare('SELECT count(*) n FROM entities').get().n, 0);
});

test('local collection report ignores historical failures after a later successful window', t => {
  const db = database(t), first = schedule(db);
  finishJob(db, first, new SourceError('TIMEOUT', 'Old failure'), { now: new Date(NOW) });
  const nextTime = NOW + 6 * 3600000, next = schedule(db, nextTime);
  finishJob(db, next, null, { now: new Date(nextTime) });
  const report = summarizeLocalCollection(db, { startedAt: iso(NOW), now: nextTime });
  assert.deepEqual(report.failures, []); assert.equal(report.collection.counts.success, 1);
  assert.equal(db.prepare("SELECT count(*) n FROM jobs WHERE type='github_repository' AND status='failed'").get().n, 1);
  assert.equal(report.request_count_basis, 'distinct_cached_endpoints_not_http_requests');
});

test('external deletion ledgers require matching database mode before any restored file is created', t => {
  const directory = mkdtempSync(join(tmpdir(), 'radar-architecture-recovery-'));
  t.after(() => { const path = resolve(directory); assert.ok(path.startsWith(resolve(tmpdir()) + sep)); rmSync(path, { recursive: true, force: true }); });
  const source = join(directory, 'source.sqlite'), backup = join(directory, 'backup.sqlite');
  const db = openDatabase({ dbPath: source, mode: 'demo' });
  const ledger = readDeletionLedger(db); db.close();
  assert.equal(ledger.mode, 'demo'); backupDatabase({ source, target: backup });
  if (process.platform !== 'win32') assert.equal(statSync(backup).mode & 0o777, 0o600);
  const target = join(directory, 'restored.sqlite');
  assert.throws(() => restoreDatabase({ backup, target, deletions: { ...ledger, mode: 'production' } }), /ledger mode must match/);
  assert.equal(existsSync(target), false);
  assert.throws(() => restoreDatabase({ backup, target, deletions: { accounts: [], evidence: [] } }), /ledger mode must match/);
  assert.equal(existsSync(target), false);
  assert.equal(restoreDatabase({ backup, target, deletions: ledger }).mode, 'demo');
});

test('one revoked citation suppresses the whole multi-source event during preparation and queued delivery', async t => {
  const db = database(t), job = schedule(db);
  await processCollectionJob(db, job, { now: () => NOW, applyCollection, fetchImpl: fixtureFetch });
  db.prepare("UPDATE events SET review_status='published',reviewed_at=?").run(iso(NOW));
  db.prepare("UPDATE evidence SET review_status='published',reviewed_at=?").run(iso(NOW));
  db.prepare('INSERT INTO sources(id,name,url,status,permission_status,collection_method) VALUES(?,?,?,?,?,?)')
    .run('second-source','Second citation','https://example.com','approved','approved','manual');
  db.prepare('INSERT INTO evidence(id,entity_id,source_id,title,url,excerpt,source_name,fetched_at,review_status,is_demo,permission_status) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run('second-citation','gh:7654','second-source','Second citation','https://example.com/release','Additional support','Second citation',iso(NOW),'published',0,'approved');
  db.prepare('INSERT INTO event_evidence(event_id,evidence_id) VALUES(?,?)').run('gh:release:8765','second-citation');
  db.prepare('INSERT INTO users(id,name,email,email_opt_in,unsubscribe_token,created_at) VALUES(?,?,?,?,?,?)')
    .run('reader','Reader','reader@example.com',1,'fixture-unsubscribe-token',iso(NOW-86400000));
  db.prepare('INSERT INTO watches(id,user_id,entity_id,reason,event_types,frequency,created_at) VALUES(?,?,?,?,?,?,?)')
    .run('watch','reader','gh:7654','Follow release','["release"]','daily',iso(NOW-86400000));
  db.prepare("UPDATE sources SET status='blocked' WHERE id='second-source'").run();
  assert.equal(prepareOutbox(db,{now:new Date(NOW)}),0,'A surviving citation cannot keep the whole summary eligible');
  db.prepare("UPDATE sources SET status='approved' WHERE id='second-source'").run();
  assert.equal(prepareOutbox(db,{now:new Date(NOW)}),1);
  db.prepare("UPDATE sources SET status='blocked' WHERE id='second-source'").run();
  const result=await processOutbox(db,{now:()=>NOW});
  assert.equal(result[0].status,'cancelled');
  assert.equal(db.prepare('SELECT status FROM outbox').get().status,'cancelled');
});
