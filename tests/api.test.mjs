import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createApp } from '../server/index.mjs';
import { openDatabase, now } from '../server/db.mjs';
import { applyCollection } from '../server/store.mjs';
import { prepareOutbox } from '../workers/delivery.mjs';
import { refreshPublicProfile } from '../server/auth-profile.mjs';

async function setup(t,options={}) {
  const app=createApp({dbPath:':memory:',logErrors:false,...options});
  const address=await app.listen(0);const origin=`http://127.0.0.1:${address.port}`;
  t.after(()=>app.close());
  async function request(path,{method='GET',data,session,origin:requestOrigin=origin,csrf=true,headers:extra={}}={}) {
    const headers={...extra};if(method!=='GET'){headers.Origin=requestOrigin;headers['Content-Type']='application/json';if(csrf&&session)headers['X-CSRF-Token']=session.csrf_token;}if(session)headers.Cookie=session.cookie;
    const response=await fetch(origin+'/api/v1'+path,{method,headers,body:method==='GET'?undefined:JSON.stringify(data??{})});
    return {status:response.status,body:await response.json(),headers:response.headers};
  }
  async function login(){const response=await request('/auth/demo',{method:'POST'});assert.equal(response.status,201);return {...response.body,cookie:response.headers.get('set-cookie').split(';')[0]};}
  return {app,request,login,origin};
}

test('public discovery preserves negative growth, unknowns, source dates and demo disclosure',async t=>{
  const {request}=await setup(t);const feed=await request('/feed?period=7d');assert.equal(feed.status,200);assert.equal(feed.body.data.length,12);assert.equal(feed.body.stats.repositories,8);assert.equal(feed.body.mode,'demo');assert.ok(feed.body.warnings.length);assert.ok(feed.body.data.every(e=>e.is_demo));
  assert.equal(feed.body.data.find(e=>e.id==='cypress').delta_24h,-13);assert.equal(feed.body.data.find(e=>e.id==='drissionpage').delta_24h,null);
  assert.ok(!feed.body.events.some(e=>e.review_status!=='published'));
  const detail=(await request('/entities/playwright')).body;assert.ok(detail.editions.length);assert.ok(detail.assertions.some(a=>a.status==='unknown'));assert.ok(detail.relations.length);assert.ok(detail.events.every(e=>e.evidence_ids.length));assert.equal(detail.created_at,null);
  const evidence=(await request('/evidence/ev-playwright')).body;assert.equal(evidence.published_at,null);assert.ok(evidence.excerpt.includes('演示'));
  const inverse=(await request('/entities/browserbase/relations')).body.data;assert.ok(inverse.some(r=>r.related_entity_id==='stagehand'&&r.related_name==='Stagehand'));assert.ok(inverse.every(r=>r.related_entity_id!=='browserbase'));
  assert.equal((await request('/repositories?q=Playwright')).body.data.length,1);assert.equal((await request('/repositories?q=%25')).body.data.length,0);
  assert.equal((await request('/products')).body.data.length,4);assert.equal((await request('/entities?kind=bad')).status,400);assert.equal((await request('/entities/%')).status,400);
});

test('authentication, same-origin and CSRF defenses are enforced by the server',async t=>{
  const {app,request,login}=await setup(t);assert.equal((await request('/research-tasks')).status,401);const user=await login();
  assert.equal((await request('/session',{session:user})).body.user.id,user.user.id);
  assert.equal((await request('/research-tasks',{method:'POST',data:{title:'x'},session:user,origin:'https://evil.example'})).status,403);
  assert.equal((await request('/research-tasks',{method:'POST',data:{title:'x'},session:user,csrf:false})).status,403);
  assert.equal((await request('/research-tasks',{method:'POST',data:{title:''},session:user})).status,400);
  app.db.prepare("UPDATE users SET role='user' WHERE id=?").run(user.user.id);
  assert.equal((await request('/admin/overview',{session:user})).status,403);
  assert.equal((await request('/admin/budget',{method:'PATCH',data:{daily_limit:10,monthly_limit:100},session:user})).status,403);
  assert.equal((await request('/auth/logout',{method:'POST',session:user})).status,200);assert.equal((await request('/research-tasks',{session:user})).status,401);
});

