import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.mjs';
import { getCollectionStatus } from '../server/collection-status.mjs';
import { initializeWorkerSchema } from '../workers/jobs.mjs';
import { createApp } from '../server/index.mjs';

const NOW='2026-09-22T10:00:00.000Z';
function setup(t){const db=openDatabase({dbPath:':memory:',mode:'production'});initializeWorkerSchema(db);t.after(()=>db.close());return db;}
function addRepository(db,slug){
  const entityId=`entity:${slug}`;
  db.prepare("INSERT INTO entities(id,kind,name,slug,description,topic,stars,observed_at,first_seen_at,is_demo) VALUES(?,'repository',?,?,?,'浏览器自动化',100,?,?,0)").run(entityId,slug,slug,'已有来源资料',NOW,NOW);
  db.prepare("INSERT INTO snapshots(id,entity_id,stars,observed_at,source_id) VALUES(?,?,100,?,'github')").run(`snapshot:${slug}`,entityId,NOW);
}
function addJob(db,slug,status,{bucket=82873,at='2026-09-22T09:00:00.000Z',next=null,error=null,id}={}){
  const [owner,repo]=slug.split('/');const jobId=id||`github:${slug.toLowerCase()}:${bucket}`;
  db.prepare("INSERT INTO jobs(id,source_id,type,status,attempts,last_run_at,next_run_at,last_error,payload_json) VALUES(?,'github','github_repository',?,1,?,?,?,?)").run(jobId,status,at,next,error,JSON.stringify({owner,repo}));return jobId;
}
function seedPartial(db){
  db.prepare("UPDATE sources SET status='paused',permission_status='pending',last_success_at=?,last_error='TIMEOUT: 来源请求超时' WHERE id='github'").run(NOW);
  for(let index=0;index<7;index++){const slug=`owner/repo-${index}`;addRepository(db,slug);addJob(db,slug,'completed');}
  addJob(db,'browserbase/stagehand','retry',{error:'TIMEOUT: 来源请求超时',next:'2026-09-22T10:30:00.000Z'});
}

test('one failed repository is reported as partial failure and paused source keeps successful data',t=>{
  const db=setup(t);seedPartial(db);const result=getCollectionStatus(db,{now:NOW}),source=result.sources[0];
  assert.equal(result.status,'partial_failure');assert.deepEqual(source.counts,{total:8,success:7,failed:1,pending:0,running:0,pending_retry:1});
  assert.match(source.result_summary,/7个成功，1个失败/);assert.match(source.result_summary,/browserbase\/stagehand：请求超时/);
  assert.equal(source.schedule_status,'disabled');assert.equal(source.worker_status,'unconfirmed');assert.equal(source.schedule_summary,'持续采集未启用');
  assert.equal(source.retained_entities,7);assert.equal(result.data_source_count,1);assert.equal(result.warnings.length,1);
  assert.doesNotMatch(source.result_summary,/全部仓库/);assert.doesNotMatch(result.summary,/正在采集|正在运行|自动重试/);
});

test('a successful retry overrides stale source and parent errors without changing the database',t=>{
  const db=setup(t);seedPartial(db);addRepository(db,'browserbase/stagehand');
  db.prepare("UPDATE jobs SET status='completed',last_run_at=?,last_error=NULL,next_run_at=NULL WHERE id='github:browserbase/stagehand:82873'").run(NOW);
  db.prepare("UPDATE jobs SET status='failed',last_error='TIMEOUT' WHERE id='github-collect'").run();
  const before=db.prepare("SELECT last_error FROM sources WHERE id='github'").get().last_error;
  const result=getCollectionStatus(db,{now:NOW});assert.equal(result.status,'completed');assert.equal(result.counts.success,8);assert.equal(result.counts.failed,0);
  assert.deepEqual(result.warnings,[]);assert.equal(result.data_source_count,1);assert.match(result.summary,/8个成功/);assert.match(result.summary,/持续采集未启用/);assert.doesNotMatch(result.summary,/失败|TIMEOUT/);
  assert.equal(db.prepare("SELECT last_error FROM sources WHERE id='github'").get().last_error,before);
});

test('repository aggregation ignores older failed windows and future retry times',t=>{
  const db=setup(t);addRepository(db,'Owner/Repo');
  addJob(db,'Owner/Repo','retry',{bucket:82872,at:'2026-09-22T08:00:00.000Z',next:'2026-10-01T00:00:00.000Z',error:'TIMEOUT: old failure'});
  addJob(db,'owner/repo','completed',{bucket:82873});
  let result=getCollectionStatus(db,{now:NOW});assert.equal(result.counts.total,1);assert.equal(result.counts.success,1);assert.equal(result.counts.failed,0);assert.deepEqual(result.warnings,[]);
  addJob(db,'OWNER/REPO','queued',{bucket:82874,at:null,next:'2026-09-22T12:00:00.000Z'});
  result=getCollectionStatus(db,{now:NOW});assert.equal(result.counts.total,1);assert.equal(result.counts.pending,1);assert.equal(result.counts.failed,0);assert.equal(result.sources[0].worker_status,'unconfirmed');
});

