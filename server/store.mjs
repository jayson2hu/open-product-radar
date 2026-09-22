import { createHash } from 'node:crypto';
import { json, transaction, now } from './db.mjs';
import { calculateTrends } from '../workers/trends.mjs';

const liveEvidence = (db, table, key, id) => db.prepare(`SELECT e.id FROM evidence e JOIN ${table} x ON x.evidence_id=e.id LEFT JOIN sources s ON s.id=e.source_id WHERE x.${key}=? AND e.review_status='published' AND e.permission_status IN ('approved','permitted','demo') AND (s.id IS NULL OR s.status!='blocked')`).all(id).map(x=>x.id);
export function getEvent(db, row) {
  if (!row) return null;
  return {...row,is_demo:!!row.is_demo,entity_name:db.prepare('SELECT name FROM entities WHERE id=?').get(row.entity_id)?.name,
    evidence_ids:liveEvidence(db,'event_evidence','event_id',row.id)};
}
export function getRelations(db, id, includePending=false) {
  return db.prepare(`SELECT r.*,target.name AS name,target.name AS target_name,target.kind AS target_kind,source.name AS source_name,source.kind AS source_kind FROM relations r JOIN entities target ON target.id=r.target_entity_id JOIN entities source ON source.id=r.entity_id WHERE (r.entity_id=? OR r.target_entity_id=?) ${includePending?'':"AND r.status='confirmed'"}`).all(id,id).map(row=>({...row,related_entity_id:row.entity_id===id?row.target_entity_id:row.entity_id,related_name:row.entity_id===id?row.target_name:row.source_name,related_kind:row.entity_id===id?row.target_kind:row.source_kind,direction:row.entity_id===id?'outgoing':'incoming',evidence_ids:liveEvidence(db,'relation_evidence','relation_id',row.id)})).filter(r=>includePending||r.evidence_ids.length);
}
export function getEntity(db, id, {details=true,includePending=false}={}) {
  const row = db.prepare(`SELECT * FROM entities WHERE id=? ${includePending?'':"AND review_status='published'"}`).get(id);
  if(!row) return null;
  if(!includePending&&db.prepare("SELECT 1 FROM entity_evidence ee JOIN evidence ev ON ev.id=ee.evidence_id JOIN sources s ON s.id=ev.source_id WHERE ee.entity_id=? AND s.status='blocked' LIMIT 1").get(id)){
    row.description='来源权限已撤销，介绍暂不展示';row.original_description=null;row.extra_json='{}';
  }
  const extra=json(row.extra_json,{}); delete row.extra_json;
  const entity={...row,...extra,is_demo:!!row.is_demo,featured:!!row.featured,tags:extra.tags||[]};
  if(!details) return entity;
  entity.editions=db.prepare("SELECT * FROM editions WHERE entity_id=? AND review_status='published'").all(id).map(e=>({...e,evidence_ids:liveEvidence(db,'edition_evidence','edition_id',e.id)})).filter(e=>e.evidence_ids.length);
  entity.assertions=db.prepare("SELECT * FROM assertions WHERE entity_id=? AND review_status='published'").all(id).map(a=>{
    const evidence_ids=liveEvidence(db,'assertion_evidence','assertion_id',a.id);
    return {...a,...(a.status!=='unknown'&&!evidence_ids.length?{status:'unknown',value:'缺少有效证据',scope:'原判断已暂停展示'}:{}),evidence_ids};
  });
  entity.relations=getRelations(db,id,includePending);
  entity.events=db.prepare(`SELECT * FROM events WHERE entity_id=? ${includePending?'':"AND review_status='published'"} ORDER BY observed_at DESC`).all(id).map(e=>getEvent(db,e)).filter(e=>includePending||e.evidence_ids.length);
  entity.snapshots=db.prepare('SELECT stars,observed_at,source_id,metric_version,scope FROM snapshots WHERE entity_id=? ORDER BY observed_at ASC LIMIT 200').all(id);
  return entity;
}

