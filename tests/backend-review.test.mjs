import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createApp } from '../server/index.mjs';
import { now } from '../server/db.mjs';

async function setup(t, options={}) {
  const app=createApp({dbPath:':memory:',logErrors:false,...options});const address=await app.listen(0);const origin=`http://127.0.0.1:${address.port}`;t.after(()=>app.close());
  async function request(path,{method='GET',data,session}={}){const headers={};if(method!=='GET'){headers.Origin=origin;headers['Content-Type']='application/json';if(session)headers['X-CSRF-Token']=session.csrf;}if(session)headers.Cookie=session.cookie;const response=await fetch(origin+'/api/v1'+path,{method,headers,body:method==='GET'?undefined:JSON.stringify(data||{})});return {status:response.status,body:await response.json()};}
  function session(role='admin',githubId=null){const uid=randomUUID(),raw=randomUUID(),csrf=randomUUID();app.db.prepare('INSERT INTO users(id,name,role,github_id,unsubscribe_token,created_at) VALUES(?,?,?,?,?,?)').run(uid,'Test account',role,githubId,randomUUID(),now());app.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(createHash('sha256').update(raw).digest('hex'),uid,csrf,new Date(Date.now()+3600000).toISOString());return {userId:uid,cookie:'radar_session='+raw,csrf};}
  return {app,request,session};
}

test('a derived record is hidden if any cited source is blocked, even when another citation is valid',async t=>{
  const {app,request}=await setup(t);const db=app.db;
  db.prepare("INSERT INTO sources(id,name,url,status,permission_status,collection_method) VALUES('other','Another source','https://example.org','active','approved','manual')").run();
  db.prepare("INSERT INTO evidence(id,entity_id,source_id,title,url,excerpt,source_name,fetched_at,review_status,is_demo,permission_status) VALUES('other-evidence','playwright','other','Other citation','https://example.org','A different fact','Another source',?,'published',1,'approved')").run(now());
  db.prepare("INSERT INTO event_evidence VALUES('event-playwright-release','other-evidence')").run();
  db.prepare("INSERT INTO assertion_evidence VALUES('assert-playwright-deployment','other-evidence')").run();
  db.prepare("INSERT INTO edition_evidence VALUES('edition-playwright','other-evidence')").run();
  db.prepare("INSERT INTO relation_evidence VALUES('rel-playwright-browserbase','other-evidence')").run();
  db.prepare("UPDATE sources SET status='blocked' WHERE id='demo'").run();
  const detail=(await request('/entities/playwright')).body;
  assert.equal(detail.events.length,0);assert.equal(detail.editions.length,0);assert.equal(detail.relations.length,0);
  assert.equal(detail.assertions.find(a=>a.dimension==='deployment').status,'unknown');
  const feed=(await request('/feed')).body;assert.equal(feed.events.length,0);assert.equal(feed.stats.events,0);
});

test('hidden source text cannot be discovered through public search filters',async t=>{
  const {app,request}=await setup(t);
  app.db.prepare("UPDATE entities SET description='restricted-needle-2749',extra_json=? WHERE id='playwright'").run(JSON.stringify({tags:['restricted-tag-3848']}));
  app.db.prepare("UPDATE sources SET status='blocked' WHERE id='demo'").run();
  assert.equal((await request('/entities?q=restricted-needle-2749')).body.data.length,0);
  assert.equal((await request('/entities?q=restricted-tag-3848')).body.data.length,0);
  assert.equal((await request('/entities?q=playwright')).body.data.length,1,'Public identity remains searchable');
});

test('GitHub administrator membership applies to existing accounts and revokes old sessions',async t=>{
  const removed=await setup(t,{mode:'production',adminGithubIds:[]});const oldAdmin=removed.session('admin','123');
  assert.equal((await removed.request('/admin/overview',{session:oldAdmin})).status,403);
  assert.equal((await removed.request('/session',{session:oldAdmin})).body.user.role,'user');
  const granted=await setup(t,{mode:'production',adminGithubIds:['123']});const existing=granted.session('user','123');
  assert.equal((await granted.request('/admin/overview',{session:existing})).status,200);
  const editor=granted.session('editor','456');assert.equal((await granted.request('/session',{session:editor})).body.user.role,'editor');
});

test('editor access does not reveal financial receipts or private delivery queue identifiers',async t=>{
  const {app,request,session}=await setup(t);const admin=session(),editor=session('editor');
  const order=await request('/admin/orders',{method:'POST',session:admin,data:{user_id:admin.userId,amount:49,reference:'private-payment-reference'}});
  await request(`/admin/orders/${order.body.id}/refund`,{method:'POST',session:admin,data:{reason:'private-refund-customer-bank'}});
  await request('/admin/costs',{method:'POST',session:admin,data:{category:'Hosting',amount:1,note:'private-vendor-note'}});
  await request('/analytics',{method:'POST',session:admin,data:{event:'feed_view',cohort:'private-customer-segment'}});
  const editorial=await request('/admin/overview',{session:editor});assert.equal(editorial.status,200);assert.deepEqual(editorial.body.orders,[]);assert.deepEqual(editorial.body.costs,[]);assert.deepEqual(editorial.body.outbox,[]);
  assert.ok(!JSON.stringify(editorial.body).includes('private-'));assert.deepEqual(editorial.body.metrics.events,[]);assert.equal(editorial.body.capabilities.business_admin,false);
  const operational=(await request('/admin/overview',{session:admin})).body;assert.equal(operational.orders.length,1);assert.equal(operational.costs.length,1);
});

