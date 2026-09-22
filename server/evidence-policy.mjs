const PERMISSIONS = new Set(['approved', 'permitted', 'demo']);
const LINK_TABLES = new Map([['event_evidence','event_id'],['assertion_evidence','assertion_id'],['edition_evidence','edition_id'],['relation_evidence','relation_id']]);

/** A statement can use all of its citations or none. Dropping one invalid
 * citation does not make a multi-source statement safe to keep publishing. */
export function evidenceSet(db, table, key, itemId, {allowPending=false,requireCurrentPermission=false}={}) {
  if(LINK_TABLES.get(table)!==key)throw new Error('Invalid evidence link table');
  const rows=db.prepare(`SELECT e.id,e.review_status,e.permission_status,s.id source_id,s.status source_status,s.permission_status source_permission
    FROM ${table} link LEFT JOIN evidence e ON e.id=link.evidence_id LEFT JOIN sources s ON s.id=e.source_id WHERE link.${key}=?`).all(itemId);
  const valid=rows.length>0&&rows.every(e=>e.id&&e.source_id&&['published',...(allowPending?['pending']:[])].includes(e.review_status)&&PERMISSIONS.has(e.permission_status)
    &&!['blocked','revoked'].includes(e.source_status)&&(!requireCurrentPermission||PERMISSIONS.has(e.source_permission)));
  return {valid,total:rows.length,ids:valid?rows.map(e=>e.id):[]};
}

export function metadataBlockedSQL(entityAlias='entities') {
  return `EXISTS(SELECT 1 FROM entity_evidence metadata_link JOIN evidence metadata_evidence ON metadata_evidence.id=metadata_link.evidence_id
    LEFT JOIN sources metadata_source ON metadata_source.id=metadata_evidence.source_id WHERE metadata_link.entity_id=${entityAlias}.id
    AND (metadata_source.id IS NULL OR metadata_source.status IN ('blocked','revoked') OR metadata_evidence.review_status IN ('deleted','rejected','retracted')))`;
}

export function visibleEventSQL(alias='events', {pending=false}={}) {
  return `${alias}.review_status='${pending?'pending':'published'}'
    AND EXISTS(SELECT 1 FROM entities event_entity WHERE event_entity.id=${alias}.entity_id AND event_entity.review_status='published')
    AND EXISTS(SELECT 1 FROM event_evidence required_link WHERE required_link.event_id=${alias}.id)
    AND NOT EXISTS(SELECT 1 FROM event_evidence visibility_link LEFT JOIN evidence visibility_evidence ON visibility_evidence.id=visibility_link.evidence_id
      LEFT JOIN sources visibility_source ON visibility_source.id=visibility_evidence.source_id WHERE visibility_link.event_id=${alias}.id
      AND (visibility_evidence.id IS NULL OR visibility_source.id IS NULL
        OR visibility_evidence.review_status NOT IN (${pending?"'pending','published'":"'published'"})
        OR visibility_evidence.permission_status NOT IN ('approved','permitted','demo') OR visibility_source.status IN ('blocked','revoked')))`;
}

export function getContentStatus(db, entityId=null) {
  const where=entityId?' AND events.entity_id=?':'',params=entityId?[entityId]:[];
  return {
    published_events:db.prepare(`SELECT count(*) n FROM events WHERE ${visibleEventSQL()}${where}`).get(...params).n,
    pending_events:db.prepare(`SELECT count(*) n FROM events WHERE ${visibleEventSQL('events',{pending:true})}${where}`).get(...params).n,
    pending_release_events:db.prepare(`SELECT count(*) n FROM events WHERE ${visibleEventSQL('events',{pending:true})} AND type='release'${where}`).get(...params).n,
  };
}