/** Persist official public metadata and pending events, never model-derived claims. */
export function applyCollection(db, result) {
  const mode=db.prepare("SELECT value FROM database_meta WHERE key='mode'").get()?.value;
  if(mode!=='production') throw new Error('Real collection requires an isolated production database');
  const source=db.prepare("SELECT * FROM sources WHERE id='github'").get();
  if(!['active','approved'].includes(source?.status)||!['approved','permitted'].includes(source?.permission_status)) throw new Error('GitHub source is not approved');
  if(result.unchanged&&!result.repository) return {unchanged:true};
  const repo=result.repository;
  if(!repo?.id||repo.is_demo) throw new Error('Collection requires non-demo stable repository identity');
  const blockedEvidence=new Set((result.evidence||[]).filter(e=>{
    const contentHash=e.content_hash||createHash('sha256').update(e.excerpt||'').digest('hex');
    const urlHash=createHash('sha256').update(e.url||'').digest('hex');
    return db.prepare('SELECT 1 FROM deletion_tombstones WHERE evidence_id=? OR content_hash=? OR url=?').get(e.id,contentHash,urlHash);
  }).map(e=>e.id));
  if([...blockedEvidence].some(eid=>eid.startsWith('gh:repo:'))){const error=new Error('Repository metadata is subject to a source deletion; reimport is blocked');error.code='DELETED_SOURCE';throw error;}
  return transaction(db,()=>{
    const existing=db.prepare('SELECT first_seen_at FROM entities WHERE id=?').get(repo.id);
    db.prepare(`INSERT INTO entities(id,kind,name,owner,slug,description,original_description,topic,language,license,website,repository_url,docs_url,stars,delta_24h,delta_7d,trend_status,observed_at,first_seen_at,created_at,is_demo,featured,review_status,extra_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,owner=excluded.owner,slug=excluded.slug,description=excluded.description,original_description=excluded.original_description,language=excluded.language,license=excluded.license,website=excluded.website,repository_url=excluded.repository_url,stars=excluded.stars,observed_at=excluded.observed_at,extra_json=excluded.extra_json`)
      .run(repo.id,'repository',repo.name,repo.owner||null,repo.slug||repo.full_name||repo.id,repo.description||'',repo.original_description||repo.description||'',repo.topic||'浏览器自动化',repo.language||null,repo.license||null,repo.website||null,repo.repository_url||repo.html_url||null,repo.docs_url||null,repo.stars??result.snapshot?.stars??null,null,null,'insufficient',repo.observed_at||now(),existing?.first_seen_at||repo.first_seen_at||now(),repo.created_at||null,0,0,'published',JSON.stringify({tags:repo.tags||[],archived:!!repo.archived}));
    let savedEvidence=0;
    for(const e of result.evidence||[]) {
      const hash=e.content_hash||createHash('sha256').update(e.excerpt||'').digest('hex');
      const urlHash=createHash('sha256').update(e.url||'').digest('hex');
      if(db.prepare('SELECT 1 FROM deletion_tombstones WHERE evidence_id=? OR content_hash=? OR url=?').get(e.id,hash,urlHash)) continue;
      db.prepare('INSERT OR IGNORE INTO evidence(id,entity_id,source_id,title,url,excerpt,source_name,published_at,fetched_at,reviewed_at,review_status,is_demo,permission_status,content_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(e.id,repo.id,'github',e.title||repo.name,e.url,e.excerpt||'',e.source_name||'GitHub',e.published_at||null,e.fetched_at||now(),null,'pending',0,'approved',hash);
      if(e.id.startsWith('gh:repo:'))db.prepare('INSERT OR IGNORE INTO entity_evidence(entity_id,evidence_id,field) VALUES(?,?,?)').run(repo.id,e.id,'description');
      savedEvidence++;
    }
    for(const e of result.events||[]) {
      if((e.evidence_ids||[]).some(eid=>blockedEvidence.has(eid)||db.prepare("SELECT 1 FROM evidence WHERE id=? AND review_status='deleted'").get(eid)))continue;
      db.prepare('INSERT OR IGNORE INTO events(id,entity_id,title,summary,type,published_at,observed_at,reviewed_at,review_status,is_demo,dedupe_key) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(e.id,repo.id,e.title,e.summary||'',e.type||'release',e.published_at||null,e.observed_at||now(),null,'pending',0,e.dedupe_key||e.id);
      for(const eid of e.evidence_ids||[]) if(db.prepare("SELECT 1 FROM evidence WHERE id=? AND review_status!='deleted'").get(eid)) db.prepare('INSERT OR IGNORE INTO event_evidence VALUES(?,?)').run(e.id,eid);
    }
    if(result.snapshot) {
      const s=result.snapshot;
      db.prepare('INSERT OR IGNORE INTO snapshots(id,entity_id,stars,observed_at,source_id,metric_version,scope) VALUES(?,?,?,?,?,?,?)').run(s.id,repo.id,s.stars,s.observed_at,'github',s.metric_version||'github.stargazers_count.v1',s.scope||'public');
      const history=db.prepare('SELECT * FROM snapshots WHERE entity_id=? ORDER BY observed_at DESC LIMIT 400').all(repo.id);
      const trends=calculateTrends({...s,entity_id:repo.id},history);
      db.prepare('UPDATE entities SET delta_24h=?,delta_7d=?,trend_status=?,extra_json=? WHERE id=?').run(trends.delta_24h,trends.delta_7d,trends.trend_status,JSON.stringify({tags:repo.tags||[],archived:!!repo.archived,trend_24h:trends.trend_24h,trend_7d:trends.trend_7d}),repo.id);
    }
    db.prepare('UPDATE sources SET last_success_at=?,last_error=NULL WHERE id=?').run(now(),'github');
    return {entity_id:repo.id,evidence:savedEvidence,events:(result.events||[]).length};
  });
}

export function applyTrend(db, entityId, day, week) {
  db.prepare('UPDATE entities SET delta_24h=?,delta_7d=?,trend_status=? WHERE id=?').run(day?.delta??null,week?.delta??null,day?.status||'insufficient',entityId);
}
