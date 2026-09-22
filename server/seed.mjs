import { now, transaction } from './db.mjs';

/** Deliberately synthetic fixtures. Never loaded into a production database. */
export function seedDemo(db) {
  if (db.prepare("SELECT value FROM database_meta WHERE key='mode'").get()?.value !== 'demo') throw new Error('Cannot seed demo data into production');
  if (db.prepare('SELECT count(*) AS n FROM entities').get().n) return;
  const observed = now();
  const ago = (hours) => new Date(Date.now() - hours * 3600000).toISOString();
  const items = [
    ['playwright','repository','Playwright','microsoft','端到端浏览器自动化与测试工具，支持多种浏览器。','TypeScript','Apache-2.0',78640,164,1092,'comparable','https://github.com/microsoft/playwright'],
    ['puppeteer','repository','Puppeteer','puppeteer','通过 JavaScript 控制 Chrome 和 Firefox 的浏览器自动化工具。','TypeScript','Apache-2.0',92520,67,431,'comparable','https://github.com/puppeteer/puppeteer'],
    ['browser-use','repository','Browser Use','browser-use','为 AI 代理连接浏览器操作能力；可靠性需要结合业务流程实测。','Python','MIT',71180,286,1824,'comparable','https://github.com/browser-use/browser-use'],
    ['stagehand','repository','Stagehand','browserbase','面向开发者的浏览器交互工具，结合代码与自然语言操作。','TypeScript','MIT',15430,132,740,'comparable','https://github.com/browserbase/stagehand'],
    ['selenium','repository','Selenium','SeleniumHQ','跨浏览器自动化工具生态，适合已有 WebDriver 工作流。','Java','Apache-2.0',33510,21,122,'comparable','https://github.com/SeleniumHQ/selenium'],
    ['cypress','repository','Cypress','cypress-io','面向 Web 应用的测试工具，选择前核对运行环境与许可条件。','JavaScript','MIT',47820,-13,-29,'comparable','https://github.com/cypress-io/cypress'],
    ['robotframework','repository','Robot Framework','robotframework','基于关键字的自动化框架，浏览器能力依赖适配库与运行环境。','Python','Apache-2.0',10640,8,56,'comparable','https://github.com/robotframework/robotframework'],
    ['drissionpage','repository','DrissionPage','g1879','Python 网页自动化工具；首次观察尚不足以建立增长基线。','Python','待核查',10380,null,null,'insufficient','https://github.com/g1879/DrissionPage'],
    ['browserbase','product','Browserbase','','托管浏览器基础设施。套餐、区域与并发条件需按官方资料核查。',null,null,null,null,null,'insufficient','https://www.browserbase.com'],
    ['browserless','product','Browserless','','提供浏览器运行与连接能力；自托管和云服务应分开评估。',null,null,null,null,null,'insufficient','https://www.browserless.io'],
    ['apify','product','Apify','','面向数据采集与自动化任务的平台。计费、额度与数据使用范围需分别确认。',null,null,null,null,null,'insufficient','https://apify.com'],
    ['steel','product','Steel','','浏览器基础设施产品；部署与功能范围请以选定版本证据为准。',null,null,null,null,null,'insufficient','https://steel.dev'],
  ];
  transaction(db, () => {
    db.prepare('INSERT OR IGNORE INTO sources(id,name,url,status,permission_status,collection_method,reason,last_success_at) VALUES(?,?,?,?,?,?,?,?)')
      .run('demo','演示资料库','https://example.com','active','demo','fixture','人工编写的交互演示数据，非实时采集',observed);
    const insert = db.prepare(`INSERT INTO entities(id,kind,name,owner,slug,description,original_description,topic,language,license,website,repository_url,docs_url,stars,delta_24h,delta_7d,trend_status,observed_at,first_seen_at,created_at,is_demo,featured,review_status,extra_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const [id,kind,name,owner,description,language,license,stars,d24,d7,trend,url] of items) {
      insert.run(id,kind,name,owner,id,description,description,'浏览器自动化',language,license,url,kind==='repository'?url:null,url,stars,d24,d7,trend,observed,ago(id==='drissionpage'?3:240),null,1,id==='playwright'||id==='browser-use'?1:0,'published',JSON.stringify({tags:kind==='repository'?['浏览器自动化',language]:['云服务','待验证'],trend_note:trend==='insufficient'?'缺少可比历史样本':null}));
      const ev = `ev-${id}`;
      db.prepare('INSERT INTO evidence(id,entity_id,source_id,title,url,excerpt,source_name,published_at,fetched_at,reviewed_at,review_status,is_demo,permission_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(ev,id,'demo',`${name} 官方入口 · 演示证据`,url,'【演示摘录】用于展示来源、适用范围和审核流程。本摘录及以下结构化判断未经过真实采集或核验，不可作为选型结论。','演示资料库',null,observed,observed,'published',1,'demo');
      db.prepare('INSERT INTO entity_evidence(entity_id,evidence_id,field) VALUES(?,?,?)').run(id,ev,'description');
      const dims = [
        ['deployment','部署方式',kind==='repository'?'supported':'unknown',kind==='repository'?'可在自有环境运行（演示）':'具体部署形态待核查','以选定发行版本、依赖及运行环境为准'],
        ['browser','浏览器覆盖',id==='playwright'?'supported':'limited',id==='playwright'?'Chromium / Firefox / WebKit（演示）':'支持范围需结合任务验证','浏览器版本与操作系统条件尚未完成实测'],
        ['license','许可条件',license&&license!=='待核查'?'limited':'unknown',license||'套餐条款待核查','仓库许可不代表关联云服务条款；请逐版本确认'],
        ['cost','运行成本','unknown','暂无经核实的可比成本','云套餐、模型调用、运维和人工时间须分别记录'],
        ['reliability','业务可靠性','unknown','未完成目标业务场景实测','登录态、验证码、页面变化、失败恢复需验证'],
      ];
      for (const [dimension,label,status,value,scope] of dims) {
        const aid = `assert-${id}-${dimension}`;
        db.prepare('INSERT INTO assertions(id,entity_id,dimension,label,status,value,scope) VALUES(?,?,?,?,?,?,?)').run(aid,id,dimension,label,status,value,scope);
        if (status!=='unknown') db.prepare('INSERT INTO assertion_evidence VALUES(?,?)').run(aid,ev);
      }
      const eid = `edition-${id}`;
      db.prepare('INSERT INTO editions(id,entity_id,name,deployment,price,currency,billing_period,version) VALUES(?,?,?,?,?,?,?,?)').run(eid,id,kind==='repository'?'开源发行版（演示）':'云服务套餐（待核验）',kind==='repository'?'self_hosted':'cloud',null,null,null,'未核实具体版本');
      db.prepare('INSERT INTO edition_evidence VALUES(?,?)').run(eid,ev);
      if (stars!=null) {
        for (const [hours,delta] of [[0,0],...(trend==='comparable'?[[24,d24],[168,d7]]:[])]) {
          db.prepare('INSERT INTO snapshots(id,entity_id,stars,observed_at,source_id,metric_version,scope) VALUES(?,?,?,?,?,?,?)').run(`snap-${id}-${hours}`,id,stars-delta,ago(hours),'demo','stars-v1','public');
        }
      }
    }
    const events = [
      ['playwright','release','示例：版本更新进入评估','演示事件：新增浏览器兼容性变更，升级前检查现有测试与运行环境。',3,'published'],
      ['browser-use','capability','示例：浏览器会话能力变化','演示事件：会话复用能力发生变化，建议重新验证登录态保持与失败恢复。',7,'published'],
      ['browserbase','pricing','示例：套餐条件待复核','演示事件：并发与时长条件可能影响部署成本。具体报价尚未核实。',11,'published'],
      ['stagehand','release','示例：发布记录已收录','演示事件：先核对适用版本，再判断是否影响当前任务。',19,'published'],
      ['selenium','issue','示例：兼容性问题影响排查','演示事件：问题报告需要核对复现条件，不能解释为所有用户均受影响。',35,'published'],
      ['browserless','deployment','示例：部署说明变化','演示事件：自托管说明与云服务能力应分别核对。',49,'published'],
      ['apify','capability','示例：新能力等待编辑审核','演示待审草稿，不出现在公开事件流。',2,'pending'],
    ];
    for (const [id,type,title,summary,hours,status] of events) {
      const eid=`event-${id}-${type}`;
      db.prepare('INSERT INTO events(id,entity_id,title,summary,type,published_at,observed_at,reviewed_at,review_status,is_demo,dedupe_key) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(eid,id,title,summary,type,ago(hours),ago(hours),status==='published'?observed:null,status,1,eid);
      db.prepare('INSERT INTO event_evidence VALUES(?,?)').run(eid,`ev-${id}`);
    }
    for (const [from,to,type,status,reason] of [['stagehand','browserbase','developed_by','confirmed','演示关系：展示关系证据与审核状态'],['playwright','browserbase','compatible_with','confirmed','演示兼容关系，不代表同一产品或完全等价'],['puppeteer','browserless','compatible_with','confirmed','演示兼容关系，适用版本需核对'],['browser-use','steel','candidate','needs_review','仅为候选关系，尚未确认']]) {
      const rid=`rel-${from}-${to}`;
      db.prepare('INSERT INTO relations(id,entity_id,target_entity_id,type,status,reason,reviewed_at) VALUES(?,?,?,?,?,?,?)').run(rid,from,to,type,status,reason,status==='confirmed'?observed:null);
      db.prepare('INSERT INTO relation_evidence VALUES(?,?)').run(rid,`ev-${to}`);
    }
    db.prepare('INSERT INTO jobs(id,source_id,type,status,attempts,last_run_at,last_error) VALUES(?,?,?,?,?,?,?)').run('demo-review','demo','editorial_review','completed',1,observed,null);
  });
}
