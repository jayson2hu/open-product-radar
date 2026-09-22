import { pathToFileURL } from 'node:url';
import { openDatabase } from '../server/db.mjs';
import { initializeWorkerSchema, scheduleRepositories, claimJob, processCollectionJob } from './jobs.mjs';
import { prepareOutbox, processOutbox, createResendTransport } from './delivery.mjs';
import { assertSourcePermission } from './github.mjs';
import { getCollectionStatus } from '../server/collection-status.mjs';

export async function runWorker({ argv = process.argv.slice(2), env = process.env, logger = console.log } = {}) {
  const unknown = argv.filter(arg => !['--once', '--collect', '--help'].includes(arg));
  if (unknown.length) throw new Error(`Unknown worker option: ${unknown.join(', ')}`);
  if (argv.includes('--help')) { logger('Worker: --once (single cycle), --collect (explicit real GitHub collection, production only). Default email mode is preview; sources require approval.'); return; }
  const mode = env.RADAR_MODE || 'demo';
  const collect = argv.includes('--collect');
  const timeoutMs = numeric(env.RADAR_GITHUB_TIMEOUT_MS, 30_000);
  if (timeoutMs < 1000 || timeoutMs > 45_000) throw new Error('RADAR_GITHUB_TIMEOUT_MS must be between 1000 and 45000 (within the collection lease)');
  if (collect && mode !== 'production') throw new Error('Real GitHub collection requires RADAR_MODE=production and an isolated production database');
  const db = openDatabase({ dbPath: env.RADAR_DB_PATH || `data/radar-${mode}.sqlite`, mode });
  initializeWorkerSchema(db);
  const emailMode = env.RADAR_EMAIL_MODE || 'preview';
  if (!['preview', 'outbox', 'resend'].includes(emailMode)) { db.close(); throw new Error('RADAR_EMAIL_MODE must be preview, outbox or resend'); }
  const external = emailMode === 'resend';
  if (external && (mode !== 'production' || env.RADAR_EMAIL_DELIVERY_ENABLED !== 'yes' || !env.RADAR_EMAIL_FROM || !env.RADAR_PUBLIC_URL?.startsWith('https://'))) {
    db.close(); throw new Error('External delivery requires production, RADAR_EMAIL_DELIVERY_ENABLED=yes, RADAR_EMAIL_FROM and HTTPS RADAR_PUBLIC_URL');
  }
  let stopping = false, wake = null;
  const stop = () => { stopping = true; wake?.(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const transport = external ? createResendTransport({ apiKey: env.RADAR_RESEND_API_KEY }) : null;
    do {
      const cycle = { time: new Date().toISOString(), mode, collection: collect ? 'enabled' : 'disabled', scheduled: 0, completed: 0, failures: 0, email_mode: emailMode };
      if (collect) {
        try {
          assertSourcePermission(db.prepare('SELECT * FROM sources WHERE id=?').get('github'));
          const configured = (env.RADAR_GITHUB_REPOSITORIES || '').split(',').map(s => s.trim()).filter(Boolean);
          const known = db.prepare("SELECT slug FROM entities WHERE kind='repository' AND is_demo=0 AND id LIKE 'gh:%'").all().map(row => row.slug);
          cycle.scheduled = scheduleRepositories(db, [...configured, ...known]);
          db.prepare("UPDATE jobs SET status='running',last_run_at=?,last_error=NULL WHERE id='github-collect'").run(cycle.time);
          const { applyCollection } = await import('../server/store.mjs');
          for (let count = 0; count < 50 && !stopping; count++) {
            const job = claimJob(db); if (!job) break;
            const result = await processCollectionJob(db, job, { applyCollection, token: env.GITHUB_TOKEN, timeoutMs,
              dailyRequestLimit: numeric(env.RADAR_DAILY_REQUEST_LIMIT, 1000), monthlyRequestLimit: numeric(env.RADAR_MONTHLY_REQUEST_LIMIT, 20000) });
            if (result.status === 'completed') cycle.completed++; else { cycle.failures++; cycle.last_error = result.code; }
            if (['RATE_LIMITED', 'BUDGET_EXHAUSTED', 'SOURCE_NOT_APPROVED'].includes(result.code)) break;
          }
          const aggregate = getCollectionStatus(db).sources.find(source => source.source_id === 'github');
          const parentStatus = ({ completed: 'completed', partial_failure: 'partial_failure', failed: 'failed',
            running: 'running', pending: 'queued', blocked: 'paused', not_collected: 'paused' })[aggregate.status];
          const outstanding = aggregate.failures.map(item => `${item.repository}: ${item.code}`).join('; ');
          cycle.result = aggregate.counts;
          // An idle poll must not erase a repository failure still waiting for retry.
          db.prepare("UPDATE jobs SET status=?,last_error=? WHERE id='github-collect'").run(parentStatus, outstanding || null);
        } catch (error) {
          cycle.last_error = error.code || 'WORKER_CONFIGURATION'; cycle.failures++;
          db.prepare("UPDATE jobs SET status='paused',last_run_at=?,last_error=? WHERE id='github-collect'").run(cycle.time, cycle.last_error);
        }
      }
      cycle.digests_prepared = prepareOutbox(db);
      cycle.deliveries = await processOutbox(db, { mode: external ? 'external' : emailMode, transport, allowExternalDelivery: external,
        baseUrl: env.RADAR_PUBLIC_URL || 'http://127.0.0.1:4188', from: env.RADAR_EMAIL_FROM || 'radar@localhost.invalid', previewDirectory: env.RADAR_EMAIL_PREVIEW_DIR || 'data/mail-preview' });
      logger(JSON.stringify(cycle));
      if (argv.includes('--once') || stopping) break;
      await new Promise(resolve => { const timer = setTimeout(resolve, Math.max(1000, Math.min(60_000, numeric(env.RADAR_WORKER_INTERVAL_MS, 30_000)))); wake = () => { clearTimeout(timer); resolve(); }; });
      wake = null;
    } while (!stopping);
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); db.close(); }
}

function numeric(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const number = Number(value); if (!Number.isSafeInteger(number) || number < 0) throw new Error('Worker budgets and intervals must be nonnegative integers');
  return number;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWorker().catch(error => { console.error(`Worker stopped: ${error.message}`); process.exitCode = 1; });
}
