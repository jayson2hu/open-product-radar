import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, unlinkSync, realpathSync, existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';

const hash = input => createHash('sha256').update(input).digest('hex').slice(0, 32);
const parse = input => { try { return JSON.parse(input); } catch { return []; } };
const published = "('published','corrected')";

function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

/** Run before account/evidence deletion cascades so affected private preview files remain discoverable. */
export function purgePreviewFiles(db, { userId = null, evidenceId = null, previewDirectory = process.env.RADAR_EMAIL_PREVIEW_DIR || 'data/mail-preview' } = {}) {
  if (!userId && !evidenceId) throw new Error('Preview purge requires a specific account or evidence');
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='worker_delivery_state'").get()) return 0;
  const previews = db.prepare(`SELECT DISTINCT s.preview_path FROM worker_delivery_state s JOIN outbox o ON o.id=s.outbox_id
    WHERE s.preview_path IS NOT NULL AND ((? IS NOT NULL AND o.user_id=?) OR (? IS NOT NULL AND EXISTS(
      SELECT 1 FROM digest_events de JOIN event_evidence ee ON ee.event_id=de.event_id WHERE de.digest_id=o.digest_id AND ee.evidence_id=?)))`).all(userId,userId,evidenceId,evidenceId);
  const root = resolve(previewDirectory);
  let removed = 0;
  for (const preview of previews) {
    const path = resolve(preview.preview_path);
    if (dirname(path) !== root || !/^[a-f0-9]{32}\.eml$/.test(basename(path))) throw new Error('Preview path is outside the configured preview directory');
    if (!existsSync(path)) continue;
    if (realpathSync(dirname(path)) !== realpathSync(root)) throw new Error('Preview path resolved outside the configured preview directory');
    unlinkSync(path); removed++;
  }
  return removed;
}

function eligibleEvents(db, userId, { frequency = null, sinceRead = true } = {}) {
  const permissions = db.prepare("SELECT value FROM database_meta WHERE key='mode'").get()?.value === 'demo' ? "('approved','permitted','demo')" : "('approved','permitted')";
  const rows = db.prepare(`SELECT e.*,w.event_types,w.last_read_at,w.created_at AS watch_created_at,w.frequency
    FROM events e JOIN watches w ON w.entity_id=e.entity_id
    WHERE w.user_id=? AND w.paused=0 AND w.frequency<>'in_app' AND e.review_status IN ${published}
    AND EXISTS(SELECT 1 FROM event_evidence required_link WHERE required_link.event_id=e.id)
    AND NOT EXISTS(SELECT 1 FROM event_evidence ee LEFT JOIN evidence ev ON ev.id=ee.evidence_id
      LEFT JOIN sources s ON s.id=ev.source_id WHERE ee.event_id=e.id
      AND (ev.id IS NULL OR s.id IS NULL OR ev.review_status NOT IN ${published}
        OR ev.permission_status NOT IN ${permissions} OR s.status NOT IN ('active','approved')
        OR s.permission_status NOT IN ${permissions}))`).all(userId);
  return rows.filter(event => (!frequency || event.frequency === frequency) && (!parse(event.event_types).length || parse(event.event_types).includes(event.type)) &&
    (!sinceRead || (event.reviewed_at || event.observed_at) > (event.last_read_at || event.watch_created_at)));
}

function windowKey(now, frequency) {
  if (frequency === 'daily') return `scheduled:daily:${now.toISOString().slice(0, 10)}`;
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return `scheduled:weekly:${monday.toISOString().slice(0, 10)}`;
}

/** Shared by API and scheduled digests; the same reviewed event version is queued once. */
export function findUnrecordedEvents(db, userId, events) {
  const existing = db.prepare(`SELECT 1 FROM worker_digest_versions v JOIN digests d ON d.id=v.digest_id
    WHERE d.user_id=? AND v.event_id=? AND v.version=? LIMIT 1`);
  return events.filter(event => !existing.get(userId, event.id, event.reviewed_at || event.observed_at));
}

export function recordDigestVersions(db, digestId, events) {
  const insert = db.prepare('INSERT OR IGNORE INTO worker_digest_versions(digest_id,event_id,version) VALUES(?,?,?)');
  for (const event of events) insert.run(digestId, event.id, event.reviewed_at || event.observed_at);
}

