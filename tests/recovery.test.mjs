import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../server/db.mjs';
import { seedDemo } from '../server/seed.mjs';
import { deleteAccount, deleteEvidence } from '../server/privacy.mjs';
import { backupDatabase } from '../scripts/backup.mjs';
import { restoreDatabase } from '../scripts/restore.mjs';

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'radar-recovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('backup includes WAL data; restore replays later evidence and account deletions', t => {
  const dir = workspace(t), current = join(dir, 'current.sqlite'), backup = join(dir, 'backup.sqlite'), target = join(dir, 'restored.sqlite');
  const db = openDatabase({ dbPath: current, mode: 'demo' });
  seedDemo(db);
  db.prepare("INSERT INTO users(id,name,role,unsubscribe_token,created_at) VALUES('private-user','Private user','user','unsubscribe-secret',?)").run(new Date().toISOString());
  db.prepare("INSERT INTO users(id,name,role,unsubscribe_token,created_at) VALUES('kept-user','Kept user','user','kept-unsubscribe',?)").run(new Date().toISOString());
  db.prepare("INSERT INTO sessions VALUES('old-session','kept-user','old-csrf','2099-01-01T00:00:00.000Z')").run();
  db.prepare("INSERT INTO research_tasks(id,user_id,title,created_at,updated_at) VALUES('private-task','private-user','Sensitive task',?,?)").run(new Date().toISOString(),new Date().toISOString());
  db.prepare("INSERT INTO notes(id,user_id,task_id,body,created_at,updated_at) VALUES('private-note','private-user','private-task','Sensitive note',?,?)").run(new Date().toISOString(),new Date().toISOString());
  db.prepare("INSERT INTO corrections(id,user_id,description,created_at) VALUES('private-correction','private-user','Sensitive correction',?)").run(new Date().toISOString());
  db.prepare("INSERT INTO digests VALUES('kept-digest','kept-user','Digest',?,'ready',1,'daily')").run(new Date().toISOString());
  db.prepare("INSERT INTO outbox VALUES('queued-mail','kept-user','kept-digest','queued','unique-key',?,NULL)").run(new Date().toISOString());
  const result = backupDatabase({ source: current, target: backup });
  assert.equal(result.mode, 'demo');
  assert.equal(result.sha256.length, 64);
  deleteEvidence(db, 'ev-playwright', 'Permission withdrawn');
  deleteAccount(db, 'private-user');
  db.close();
  const restored = restoreDatabase({ backup, target, current });
  assert.equal(restored.replayed.accounts, 1);
  assert.ok(restored.replayed.evidence >= 1);
  const recovered = new DatabaseSync(target);
  try {
    assert.equal(recovered.prepare("SELECT 1 FROM users WHERE id='private-user'").get(), undefined);
    assert.equal(recovered.prepare("SELECT 1 FROM research_tasks WHERE id='private-task'").get(), undefined);
    assert.equal(recovered.prepare("SELECT 1 FROM notes WHERE id='private-note'").get(), undefined);
    assert.equal(recovered.prepare("SELECT 1 FROM corrections WHERE id='private-correction'").get(), undefined);
    assert.equal(recovered.prepare('SELECT COUNT(*) n FROM sessions').get().n, 0);
    assert.equal(recovered.prepare("SELECT status FROM outbox WHERE id='queued-mail'").get().status, 'uncertain');
    assert.equal(recovered.prepare("SELECT excerpt FROM evidence WHERE id='ev-playwright'").get().excerpt, '');
    assert.equal(recovered.prepare("SELECT description FROM entities WHERE id='playwright'").get().description, '来源已删除，介绍等待重新核查');
    assert.equal(recovered.prepare("SELECT review_status FROM events WHERE id='event-playwright-release'").get().review_status, 'retracted');
    assert.equal(recovered.prepare("SELECT status FROM assertions WHERE id='assert-playwright-browser'").get().status, 'unknown');
    assert.equal(recovered.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { recovered.close(); }
});

test('recovery refuses overwrite, checksum corruption, missing ledger and cross-mode replay', t => {
  const dir = workspace(t), current = join(dir, 'source.sqlite'), backup = join(dir, 'backup.sqlite');
  const db = openDatabase({ dbPath: current, mode: 'demo' }); seedDemo(db); db.close();
  backupDatabase({ source: current, target: backup });
  assert.throws(() => backupDatabase({ source: current, target: backup }), /already exists/);
  assert.throws(() => restoreDatabase({ backup, target: current, current }), /overwrite/);
  assert.throws(() => restoreDatabase({ backup, target: join(dir, 'missing.sqlite') }), /deletion ledger/);
  const prod = join(dir, 'production.sqlite'); openDatabase({ dbPath: prod, mode: 'production' }).close();
  assert.throws(() => restoreDatabase({ backup, target: join(dir, 'cross.sqlite'), current: prod }), /mix demo and production/);
  const bytes = readFileSync(backup); bytes[bytes.length - 1] ^= 1; writeFileSync(backup, bytes);
  assert.throws(() => restoreDatabase({ backup, target: join(dir, 'corrupt.sqlite'), current }), /checksum/);
});
