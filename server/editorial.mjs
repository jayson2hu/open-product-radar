import { randomUUID, createHash } from 'node:crypto';
import { now, transaction } from './db.mjs';
import { getEntity, getEvent } from './store.mjs';

export function createEditorialRoutes({db,mode,audit,body,fail,textField,enumField,numField,safeURL,needAdmin,entityExists}) {
  const eid=prefix=>`${prefix}-${randomUUID()}`;
  const eventTypes=['release','capability','pricing','deployment','issue','discovery','correction'];
  function refs(value,{published=false,required=true}={}) {
    if(!Array.isArray(value)||value.length>20||(required&&!value.length)||new Set(value).size!==value.length||value.some(v=>typeof v!=='string'||v.length>250))fail(400,'VALIDATION','请提供不重复的证据 ID（最多 20 项）');
    for(const valueId of value){const e=db.prepare('SELECT e.*,s.status source_status FROM evidence e LEFT JOIN sources s ON s.id=e.source_id WHERE e.id=?').get(valueId);if(!e||['deleted','rejected','retracted'].includes(e.review_status)||e.source_status==='blocked')fail(409,'EVIDENCE_REQUIRED','证据不存在、来源被禁用或已撤回');if(published&&e.review_status!=='published')fail(409,'EVIDENCE_REQUIRED','事实判断必须引用已经审核的证据');}
    return value;
  }
  function links(table,key,itemId,ids){for(const value of ids)db.prepare(`INSERT INTO ${table}(${key},evidence_id) VALUES(?,?)`).run(itemId,value);}
  return async function editorial({path,method,req,user,reply}) {
    if(method==='POST'&&path==='/admin/sources'){
      needAdmin(user);const b=await body(req),sid=textField(b.id,'来源 ID',{max:80,fallback:eid('source')});if(!/^[a-zA-Z0-9:_-]+$/.test(sid))fail(400,'VALIDATION','来源 ID 只能包含字母、数字、冒号、下划线和短横线');if(db.prepare('SELECT 1 FROM sources WHERE id=?').get(sid))fail(409,'ALREADY_EXISTS','来源 ID 已存在');
      db.prepare('INSERT INTO sources(id,name,url,status,permission_status,collection_method,retention_days,reason,terms_url) VALUES(?,?,?,?,?,?,?,?,?)').run(sid,textField(b.name,'来源名称',{required:true,max:160}),safeURL(b.url,{optional:false}),'paused','pending',enumField(b.collection_method,['public_api','official_page','manual','rss'],'采集方式','manual'),numField(b.retention_days,'保留天数',{min:1,max:3650,integer:true,fallback:90}),textField(b.reason,'权限与用途说明',{required:true,max:4000}),safeURL(b.terms_url));audit(user,'source_created',sid,'新来源待权限审核');reply(db.prepare('SELECT * FROM sources WHERE id=?').get(sid),201);return true;
    }
    if(method==='POST'&&path==='/admin/entities'){
      const b=await body(req),entityId=eid('entity'),kind=enumField(b.kind,['repository','product'],'对象类型');const name=textField(b.name,'名称',{required:true,max:160}),slug=textField(b.slug,'标识',{max:160,fallback:entityId});
      if(!/^[a-zA-Z0-9:_-]+$/.test(slug))fail(400,'VALIDATION','标识只能包含字母、数字、冒号、下划线和短横线');if(db.prepare('SELECT 1 FROM entities WHERE slug=?').get(slug))fail(409,'ALREADY_EXISTS','对象标识已存在');
      const description=textField(b.description,'介绍',{required:true,max:6000}),stamp=now();
      db.prepare('INSERT INTO entities(id,kind,name,owner,slug,description,original_description,topic,language,license,website,repository_url,docs_url,trend_status,observed_at,first_seen_at,created_at,is_demo,review_status,extra_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(entityId,kind,name,textField(b.owner,'维护方',{max:160,fallback:null}),slug,description,textField(b.original_description,'原文介绍',{max:6000,fallback:description}),textField(b.topic,'主题',{required:true,max:100}),textField(b.language,'语言',{max:100,fallback:null}),textField(b.license,'许可证',{max:200,fallback:null}),safeURL(b.website),safeURL(b.repository_url),safeURL(b.docs_url),'insufficient',stamp,stamp,null,mode==='demo'?1:0,'published',JSON.stringify({tags:[],editorial:true}));
      audit(user,'entity_created',entityId,'编辑录入基础资料；版本、事实判断和事件需单独附证据');reply(getEntity(db,entityId),201);return true;
    }
    if(method==='POST'&&path==='/admin/evidence'){
      const b=await body(req),entity=entityExists(b.entity_id),source=db.prepare('SELECT * FROM sources WHERE id=?').get(textField(b.source_id,'来源',{required:true,max:100}));if(!source)fail(404,'NOT_FOUND','请先创建来源记录');if(source.status==='blocked')fail(409,'SOURCE_BLOCKED','该来源已被禁用');
      const evidenceId=eid('evidence'),excerpt=textField(b.excerpt,'原文摘录',{required:true,max:12000}),url=safeURL(b.url,{optional:false});const published=b.published_at?textField(b.published_at,'来源发布时间',{max:40}):null;if(published&&!Number.isFinite(Date.parse(published)))fail(400,'VALIDATION','发布时间格式无效');
      const contentHash=createHash('sha256').update(excerpt).digest('hex'),urlHash=createHash('sha256').update(url).digest('hex');if(db.prepare('SELECT 1 FROM deletion_tombstones WHERE content_hash=? OR url=?').get(contentHash,urlHash))fail(409,'SOURCE_DELETED','该来源内容存在删除记录，禁止重新导入');
      db.prepare('INSERT INTO evidence(id,entity_id,source_id,title,url,excerpt,source_name,published_at,fetched_at,review_status,is_demo,permission_status,content_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(evidenceId,entity.id,source.id,textField(b.title,'证据标题',{required:true,max:240}),url,excerpt,source.name,published?new Date(published).toISOString():null,now(),'pending',mode==='demo'?1:0,source.permission_status,contentHash);audit(user,'evidence_created',evidenceId,'原文摘录待审核');reply(db.prepare('SELECT * FROM evidence WHERE id=?').get(evidenceId),201);return true;
    }
    let match;
    if(method==='POST'&&(match=path.match(/^\/admin\/evidence\/([^/]+)\/review$/))){
      const evidenceId=decodeURIComponent(match[1]),e=db.prepare('SELECT * FROM evidence WHERE id=?').get(evidenceId);if(!e||e.review_status==='deleted')fail(404,'NOT_FOUND','证据不存在或已删除');const b=await body(req),status=enumField(b.status,['published','rejected'],'审核状态'),reason=textField(b.reason,'审核理由',{required:true,max:2000});const source=db.prepare('SELECT * FROM sources WHERE id=?').get(e.source_id);if(status==='published'&&(!['approved','permitted','demo'].includes(source?.permission_status)||source.status==='blocked'))fail(409,'SOURCE_PERMISSION','请先核对并批准来源权限');db.prepare('UPDATE evidence SET review_status=?,permission_status=?,reviewed_at=? WHERE id=?').run(status,source?.permission_status||'pending',now(),evidenceId);audit(user,'evidence_review',evidenceId,reason);reply(db.prepare('SELECT * FROM evidence WHERE id=?').get(evidenceId));return true;
    }
    if(method==='POST'&&path==='/admin/events'){
      const b=await body(req),entity=entityExists(b.entity_id),evidenceIds=refs(b.evidence_ids),eventId=eid('event');const published=b.published_at?textField(b.published_at,'来源发布时间',{max:40}):null;if(published&&!Number.isFinite(Date.parse(published)))fail(400,'VALIDATION','发布时间格式无效');
      transaction(db,()=>{db.prepare('INSERT INTO events(id,entity_id,title,summary,type,published_at,observed_at,review_status,is_demo,dedupe_key) VALUES(?,?,?,?,?,?,?,?,?,?)').run(eventId,entity.id,textField(b.title,'标题',{required:true,max:240}),textField(b.summary,'摘要',{required:true,max:6000}),enumField(b.type,eventTypes,'事件类型'),published?new Date(published).toISOString():null,now(),'pending',mode==='demo'?1:0,eventId);links('event_evidence','event_id',eventId,evidenceIds);audit(user,'event_created',eventId,'事件草稿待审核');});reply({...getEvent(db,db.prepare('SELECT * FROM events WHERE id=?').get(eventId)),evidence_ids:evidenceIds},201);return true;
    }
    if(method==='POST'&&path==='/admin/assertions'){
      const b=await body(req),entity=entityExists(b.entity_id),assertionId=eid('assertion'),status=enumField(b.status,['supported','limited','unsupported','unknown'],'能力状态'),evidenceIds=refs(b.evidence_ids??[],{published:true,required:status!=='unknown'});
      transaction(db,()=>{db.prepare('INSERT INTO assertions(id,entity_id,dimension,label,status,value,scope,review_status) VALUES(?,?,?,?,?,?,?,?)').run(assertionId,entity.id,textField(b.dimension,'比较维度 ID',{required:true,max:100}),textField(b.label,'维度名称',{required:true,max:160}),status,textField(b.value,'事实或限制',{required:true,max:6000}),textField(b.scope,'版本、套餐与适用条件',{required:true,max:3000}),'published');links('assertion_evidence','assertion_id',assertionId,evidenceIds);audit(user,'assertion_created',assertionId,'编辑创建附证据的范围化判断');});reply({...db.prepare('SELECT * FROM assertions WHERE id=?').get(assertionId),evidence_ids:evidenceIds},201);return true;
    }
    if(method==='POST'&&path==='/admin/editions'){
      const b=await body(req),entity=entityExists(b.entity_id),editionId=eid('edition'),evidenceIds=refs(b.evidence_ids,{published:true});const price=b.price==null?null:numField(b.price,'价格'),currency=price===null?null:enumField(b.currency,['CNY','USD','EUR','GBP','JPY'],'币种'),billing=price===null?null:enumField(b.billing_period,['one_time','month','year','usage','free'],'计费周期');
      transaction(db,()=>{db.prepare('INSERT INTO editions(id,entity_id,name,deployment,price,currency,billing_period,version) VALUES(?,?,?,?,?,?,?,?)').run(editionId,entity.id,textField(b.name,'版本或套餐名称',{required:true,max:200}),enumField(b.deployment,['self_hosted','cloud','hybrid','unknown'],'部署方式'),price,currency,billing,textField(b.version,'适用发行版本或套餐版本',{required:true,max:200}));links('edition_evidence','edition_id',editionId,evidenceIds);audit(user,'edition_created',editionId,'附来源的版本与套餐记录');});reply({...db.prepare('SELECT * FROM editions WHERE id=?').get(editionId),evidence_ids:evidenceIds},201);return true;
    }
    if(method==='POST'&&path==='/admin/relations'){
      const b=await body(req),entity=entityExists(b.entity_id),target=entityExists(b.target_entity_id);if(entity.id===target.id)fail(400,'VALIDATION','关系必须连接两个不同对象');const relationId=eid('relation'),evidenceIds=refs(b.evidence_ids??[],{required:false});
      transaction(db,()=>{db.prepare('INSERT INTO relations(id,entity_id,target_entity_id,type,status,reason) VALUES(?,?,?,?,?,?)').run(relationId,entity.id,target.id,enumField(b.type,['developed_by','official_product','compatible_with','hosted_version','alternative','candidate'],'关系类型'),'needs_review',textField(b.reason,'关系说明',{max:2000}));links('relation_evidence','relation_id',relationId,evidenceIds);audit(user,'relation_created',relationId,'候选关系等待证据审核');});reply({...db.prepare('SELECT * FROM relations WHERE id=?').get(relationId),evidence_ids:evidenceIds},201);return true;
    }
    return false;
  };
}