test('all failed repositories are distinct from mixed success, failure and pending work',t=>{
  const db=setup(t);addJob(db,'owner/one','failed',{error:'TIMEOUT: expired'});addJob(db,'owner/two','retry',{error:'RATE_LIMITED: limit'});
  let result=getCollectionStatus(db,{now:NOW});assert.equal(result.status,'failed');assert.equal(result.counts.failed,2);assert.match(result.summary,/全部仓库最近一次采集失败/);
  addJob(db,'owner/three','queued',{at:null,next:NOW});result=getCollectionStatus(db,{now:NOW});assert.equal(result.status,'partial_failure');assert.equal(result.counts.pending,1);assert.doesNotMatch(result.summary,/全部仓库/);
});

test('queued and stale running records never imply a live worker; unexpired leases support current execution',t=>{
  const db=setup(t);db.prepare("UPDATE sources SET status='approved',permission_status='approved' WHERE id='github'").run();
  const queued=addJob(db,'owner/queued','queued',{at:null,next:NOW});const expired=addJob(db,'owner/expired','running');const live=addJob(db,'owner/live','running');
  db.prepare('INSERT INTO worker_leases VALUES(?,?,?)').run(expired,'old','2026-09-22T09:59:59.000Z');
  let result=getCollectionStatus(db,{now:NOW});assert.equal(result.counts.running,0);assert.equal(result.counts.pending,3);assert.equal(result.sources[0].worker_status,'unconfirmed');assert.equal(result.sources[0].schedule_status,'unverified');
  db.prepare('INSERT INTO worker_leases VALUES(?,?,?)').run(queued,'queued-lease','2026-09-22T10:01:00.000Z');
  assert.equal(getCollectionStatus(db,{now:NOW}).counts.running,0,'A lease on an unclaimed queued row does not prove execution');
  db.prepare('INSERT INTO worker_leases VALUES(?,?,?)').run(live,'current','2026-09-22T10:01:00.000Z');
  result=getCollectionStatus(db,{now:NOW});assert.equal(result.counts.running,1);assert.equal(result.counts.pending,2);assert.equal(result.sources[0].worker_status,'observed');assert.equal(result.sources[0].schedule_status,'unverified');
  assert.equal(getCollectionStatus(db,{now:'2026-09-22T10:02:00.000Z'}).counts.running,0);
});

test('revoked sources are not counted as available even with past successful repositories',t=>{
  const db=setup(t);seedPartial(db);db.prepare("UPDATE sources SET status='blocked' WHERE id='github'").run();
  const result=getCollectionStatus(db,{now:NOW});assert.equal(result.status,'blocked');assert.equal(result.data_source_count,0);assert.equal(result.sources[0].retained_entities,0);assert.equal(result.sources[0].schedule_status,'blocked');assert.match(result.warnings[0],/来源权限已撤销/);assert.doesNotMatch(result.summary,/保留7个仓库/);
});

test('feed and entity listings expose structured collection facts with accurate source count',async t=>{
  const app=createApp({dbPath:':memory:',mode:'production',logErrors:false});seedPartial(app.db);const address=await app.listen(0);t.after(()=>app.close());
  const base=`http://127.0.0.1:${address.port}/api/v1`;
  let feed=await(await fetch(base+'/feed')).json();assert.equal(feed.stats.sources,1);assert.equal(feed.stats.repositories,7);assert.equal(feed.collection.counts.failed,1);assert.ok(feed.warnings.some(warning=>warning.includes('7个成功，1个失败')));assert.ok(!feed.warnings.some(warning=>warning.includes('最近采集失败')));
  const entities=await(await fetch(base+'/entities')).json();assert.equal(entities.collection.counts.success,7);
  addRepository(app.db,'browserbase/stagehand');app.db.prepare("UPDATE jobs SET status='completed',last_error=NULL WHERE id='github:browserbase/stagehand:82873'").run();
  feed=await(await fetch(base+'/feed')).json();assert.equal(feed.stats.sources,1);assert.equal(feed.collection.counts.success,8);assert.equal(feed.collection.status,'completed');assert.ok(!feed.warnings.some(warning=>warning.includes('失败')||warning.includes('持续采集未启用')));
  app.db.prepare("UPDATE sources SET status='blocked' WHERE id='github'").run();feed=await(await fetch(base+'/feed')).json();assert.equal(feed.stats.sources,0);assert.equal(feed.collection.status,'blocked');
});
