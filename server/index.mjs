import http from 'node:http';
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, statSync, realpathSync, createReadStream } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, json, now, transaction, SCHEMA_VERSION } from './db.mjs';
import { seedDemo } from './seed.mjs';
import { getEntity, getEvent, getRelations, publicEntityRow } from './store.mjs';
import { deleteEvidence, deleteAccount } from './privacy.mjs';
import { createEditorialRoutes } from './editorial.mjs';
import { getCollectionStatus } from './collection-status.mjs';
import { refreshPublicProfile } from './auth-profile.mjs';
import { getAuthConfiguration, reconcileGithubRole } from './auth-config.mjs';
import { evidenceSet, metadataBlockedSQL, getContentStatus } from './evidence-policy.mjs';
import { comparisonCell } from './comparison.mjs';
import { initializeWorkerSchema } from '../workers/jobs.mjs';
import { findUnrecordedEvents, recordDigestVersions } from '../workers/delivery.mjs';

const PREFIX='/api/v1';
const EVENT_TYPES=['release','capability','pricing','deployment','issue','discovery','correction'];
const TASK_STATUS=['researching','trial','adopted','watching','rejected'];
const DIMENSIONS=[['deployment','部署方式'],['browser','浏览器覆盖'],['license','许可条件'],['cost','运行成本'],['reliability','业务可靠性']].map(([id,label])=>({id,label}));
const ANALYTICS=['feed_view','entity_view','evidence_view','task_created','candidate_added','comparison_view','watch_created','digest_view','note_created','decision_updated','trial_started','adopted','rejected','correction_submitted','return_visit','pricing_view','contact_clicked','first_source_click','source_click','task_completed','watch_reason_saved','signup','export_requested'];
const hash=v=>createHash('sha256').update(v).digest('hex');
const token=()=>randomBytes(32).toString('base64url');
const id=(prefix)=>`${prefix}-${randomUUID()}`;
const publicUser=u=>u?{id:u.id,name:u.name,email:u.email,role:u.role,email_opt_in:!!u.email_opt_in,timezone:u.timezone,is_demo:!!u.is_demo}:null;
const fail=(status,code,message)=>{const e=new Error(message);Object.assign(e,{status,code});throw e;};
function textField(value,name,{required=false,max=4000,fallback=''}={}) {
  if(value===undefined||value===null) { if(required) fail(400,'VALIDATION',`${name}不能为空`); return fallback; }
  if(typeof value!=='string'||value.length>max) fail(400,'VALIDATION',`${name}格式错误或过长`);
  const v=value.trim(); if(required&&!v) fail(400,'VALIDATION',`${name}不能为空`); return v;
}
function enumField(value,values,name,fallback) { if(value===undefined&&fallback!==undefined)return fallback;if(!values.includes(value))fail(400,'VALIDATION',`${name}选项无效`);return value; }
function boolField(value,name,fallback=false) { if(value===undefined)return fallback;if(typeof value!=='boolean')fail(400,'VALIDATION',`${name}应为布尔值`);return value; }
function numField(value,name,{min=0,max=1000000,integer=false,fallback}={}){if(value===undefined&&fallback!==undefined)return fallback;if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max||(integer&&!Number.isInteger(value)))fail(400,'VALIDATION',`${name}数值无效`);return value;}
function safeURL(value,{optional=true}={}){if(!value&&optional)return null;const raw=textField(value,'网址',{required:true,max:2048});try{const u=new URL(raw);if(!['https:','http:'].includes(u.protocol)||u.username||u.password)throw Error();return u.href;}catch{fail(400,'VALIDATION','请输入有效的 HTTP(S) 网址');}}
function cookies(req){return Object.fromEntries((req.headers.cookie||'').split(';').filter(Boolean).map(s=>{const k=s.indexOf('=');return [s.slice(0,k).trim(),s.slice(k+1).trim()];}));}
async function body(req){let size=0,parts=[];for await(const part of req){size+=part.length;if(size>65536)fail(413,'BODY_TOO_LARGE','请求内容超过 64 KB');parts.push(part);}try{const value=JSON.parse(Buffer.concat(parts).toString()||'{}');if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value;}catch{fail(400,'INVALID_JSON','请求内容必须为 JSON 对象');}}
function equal(a,b){if(typeof a!=='string'||typeof b!=='string')return false;const aa=Buffer.from(a),bb=Buffer.from(b);return aa.length===bb.length&&timingSafeEqual(aa,bb);}