/** Scheduling creates no empty digest and never uses account login as email consent. */
export function prepareOutbox(db, { now = new Date() } = {}) {
  return transaction(db, () => {
    let created = 0;
    const users = db.prepare('SELECT * FROM users WHERE email_opt_in=1 AND email IS NOT NULL').all();
    for (const user of users) {
      for (const frequency of ['daily', 'weekly']) {
        const key = windowKey(now, frequency);
        if (db.prepare('SELECT 1 FROM digests WHERE user_id=? AND window_key=?').get(user.id, key)) continue;
        const events = findUnrecordedEvents(db, user.id, eligibleEvents(db, user.id, { frequency }));
        if (!events.length) continue;
        events.sort((a, b) => a.id.localeCompare(b.id));
        const version = hash(events.map(e => `${e.id}:${e.reviewed_at || e.observed_at}`).join('|'));
        const digestId = `digest:${hash(`${user.id}:${key}:${version}`)}`;
        const outboxId = `outbox:${hash(digestId)}`;
        db.prepare('INSERT INTO digests(id,user_id,title,created_at,status,is_demo,window_key) VALUES(?,?,?,?,?,?,?)')
          .run(digestId, user.id, `你关注的 ${events.length} 条已核查变化`, now.toISOString(), 'ready', user.is_demo, key);
        for (const event of events) {
          db.prepare('INSERT INTO digest_events(digest_id,event_id) VALUES(?,?)').run(digestId, event.id);
        }
        recordDigestVersions(db, digestId, events);
        db.prepare('INSERT INTO outbox(id,user_id,digest_id,status,idempotency_key,created_at) VALUES(?,?,?,?,?,?)')
          .run(outboxId, user.id, digestId, 'queued', `digest:${digestId}:version:${version}`, now.toISOString());
        created++;
      }
    }
    return created;
  });
}

function cleanEmail(value) {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value)) throw new Error('Invalid email address');
  return value;
}

