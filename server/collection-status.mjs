import { json } from './db.mjs';

const SIX_HOURS = 6 * 60 * 60 * 1000;
const ERROR_MESSAGES = {
  TIMEOUT: '请求超时', NETWORK_ERROR: '网络请求失败', RATE_LIMITED: '来源限流，等待重试',
  BUDGET_EXHAUSTED: '已达到采集预算', SOURCE_NOT_APPROVED: '来源尚未获准采集',
  NOT_FOUND: '仓库不存在或不可访问', FORBIDDEN: '来源拒绝访问',
  UPSTREAM_ERROR: '来源服务暂时异常', INVALID_REPOSITORY: '仓库配置无效',
  INVALID_JOB: '采集任务配置无效', LEASE_LOST: '任务执行时间已超出有效范围',
  DELETED_SOURCE: '来源删除要求禁止重新采集', WORKER_ERROR: '采集未完成，请查看运行记录',
};
const emptyCounts = () => ({ total: 0, success: 0, failed: 0, pending: 0, running: 0, pending_retry: 0 });
const time = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const latestDate = values => values.filter(value => time(value)).sort((a, b) => time(b) - time(a))[0] || null;

function repositoryJob(row) {
  const payload = json(row.payload_json, {});
  const scheduled = /^github:([^/:]+\/[^/:]+):(\d+)$/.exec(row.id);
  const candidate = payload && typeof payload.owner === 'string' && typeof payload.repo === 'string'
    ? `${payload.owner}/${payload.repo}` : scheduled?.[1];
  if (!candidate || !/^[\w.-]+\/[\w.-]+$/.test(candidate)) return null;
  return { ...row, repository: candidate, key: candidate.toLowerCase(), bucket: scheduled ? Number(scheduled[2]) : null };
}

function newer(candidate, previous) {
  // Retry scheduling is not creation time: an old failed job's next_run_at must
  // never override a later successful collection for the same repository.
  if (candidate.bucket !== null && previous.bucket !== null && candidate.bucket !== previous.bucket) return candidate.bucket > previous.bucket;
  const observed = job => time(job.last_run_at) || (job.bucket !== null ? job.bucket * SIX_HOURS : time(job.next_run_at));
  return observed(candidate) > observed(previous) || (observed(candidate) === observed(previous) && candidate.ordinal > previous.ordinal);
}

function failure(job) {
  const match = /^([A-Z][A-Z0-9_]*)\b/.exec(job.last_error || '');
  const code = match?.[1] || 'WORKER_ERROR';
  return { repository: job.repository, code, message: ERROR_MESSAGES[code] || ERROR_MESSAGES.WORKER_ERROR,
    last_attempt_at: job.last_run_at || null, retry_at: job.status === 'retry' ? job.next_run_at : null };
}

function resultStatus(counts, hasData) {
  if (counts.failed) return counts.failed === counts.total ? 'failed' : 'partial_failure';
  if (counts.running) return 'running';
  if (counts.pending) return 'pending';
  if (counts.success || hasData) return 'completed';
  return 'not_collected';
}

/** Read-only projection. Source permission, past collection results and worker
 * liveness are different facts; neither a queued job nor source approval is a
 * heartbeat. Per-source last_error and the parent cycle are not per-repo truth. */