export function createApp(options={}) {
  const mode=options.mode||process.env.RADAR_MODE||'demo';
  const dbPath=options.dbPath||process.env.RADAR_DB_PATH||`data/radar-${mode}.sqlite`;
  const db=openDatabase({dbPath,mode}); initializeWorkerSchema(db); if(mode==='demo')seedDemo(db);
  const distPath=resolve(options.distPath||'dist');
  const publicUrl=options.publicUrl||process.env.RADAR_PUBLIC_URL||'';
  const auth=getAuthConfiguration(options,mode,publicUrl);
  const origins=new Set([...(options.allowedOrigins||[]),...((process.env.RADAR_ALLOWED_ORIGINS||'').split(',').filter(Boolean)),...(mode==='demo'?['http://localhost:5188','http://127.0.0.1:5188']:[])]);
  if(publicUrl){try{const publicAddress=new URL(publicUrl);if(['http:','https:'].includes(publicAddress.protocol)&&!publicAddress.username&&!publicAddress.password)origins.add(publicAddress.origin);}catch{}}
  const rateLimits=new Map();
  const csrfRequired=options.csrfRequired!==false;
  const send=(res,status,data,headers={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(JSON.stringify(data));};
  const audit=(actor,action,target,reason='')=>db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?)').run(id('audit'),actor?.id||null,action,target||null,reason,now());
  const needUser=user=>{if(!user)fail(401,'UNAUTHENTICATED','请先登录后继续');return user;};
  const needEditor=user=>{needUser(user);if(!['editor','admin'].includes(user.role))fail(403,'FORBIDDEN','需要编辑或管理员权限');};
  const needAdmin=user=>{needUser(user);if(user.role!=='admin')fail(403,'FORBIDDEN','需要管理员权限');};
  const owned=(table,itemId,user)=>{needUser(user);const row=db.prepare(`SELECT * FROM ${table} WHERE id=? AND user_id=?`).get(itemId,user.id);if(!row)fail(404,'NOT_FOUND','记录不存在');return row;};
  const entityExists=eid=>{if(typeof eid!=='string'||eid.length>200)fail(400,'VALIDATION','对象 ID 格式无效');const e=getEntity(db,eid,{details:false});if(!e)fail(404,'NOT_FOUND','研究对象不存在');return e;};
  const list=data=>({data,as_of:now(),coverage:mode==='demo'?'演示样本，不代表市场全量':'已收录并获准采集的公开来源',warnings:mode==='demo'?['当前为演示数据，数值、事件与判断均用于交互验证']:[]});
  const taskJSON=row=>({...row,candidate_ids:db.prepare('SELECT entity_id FROM task_candidates WHERE task_id=? ORDER BY created_at').all(row.id).map(c=>c.entity_id)});
  const eventsFor=(eid)=>db.prepare("SELECT * FROM events WHERE entity_id=? AND review_status='published' ORDER BY observed_at DESC").all(eid).map(e=>getEvent(db,e)).filter(e=>e.evidence_ids.length);
  const watchJSON=row=>{const types=json(row.event_types,[]),events=eventsFor(row.entity_id).filter(e=>!types.length||types.includes(e.type));return {...row,event_types:types,paused:!!row.paused,entity:getEntity(db,row.entity_id,{details:false}),events,unread_count:row.paused?0:events.filter(e=>!row.last_read_at||Date.parse(e.reviewed_at||e.observed_at)>Date.parse(row.last_read_at)).length};};
  const digestJSON=row=>({...row,is_demo:!!row.is_demo,events:db.prepare("SELECT e.* FROM events e JOIN digest_events de ON de.event_id=e.id WHERE de.digest_id=? AND e.review_status='published' ORDER BY e.observed_at DESC").all(row.id).map(e=>getEvent(db,e)).filter(e=>e.evidence_ids.length)});
  function newSession(user,res){const raw=token(),csrf_token=token();db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hash(raw),user.id,csrf_token,new Date(Date.now()+7*86400000).toISOString());res.setHeader('Set-Cookie',`radar_session=${raw}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${mode==='production'?'; Secure':''}`);return csrf_token;}
  function clearSession(req,res){const raw=cookies(req).radar_session;if(raw)db.prepare('DELETE FROM sessions WHERE id_hash=?').run(hash(raw));res.setHeader('Set-Cookie',`radar_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${mode==='production'?'; Secure':''}`);}
  function limits(req,path,user){const principal=user&&path!=='/auth/demo'?`account:${user.id}`:`address:${req.socket.remoteAddress}`;const key=`${principal}:${path==='/auth/demo'?'login':req.method==='GET'?'read':'write'}`;const t=Date.now(),value=rateLimits.get(key);const max=path==='/auth/demo'?20:req.method==='GET'?600:120;if(!value||t-value.start>60000)rateLimits.set(key,{start:t,count:1});else if(++value.count>max)fail(429,'RATE_LIMIT','操作过于频繁，请稍后重试');if(rateLimits.size>10000)for(const [k,v]of rateLimits)if(t-v.start>60000)rateLimits.delete(k);}
  function validateOrigin(req){const origin=req.headers.origin;const address=server.address();const port=typeof address==='object'?address?.port:0;const local=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);const isLocal=local&&[`http://localhost:${port}`,`http://127.0.0.1:${port}`].includes(origin);if(!origin||(!origins.has(origin)&&!isLocal))fail(403,'ORIGIN_REJECTED','请求来源校验失败');}
  function budgetStatus(){const b=db.prepare('SELECT * FROM budget WHERE id=1').get();const day=now().slice(0,10),month=day.slice(0,7);const spent=db.prepare('SELECT COALESCE(SUM(CASE WHEN substr(created_at,1,10)=? THEN amount ELSE 0 END),0) daily_spent,COALESCE(SUM(CASE WHEN substr(created_at,1,7)=? THEN amount ELSE 0 END),0) monthly_spent FROM costs').get(day,month);return {...b,...spent,exhausted:spent.daily_spent>=b.daily_limit||spent.monthly_spent>=b.monthly_limit};}
  const editorial=createEditorialRoutes({db,mode,audit,body,fail,textField,enumField,numField,safeURL,needAdmin,entityExists});

  const server=http.createServer(async(req,res)=>{
    const requestId=randomUUID();
    res.setHeader('X-Request-Id',requestId);res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    try{
      const url=new URL(req.url,'http://localhost');
      if(!url.pathname.startsWith(PREFIX+'/'))return serveStatic(req,res,url.pathname,distPath);
      const path=url.pathname.slice(PREFIX.length),method=req.method;
      const cookie=cookies(req).radar_session;
      const session=cookie?db.prepare('SELECT * FROM sessions WHERE id_hash=? AND expires_at>?').get(hash(cookie),now()):null;
      let user=session?db.prepare('SELECT * FROM users WHERE id=?').get(session.user_id):null;
      if(mode==='production'&&user)user=reconcileGithubRole(db,user,auth.adminGithubIds);
      limits(req,path,user);
      if(['POST','PATCH','PUT','DELETE'].includes(method)){
        validateOrigin(req);
        if(!req.headers['content-type']?.toLowerCase().startsWith('application/json'))fail(415,'CONTENT_TYPE','请使用 application/json');
        if(user&&csrfRequired&&!['/auth/demo','/analytics'].includes(path)&&!equal(req.headers['x-csrf-token'],session.csrf_token))fail(403,'CSRF_REJECTED','会话校验失败，请刷新后重试');
      }
      const reply=(data,status=200)=>send(res,status,data);
      if(method==='GET'&&path==='/health')return reply({status:'ok',mode,version:'0.1.0',schema_version:SCHEMA_VERSION});
      if(method==='GET'&&path==='/session')return reply({user:publicUser(user),mode,csrf_token:session?.csrf_token||null,
        capabilities:auth.publicCapabilities(['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))});
      if(method==='POST'&&path==='/auth/demo'){
        if(mode!=='demo'||!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))fail(404,'NOT_FOUND','演示登录仅供本机演示使用');
        await body(req);clearSession(req,res);const uid=id('demo-user');
        db.prepare('INSERT INTO users(id,name,email,role,email_opt_in,timezone,is_demo,unsubscribe_token,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(uid,'演示访客',null,'admin',0,'Asia/Shanghai',1,token(),now());
        const demoUser=db.prepare('SELECT * FROM users WHERE id=?').get(uid);const csrf_token=newSession(demoUser,res);audit(demoUser,'demo_login',uid,'独立本机演示账户');return reply({user:publicUser(demoUser),mode,csrf_token},201);
      }
      if(method==='POST'&&path==='/auth/logout'){await body(req);clearSession(req,res);return reply({ok:true});}
      if(method==='GET'&&path==='/auth/github'){
        if(mode!=='production')fail(400,'AUTH_MODE','演示模式请使用本机演示登录');
        const client=auth.clientId;if(!auth.githubEnabled)fail(503,'AUTH_UNCONFIGURED','GitHub 登录尚未配置完成，请先使用公开研究资料');
        const state=token();db.prepare('DELETE FROM oauth_states WHERE expires_at<?').run(now());db.prepare('INSERT INTO oauth_states VALUES(?,?)').run(hash(state),new Date(Date.now()+600000).toISOString());
        res.setHeader('Set-Cookie',`radar_oauth=${state}; Path=${PREFIX}/auth/github; HttpOnly; SameSite=Lax; Secure; Max-Age=600`);
        const dest=new URL('https://github.com/login/oauth/authorize');dest.searchParams.set('client_id',client);dest.searchParams.set('redirect_uri',`${publicUrl.replace(/\/$/,'')}${PREFIX}/auth/github/callback`);dest.searchParams.set('state',state); // No private repository or email scopes.
        res.writeHead(302,{Location:dest.href});return res.end();
      }
      if(method==='GET'&&path==='/auth/github/callback'){
        if(!auth.githubEnabled)fail(503,'AUTH_UNCONFIGURED','GitHub 登录尚未配置完成，请先使用公开研究资料');
        const state=url.searchParams.get('state'),code=url.searchParams.get('code');
        if(!state||!code||!equal(cookies(req).radar_oauth,state)||!db.prepare('SELECT 1 FROM oauth_states WHERE state_hash=? AND expires_at>?').get(hash(state),now()))fail(400,'OAUTH_STATE','登录状态无效或已过期');
        db.prepare('DELETE FROM oauth_states WHERE state_hash=?').run(hash(state));
        const tokenResponse=await fetch('https://github.com/login/oauth/access_token',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({client_id:auth.clientId,client_secret:auth.clientSecret,code,redirect_uri:`${publicUrl.replace(/\/$/,'')}${PREFIX}/auth/github/callback`}),signal:AbortSignal.timeout(15000)});
        const credentials=await tokenResponse.json();if(!tokenResponse.ok||!credentials.access_token)fail(502,'OAUTH_FAILED','GitHub 登录暂时不可用');
        const profileResponse=await fetch('https://api.github.com/user',{headers:{Authorization:`Bearer ${credentials.access_token}`,Accept:'application/vnd.github+json','User-Agent':'open-product-radar'},signal:AbortSignal.timeout(15000)});
        const profile=await profileResponse.json();if(!profileResponse.ok||!profile.id||!profile.login)fail(502,'OAUTH_FAILED','无法获取 GitHub 公开身份');
        let account=db.prepare('SELECT * FROM users WHERE github_id=?').get(String(profile.id));
        if(!account){const uid=id('user');db.prepare('INSERT INTO users(id,name,email,role,email_opt_in,timezone,github_id,is_demo,unsubscribe_token,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(uid,profile.name||profile.login,profile.email||null,auth.adminGithubIds.has(String(profile.id))?'admin':'user',0,'Asia/Shanghai',String(profile.id),0,token(),now());account=db.prepare('SELECT * FROM users WHERE id=?').get(uid);}
        account=refreshPublicProfile(db,account,profile);
        account=reconcileGithubRole(db,account,auth.adminGithubIds);
        clearSession(req,res);
        newSession(account,res);res.writeHead(302,{Location:'/'});return res.end();
      }

      if(method==='GET'&&['/feed','/repositories','/products','/entities'].includes(path)){
        const kind=path==='/repositories'?'repository':path==='/products'?'product':url.searchParams.get('kind');if(kind&&!['repository','product'].includes(kind))fail(400,'VALIDATION','对象类型无效');
        const period=enumField(url.searchParams.get('period')||'24h',['24h','7d'],'观察窗口');
        const q=(url.searchParams.get('q')||'').trim().toLocaleLowerCase().slice(0,200),topic=url.searchParams.get('topic'),language=url.searchParams.get('language');
        const sort=enumField(url.searchParams.get('sort')||'growth',['growth','stars','recent'],'排序方式'),metric=period==='7d'?'delta_7d':'delta_24h';
        const where=["review_status='published'"],params=[];
        if(kind){where.push('kind=?');params.push(kind);}
        if(q){where.push("lower(name || ' ' || COALESCE(owner,'') || ' ' || CASE WHEN metadata_blocked THEN '' ELSE description || ' ' || extra_json END) LIKE ? ESCAPE '\\'");params.push('%'+q.replace(/[\\%_]/g, c=>'\\'+c)+'%');}
        if(topic&&topic!=='all'){where.push('topic=?');params.push(topic);}
        if(language&&language!=='all'){where.push('language=? AND metadata_blocked=0');params.push(language);}
        const order=sort==='stars'?'CASE WHEN metadata_blocked=0 THEN stars END DESC':sort==='recent'?'observed_at DESC':`CASE WHEN metadata_blocked=0 THEN ${metric} END DESC`;
        const limit=Math.max(1,Math.min(200,Math.trunc(Number(url.searchParams.get('limit'))||100)));
        const visibleEntities=`WITH visible_entities AS (SELECT entities.*,${metadataBlockedSQL()} AS metadata_blocked FROM entities)`;
        const data=db.prepare(`${visibleEntities} SELECT * FROM visible_entities WHERE ${where.join(' AND ')} ORDER BY ${order},name LIMIT ?`).all(...params,limit).map(publicEntityRow);
        const result={...list(data),mode};
        const comparableCount=db.prepare(`${visibleEntities} SELECT count(*) n FROM visible_entities WHERE ${where.join(' AND ')} AND metadata_blocked=0 AND ${metric} IS NOT NULL`).get(...params).n;
        result.sort={requested:sort,effective:sort==='growth'&&comparableCount===0?'name':sort,period,comparable_count:comparableCount};
        result.collection=getCollectionStatus(db);
        const observed=data.map(e=>e.observed_at).filter(Boolean).sort();
        result.as_of=observed.at(-1)||null;
        if(mode==='production'){
          result.warnings.push(...result.collection.warnings);
          if(observed.length&&Date.now()-Date.parse(observed.at(-1))>48*3600000)result.warnings.push('最新观察已超过 48 小时，请留意数据时效');
        }
        if(path==='/feed'){
          result.content_status={repositories:db.prepare("SELECT count(*) n FROM entities WHERE kind='repository' AND review_status='published'").get().n,
            products:db.prepare("SELECT count(*) n FROM entities WHERE kind='product' AND review_status='published'").get().n,...getContentStatus(db)};
          const cutoff=new Date(Date.now()-(period==='7d'?7:1)*86400000).toISOString();const ids=new Set(data.map(e=>e.id));
          result.events=db.prepare("SELECT * FROM events WHERE review_status='published' AND observed_at>=? ORDER BY observed_at DESC LIMIT 100").all(cutoff).filter(e=>ids.has(e.entity_id)).map(e=>getEvent(db,e)).filter(e=>e.evidence_ids.length);
          result.stats={repositories:result.content_status.repositories,products:result.content_status.products,events:result.content_status.published_events,sources:result.collection.data_source_count};
          result.warnings.push('Star 净变化只描述观察窗口，不代表真实用户量或收入');
          if(!data.length)result.warnings.push('当前范围尚无已审核数据');
        }
        return reply(result);
      }
      let match;
      if(method==='GET'&&(match=path.match(/^\/entities\/([^/]+)(?:\/(changes|relations))?$/))){const entity=entityExists(decodeURIComponent(match[1]));return reply(match[2]==='changes'?list(eventsFor(entity.id)):match[2]==='relations'?list(getRelations(db,entity.id)):getEntity(db,entity.id));}
      if(method==='GET'&&(match=path.match(/^\/evidence\/([^/]+)$/))){const e=db.prepare("SELECT e.* FROM evidence e JOIN sources s ON s.id=e.source_id WHERE e.id=? AND e.review_status='published' AND e.permission_status IN ('approved','permitted','demo') AND s.status NOT IN ('blocked','revoked')").get(decodeURIComponent(match[1]));if(!e)fail(404,'NOT_FOUND','证据不存在或已撤回');return reply({...e,is_demo:!!e.is_demo});}
      if(method==='POST'&&path==='/analytics'){const b=await body(req),event=enumField(b.event,ANALYTICS,'分析事件');const taskId=textField(b.task_id,'任务 ID',{max:150,fallback:null});if(taskId)owned('research_tasks',taskId,user);const entityId=textField(b.entity_id,'对象 ID',{max:150,fallback:null});if(entityId)entityExists(entityId);db.prepare('INSERT INTO analytics VALUES(?,?,?,?,?,?,?,?,?,?)').run(id('event'),user?.id||null,event,entityId,taskId,b.phase?enumField(b.phase,['selection','adopted'],'阶段'):null,textField(b.channel,'渠道',{max:80,fallback:null}),textField(b.cohort,'用户组',{max:80,fallback:null}),now(),mode==='demo'?1:0);return reply({ok:true},202);}

      if(path==='/research-tasks'){
        needUser(user);
        if(method==='GET')return reply(list(db.prepare('SELECT * FROM research_tasks WHERE user_id=? ORDER BY updated_at DESC').all(user.id).map(taskJSON)));
        if(method==='POST'){
          const b=await body(req),tid=id('task'),stamp=now();const fields=['title','problem','must_have','flexible','uncertainties','reevaluate_when'].map(key=>textField(b[key],key,{required:key==='title',max:key==='title'?160:4000}));
          const phase=enumField(b.phase,['selection','adopted'],'阶段','selection'),status=enumField(b.status,TASK_STATUS,'状态','researching');
          const candidates=b.candidate_ids??[];if(!Array.isArray(candidates)||candidates.length>5||new Set(candidates).size!==candidates.length)fail(400,'VALIDATION','候选最多 5 项且不能重复');for(const eid of candidates)entityExists(eid);
          transaction(db,()=>{db.prepare('INSERT INTO research_tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(tid,user.id,...fields,phase,status,stamp,stamp);for(const eid of candidates)db.prepare('INSERT INTO task_candidates VALUES(?,?,?)').run(tid,eid,stamp);});
          return reply(taskJSON(owned('research_tasks',tid,user)),201);
        }
      }
      if((match=path.match(/^\/research-tasks\/([^/]+)(?:\/(comparison|candidates)(?:\/([^/]+))?)?$/))){
        const tid=decodeURIComponent(match[1]),task=owned('research_tasks',tid,user),action=match[2];
        if(!action&&method==='GET')return reply(taskJSON(task));
        if(!action&&method==='PATCH'){const b=await body(req);const sets=[],values=[];for(const key of ['title','problem','must_have','flexible','uncertainties','reevaluate_when'])if(key in b){sets.push(`${key}=?`);values.push(textField(b[key],key,{required:key==='title',max:key==='title'?160:4000}));}if('phase'in b){sets.push('phase=?');values.push(enumField(b.phase,['selection','adopted'],'阶段'));}if('status'in b){sets.push('status=?');values.push(enumField(b.status,TASK_STATUS,'状态'));}if(sets.length)db.prepare(`UPDATE research_tasks SET ${sets.join(',')},updated_at=? WHERE id=?`).run(...values,now(),tid);return reply(taskJSON(owned('research_tasks',tid,user)));}
        if(!action&&method==='DELETE'){await body(req);db.prepare('DELETE FROM research_tasks WHERE id=?').run(tid);return reply({ok:true});}
        if(action==='candidates'&&method==='POST'){const b=await body(req),eid=textField(b.entity_id,'候选对象',{required:true,max:150});entityExists(eid);const exists=db.prepare('SELECT 1 FROM task_candidates WHERE task_id=? AND entity_id=?').get(tid,eid);if(!exists&&db.prepare('SELECT count(*) n FROM task_candidates WHERE task_id=?').get(tid).n>=5)fail(409,'CANDIDATE_LIMIT','每个研究任务最多比较 5 个候选');db.prepare('INSERT OR IGNORE INTO task_candidates VALUES(?,?,?)').run(tid,eid,now());db.prepare('UPDATE research_tasks SET updated_at=? WHERE id=?').run(now(),tid);return reply(taskJSON(owned('research_tasks',tid,user)));}
        if(action==='candidates'&&match[3]&&method==='DELETE'){await body(req);db.prepare('DELETE FROM task_candidates WHERE task_id=? AND entity_id=?').run(tid,decodeURIComponent(match[3]));return reply(taskJSON(owned('research_tasks',tid,user)));}
        if(action==='comparison'&&method==='GET'){const t=taskJSON(task),candidates=t.candidate_ids.map(eid=>getEntity(db,eid));const dimensions=[...DIMENSIONS];for(const c of candidates)for(const a of c.assertions)if(!dimensions.some(d=>d.id===a.dimension))dimensions.push({id:a.dimension,label:a.label});return reply({task:t,candidates,dimensions,rows:dimensions.map(d=>({dimension:d.id,label:d.label,cells:candidates.map(c=>comparisonCell(c,d.id))})),warnings:['未知与缺少证据不等于不支持','请结合任务条件、版本和套餐范围判断',...(mode==='demo'?['比较内容为演示判断，不可用于真实选型']:[])]});}
      }

      if(path==='/watches'){
        needUser(user);
        if(method==='GET')return reply(list(db.prepare('SELECT * FROM watches WHERE user_id=? ORDER BY created_at DESC').all(user.id).map(watchJSON)));
        if(method==='POST'){const b=await body(req),eid=textField(b.entity_id,'对象',{required:true,max:150});entityExists(eid);const reason=textField(b.reason,'关注原因',{max:2000});const types=b.event_types??EVENT_TYPES;if(!Array.isArray(types)||types.some(t=>!EVENT_TYPES.includes(t))||types.length>EVENT_TYPES.length)fail(400,'VALIDATION','事件类型无效');const frequency=enumField(b.frequency,['daily','weekly','in_app'],'频率','in_app');const existing=db.prepare('SELECT * FROM watches WHERE user_id=? AND entity_id=?').get(user.id,eid);if(existing)return reply(watchJSON(existing));const wid=id('watch');db.prepare('INSERT INTO watches VALUES(?,?,?,?,?,?,?,?,?)').run(wid,user.id,eid,reason,JSON.stringify([...new Set(types)]),frequency,0,null,now());return reply(watchJSON(owned('watches',wid,user)),201);}
      }
      if((match=path.match(/^\/watches\/([^/]+)(?:\/(read))?$/))){const wid=decodeURIComponent(match[1]),watch=owned('watches',wid,user);if(method==='POST'&&match[2]==='read'){await body(req);db.prepare('UPDATE watches SET last_read_at=? WHERE id=?').run(now(),wid);return reply(watchJSON(owned('watches',wid,user)));}if(method==='PATCH'&&!match[2]){const b=await body(req);const reason=textField(b.reason,'关注原因',{max:2000,fallback:watch.reason}),frequency=enumField(b.frequency,['daily','weekly','in_app'],'频率',watch.frequency),paused=boolField(b.paused,'暂停',!!watch.paused),types=b.event_types??json(watch.event_types,[]);if(!Array.isArray(types)||types.some(t=>!EVENT_TYPES.includes(t))||types.length>EVENT_TYPES.length)fail(400,'VALIDATION','事件类型无效');db.prepare('UPDATE watches SET reason=?,frequency=?,paused=?,event_types=? WHERE id=?').run(reason,frequency,paused?1:0,JSON.stringify([...new Set(types)]),wid);if(paused||frequency==='in_app')db.prepare("UPDATE outbox SET status='cancelled',last_error='关注偏好已更改，请重新生成摘要' WHERE user_id=? AND status IN ('queued','retry','previewed')").run(user.id);return reply(watchJSON(owned('watches',wid,user)));}if(method==='DELETE'&&!match[2]){await body(req);db.prepare('DELETE FROM watches WHERE id=?').run(wid);db.prepare("UPDATE outbox SET status='cancelled',last_error='关注已删除' WHERE user_id=? AND status IN ('queued','retry','previewed')").run(user.id);return reply({ok:true});}}

      if(path==='/notes'){
        needUser(user);
        if(method==='GET'){const tid=url.searchParams.get('task_id'),eid=url.searchParams.get('entity_id');if(tid)owned('research_tasks',tid,user);return reply(list(db.prepare('SELECT * FROM notes WHERE user_id=? ORDER BY created_at DESC').all(user.id).filter(n=>(!tid||n.task_id===tid)&&(!eid||n.entity_id===eid))));}
        if(method==='POST'){const b=await body(req),eid=textField(b.entity_id,'对象',{max:150,fallback:null}),tid=textField(b.task_id,'任务',{max:150,fallback:null});if(!eid&&!tid)fail(400,'VALIDATION','备注需关联对象或研究任务');if(eid)entityExists(eid);if(tid)owned('research_tasks',tid,user);const nid=id('note'),stamp=now();db.prepare('INSERT INTO notes VALUES(?,?,?,?,?,?,?,?)').run(nid,user.id,eid,tid,textField(b.body,'备注',{required:true,max:12000}),enumField(b.status,TASK_STATUS,'状态','researching'),stamp,stamp);return reply(owned('notes',nid,user),201);}
      }
      if((match=path.match(/^\/notes\/([^/]+)$/))){const nid=decodeURIComponent(match[1]),note=owned('notes',nid,user);if(method==='PATCH'){const b=await body(req);db.prepare('UPDATE notes SET body=?,status=?,updated_at=? WHERE id=?').run(textField(b.body,'备注',{required:b.body!==undefined,max:12000,fallback:note.body}),enumField(b.status,TASK_STATUS,'状态',note.status),now(),nid);return reply(owned('notes',nid,user));}if(method==='DELETE'){await body(req);db.prepare('DELETE FROM notes WHERE id=?').run(nid);return reply({ok:true});}}

      if(method==='GET'&&path==='/digests'){needUser(user);return reply(list(db.prepare('SELECT * FROM digests WHERE user_id=? ORDER BY created_at DESC').all(user.id).map(digestJSON)));}
      if(method==='POST'&&path==='/digests/generate'){
        needUser(user);await body(req);const watches=db.prepare('SELECT * FROM watches WHERE user_id=? AND paused=0').all(user.id).map(watchJSON);const eventMap=new Map();
        for(const watch of watches)for(const event of watch.events)if(!watch.last_read_at||Date.parse(event.reviewed_at||event.observed_at)>Date.parse(watch.last_read_at))eventMap.set(event.id,event);
        let events=[...eventMap.values()].sort((a,b)=>a.id.localeCompare(b.id));if(!events.length)return reply({empty:true,message:'关注对象暂无新的已审核变化',events:[]});
        const key=hash(events.map(e=>`${e.id}:${e.reviewed_at||e.observed_at}`).join('|'));const existing=db.prepare('SELECT * FROM digests WHERE user_id=? AND window_key=?').get(user.id,key);if(existing)return reply({...digestJSON(existing),reused:true});
        events=findUnrecordedEvents(db,user.id,events);
        if(!events.length){const previous=db.prepare('SELECT * FROM digests WHERE user_id=? ORDER BY created_at DESC LIMIT 1').get(user.id);return reply(previous?{...digestJSON(previous),reused:true}:{empty:true,message:'这些变化已整理过',events:[]});}
        const did=id('digest');transaction(db,()=>{db.prepare('INSERT INTO digests VALUES(?,?,?,?,?,?,?)').run(did,user.id,`${now().slice(0,10)} · ${events.length} 条值得复核的变化`,now(),'ready',mode==='demo'?1:0,key);for(const event of events)db.prepare('INSERT INTO digest_events VALUES(?,?)').run(did,event.id);recordDigestVersions(db,did,events);if(user.email_opt_in&&watches.some(w=>w.frequency!=='in_app'))db.prepare('INSERT INTO outbox(id,user_id,digest_id,status,idempotency_key,created_at) VALUES(?,?,?,?,?,?)').run(id('mail'),user.id,did,'queued',`${user.id}:${key}`,now());});return reply(digestJSON(owned('digests',did,user)),201);
      }
      if(method==='GET'&&(match=path.match(/^\/digests\/([^/]+)$/)))return reply(digestJSON(owned('digests',decodeURIComponent(match[1]),user)));
      if(method==='POST'&&path==='/corrections'){needUser(user);const b=await body(req),eid=textField(b.entity_id,'对象',{max:150,fallback:null}),evid=textField(b.evidence_id,'证据',{max:200,fallback:null});if(eid)entityExists(eid);if(evid&&!db.prepare("SELECT 1 FROM evidence WHERE id=? AND review_status='published'").get(evid))fail(404,'NOT_FOUND','证据不存在');const cid=id('correction');db.prepare('INSERT INTO corrections(id,user_id,entity_id,evidence_id,description,url,status,created_at) VALUES(?,?,?,?,?,?,?,?)').run(cid,user.id,eid,evid,textField(b.description,'纠错描述',{required:true,max:6000}),safeURL(b.url),'pending',now());return reply({id:cid,status:'pending',message:'纠错已进入人工审核'},201);}
      if(method==='PATCH'&&path==='/preferences'){needUser(user);const b=await body(req),opt=boolField(b.email_opt_in,'邮件订阅',!!user.email_opt_in),timezone=textField(b.timezone,'时区',{max:80,fallback:user.timezone});if(mode==='production'&&opt&&!user.email)fail(409,'EMAIL_UNAVAILABLE','GitHub 公开资料尚未提供邮箱；请添加公开邮箱并重新登录，或继续使用站内摘要。');try{new Intl.DateTimeFormat('zh-CN',{timeZone:timezone});}catch{fail(400,'VALIDATION','时区无效');}transaction(db,()=>{db.prepare('UPDATE users SET email_opt_in=?,timezone=? WHERE id=?').run(opt?1:0,timezone,user.id);if(!opt)db.prepare("UPDATE outbox SET status='cancelled',last_error='用户已退订' WHERE user_id=? AND status IN ('queued','retry','previewed')").run(user.id);});return reply({user:publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(user.id)),email_opt_in:opt,timezone});}
      if(method==='GET'&&path==='/unsubscribe'){const key=url.searchParams.get('token');if(!key||key.length<32)fail(400,'INVALID_TOKEN','退订链接无效');const account=db.prepare('SELECT * FROM users WHERE unsubscribe_token=?').get(key);if(!account)fail(400,'INVALID_TOKEN','退订链接无效');transaction(db,()=>{db.prepare('UPDATE users SET email_opt_in=0 WHERE id=?').run(account.id);db.prepare("UPDATE outbox SET status='cancelled',last_error='用户已退订' WHERE user_id=? AND status IN ('queued','retry','previewed')").run(account.id);});return reply({ok:true,message:'已退订邮件，排队中的投递已停止。站内关注仍保留。'});}
      if(method==='GET'&&path==='/account/export'){needUser(user);res.setHeader('Content-Disposition','attachment; filename="radar-account-export.json"');return reply({exported_at:now(),user:publicUser(user),research_tasks:db.prepare('SELECT * FROM research_tasks WHERE user_id=?').all(user.id).map(taskJSON),watches:db.prepare('SELECT * FROM watches WHERE user_id=?').all(user.id).map(watchJSON),notes:db.prepare('SELECT * FROM notes WHERE user_id=?').all(user.id),digests:db.prepare('SELECT * FROM digests WHERE user_id=?').all(user.id).map(digestJSON),corrections:db.prepare('SELECT * FROM corrections WHERE user_id=?').all(user.id),orders:db.prepare('SELECT id,amount,currency,days,status,created_at,expires_at,refunded_at FROM orders WHERE user_id=?').all(user.id)});}
      if(method==='DELETE'&&path==='/account'){needUser(user);await body(req);audit(user,'account_deleted',user.id,'用户主动删除账户；财务记录去关联保留');deleteAccount(db,user.id);clearSession(req,res);return reply({ok:true,message:'账户和私有研究数据已删除，必要财务记录已去除账户关联'});}

      if(path.startsWith('/admin/')){
        needEditor(user);
        if(await editorial({path,method,req,user,reply}))return;
        if(method==='GET'&&path==='/admin/overview'){
          const businessAdmin=user.role==='admin';
          const editorialActions=['entity_created','evidence_created','evidence_review','evidence_deleted','event_created','event_publish','event_retract','event_correct','relation_created','relation_review','assertion_created','edition_created','correction_review','source_created','source_status'];
          const visibleAudit=businessAdmin?db.prepare('SELECT * FROM audit ORDER BY created_at DESC LIMIT 100').all():db.prepare(`SELECT * FROM audit WHERE action IN (${editorialActions.map(()=>'?').join(',')}) ORDER BY created_at DESC LIMIT 100`).all(...editorialActions);
          const counters=db.prepare('SELECT event,phase,cohort,count(*) count FROM analytics WHERE is_demo=? GROUP BY event,phase,cohort').all(mode==='demo'?1:0);
          const counts={users:db.prepare('SELECT count(*) n FROM users').get().n,tasks:db.prepare('SELECT count(*) n FROM research_tasks').get().n,watches:db.prepare('SELECT count(*) n FROM watches').get().n,notes:db.prepare('SELECT count(*) n FROM notes').get().n,digests:db.prepare('SELECT count(*) n FROM digests').get().n,corrections:db.prepare("SELECT count(*) n FROM corrections WHERE status='pending'").get().n,paid_orders:db.prepare("SELECT count(*) n FROM orders WHERE status='paid'").get().n};
          return reply({capabilities:{business_admin:businessAdmin},entities:db.prepare('SELECT id,kind,name,slug,review_status FROM entities ORDER BY name LIMIT 1000').all(),evidence:db.prepare('SELECT * FROM evidence ORDER BY fetched_at DESC LIMIT 200').all(),sources:db.prepare('SELECT * FROM sources').all(),jobs:db.prepare('SELECT * FROM jobs ORDER BY last_run_at DESC').all().map(j=>({...j,payload:json(j.payload_json,{})})),corrections:db.prepare('SELECT * FROM corrections ORDER BY created_at DESC LIMIT 100').all(),pending_events:db.prepare("SELECT * FROM events WHERE review_status!='published' ORDER BY observed_at DESC LIMIT 100").all().map(e=>({...getEvent(db,e),evidence:db.prepare('SELECT ev.* FROM evidence ev JOIN event_evidence ee ON ee.evidence_id=ev.id WHERE ee.event_id=?').all(e.id)})),relations:db.prepare('SELECT * FROM relations').all().map(r=>({...r,entity_name:db.prepare('SELECT name FROM entities WHERE id=?').get(r.entity_id)?.name,target_name:db.prepare('SELECT name FROM entities WHERE id=?').get(r.target_entity_id)?.name,evidence_ids:db.prepare('SELECT evidence_id FROM relation_evidence WHERE relation_id=?').all(r.id).map(e=>e.evidence_id)})),audit:visibleAudit,metrics:{...(businessAdmin?counts:{}),events:businessAdmin?counters:[],is_demo:mode==='demo',note:mode==='demo'?'演示使用情况，不能用于商业结论':'试点实际使用记录；付费与留存需按阶段、渠道、用户组分开解释'},costs:businessAdmin?db.prepare('SELECT * FROM costs ORDER BY created_at DESC LIMIT 100').all():[],orders:businessAdmin?db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 100').all():[],budget:businessAdmin?budgetStatus():null,quality:{published_events:db.prepare("SELECT count(*) n FROM events WHERE review_status='published'").get().n,pending_events:db.prepare("SELECT count(*) n FROM events WHERE review_status='pending'").get().n,missing_evidence:db.prepare("SELECT count(*) n FROM events e WHERE e.review_status='published' AND NOT EXISTS(SELECT 1 FROM event_evidence ee JOIN evidence ev ON ev.id=ee.evidence_id WHERE ee.event_id=e.id AND ev.review_status='published')").get().n,deleted_evidence:db.prepare('SELECT count(*) n FROM deletion_tombstones').get().n},outbox:businessAdmin?db.prepare('SELECT id,user_id,digest_id,status,created_at,last_error FROM outbox ORDER BY created_at DESC LIMIT 100').all():[],mode});
        }
        if(method==='PATCH'&&(match=path.match(/^\/admin\/sources\/([^/]+)$/))){needAdmin(user);const sid=decodeURIComponent(match[1]);if(!db.prepare('SELECT 1 FROM sources WHERE id=?').get(sid))fail(404,'NOT_FOUND','来源不存在');const b=await body(req),status=enumField(b.status,['active','approved','paused','blocked'],'来源状态'),reason=textField(b.reason,'审核理由',{required:true,max:2000});if(sid==='demo'&&status==='approved')fail(400,'VALIDATION','演示来源不能作为真实来源批准');transaction(db,()=>{db.prepare('UPDATE sources SET status=?,reason=?,permission_status=CASE WHEN ? IN (\'active\',\'approved\') AND id!=\'demo\' THEN \'approved\' ELSE permission_status END WHERE id=?').run(status,reason,status,sid);audit(user,'source_status',sid,reason);});return reply(db.prepare('SELECT * FROM sources WHERE id=?').get(sid));}
        if(method==='POST'&&(match=path.match(/^\/admin\/jobs\/([^/]+)\/retry$/))){needAdmin(user);const jid=decodeURIComponent(match[1]),job=db.prepare('SELECT * FROM jobs WHERE id=?').get(jid);if(!job)fail(404,'NOT_FOUND','任务不存在');await body(req);if(job.type!=='github_repository')fail(409,'JOB_NOT_RETRYABLE','此记录为调度配置或人工审核记录；请配置仓库后运行采集 Worker，具体失败的仓库任务支持重试。');if(job.status==='running')fail(409,'JOB_RUNNING','任务正在运行，请等待当前执行完成');if(budgetStatus().exhausted)fail(409,'BUDGET_EXHAUSTED','预算已耗尽，请先核查预算与成本');const source=db.prepare('SELECT * FROM sources WHERE id=?').get(job.source_id);if(!['active','approved'].includes(source?.status))fail(409,'SOURCE_PAUSED','来源未启用，请先审核来源权限');db.prepare("UPDATE jobs SET status='queued',attempts=0,next_run_at=?,last_error=NULL WHERE id=?").run(now(),jid);audit(user,'job_retry',jid,'进入后台处理队列');return reply({...db.prepare('SELECT * FROM jobs WHERE id=?').get(jid),message:'已排队；需运行采集工作进程执行'},202);}
        if(method==='POST'&&(match=path.match(/^\/admin\/events\/([^/]+)\/review$/))){const eid=decodeURIComponent(match[1]),event=db.prepare('SELECT * FROM events WHERE id=?').get(eid);if(!event)fail(404,'NOT_FOUND','事件不存在');const b=await body(req),action=enumField(b.action,['publish','retract','correct'],'审核动作'),reason=textField(b.reason,'审核理由',{required:true,max:2000});if(action==='correct'&&!b.title&&!b.summary)fail(400,'VALIDATION','更正需要填写标题或摘要');const title=textField(b.title,'标题',{max:240,fallback:event.title}),summary=textField(b.summary,'摘要',{max:6000,fallback:event.summary});if(!title||!summary)fail(400,'VALIDATION','标题和摘要不能为空');const evidence=db.prepare('SELECT ev.*,s.status source_status,s.permission_status source_permission FROM evidence ev JOIN event_evidence ee ON ee.evidence_id=ev.id LEFT JOIN sources s ON s.id=ev.source_id WHERE ee.event_id=?').all(eid);if(action!=='retract'&&(!evidence.length||evidence.some(e=>['blocked','revoked'].includes(e.source_status)||!['approved','permitted','demo'].includes(e.source_permission)||!['approved','permitted','demo'].includes(e.permission_status)||['deleted','rejected','retracted'].includes(e.review_status))))fail(409,'EVIDENCE_REQUIRED','发布必须具备可审核且允许使用的来源证据');transaction(db,()=>{if(action!=='retract')for(const e of evidence)db.prepare("UPDATE evidence SET review_status='published',reviewed_at=? WHERE id=?").run(now(),e.id);db.prepare('UPDATE events SET title=?,summary=?,review_status=?,reviewed_at=? WHERE id=?').run(title,summary,action==='retract'?'retracted':'published',now(),eid);if(action==='retract')db.prepare("UPDATE outbox SET status='cancelled',last_error='摘要内容已撤回' WHERE digest_id IN (SELECT digest_id FROM digest_events WHERE event_id=?) AND status IN ('queued','retry','previewed')").run(eid);audit(user,`event_${action}`,eid,reason);});return reply(getEvent(db,db.prepare('SELECT * FROM events WHERE id=?').get(eid)));}
        if(method==='POST'&&(match=path.match(/^\/admin\/relations\/([^/]+)\/review$/))){const rid=decodeURIComponent(match[1]);if(!db.prepare('SELECT 1 FROM relations WHERE id=?').get(rid))fail(404,'NOT_FOUND','关系不存在');const b=await body(req),status=enumField(b.status,['confirmed','rejected','needs_review'],'审核状态'),reason=textField(b.reason,'审核理由',{required:true,max:2000});if(status==='confirmed'&&!evidenceSet(db,'relation_evidence','relation_id',rid,{requireCurrentPermission:true}).valid)fail(409,'EVIDENCE_REQUIRED','确认关系必须有已审核证据');db.prepare('UPDATE relations SET status=?,reason=?,reviewed_at=? WHERE id=?').run(status,reason,now(),rid);audit(user,'relation_review',rid,reason);return reply(db.prepare('SELECT * FROM relations WHERE id=?').get(rid));}
        if(method==='POST'&&(match=path.match(/^\/admin\/corrections\/([^/]+)\/review$/))){const cid=decodeURIComponent(match[1]);if(!db.prepare('SELECT 1 FROM corrections WHERE id=?').get(cid))fail(404,'NOT_FOUND','纠错不存在');const b=await body(req),status=enumField(b.status,['resolved','rejected'],'处理结果'),reason=textField(b.reason,'处理说明',{required:true,max:2000});db.prepare('UPDATE corrections SET status=?,reason=?,reviewed_at=? WHERE id=?').run(status,reason,now(),cid);audit(user,'correction_review',cid,reason);return reply(db.prepare('SELECT * FROM corrections WHERE id=?').get(cid));}
        if(method==='POST'&&(match=path.match(/^\/admin\/evidence\/([^/]+)\/delete$/))){needAdmin(user);const evid=decodeURIComponent(match[1]);if(!db.prepare('SELECT 1 FROM evidence WHERE id=?').get(evid))fail(404,'NOT_FOUND','证据不存在');const b=await body(req),reason=textField(b.reason,'删除理由',{required:true,max:2000});deleteEvidence(db,evid,reason,user);return reply({ok:true,message:'来源摘录已删除，事件、判断、版本、关系与待投递摘要已同步撤回'});}
        if(method==='POST'&&path==='/admin/costs'){needAdmin(user);const b=await body(req),cid=id('cost');db.prepare('INSERT INTO costs VALUES(?,?,?,?,?,?,?)').run(cid,textField(b.category,'成本类别',{required:true,max:80}),numField(b.amount,'金额'),numField(b.minutes,'人工分钟',{fallback:0}),textField(b.note,'说明',{required:true,max:2000}),now(),user.id);audit(user,'cost_recorded',cid,'人工成本记录');return reply(db.prepare('SELECT * FROM costs WHERE id=?').get(cid),201);}
        if(method==='POST'&&path==='/admin/orders'){needAdmin(user);const b=await body(req),uid=textField(b.user_id,'账户',{required:true,max:150});if(!db.prepare('SELECT 1 FROM users WHERE id=?').get(uid))fail(404,'NOT_FOUND','账户不存在');const amount=numField(b.amount,'已核款金额',{min:0.01}),currency=enumField(b.currency,['CNY'],'币种','CNY'),reference=textField(b.reference,'核款凭证编号',{required:true,max:200}),days=numField(b.days,'有效天数',{min:1,max:365,integer:true,fallback:30});if(db.prepare('SELECT 1 FROM orders WHERE reference=?').get(reference))fail(409,'DUPLICATE_REFERENCE','该核款凭证已记录');const oid=id('order');db.prepare('INSERT INTO orders(id,user_id,amount,currency,reference,days,status,created_at,expires_at,actor_id) VALUES(?,?,?,?,?,?,?,?,?,?)').run(oid,uid,amount,currency,reference,days,'paid',now(),new Date(Date.now()+days*86400000).toISOString(),user.id);audit(user,'manual_payment_recorded',oid,'管理员核实外部收款后手工登记；系统未执行收款');return reply(db.prepare('SELECT * FROM orders WHERE id=?').get(oid),201);}
        if(method==='POST'&&(match=path.match(/^\/admin\/orders\/([^/]+)\/refund$/))){needAdmin(user);const oid=decodeURIComponent(match[1]),order=db.prepare('SELECT * FROM orders WHERE id=?').get(oid);if(!order)fail(404,'NOT_FOUND','订单不存在');const b=await body(req),reason=textField(b.reason,'退款说明',{required:true,max:2000});if(order.status==='refunded')return reply({...order,reused:true});db.prepare("UPDATE orders SET status='refunded',refunded_at=?,refund_reason=? WHERE id=?").run(now(),reason,oid);audit(user,'manual_refund_recorded',oid,reason);return reply({...db.prepare('SELECT * FROM orders WHERE id=?').get(oid),message:'已记录人工退款；资金退回需通过原收款渠道完成'});}
        if(method==='PATCH'&&path==='/admin/budget'){needAdmin(user);const b=await body(req),existing=budgetStatus(),daily=numField(b.daily_limit,'日预算',{fallback:existing.daily_limit}),monthly=numField(b.monthly_limit,'月预算',{fallback:existing.monthly_limit});if(daily>monthly)fail(400,'VALIDATION','日预算不能高于月预算');db.prepare('UPDATE budget SET daily_limit=?,monthly_limit=?,updated_at=? WHERE id=1').run(daily,monthly,now());audit(user,'budget_changed','1',`日预算 ${daily}；月预算 ${monthly}`);return reply(budgetStatus());}
      }
      fail(404,'NOT_FOUND','接口不存在');
    }catch(error){if(res.headersSent){res.destroy();return;}const status=error.status||(error instanceof URIError?400:500);if(status===500&&options.logErrors!==false)console.error(`[${requestId}]`,error.message);send(res,status,{error:{code:error.code||(status===400?'INVALID_PATH':'INTERNAL_ERROR'),message:status===500?'服务暂时无法完成请求，请稍后重试':error.message},request_id:requestId});}
  });
  server.requestTimeout=30000;server.headersTimeout=15000;server.maxHeadersCount=60;
  return {server,db,mode,dbPath,listen(port=Number(process.env.PORT||4188),host=process.env.HOST||'127.0.0.1'){return new Promise((resolveListen,reject)=>{server.once('error',reject);server.listen(port,host,()=>{server.removeListener('error',reject);resolveListen(server.address());});});},async close(){if(server.listening)await new Promise((ok,no)=>server.close(e=>e?no(e):ok()));db.close();}};
}

function serveStatic(req,res,pathname,distPath){
  if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);return res.end();}
  if(!existsSync(distPath)){res.writeHead(503,{'Content-Type':'text/plain; charset=utf-8'});return res.end('前端尚未构建。开发请启动开发服务；部署前请执行构建。');}
  let decoded;try{decoded=decodeURIComponent(pathname);}catch{res.writeHead(400);return res.end();}
  const base=realpathSync(distPath);let target=resolve(base,`.${decoded}`);
  if(target!==base&&!target.startsWith(base+sep)){res.writeHead(403);return res.end();}
  if(!existsSync(target)||!statSync(target).isFile())target=resolve(base,'index.html');
  if(!existsSync(target)){res.writeHead(404);return res.end();}
  target=realpathSync(target);if(!target.startsWith(base+sep)){res.writeHead(403);return res.end();}
  const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.woff2':'font/woff2','.json':'application/json'};
  res.writeHead(200,{'Content-Type':types[extname(target)]||'application/octet-stream','Cache-Control':extname(target)==='.html'?'no-cache':'public, max-age=3600'});if(req.method==='HEAD')return res.end();createReadStream(target).on('error',()=>res.destroy()).pipe(res);
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const app=createApp();const address=await app.listen();console.log(`Open Product Radar (${app.mode}) http://${address.address}:${address.port}`);
  let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;await app.close();process.exit(0);};process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
