import { randomUUID, createHash } from 'node:crypto';
import { assertSourcePermission, collectRepository, SourceError, validateRepository } from './github.mjs';

export function initializeWorkerSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS worker_leases(job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,owner TEXT NOT NULL,lease_until TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS worker_source_state(source_id TEXT PRIMARY KEY REFERENCES sources(id),next_allowed_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS github_http_cache(url TEXT PRIMARY KEY,etag TEXT,body_json TEXT NOT NULL,checked_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS worker_budget_usage(id TEXT PRIMARY KEY,job_id TEXT NOT NULL,requests INTEGER NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS worker_usage_time ON worker_budget_usage(created_at);
    CREATE TABLE IF NOT EXISTS worker_delivery_state(outbox_id TEXT PRIMARY KEY REFERENCES outbox(id) ON DELETE CASCADE,lease_owner TEXT,lease_until TEXT,attempts INTEGER NOT NULL DEFAULT 0,completed_at TEXT,provider_id TEXT,preview_path TEXT);
    CREATE TABLE IF NOT EXISTS worker_digest_versions(digest_id TEXT NOT NULL REFERENCES digests(id) ON DELETE CASCADE,event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,version TEXT NOT NULL,PRIMARY KEY(digest_id,event_id));`);
}

function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function scheduleRepositories(db, repositories, { now = new Date(), intervalHours = 6 } = {}) {
  assertSourcePermission(db.prepare('SELECT * FROM sources WHERE id=?').get('github'));
  const bucket = Math.floor(now.getTime() / (intervalHours * 3_600_000));
  let count = 0;
  const insert = db.prepare("INSERT OR IGNORE INTO jobs(id,source_id,type,status,next_run_at,payload_json) VALUES(?,'github','github_repository','queued',?,?)");
  for (const slug of [...new Set(repositories)]) {
    const [owner, repo, excess] = slug.split('/'); validateRepository(owner, repo);
    if (excess !== undefined) throw new SourceError('INVALID_REPOSITORY', '仓库配置应为 owner/repo');
    count += Number(insert.run(`github:${owner.toLowerCase()}/${repo.toLowerCase()}:${bucket}`, now.toISOString(), JSON.stringify({ owner, repo })).changes);
  }
  return count;
}

export function claimJob(db, { now = new Date(), leaseMs = 120_000, maxAttempts = 5, workerId = randomUUID() } = {}) {
  return transaction(db, () => {
    // A crash during the final attempt must become a visible terminal failure,
    // rather than a permanent running row excluded by attempts < maxAttempts.
    const exhausted = db.prepare(`SELECT j.id FROM jobs j LEFT JOIN worker_leases l ON l.job_id=j.id
      WHERE j.type='github_repository' AND j.status IN ('queued','retry','running') AND j.attempts>=?
      AND (l.lease_until IS NULL OR l.lease_until<=?)`).all(maxAttempts, now.toISOString());
    for (const { id } of exhausted) {
      db.prepare("UPDATE jobs SET status='failed',next_run_at=NULL,last_error='ATTEMPTS_EXHAUSTED: 最后一次执行未完成且租约已过期，请人工核查后重试' WHERE id=?").run(id);
      db.prepare('DELETE FROM worker_leases WHERE job_id=?').run(id);
    }
    const job = db.prepare(`SELECT j.* FROM jobs j LEFT JOIN worker_leases l ON l.job_id=j.id LEFT JOIN worker_source_state ss ON ss.source_id=j.source_id
      WHERE j.type='github_repository' AND j.status IN ('queued','retry','running') AND j.attempts<?
      AND (j.next_run_at IS NULL OR j.next_run_at<=?) AND (l.lease_until IS NULL OR l.lease_until<=?)
      AND (ss.next_allowed_at IS NULL OR ss.next_allowed_at<=?)
      AND NOT EXISTS(SELECT 1 FROM worker_leases occupied JOIN jobs running ON running.id=occupied.job_id WHERE running.source_id=j.source_id AND occupied.lease_until>?)
      ORDER BY j.next_run_at,j.id LIMIT 1`).get(maxAttempts, now.toISOString(), now.toISOString(), now.toISOString(), now.toISOString());
    if (!job) return null;
    const leaseOwner = `${workerId}:${randomUUID()}`;
    db.prepare('INSERT INTO worker_leases(job_id,owner,lease_until) VALUES(?,?,?) ON CONFLICT(job_id) DO UPDATE SET owner=excluded.owner,lease_until=excluded.lease_until')
      .run(job.id, leaseOwner, new Date(now.getTime() + leaseMs).toISOString());
    db.prepare("UPDATE jobs SET status='running',attempts=attempts+1,last_run_at=?,last_error=NULL WHERE id=?").run(now.toISOString(), job.id);
    return { ...job, attempts: job.attempts + 1, lease_owner: leaseOwner };
  });
}

export function reserveBudget(db, job, { now = new Date(), dailyRequestLimit = 1000, monthlyRequestLimit = 20_000, requests = 2 } = {}) {
  return transaction(db, () => {
    // Manual retry resets attempts; the new lease still represents a new request budget.
    const id = `${job.id}:attempt:${job.attempts}:lease:${job.lease_owner || 'unleased'}`;
    if (db.prepare('SELECT 1 FROM worker_budget_usage WHERE id=?').get(id)) return true;
    const day = now.toISOString().slice(0, 10), month = day.slice(0, 7);
    const usage = db.prepare('SELECT COALESCE(SUM(requests),0) AS total FROM worker_budget_usage WHERE created_at>=?');
    const costs = db.prepare('SELECT COALESCE(SUM(amount),0) AS total FROM costs WHERE created_at>=?');
    const budget = db.prepare('SELECT * FROM budget WHERE id=1').get();
    if (!budget || costs.get(`${day}T00:00:00.000Z`).total >= budget.daily_limit || costs.get(`${month}-01T00:00:00.000Z`).total >= budget.monthly_limit ||
        usage.get(`${day}T00:00:00.000Z`).total + requests > dailyRequestLimit || usage.get(`${month}-01T00:00:00.000Z`).total + requests > monthlyRequestLimit) {
      throw new SourceError('BUDGET_EXHAUSTED', '预算已达上限，保留历史数据并暂停新采集', { retryable: true, retryAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString() });
    }
    db.prepare('INSERT INTO worker_budget_usage VALUES(?,?,?,?)').run(id, job.id, requests, now.toISOString());
    return true;
  });
}

export function finishJob(db, job, error = null, { now = new Date(), maxAttempts = 5 } = {}) {
  return transaction(db, () => {
    const lease = db.prepare('SELECT * FROM worker_leases WHERE job_id=?').get(job.id);
    if (!lease || lease.owner !== job.lease_owner) throw new SourceError('LEASE_LOST', '任务租约已失效，不能覆盖另一任务结果');
    const status = error ? (error.retryable && job.attempts < maxAttempts ? 'retry' : 'failed') : 'completed';
    db.prepare('UPDATE jobs SET status=?,next_run_at=?,last_error=? WHERE id=?')
      .run(status, error?.retryAt ?? null, error ? `${error.code ?? 'WORKER_ERROR'}: ${error.message}`.slice(0, 1000) : null, job.id);
    db.prepare('DELETE FROM worker_leases WHERE job_id=? AND owner=?').run(job.id, job.lease_owner);
    if (error?.retryAt && ['RATE_LIMITED','BUDGET_EXHAUSTED'].includes(error.code)) db.prepare('INSERT INTO worker_source_state(source_id,next_allowed_at) VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at').run(job.source_id,error.retryAt);
    if (error) db.prepare('UPDATE sources SET last_error=? WHERE id=?').run(`${error.code ?? 'WORKER_ERROR'}: ${error.message}`.slice(0, 1000), job.source_id);
    else db.prepare('UPDATE sources SET last_error=NULL,last_success_at=? WHERE id=?').run(now.toISOString(), job.source_id);
    return status;
  });
}

export async function processCollectionJob(db, job, { applyCollection, fetchImpl, token, now = () => Date.now(), dailyRequestLimit, monthlyRequestLimit, timeoutMs } = {}) {
  try {
    const mode = db.prepare("SELECT value FROM database_meta WHERE key='mode'").get()?.value;
    if (mode !== 'production') throw new SourceError('DEMO_ISOLATION', '实采仅可写入独立的 production 数据库');
    const source = db.prepare('SELECT * FROM sources WHERE id=?').get('github');
    assertSourcePermission(source);
    reserveBudget(db, job, { now: new Date(now()), dailyRequestLimit, monthlyRequestLimit });
    let payload; try { payload = JSON.parse(job.payload_json); } catch { throw new SourceError('INVALID_JOB', '任务数据格式无效'); }
    const cache = db.prepare('SELECT * FROM github_http_cache').all().map(record => ({ ...record, body: JSON.parse(record.body_json) }));
    const entity = db.prepare('SELECT id FROM entities WHERE lower(slug)=?').get(`${payload.owner}/${payload.repo}`.toLowerCase());
    const history = entity ? db.prepare('SELECT * FROM snapshots WHERE entity_id=? ORDER BY observed_at DESC LIMIT 1000').all(entity.id) : [];
    const result = await collectRepository({ ...payload, token, source, cache, history, attempts: job.attempts, fetchImpl, now, timeoutMs });
    // Source permission can change while the network operation is in flight.
    assertSourcePermission(db.prepare('SELECT * FROM sources WHERE id=?').get('github'));
    const lease = db.prepare('SELECT * FROM worker_leases WHERE job_id=?').get(job.id);
    if (!lease || lease.owner !== job.lease_owner || Date.parse(lease.lease_until) <= now()) throw new SourceError('LEASE_LOST', '任务已超过租约，需要重新核查');
    applyCollection(db, result);
    transaction(db, () => {
      // Deleted release text can still arrive in GitHub's response. The store
      // excludes that evidence; do not reintroduce it through the raw HTTP cache.
      const tombstone = db.prepare('SELECT 1 FROM deletion_tombstones WHERE evidence_id=? OR content_hash=? OR url=?');
      const hash = value => createHash('sha256').update(value || '').digest('hex');
      const containsDeletedEvidence = result.evidence.some(evidence => tombstone.get(evidence.id, evidence.content_hash || hash(evidence.excerpt), hash(evidence.url)));
      const cacheInsert = db.prepare('INSERT INTO github_http_cache(url,etag,body_json,checked_at) VALUES(?,?,?,?) ON CONFLICT(url) DO UPDATE SET etag=excluded.etag,body_json=excluded.body_json,checked_at=excluded.checked_at');
      for (const record of result.http_cache) {
        if (containsDeletedEvidence) db.prepare('DELETE FROM github_http_cache WHERE url=?').run(record.url);
        else cacheInsert.run(record.url, record.etag, JSON.stringify(record.body), record.checked_at);
      }
    });
    finishJob(db, job, null, { now: new Date(now()) });
    return { status: 'completed', entity_id: result.repository.id, events: result.events.length };
  } catch (error) {
    // A replaced lease belongs to another executor. Its state must stay intact.
    const lease = db.prepare('SELECT owner FROM worker_leases WHERE job_id=?').get(job.id);
    if (lease?.owner === job.lease_owner) finishJob(db, job, error, { now: new Date(now()) });
    return { status: 'failed', code: error.code ?? 'WORKER_ERROR' };
  }
}
