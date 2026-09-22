import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

function rowsIfPresent(db, table) {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) ? db.prepare(`SELECT * FROM ${table}`).all() : [];
}

export function readDeletionLedger(db) {
  return { mode: db.prepare("SELECT value FROM database_meta WHERE key='mode'").get()?.value,
    evidence: rowsIfPresent(db, 'deletion_tombstones'), accounts: rowsIfPresent(db, 'account_deletions') };
}

export function backupDatabase({ source, target, now = new Date() }) {
  const sourcePath = resolve(source), targetPath = resolve(target);
  if (!existsSync(sourcePath)) throw new Error('Source database does not exist');
  if (existsSync(targetPath) || existsSync(`${targetPath}.manifest.json`)) throw new Error('Backup destination already exists; choose a new file');
  mkdirSync(dirname(targetPath), { recursive: true });
  const db = new DatabaseSync(sourcePath);
  try {
    db.exec('PRAGMA busy_timeout=5000');
    const check = db.prepare('PRAGMA integrity_check').get();
    if (check.integrity_check !== 'ok') throw new Error('Database integrity check failed');
    // VACUUM INTO includes committed WAL data and produces a standalone consistent snapshot.
    db.prepare('VACUUM INTO ?').run(targetPath);
    chmodSync(targetPath, 0o600);
  } finally { db.close(); }
  const snapshot = new DatabaseSync(targetPath, { readOnly: true });
  try {
    const manifest = {
      format: 'open-product-radar-backup-v1', created_at: now.toISOString(),
      mode: snapshot.prepare("SELECT value FROM database_meta WHERE key='mode'").get()?.value,
      schema_version: snapshot.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version,
      sha256: createHash('sha256').update(readFileSync(targetPath)).digest('hex'),
      deletions: readDeletionLedger(snapshot),
      note: 'Restore to a new path; replay the latest deletion ledger, invalidate sessions, and reconcile queued email before use.',
    };
    writeFileSync(`${targetPath}.manifest.json`, JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
    return { file: targetPath, manifest: `${targetPath}.manifest.json`, ...manifest };
  } finally { snapshot.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const source = process.env.RADAR_DB_PATH || `data/radar-${process.env.RADAR_MODE || 'demo'}.sqlite`;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const result = backupDatabase({ source, target: process.argv[2] || `backups/radar-${stamp}.sqlite` });
    console.log(JSON.stringify({ file: result.file, manifest: result.manifest, mode: result.mode, sha256: result.sha256 }));
  } catch (error) { console.error(`Backup failed: ${error.message}`); process.exitCode = 1; }
}