export function getCollectionStatus(db, { now = Date.now(), sourceIds = null } = {}) {
  const observedTime = now instanceof Date ? now.getTime() : typeof now === 'string' ? time(now) : now;
  const nowMs = Number.isFinite(observedTime) ? observedTime : Date.now();
  const selectedSources=sourceIds===null?null:new Set(sourceIds);
  const sourceRows = db.prepare('SELECT * FROM sources ORDER BY id').all().filter(source=>selectedSources===null||selectedSources.has(source.id));
  const hasLeases = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='worker_leases'").get();
  const leases = new Map(hasLeases ? db.prepare('SELECT job_id,lease_until FROM worker_leases').all().map(row => [row.job_id, time(row.lease_until)]) : []);
  const grouped = new Map();
  for (const row of db.prepare("SELECT rowid AS ordinal,* FROM jobs WHERE type='github_repository'").all()) {
    const job = repositoryJob(row); if (!job) continue;
    const key = `${job.source_id}:${job.key}`, previous = grouped.get(key);
    if (!previous || newer(job, previous)) grouped.set(key, job);
  }
  const retained = new Map(db.prepare(`SELECT s.id source_id,count(e.id) AS total,
    sum(CASE WHEN e.kind='repository' THEN 1 ELSE 0 END) AS repositories
    FROM sources s JOIN entities e ON e.review_status='published'
    WHERE EXISTS(SELECT 1 FROM snapshots sn WHERE sn.entity_id=e.id AND sn.source_id=s.id)
      OR EXISTS(SELECT 1 FROM evidence ev WHERE ev.entity_id=e.id AND ev.source_id=s.id
        AND ev.review_status NOT IN ('deleted','rejected','retracted')
        AND ev.permission_status IN ('approved','permitted','demo'))
    GROUP BY s.id`).all().map(row => [row.source_id, row]));

  const sources = sourceRows.map(source => {
    const jobs = [...grouped.values()].filter(job => job.source_id === source.id);
    const counts = emptyCounts(), failures = [];
    for (const job of jobs) {
      counts.total++;
      if (job.status === 'completed') counts.success++;
      else if (job.status === 'running' && (leases.get(job.id) || 0) > nowMs && !['blocked', 'revoked'].includes(source.status)) counts.running++;
      else if (job.status === 'failed' || (job.status === 'retry' && job.last_error)) {
        counts.failed++; failures.push(failure(job));
        if (job.status === 'retry') counts.pending_retry++;
      } else counts.pending++;
    }
    const blocked = ['blocked', 'revoked'].includes(source.status);
    const records = blocked ? null : retained.get(source.id);
    const retainedEntities = Number(records?.total || 0), retainedRepositories = Number(records?.repositories || 0);
    const status = blocked ? 'blocked' : resultStatus(counts, retainedEntities > 0);
    const allowed = ['active', 'approved'].includes(source.status) && ['approved', 'permitted', 'demo'].includes(source.permission_status);
    const scheduleStatus = blocked ? 'blocked' : allowed && source.collection_method !== 'manual' && source.collection_method !== 'fixture' ? 'unverified' : 'disabled';
    const workerStatus = counts.running > 0 ? 'observed' : 'unconfirmed';
    let resultSummary;
    if (blocked) resultSummary = '来源权限已撤销，相关证据与衍生介绍停止展示';
    else if (counts.total) {
      const parts = [`${counts.success}个成功`];
      if (counts.failed) parts.push(`${counts.failed}个失败`);
      if (counts.pending) parts.push(`${counts.pending}个待采`);
      if (counts.running) parts.push(`${counts.running}个已领取执行`);
      resultSummary = `各仓库最近一次采集：${parts.join('，')}`;
      if (failures.length) resultSummary += `（${failures.slice(0, 3).map(item => `${item.repository}：${item.message}`).join('；')}${failures.length > 3 ? `；另${failures.length - 3}个失败仓库` : ''}）`;
      if (status === 'failed') resultSummary = `全部仓库最近一次采集失败；${resultSummary}`;
    } else resultSummary = retainedEntities ? `已收录${retainedEntities}个对象的来源资料` : '尚无仓库采集记录';
    const scheduleSummary = blocked ? '持续采集受来源权限限制'
      : source.collection_method === 'manual' ? '人工录入来源，未启用自动采集'
      : source.collection_method === 'fixture' ? '演示资料，不进行真实采集'
      : scheduleStatus === 'disabled' ? '持续采集未启用'
      : workerStatus === 'observed' ? '已观察到本轮任务领取，持续调度状态仍需确认'
      : '来源已获准采集，尚未确认持续采集进程运行';
    const retentionSummary = retainedRepositories ? `保留${retainedRepositories}个仓库的有效数据`
      : retainedEntities ? `保留${retainedEntities}个对象的来源资料` : '';
    const summary = `${source.name}：${[resultSummary, scheduleSummary, retentionSummary].filter(Boolean).join('；')}`;
    return { source_id: source.id, name: source.name, source_status: source.status, permission_status: source.permission_status,
      status, counts, failures, retained_entities: retainedEntities, retained_repositories: retainedRepositories,
      last_attempt_at: latestDate(jobs.map(job => job.last_run_at)), last_success_at: source.last_success_at || null,
      schedule_status: scheduleStatus, worker_status: workerStatus, result_summary: resultSummary,
      schedule_summary: scheduleSummary, retention_summary: retentionSummary, summary };
  });
  const counts = emptyCounts();
  for (const source of sources) for (const field of Object.keys(counts)) counts[field] += source.counts[field];
  const dataSourceCount = sources.filter(source => !['blocked', 'revoked'].includes(source.status) && source.retained_entities > 0).length;
  const status = sources.length && sources.every(source => source.status === 'blocked') ? 'blocked'
    : sources.some(source => source.status === 'blocked') ? 'partial_failure' : resultStatus(counts, dataSourceCount > 0);
  return { status, summary: sources.map(source => source.summary).join('。'), counts,
    data_source_count: dataSourceCount, sources,
    warnings: sources.filter(source => ['blocked', 'failed', 'partial_failure'].includes(source.status)).map(source => `${source.name}：${source.result_summary}${source.retention_summary ? '；' + source.retention_summary : ''}`) };
}