export function buildEmail({ user, digest, events, evidence, baseUrl, from = 'radar@localhost.invalid', idempotencyKey }) {
  const origin = new URL(baseUrl);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash) throw new Error('Invalid public base URL');
  const unsubscribe = new URL('/api/v1/unsubscribe', origin); unsubscribe.searchParams.set('token', user.unsubscribe_token);
  const lines = [...(digest.is_demo ? ['【演示邮件预览】以下为演示资料，未经真实采集或核验。', ''] : []), digest.title, `整理时间：${digest.created_at}`, '', ...events.flatMap(event => [event.title,
    `来源发布时间：${event.published_at || '未知'}；平台观察时间：${event.observed_at}`,
    event.summary, ...evidence.filter(e => e.event_id === event.id).map(e => `来源：${e.source_name} ${e.url}`),
    `站内详情：${new URL(`/#entity/${encodeURIComponent(event.entity_id)}`, origin).href}`, '']),
    '本摘要只包含已核查的变化。来源覆盖可能不完整。', `取消邮件订阅：${unsubscribe.href}`];
  const body = lines.join('\n');
  const headers = [`From: ${cleanEmail(from)}`, `To: ${cleanEmail(user.email)}`,
    `Subject: =?UTF-8?B?${Buffer.from(digest.title).toString('base64')}?=`,
    `Date: ${new Date(digest.created_at).toUTCString()}`, `Message-ID: <${hash(idempotencyKey)}@open-product-radar.invalid>`,
    `List-Unsubscribe: <${unsubscribe.href}>`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64'];
  const encoded = Buffer.from(body).toString('base64').match(/.{1,76}/g)?.join('\r\n') || '';
  return { from, to: user.email, subject: digest.title, text: body, raw: `${headers.join('\r\n')}\r\n\r\n${encoded}\r\n` };
}

function claimDelivery(db, now, workerId) {
  return transaction(db, () => {
    const item = db.prepare(`SELECT o.* FROM outbox o LEFT JOIN worker_delivery_state s ON s.outbox_id=o.id
      WHERE o.status='queued' AND (s.lease_until IS NULL OR s.lease_until<=?) ORDER BY o.created_at,o.id LIMIT 1`).get(now.toISOString());
    if (!item) return null;
    db.prepare(`INSERT INTO worker_delivery_state(outbox_id,lease_owner,lease_until,attempts) VALUES(?,?,?,1)
      ON CONFLICT(outbox_id) DO UPDATE SET lease_owner=excluded.lease_owner,lease_until=excluded.lease_until,attempts=worker_delivery_state.attempts+1`)
      .run(item.id, workerId, new Date(now.getTime() + 120_000).toISOString());
    return item;
  });
}

/** A network failure after sending is uncertain and is never blindly retried. */
export async function processOutbox(db, { now = () => Date.now(), mode = 'preview', previewDirectory = 'data/mail-preview', baseUrl = 'http://127.0.0.1:4188', from = 'radar@localhost.invalid', transport = null, allowExternalDelivery = false, limit = 20 } = {}) {
  if (!['preview', 'external', 'outbox'].includes(mode)) throw new Error('Unsupported delivery mode');
  if (mode === 'external' && (!allowExternalDelivery || typeof transport?.send !== 'function')) throw new Error('External email requires explicit delivery configuration');
  if (mode === 'external' && db.prepare("SELECT value FROM database_meta WHERE key='mode'").get()?.value !== 'production') throw new Error('Demo databases cannot send external email');
  if (mode === 'outbox') return [];
  db.prepare(`UPDATE outbox SET status='uncertain',last_error='投递进程中断，需核对供应商回执后人工处理'
    WHERE status='sending' AND id IN (SELECT outbox_id FROM worker_delivery_state WHERE lease_until<=?)`).run(new Date(now()).toISOString());
  const results = [], workerId = randomUUID();
  for (let i = 0; i < limit; i++) {
    const item = claimDelivery(db, new Date(now()), workerId);
    if (!item) break;
    let sending = false;
    try {
      const user = db.prepare('SELECT * FROM users WHERE id=?').get(item.user_id);
      const digest = db.prepare('SELECT * FROM digests WHERE id=? AND user_id=?').get(item.digest_id, item.user_id);
      const allowed = new Set(user ? eligibleEvents(db, user.id, { sinceRead: false }).map(event => event.id) : []);
      const events = db.prepare('SELECT e.*,v.version AS prepared_version FROM events e JOIN digest_events de ON de.event_id=e.id LEFT JOIN worker_digest_versions v ON v.digest_id=de.digest_id AND v.event_id=e.id WHERE de.digest_id=? ORDER BY e.observed_at,e.id').all(item.digest_id)
        .filter(e => allowed.has(e.id) && (!e.prepared_version || e.prepared_version === (e.reviewed_at || e.observed_at)));
      if (!user?.email_opt_in || !user.email || !digest || !events.length) {
        db.prepare("UPDATE outbox SET status='cancelled',last_error=? WHERE id=?").run('退订、关注已停止或没有仍可投递的已核查变化', item.id);
        results.push({ id: item.id, status: 'cancelled' }); continue;
      }
      const permissions = db.prepare("SELECT value FROM database_meta WHERE key='mode'").get()?.value === 'demo' ? "('approved','permitted','demo')" : "('approved','permitted')";
      const evidence = db.prepare(`SELECT ev.*,ee.event_id FROM evidence ev JOIN sources s ON s.id=ev.source_id JOIN event_evidence ee ON ee.evidence_id=ev.id JOIN digest_events de ON de.event_id=ee.event_id
        WHERE de.digest_id=? AND ev.review_status IN ${published} AND ev.permission_status IN ${permissions}
        AND s.status IN ('active','approved') AND s.permission_status IN ${permissions}`).all(digest.id);
      const message = buildEmail({ user, digest, events, evidence, baseUrl, from, idempotencyKey: item.idempotency_key });
      // Final read is synchronous immediately before side effects; queued mail cannot bypass opt-out.
      if (!db.prepare('SELECT email_opt_in FROM users WHERE id=?').get(item.user_id)?.email_opt_in || db.prepare('SELECT status FROM outbox WHERE id=?').get(item.id)?.status !== 'queued') {
        db.prepare("UPDATE outbox SET status='cancelled' WHERE id=?").run(item.id); results.push({ id: item.id, status: 'cancelled' }); continue;
      }
      if (mode === 'preview') {
        const result = transaction(db, () => {
          // Keep privacy deletion from racing between the final check, file creation and saved path.
          if (!db.prepare('SELECT email_opt_in FROM users WHERE id=?').get(item.user_id)?.email_opt_in || db.prepare('SELECT status FROM outbox WHERE id=?').get(item.id)?.status !== 'queued') {
            db.prepare("UPDATE outbox SET status='cancelled' WHERE id=?").run(item.id); return { id: item.id, status: 'cancelled' };
          }
          mkdirSync(previewDirectory, { recursive: true });
          const path = resolve(previewDirectory, `${hash(item.idempotency_key)}.eml`);
          try { writeFileSync(path, message.raw, { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
          db.prepare("UPDATE outbox SET status='previewed',last_error=NULL WHERE id=?").run(item.id);
          db.prepare('UPDATE worker_delivery_state SET preview_path=?,completed_at=? WHERE outbox_id=?').run(path, new Date(now()).toISOString(), item.id);
          return { id: item.id, status: 'previewed', path };
        });
        results.push(result);
      } else {
        db.prepare("UPDATE outbox SET status='sending',last_error=NULL WHERE id=?").run(item.id);
        sending = true;
        const response = await transport.send(message, { idempotencyKey: item.idempotency_key });
        db.prepare("UPDATE outbox SET status='sent',last_error=NULL WHERE id=?").run(item.id);
        db.prepare('UPDATE worker_delivery_state SET provider_id=?,completed_at=? WHERE outbox_id=?').run(String(response?.id || ''), new Date(now()).toISOString(), item.id);
        results.push({ id: item.id, status: 'sent' });
      }
    } catch {
      const status = sending ? 'uncertain' : 'failed';
      db.prepare('UPDATE outbox SET status=?,last_error=? WHERE id=?').run(status, sending ? '供应商投递结果不确定，人工核对后再处理，禁止盲目重发' : '邮件准备失败，请核查配置与内容', item.id);
      results.push({ id: item.id, status });
    } finally {
      db.prepare('UPDATE worker_delivery_state SET lease_owner=NULL,lease_until=NULL WHERE outbox_id=? AND lease_owner=?').run(item.id, workerId);
    }
  }
  return results;
}

export function createResendTransport({ apiKey, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error('RADAR_RESEND_API_KEY is required');
  return { async send(message, { idempotencyKey }) {
    const response = await fetchImpl('https://api.resend.com/emails', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ from: message.from, to: [message.to], subject: message.subject, text: message.text }) });
    if (!response.ok) throw new Error('Email provider did not acknowledge delivery');
    const result = await response.json();
    if (typeof result.id !== 'string' || !result.id) throw new Error('Email provider returned no receipt');
    return { id: result.id };
  } };
}