test('private task, candidates, comparisons and notes are isolated between accounts',async t=>{
  const {request,login}=await setup(t),a=await login(),b=await login();
  const created=await request('/research-tasks',{method:'POST',session:a,data:{title:'选择浏览器自动化方案',problem:'登录内网后重复录入',must_have:'自托管',candidate_ids:['playwright','puppeteer']}});assert.equal(created.status,201);const task=created.body;
  assert.equal((await request(`/research-tasks/${task.id}`,{session:b})).status,404);
  assert.equal((await request(`/research-tasks/${task.id}`,{method:'DELETE',session:b})).status,404);
  assert.equal((await request(`/research-tasks/${task.id}/candidates`,{method:'POST',session:b,data:{entity_id:'browser-use'}})).status,404);
  for(const entity_id of ['browser-use','selenium','stagehand'])assert.equal((await request(`/research-tasks/${task.id}/candidates`,{method:'POST',session:a,data:{entity_id}})).status,200);
  assert.equal((await request(`/research-tasks/${task.id}/candidates`,{method:'POST',session:a,data:{entity_id:'cypress'}})).status,409);
  const comparison=(await request(`/research-tasks/${task.id}/comparison`,{session:a})).body;assert.equal(comparison.candidates.length,5);assert.equal(comparison.rows.find(r=>r.dimension==='cost').cells[0].status,'unknown');
  const note=(await request('/notes',{method:'POST',session:a,data:{task_id:task.id,entity_id:'playwright',body:'私密客户需求：预算 2000 元'}})).body;
  assert.equal((await request('/notes',{session:b})).body.data.length,0);assert.equal((await request(`/notes/${note.id}`,{method:'PATCH',session:b,data:{body:'修改'}})).status,404);
  assert.equal((await request('/notes',{method:'POST',session:b,data:{task_id:task.id,body:'跨账户'}})).status,404);
  const exported=(await request('/account/export',{session:a})).body;assert.equal(exported.notes[0].body,note.body);assert.ok(!('unsubscribe_token'in exported.user));
  assert.equal((await request(`/research-tasks/${task.id}`,{method:'PATCH',session:a,data:{phase:'adopted',status:'adopted'}})).body.phase,'adopted');
  await request(`/research-tasks/${task.id}`,{method:'DELETE',session:a});assert.equal((await request('/notes',{session:a})).body.data.length,0);
});

test('watch read markers, digest idempotency, pause and unsubscribe stop queued delivery',async t=>{
  const {app,request,login}=await setup(t),session=await login();
  const watch=(await request('/watches',{method:'POST',session,data:{entity_id:'playwright',reason:'影响现有登录流程',event_types:['release'],frequency:'daily'}})).body;assert.equal(watch.unread_count,1);
  assert.equal((await request('/watches',{method:'POST',session,data:{entity_id:'playwright'}})).body.id,watch.id);
  await request('/preferences',{method:'PATCH',session,data:{email_opt_in:true}});
  const first=(await request('/digests/generate',{method:'POST',session})).body;const repeated=(await request('/digests/generate',{method:'POST',session})).body;assert.equal(first.id,repeated.id);assert.equal(repeated.reused,true);assert.equal(app.db.prepare('SELECT count(*) n FROM outbox').get().n,1);
  const other=await login();assert.equal((await request(`/digests/${first.id}`,{session:other})).status,404);
  const key=app.db.prepare('SELECT unsubscribe_token FROM users WHERE id=?').get(session.user.id).unsubscribe_token;
  assert.equal((await request('/unsubscribe?token=wrong')).status,400);assert.equal((await request('/unsubscribe?token='+key)).status,200);assert.equal(app.db.prepare('SELECT status FROM outbox').get().status,'cancelled');assert.equal((await request('/session',{session})).body.user.email_opt_in,false);
  await request(`/watches/${watch.id}/read`,{method:'POST',session});assert.equal((await request('/watches',{session})).body.data[0].unread_count,0);assert.equal((await request('/digests/generate',{method:'POST',session})).body.empty,true);
  await request(`/watches/${watch.id}`,{method:'PATCH',session,data:{paused:true}});assert.equal((await request('/watches',{session})).body.data[0].paused,true);
});

