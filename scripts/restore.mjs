import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, readFileSync, mkdirSync, constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readDeletionLedger } from './backup.mjs';
import { openDatabase } from '../server/db.mjs';

function tableExists(db, name) { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name); }

export function replayDeletions(db, ledger) {
  if (!ledger || !Array.isArray(ledger.evidence) || !Array.isArray(ledger.accounts)) throw new Error('A complete deletion ledger is required');
  let evidenceCount = 0, accountsCount = 0;
  db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;');
  try {
    for (const item of ledger.evidence) {
      const matches = db.prepare('SELECT id,url,content_hash FROM evidence').all().filter(row => row.id === item.evidence_id ||
        (item.content_hash && row.content_hash === item.content_hash) || (item.url && createHash('sha256').update(row.url).digest('hex') === item.url));
      for (const { id } of matches) {
        if (tableExists(db, 'entity_evidence')) db.prepare("UPDATE entities SET description='来源已删除，介绍等待重新核查',original_description=NULL,extra_json='{}' WHERE id IN (SELECT entity_id FROM entity_evidence WHERE evidence_id=?)").run(id);
        db.prepare("UPDATE assertions SET review_status='retracted',status='unknown',value='证据已删除',scope='原判断停止展示' WHERE id IN (SELECT assertion_id FROM assertion_evidence WHERE evidence_id=?)").run(id);
        db.prepare("UPDATE editions SET review_status='retracted',name='来源已删除',version=NULL,price=NULL WHERE id IN (SELECT edition_id FROM edition_evidence WHERE evidence_id=?)").run(id);
        db.prepare("UPDATE relations SET status='needs_review',reason='证据已删除' WHERE id IN (SELECT relation_id FROM relation_evidence WHERE evidence_id=?)").run(id);
        db.prepare("UPDATE events SET review_status='retracted',title='相关证据已删除',summary='' WHERE id IN (SELECT event_id FROM event_evidence WHERE evidence_id=?)").run(id);
        db.prepare("UPDATE outbox SET status='cancelled',last_error='恢复时重新应用证据删除' WHERE digest_id IN (SELECT de.digest_id FROM digest_events de JOIN event_evidence ee ON ee.event_id=de.event_id WHERE ee.evidence_id=?) AND status NOT IN ('sent','cancelled')").run(id);
        db.prepare('DELETE FROM digest_events WHERE event_id IN (SELECT event_id FROM event_evidence WHERE evidence_id=?)').run(id);
        db.prepare("UPDATE evidence SET title='已删除',excerpt='',url='',content_hash=NULL,review_status='deleted',permission_status='revoked' WHERE id=?").run(id);
        evidenceCount++;
      }
      db.prepare('INSERT OR IGNORE INTO deletion_tombstones(id,evidence_id,content_hash,url,reason,created_at) VALUES(?,?,?,?,?,?)').run(item.id, item.evidence_id, item.content_hash ?? null, item.url ?? null, item.reason || '恢复重放', item.created_at);
    }
    for (const item of ledger.accounts) {
      if (!item.user_id) throw new Error('Invalid account deletion ledger');
      db.prepare('DELETE FROM analytics WHERE user_id=?').run(item.user_id);
      db.prepare('DELETE FROM corrections WHERE user_id=?').run(item.user_id);
      accountsCount += Number(db.prepare('DELETE FROM users WHERE id=?').run(item.user_id).changes);
      if (tableExists(db, 'account_deletions')) {
        const columns = db.prepare('PRAGMA table_info(account_deletions)').all().map(x => x.name).filter(key => Object.hasOwn(item, key));
        if (columns.length) db.prepare(`INSERT OR IGNORE INTO account_deletions(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...columns.map(k => item[k]));
      }
    }
    // A pre-restore queue may already have been sent after this backup; never blindly replay it.
    db.prepare("UPDATE outbox SET status='uncertain',last_error='从备份恢复，必须人工核对供应商记录，不能自动重发' WHERE status IN ('queued','sending')").run();
    db.exec('DELETE FROM sessions; DELETE FROM oauth_states;');
    if (tableExists(db, 'worker_leases')) db.exec('DELETE FROM worker_leases');
    if (tableExists(db, 'worker_delivery_state')) db.exec('UPDATE worker_delivery_state SET lease_owner=NULL,lease_until=NULL');
    // Source cache can contain deleted material; refetch only after permission and tombstone checks.
    if (tableExists(db, 'github_http_cache')) db.exec('DELETE FROM github_http_cache');
    db.exec('COMMIT');
    return { evidence: evidenceCount, accounts: accountsCount };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function restoreDatabase({ backup, target, current, deletions }) {
  const backupPath = resolve(backup), targetPath = resolve(target);
  if (existsSync(targetPath)) throw new Error('Restore refuses to overwrite an existing database; choose a new path');
  const manifest = JSON.parse(readFileSync(`${backupPath}.manifest.json`, 'utf8'));
  const hash = createHash('sha256').update(readFileSync(backupPath)).digest('hex');
  if (manifest.format !== 'open-product-radar-backup-v1' || hash !== manifest.sha256) throw new Error('Backup manifest or checksum is invalid');
  if (!current && !deletions) throw new Error('Latest deletion ledger is required: provide --current DB or --deletions ledger.json');
  let latest = deletions;
  if (current) {
    if (!existsSync(current)) throw new Error('Current database does not exist; provide an independently retained latest deletion ledger');
    const db = new DatabaseSync(resolve(current), { readOnly: true });
    try {
      if (db.prepare("SELECT value FROM database_meta WHERE key='mode'").get()?.value !== manifest.mode) throw new Error('Cannot mix demo and production deletion ledgers');
      latest = readDeletionLedger(db);
    } finally { db.close(); }
  }
  if (!latest || !Array.isArray(latest.accounts) || !Array.isArray(latest.evidence)) throw new Error('Invalid deletion ledger');
  const ledger = { evidence: [...(manifest.deletions?.evidence || []), ...latest.evidence], accounts: [...(manifest.deletions?.accounts || []), ...latest.accounts] };
  mkdirSync(dirname(targetPath), { recursive: true });
  copyFileSync(backupPath, targetPath, constants.COPYFILE_EXCL);
  const restored = openDatabase({ dbPath: targetPath, mode: manifest.mode });
  try {
    const replayed = replayDeletions(restored, ledger);
    if (restored.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' || restored.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Restored database integrity check failed');
    return { file: targetPath, mode: manifest.mode, replayed, sessions: 'invalidated', email_queue: 'requires_reconciliation' };
  } finally { restored.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [backup, target, flag, input] = process.argv.slice(2);
    if (!backup || !target || !['--current', '--deletions'].includes(flag) || !input) throw new Error('Usage: npm run restore -- backup.sqlite new-target.sqlite --current current.sqlite (or --deletions ledger.json)');
    const options = flag === '--current' ? { current: input } : { deletions: JSON.parse(readFileSync(input, 'utf8')) };
    console.log(JSON.stringify(restoreDatabase({ backup, target, ...options })));
  } catch (error) { console.error(`Restore failed: ${error.message}`); process.exitCode = 1; }
}
