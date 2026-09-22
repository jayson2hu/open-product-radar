import { createHash, randomUUID } from 'node:crypto';
import { transaction, now } from './db.mjs';
import { purgePreviewFiles } from '../workers/delivery.mjs';
const hash=value=>createHash('sha256').update(value||'').digest('hex');

/** Also invoked after backup restoration. Tombstones contain no source excerpt. */
export function deleteEvidence(db, evidenceId, reason, actor=null) {
  const evidence=db.prepare('SELECT * FROM evidence WHERE id=?').get(evidenceId);
  if(!evidence)return {found:false};
  return transaction(db,()=>{
    purgePreviewFiles(db,{evidenceId});
    if(evidence.review_status!=='deleted')db.prepare('INSERT INTO deletion_tombstones VALUES(?,?,?,?,?,?)').run(`deletion-${randomUUID()}`,evidenceId,evidence.content_hash||hash(evidence.excerpt),hash(evidence.url),reason,now());
    db.prepare("UPDATE events SET review_status='retracted',title='来源已删除，事件已撤回',summary='依据来源删除要求撤回相关内容。',reviewed_at=? WHERE id IN (SELECT event_id FROM event_evidence WHERE evidence_id=?)").run(now(),evidenceId);
    db.prepare("UPDATE assertions SET status='unknown',value='来源已删除，原判断已撤回',scope='等待新的合法来源证据' WHERE id IN (SELECT assertion_id FROM assertion_evidence WHERE evidence_id=?)").run(evidenceId);
    db.prepare("UPDATE entities SET description='来源已删除，介绍等待重新核查',original_description=NULL,extra_json='{}' WHERE id IN (SELECT entity_id FROM entity_evidence WHERE evidence_id=?)").run(evidenceId);
    db.prepare("UPDATE editions SET review_status='retracted',name='来源已删除',version=NULL,price=NULL WHERE id IN (SELECT edition_id FROM edition_evidence WHERE evidence_id=?)").run(evidenceId);
    db.prepare("UPDATE relations SET status='needs_review',reason='来源已删除，关系需重新审核',reviewed_at=? WHERE id IN (SELECT relation_id FROM relation_evidence WHERE evidence_id=?)").run(now(),evidenceId);
    db.prepare("UPDATE outbox SET status='cancelled',last_error='来源证据已删除' WHERE digest_id IN (SELECT de.digest_id FROM digest_events de JOIN event_evidence ee ON ee.event_id=de.event_id WHERE ee.evidence_id=?) AND status IN ('queued','retry','previewed','sending')").run(evidenceId);
    db.prepare("UPDATE digests SET status='revised' WHERE id IN (SELECT de.digest_id FROM digest_events de JOIN event_evidence ee ON ee.event_id=de.event_id WHERE ee.evidence_id=?)").run(evidenceId);
    db.prepare("UPDATE evidence SET title='已删除',url='',excerpt='',review_status='deleted',reviewed_at=? WHERE id=?").run(now(),evidenceId);
    // Raw HTTP cache may contain the excerpt or full original source. Purge it;
    // the collection adapter consults tombstones before materializing it again.
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='github_http_cache'").get())db.exec('DELETE FROM github_http_cache');
    if(actor)db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?)').run(`audit-${randomUUID()}`,typeof actor==='string'?actor:actor.id,'evidence_deleted',evidenceId,reason,now());
    return {found:true,evidence_id:evidenceId};
  });
}

export function deleteAccount(db, userId) {
  return transaction(db,()=>{
    purgePreviewFiles(db,{userId});
    // An opaque account id is sufficient for reapplying deletions after restore.
    db.prepare('INSERT OR IGNORE INTO account_deletions VALUES(?,?,?)').run(userId,null,now());
    db.prepare('DELETE FROM analytics WHERE user_id=?').run(userId);
    db.prepare('DELETE FROM corrections WHERE user_id=?').run(userId);
    db.prepare('DELETE FROM users WHERE id=?').run(userId);
  });
}