test('moderation requires evidence and deletion propagates through all derived public records',async t=>{
  const {app,request,login}=await setup(t),session=await login();
  app.db.prepare("INSERT INTO events(id,entity_id,title,summary,type,observed_at,is_demo) VALUES('no-evidence','playwright','草稿','未经证实','capability',?,1)").run(now());
  assert.equal((await request('/admin/events/no-evidence/review',{method:'POST',session,data:{action:'publish',reason:'需要发布'}})).status,409);
  await request('/watches',{method:'POST',session,data:{entity_id:'playwright',frequency:'daily'}});await request('/preferences',{method:'PATCH',session,data:{email_opt_in:true}});const digest=(await request('/digests/generate',{method:'POST',session})).body;
  assert.equal((await request('/admin/events/event-apify-capability/review',{method:'POST',session,data:{action:'publish',reason:'已核对演示来源及适用范围'}})).status,200);
  assert.equal((await request('/entities/apify')).body.events.length,1);
  const deletion=await request('/admin/evidence/ev-playwright/delete',{method:'POST',session,data:{reason:'来源删除请求'}});assert.equal(deletion.status,200);
  assert.equal((await request('/evidence/ev-playwright')).status,404);const detail=(await request('/entities/playwright')).body;assert.equal(detail.events.length,0);assert.equal(detail.editions.length,0);assert.ok(detail.description.includes('来源已删除'));assert.equal(detail.original_description,null);assert.ok(detail.assertions.every(a=>a.status==='unknown'));
  assert.equal((await request(`/digests/${digest.id}`,{session})).body.events.length,0);assert.equal(app.db.prepare('SELECT status FROM outbox').get().status,'cancelled');
  const removed=app.db.prepare("SELECT * FROM evidence WHERE id='ev-playwright'").get();assert.equal(removed.excerpt,'');assert.equal(removed.url,'');assert.equal(app.db.prepare('SELECT count(*) n FROM deletion_tombstones').get().n,1);
  assert.equal((await request('/admin/events/event-playwright-release/review',{method:'POST',session,data:{action:'publish',reason:'试图重新发布'}})).status,409);
});

test('source blocking hides evidence-derived facts and events; pausing retains historical evidence',async t=>{
  const {request,login}=await setup(t),session=await login();
  await request('/admin/sources/demo',{method:'PATCH',session,data:{status:'paused',reason:'暂停采集'}});assert.equal((await request('/evidence/ev-playwright')).status,200);
  await request('/admin/sources/demo',{method:'PATCH',session,data:{status:'blocked',reason:'权限撤销'}});assert.equal((await request('/evidence/ev-playwright')).status,404);const feed=(await request('/feed')).body;assert.equal(feed.events.length,0);assert.ok(feed.data.every(e=>e.description.includes('来源权限已撤销')));const detail=(await request('/entities/playwright')).body;assert.ok(detail.assertions.every(a=>a.status==='unknown'));assert.equal(detail.original_description,null);
  assert.equal((await request('/admin/events/event-apify-capability/review',{method:'POST',session,data:{action:'publish',reason:'被撤销的来源不能重新发布'}})).status,409);
  assert.equal((await request('/admin/relations/rel-stagehand-browserbase/review',{method:'POST',session,data:{status:'confirmed',reason:'被撤销的来源不能确认关系'}})).status,409);
});