test('public relations do not disclose internal moderation reasons',async t=>{
  const {request,session}=await setup(t);const admin=session();
  assert.equal((await request('/admin/relations/rel-stagehand-browserbase/review',{method:'POST',session:admin,data:{status:'confirmed',reason:'private-review-note-for-editor-only'}})).status,200);
  const relations=(await request('/entities/stagehand/relations')).body.data;assert.equal(relations.length,1);assert.equal(relations[0].reason,undefined);assert.ok(!JSON.stringify(relations).includes('private-review'));
  assert.ok(JSON.stringify((await request('/admin/overview',{session:admin})).body).includes('private-review-note-for-editor-only'));
});

test('session capabilities disclose availability only and production never enables demo authentication',async t=>{
  const unavailable=await setup(t,{mode:'production',githubClientId:'',githubClientSecret:''});const session=(await unavailable.request('/session')).body;
  assert.equal(session.capabilities.auth.github_enabled,false);assert.equal(session.capabilities.auth.demo_enabled,false);assert.equal(session.capabilities.auth.login_available,false);assert.ok(session.capabilities.auth.unavailable_reason);assert.equal((await unavailable.request('/auth/demo',{method:'POST'})).status,404);
  const configured=await setup(t,{mode:'production',publicUrl:'https://radar.example',githubClientId:'private-client-fixture',githubClientSecret:'private-secret-fixture'});
  const capabilities=(await configured.request('/session')).body;assert.equal(capabilities.capabilities.auth.github_enabled,true);assert.ok(!JSON.stringify(capabilities).includes('private-'));assert.equal((await configured.request('/auth/github/callback?state=wrong&code=fixture')).status,400);
  const insecure=await setup(t,{mode:'production',publicUrl:'http://radar.example',githubClientId:'fixture',githubClientSecret:'fixture'});assert.equal((await insecure.request('/session')).body.capabilities.auth.github_enabled,false);assert.equal((await insecure.request('/auth/github')).status,503);
  const demo=await setup(t);assert.equal((await demo.request('/session')).body.capabilities.auth.demo_enabled,true);
});

test('public content counts explain pending releases without exposing drafts, and describe actual sorting',async t=>{
  const {app,request}=await setup(t);
  app.db.prepare("UPDATE events SET type='release',title='private-draft-title-marker' WHERE id='event-apify-capability'").run();
  app.db.prepare('UPDATE entities SET delta_24h=NULL,delta_7d=NULL,trend_status=?').run('insufficient');
  const feed=(await request('/feed')).body;assert.equal(feed.content_status.pending_release_events,1);assert.equal(feed.sort.effective,'name');assert.equal(feed.sort.comparable_count,0);assert.ok(!JSON.stringify(feed).includes('private-draft-title-marker'));
  const detail=(await request('/entities/apify')).body;assert.equal(detail.content_status.pending_release_events,1);assert.equal(detail.content_status.published_events,0);assert.deepEqual(detail.collection.sources.map(source=>source.source_id),['demo']);assert.ok(!JSON.stringify(detail).includes('private-draft-title-marker'));
});

test('entity JSON cannot override stable identity and snapshot windows retain the latest observation',async t=>{
  const {app,request}=await setup(t);
  app.db.prepare("UPDATE entities SET extra_json=? WHERE id='playwright'").run(JSON.stringify({id:'spoofed',kind:'product',review_status:'pending',is_demo:false,tags:'malformed'}));
  let detail=(await request('/entities/playwright')).body;assert.equal(detail.id,'playwright');assert.equal(detail.kind,'repository');assert.equal(detail.review_status,'published');assert.equal(detail.is_demo,true);assert.deepEqual(detail.tags,[]);
  const insert=app.db.prepare("INSERT INTO snapshots(id,entity_id,stars,observed_at,source_id) VALUES(?,'playwright',?,?,'demo')");const start=Date.now()+86400000;let latest;
  for(let index=0;index<205;index++){latest=new Date(start+index*3600000).toISOString();insert.run(`recent-${index}`,index,latest);}
  detail=(await request('/entities/playwright')).body;assert.equal(detail.snapshots.length,200);assert.equal(detail.snapshots.at(-1).observed_at,latest);assert.equal(detail.snapshots.at(-1).stars,204);
  app.db.prepare("UPDATE sources SET status='blocked' WHERE id='demo'").run();detail=(await request('/entities/playwright')).body;assert.deepEqual(detail.snapshots,[]);assert.equal(detail.stars,null);assert.equal(detail.delta_24h,null);
});

test('one authenticated account cannot exhaust another account limit behind the same proxy',async t=>{
  const {request,session}=await setup(t);const abusive=session('user'),other=session('user');
  for(let index=0;index<120;index++)assert.equal((await request('/notes',{method:'POST',session:abusive,data:{}})).status,400);
  assert.equal((await request('/notes',{method:'POST',session:abusive,data:{}})).status,429);
  assert.equal((await request('/notes',{method:'POST',session:other,data:{entity_id:'playwright',body:'Another account can still save its private note.'}})).status,201);
});

test('comparison does not silently choose the first fact when editions or conditions differ',async t=>{
  const {request,session}=await setup(t);const admin=session();
  const fact=await request('/admin/assertions',{method:'POST',session:admin,data:{entity_id:'playwright',dimension:'deployment',label:'部署方式',status:'unsupported',value:'该托管套餐不包含自托管交付',scope:'托管套餐，仅适用于本次版本范围测试',evidence_ids:['ev-playwright']}});assert.equal(fact.status,201);
  const task=(await request('/research-tasks',{method:'POST',session:admin,data:{title:'按范围核对部署方式',candidate_ids:['playwright']}})).body;
  const comparison=(await request(`/research-tasks/${task.id}/comparison`,{session:admin})).body;const cell=comparison.rows.find(row=>row.dimension==='deployment').cells[0];
  assert.equal(cell.status,'unknown');assert.equal(cell.variants.length,2);assert.match(cell.value,/版本|套餐|范围/);
});
