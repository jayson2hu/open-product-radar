import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const SCHEMA_VERSION = 3;
export const now = () => new Date().toISOString();
export const json = (value, fallback = null) => { try { return JSON.parse(value); } catch { return fallback; } };

export function openDatabase({ dbPath = process.env.RADAR_DB_PATH || `data/radar-${process.env.RADAR_MODE || 'demo'}.sqlite`, mode = process.env.RADAR_MODE || 'demo' } = {}) {
  if (!['demo', 'production'].includes(mode)) throw new Error('RADAR_MODE must be demo or production');
  if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS database_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  const stored = db.prepare('SELECT value FROM database_meta WHERE key=?').get('mode');
  if (stored && stored.value !== mode) { db.close(); throw new Error('Database mode mismatch: demo and production data must remain isolated'); }
  db.prepare('INSERT OR IGNORE INTO database_meta(key,value) VALUES (?,?)').run('mode', mode);
  if (!db.prepare('SELECT 1 FROM schema_migrations WHERE version=1').get()) {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT,role TEXT NOT NULL DEFAULT 'user',email_opt_in INTEGER NOT NULL DEFAULT 0,timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',github_id TEXT UNIQUE,is_demo INTEGER NOT NULL DEFAULT 0,unsubscribe_token TEXT UNIQUE NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE sessions(id_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,csrf_token TEXT NOT NULL,expires_at TEXT NOT NULL);
      CREATE TABLE oauth_states(state_hash TEXT PRIMARY KEY,expires_at TEXT NOT NULL);
      CREATE TABLE sources(id TEXT PRIMARY KEY,name TEXT NOT NULL,url TEXT NOT NULL,status TEXT NOT NULL,permission_status TEXT NOT NULL,collection_method TEXT NOT NULL,retention_days INTEGER NOT NULL DEFAULT 90,reason TEXT,last_success_at TEXT,last_error TEXT,terms_url TEXT);
      CREATE TABLE entities(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('repository','product')),name TEXT NOT NULL,owner TEXT,slug TEXT UNIQUE,description TEXT NOT NULL,original_description TEXT,topic TEXT NOT NULL,language TEXT,license TEXT,website TEXT,repository_url TEXT,docs_url TEXT,stars INTEGER,delta_24h INTEGER,delta_7d INTEGER,trend_status TEXT NOT NULL DEFAULT 'insufficient',observed_at TEXT,first_seen_at TEXT NOT NULL,created_at TEXT,is_demo INTEGER NOT NULL,featured INTEGER NOT NULL DEFAULT 0,review_status TEXT NOT NULL DEFAULT 'published',extra_json TEXT NOT NULL DEFAULT '{}');
      CREATE INDEX entity_filters ON entities(kind,topic,review_status);
      CREATE TABLE snapshots(id TEXT PRIMARY KEY,entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,stars INTEGER NOT NULL,observed_at TEXT NOT NULL,source_id TEXT NOT NULL REFERENCES sources(id),metric_version TEXT NOT NULL DEFAULT 'stars-v1',scope TEXT NOT NULL DEFAULT 'public',UNIQUE(entity_id,source_id,observed_at,metric_version));
      CREATE INDEX snapshots_entity_time ON snapshots(entity_id,observed_at);
      CREATE TABLE evidence(id TEXT PRIMARY KEY,entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL,source_id TEXT REFERENCES sources(id),title TEXT NOT NULL,url TEXT NOT NULL,excerpt TEXT NOT NULL,source_name TEXT NOT NULL,published_at TEXT,fetched_at TEXT NOT NULL,reviewed_at TEXT,review_status TEXT NOT NULL DEFAULT 'pending',is_demo INTEGER NOT NULL,permission_status TEXT NOT NULL DEFAULT 'permitted',content_hash TEXT);
      CREATE TABLE editions(id TEXT PRIMARY KEY,entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,name TEXT NOT NULL,deployment TEXT,price REAL,currency TEXT,billing_period TEXT,version TEXT,review_status TEXT NOT NULL DEFAULT 'published');
      CREATE TABLE edition_evidence(edition_id TEXT REFERENCES editions(id) ON DELETE CASCADE,evidence_id TEXT REFERENCES evidence(id) ON DELETE CASCADE,PRIMARY KEY(edition_id,evidence_id));
      CREATE TABLE assertions(id TEXT PRIMARY KEY,entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,dimension TEXT NOT NULL,label TEXT NOT NULL,status TEXT NOT NULL,value TEXT NOT NULL,scope TEXT NOT NULL,review_status TEXT NOT NULL DEFAULT 'published');
      CREATE TABLE assertion_evidence(assertion_id TEXT REFERENCES assertions(id) ON DELETE CASCADE,evidence_id TEXT REFERENCES evidence(id) ON DELETE CASCADE,PRIMARY KEY(assertion_id,evidence_id));
      CREATE TABLE relations(id TEXT PRIMARY KEY,entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,target_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,type TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'needs_review',reason TEXT,reviewed_at TEXT);
      CREATE TABLE relation_evidence(relation_id TEXT REFERENCES relations(id) ON DELETE CASCADE,evidence_id TEXT REFERENCES evidence(id) ON DELETE CASCADE,PRIMARY KEY(relation_id,evidence_id));
      CREATE TABLE events(id TEXT PRIMARY KEY,entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,title TEXT NOT NULL,summary TEXT NOT NULL,type TEXT NOT NULL,published_at TEXT,observed_at TEXT NOT NULL,reviewed_at TEXT,review_status TEXT NOT NULL DEFAULT 'pending',is_demo INTEGER NOT NULL,dedupe_key TEXT UNIQUE);
      CREATE INDEX events_status_date ON events(review_status,observed_at);
      CREATE TABLE event_evidence(event_id TEXT REFERENCES events(id) ON DELETE CASCADE,evidence_id TEXT REFERENCES evidence(id) ON DELETE CASCADE,PRIMARY KEY(event_id,evidence_id));
      CREATE TABLE research_tasks(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,title TEXT NOT NULL,problem TEXT NOT NULL DEFAULT '',must_have TEXT NOT NULL DEFAULT '',flexible TEXT NOT NULL DEFAULT '',uncertainties TEXT NOT NULL DEFAULT '',reevaluate_when TEXT NOT NULL DEFAULT '',phase TEXT NOT NULL DEFAULT 'selection',status TEXT NOT NULL DEFAULT 'researching',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE INDEX tasks_owner ON research_tasks(user_id);
      CREATE TABLE task_candidates(task_id TEXT NOT NULL REFERENCES research_tasks(id) ON DELETE CASCADE,entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,created_at TEXT NOT NULL,PRIMARY KEY(task_id,entity_id));
      CREATE TABLE watches(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,reason TEXT NOT NULL,event_types TEXT NOT NULL,frequency TEXT NOT NULL DEFAULT 'in_app',paused INTEGER NOT NULL DEFAULT 0,last_read_at TEXT,created_at TEXT NOT NULL,UNIQUE(user_id,entity_id));
      CREATE TABLE notes(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL,task_id TEXT REFERENCES research_tasks(id) ON DELETE CASCADE,body TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'researching',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE digests(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,title TEXT NOT NULL,created_at TEXT NOT NULL,status TEXT NOT NULL,is_demo INTEGER NOT NULL,window_key TEXT NOT NULL,UNIQUE(user_id,window_key));
      CREATE TABLE digest_events(digest_id TEXT NOT NULL REFERENCES digests(id) ON DELETE CASCADE,event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,PRIMARY KEY(digest_id,event_id));
      CREATE TABLE outbox(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,digest_id TEXT NOT NULL REFERENCES digests(id) ON DELETE CASCADE,status TEXT NOT NULL DEFAULT 'queued',idempotency_key TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,last_error TEXT);
      CREATE TABLE corrections(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id) ON DELETE SET NULL,entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL,evidence_id TEXT REFERENCES evidence(id) ON DELETE SET NULL,description TEXT NOT NULL,url TEXT,status TEXT NOT NULL DEFAULT 'pending',reason TEXT,created_at TEXT NOT NULL,reviewed_at TEXT);
      CREATE TABLE jobs(id TEXT PRIMARY KEY,source_id TEXT REFERENCES sources(id),type TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,last_run_at TEXT,next_run_at TEXT,last_error TEXT,payload_json TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE audit(id TEXT PRIMARY KEY,actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,action TEXT NOT NULL,target_id TEXT,reason TEXT,created_at TEXT NOT NULL);
      CREATE TABLE costs(id TEXT PRIMARY KEY,category TEXT NOT NULL,amount REAL NOT NULL,minutes REAL NOT NULL DEFAULT 0,note TEXT NOT NULL,created_at TEXT NOT NULL,actor_id TEXT REFERENCES users(id) ON DELETE SET NULL);
      CREATE TABLE orders(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id) ON DELETE SET NULL,amount REAL NOT NULL,currency TEXT NOT NULL,reference TEXT NOT NULL UNIQUE,days INTEGER NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,refunded_at TEXT,refund_reason TEXT,actor_id TEXT REFERENCES users(id) ON DELETE SET NULL);
      CREATE TABLE budget(id INTEGER PRIMARY KEY CHECK(id=1),daily_limit REAL NOT NULL,monthly_limit REAL NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE analytics(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id) ON DELETE SET NULL,event TEXT NOT NULL,entity_id TEXT,task_id TEXT,phase TEXT,channel TEXT,cohort TEXT,created_at TEXT NOT NULL,is_demo INTEGER NOT NULL);
      CREATE TABLE deletion_tombstones(id TEXT PRIMARY KEY,evidence_id TEXT NOT NULL,content_hash TEXT,url TEXT,reason TEXT NOT NULL,created_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES(1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      COMMIT;`);
  }
  if (!db.prepare('SELECT 1 FROM schema_migrations WHERE version=2').get()) {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE account_deletions(user_id TEXT PRIMARY KEY,github_id TEXT,created_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES(2,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      COMMIT;`);
  }
  if (!db.prepare('SELECT 1 FROM schema_migrations WHERE version=3').get()) {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE entity_evidence(entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,field TEXT NOT NULL DEFAULT 'description',PRIMARY KEY(entity_id,evidence_id,field));
      INSERT OR IGNORE INTO entity_evidence(entity_id,evidence_id,field) SELECT entity_id,id,'description' FROM evidence WHERE entity_id IS NOT NULL AND (id LIKE 'gh:repo:%' OR id LIKE 'ev-%');
      INSERT INTO schema_migrations VALUES(3,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      COMMIT;`);
  }
  db.prepare('INSERT OR IGNORE INTO budget VALUES(1,?,?,?)').run(20, 300, now());
  db.prepare('INSERT OR IGNORE INTO sources(id,name,url,status,permission_status,collection_method,reason,terms_url) VALUES(?,?,?,?,?,?,?,?)')
    .run('github', 'GitHub Public API', 'https://api.github.com', 'paused', 'pending', 'public_api', '首次实采前需核对来源条款、配额及范围，并在后台启用', 'https://docs.github.com/en/site-policy/github-terms/github-terms-of-service');
  db.prepare('INSERT OR IGNORE INTO jobs(id,source_id,type,status,payload_json) VALUES(?,?,?,?,?)').run('github-collect', 'github', 'github_collection', 'paused', '{}');
  return db;
}

export function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