test('manual payments and refunds are audited, duplicate receipts rejected and exhausted budgets stop retries',async t=>{
  const {app,request,login}=await setup(t),session=await login();
  const order=(await request('/admin/orders',{method:'POST',session,data:{user_id:session.user.id,amount:49,currency:'CNY',reference:'offline-001',days:30}})).body;assert.equal(order.status,'paid');
  assert.equal((await request('/admin/orders',{method:'POST',session,data:{user_id:session.user.id,amount:49,reference:'offline-001'}})).status,409);
  assert.equal((await request(`/admin/orders/${order.id}/refund`,{method:'POST',session,data:{reason:'已在原渠道退款'}})).body.status,'refunded');
  await request('/admin/costs',{method:'POST',session,data:{category:'人工核查',amount:20,minutes:40,note:'演示人工成本'}});
  const overview=(await request('/admin/overview',{session})).body;assert.equal(overview.budget.exhausted,true);assert.equal(overview.metrics.paid_orders,0);assert.ok(overview.audit.length>=3);
  assert.equal((await request('/admin/jobs/github-collect/retry',{method:'POST',session})).body.error.code,'JOB_NOT_RETRYABLE');
  app.db.prepare("UPDATE jobs SET type='github_repository',payload_json=? WHERE id='demo-review'").run(JSON.stringify({owner:'microsoft',repo:'playwright'}));
  assert.equal((await request('/admin/jobs/demo-review/retry',{method:'POST',session})).status,409);
  app.db.prepare("UPDATE jobs SET attempts=5,status='failed' WHERE id='demo-review'").run();
  await request('/admin/budget',{method:'PATCH',session,data:{daily_limit:50,monthly_limit:500}});const retry=await request('/admin/jobs/demo-review/retry',{method:'POST',session});assert.equal(retry.status,202);assert.equal(retry.body.attempts,0);
  app.db.prepare("UPDATE jobs SET status='running' WHERE id='demo-review'").run();assert.equal((await request('/admin/jobs/demo-review/retry',{method:'POST',session})).status,409);
});

test('manual and scheduled digests share event version deduplication in both directions',async t=>{
  const {app,request,login}=await setup(t);
  async function subscriber(name){const session=await login();app.db.prepare('UPDATE users SET email=?,email_opt_in=1 WHERE id=?').run(`${name}@example.com`,session.user.id);const watch=(await request('/watches',{method:'POST',session,data:{entity_id:'playwright',frequency:'daily'}})).body;app.db.prepare("UPDATE watches SET created_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(watch.id);return session;}
  const manual=await subscriber('manual');assert.equal((await request('/digests/generate',{method:'POST',session:manual})).status,201);assert.equal(prepareOutbox(app.db),0);
  const scheduled=await subscriber('scheduled');assert.equal(prepareOutbox(app.db),1);const regenerated=await request('/digests/generate',{method:'POST',session:scheduled});assert.equal(regenerated.body.reused,true);assert.equal(app.db.prepare('SELECT count(*) n FROM outbox').get().n,2);
});

test('account deletion cascades private data and records restoration tombstone without private text',async t=>{
  const {app,request,login}=await setup(t),session=await login();const task=(await request('/research-tasks',{method:'POST',session,data:{title:'客户机密任务'}})).body;
  await request('/notes',{method:'POST',session,data:{task_id:task.id,body:'机密'}});await request('/watches',{method:'POST',session,data:{entity_id:'playwright'}});await request('/digests/generate',{method:'POST',session});await request('/corrections',{method:'POST',session,data:{entity_id:'playwright',description:'私人提供的纠错'}});
  assert.equal((await request('/account',{method:'DELETE',session})).status,200);
  for(const table of ['users','sessions','research_tasks','notes','watches','digests','outbox','corrections'])assert.equal(app.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0,table);
  assert.equal(app.db.prepare('SELECT * FROM account_deletions').get().user_id,session.user.id);assert.equal((await request('/session',{session})).body.user,null);
});

test('production database begins empty, refuses demo authentication and rejects mixing modes',async t=>{
  const {request}=await setup(t,{mode:'production'});assert.equal((await request('/feed')).body.data.length,0);assert.equal((await request('/auth/demo',{method:'POST'})).status,404);assert.equal((await request('/auth/github')).status,503);
  const dir=mkdtempSync(join(tmpdir(),'radar-mode-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'test.sqlite');const db=openDatabase({dbPath:path,mode:'demo'});db.close();assert.throws(()=>openDatabase({dbPath:path,mode:'production'}),/mode mismatch/);
});

test('production editorial workflow publishes a product only with permissioned evidence and scoped facts',async t=>{
  const {app,request}=await setup(t,{mode:'production'});const raw='fixture-session-token',csrf='fixture-csrf-token',uid='fixture-editor';app.db.prepare('INSERT INTO users(id,name,role,unsubscribe_token,created_at) VALUES(?,?,?,?,?)').run(uid,'测试管理员','admin','fixture-unsubscribe-token-long-enough',now());app.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(createHash('sha256').update(raw).digest('hex'),uid,csrf,new Date(Date.now()+3600000).toISOString());const session={cookie:'radar_session='+raw,csrf_token:csrf};
  const product=await request('/admin/entities',{method:'POST',session,data:{kind:'product',name:'测试产品',slug:'test-product',description:'只用于接口测试的资料',topic:'浏览器自动化',website:'https://product.example'}});assert.equal(product.status,201);assert.equal(product.body.is_demo,false);
  const source=await request('/admin/sources',{method:'POST',session,data:{id:'test-official',name:'产品官方资料',url:'https://product.example/docs',collection_method:'manual',reason:'人工提供允许引用的资料'}});assert.equal(source.status,201);
  const evidence=(await request('/admin/evidence',{method:'POST',session,data:{entity_id:product.body.id,source_id:source.body.id,title:'具体发行版本说明',url:'https://product.example/docs',excerpt:'允许在自有基础设施运行；适用于 v1。'}})).body;
  assert.equal((await request('/evidence/'+evidence.id)).status,404);
  assert.equal((await request(`/admin/evidence/${evidence.id}/review`,{method:'POST',session,data:{status:'published',reason:'核对'}})).status,409);
  await request('/admin/sources/test-official',{method:'PATCH',session,data:{status:'approved',reason:'已核对官方条款与摘录保留范围'}});
  assert.equal((await request(`/admin/evidence/${evidence.id}/review`,{method:'POST',session,data:{status:'published',reason:'原文与适用版本核对完成'}})).status,200);
  const assertion=await request('/admin/assertions',{method:'POST',session,data:{entity_id:product.body.id,dimension:'deployment',label:'部署方式',status:'supported',value:'可自托管',scope:'v1，需自备基础设施',evidence_ids:[evidence.id]}});assert.equal(assertion.status,201);
  const edition=await request('/admin/editions',{method:'POST',session,data:{entity_id:product.body.id,name:'标准云服务',deployment:'cloud',price:49,currency:'CNY',billing_period:'month',version:'2026-09',evidence_ids:[evidence.id]}});assert.equal(edition.status,201);
  const event=(await request('/admin/events',{method:'POST',session,data:{entity_id:product.body.id,title:'版本发布',summary:'自托管版本公开',type:'release',evidence_ids:[evidence.id]}})).body;assert.equal((await request('/feed')).body.events.length,0);
  assert.equal((await request(`/admin/events/${event.id}/review`,{method:'POST',session,data:{action:'publish',reason:'核对来源发布时间及版本适用范围'}})).status,200);
  const feed=(await request('/feed')).body;assert.equal(feed.events.length,1);assert.equal(feed.events[0].published_at,null);assert.ok(feed.data.every(e=>!e.is_demo));const detail=(await request('/entities/'+product.body.id)).body;assert.equal(detail.assertions[0].scope,'v1，需自备基础设施');assert.equal(detail.editions[0].price,49);
});

test('production email requires a public address and changing it resets consent and cancels queued mail',async t=>{
  const {app,request}=await setup(t,{mode:'production'});const raw='email-test-session',csrf='email-test-csrf',uid='email-test-user';
  app.db.prepare('INSERT INTO users(id,name,role,unsubscribe_token,created_at) VALUES(?,?,?,?,?)').run(uid,'Public user','user','email-test-unsubscribe-token-long-enough',now());
  app.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(createHash('sha256').update(raw).digest('hex'),uid,csrf,new Date(Date.now()+3600000).toISOString());
  const session={cookie:'radar_session='+raw,csrf_token:csrf};
  assert.equal((await request('/preferences',{method:'PATCH',session,data:{email_opt_in:true}})).body.error.code,'EMAIL_UNAVAILABLE');
  let account=app.db.prepare('SELECT * FROM users WHERE id=?').get(uid);
  account=refreshPublicProfile(app.db,account,{login:'public-user',email:'first@example.com'});
  assert.equal(account.email_opt_in,0);
  assert.equal((await request('/preferences',{method:'PATCH',session,data:{email_opt_in:true}})).status,200);
  app.db.prepare('INSERT INTO digests VALUES(?,?,?,?,?,?,?)').run('email-digest',uid,'Test',now(),'ready',0,'test-window');
  app.db.prepare('INSERT INTO outbox(id,user_id,digest_id,status,idempotency_key,created_at) VALUES(?,?,?,?,?,?)').run('email-queue',uid,'email-digest','queued','email-key',now());
  account=refreshPublicProfile(app.db,app.db.prepare('SELECT * FROM users WHERE id=?').get(uid),{login:'public-user',email:'first@example.com'});
  assert.equal(account.email_opt_in,1);
  account=refreshPublicProfile(app.db,account,{login:'public-user',email:'second@example.com'});
  assert.equal(account.email_opt_in,0);assert.equal(app.db.prepare("SELECT status FROM outbox WHERE id='email-queue'").get().status,'cancelled');
  account=refreshPublicProfile(app.db,account,{login:'public-user',email:null});assert.equal(account.email,null);
});

test('collector persistence keeps stable identities, deduplicates release events and enforces tombstones',async t=>{
  const {app}=await setup(t,{mode:'production'});app.db.prepare("UPDATE sources SET status='approved',permission_status='approved' WHERE id='github'").run();const observed=now();
  const result={repository:{id:'gh:123',name:'demo-fixture',owner:'test',slug:'test/demo-fixture',description:'fixture',topic:'浏览器自动化',repository_url:'https://github.com/test/demo-fixture',stars:100,observed_at:observed,is_demo:false},snapshot:{id:'s1',entity_id:'gh:123',stars:100,observed_at:observed,source_id:'github',metric_version:'github.stargazers_count.v1',scope:'public'},evidence:[{id:'ev1',title:'Release',url:'https://github.com/test/demo-fixture/releases/tag/v1',excerpt:'Released v1',fetched_at:observed}],events:[{id:'event1',title:'v1',summary:'Released',type:'release',evidence_ids:['ev1']}]};
  applyCollection(app.db,result);applyCollection(app.db,result);assert.equal(app.db.prepare('SELECT count(*) n FROM entities').get().n,1);assert.equal(app.db.prepare('SELECT count(*) n FROM events').get().n,1);assert.equal(app.db.prepare('SELECT review_status FROM events').get().review_status,'pending');
  app.db.prepare('INSERT INTO deletion_tombstones VALUES(?,?,?,?,?,?)').run('del1','ev1',null,null,'test',now());app.db.prepare("UPDATE evidence SET review_status='deleted' WHERE id='ev1'").run();applyCollection(app.db,result);assert.equal(app.db.prepare("SELECT review_status FROM evidence WHERE id='ev1'").get().review_status,'deleted');
});
