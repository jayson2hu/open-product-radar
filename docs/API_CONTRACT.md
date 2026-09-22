# 首版接口契约 v1

统一 `/api/v1`。JSON API；错误 `{error:{code,message},request_id}`。列表 `{data:[],as_of,coverage,warnings:[]}`。日期 UTC ISO。页面中文。所有写请求同源校验，私有资源按用户授权。开发模式本机显式进入演示账户；生产关闭演示认证，GitHub OAuth。

## 前后端共享形状

Entity: `{id,kind:'repository'|'product',name,owner,slug,description,original_description,topic,language,license,website,repository_url,docs_url,stars,delta_24h,delta_7d,trend_status:'comparable'|'insufficient'|'incomparable',observed_at,first_seen_at,created_at,is_demo,featured,review_status,tags:[],editions:[],assertions:[],relations:[],events:[]}`。assertion: `{id,dimension,label,status:'supported'|'limited'|'unsupported'|'unknown',value,scope,evidence_ids:[]}`。edition `{id,name,deployment,price,currency,billing_period,version,evidence_ids:[]}`。

Evidence: `{id,title,url,excerpt,source_name,published_at,fetched_at,reviewed_at,review_status,is_demo,permission_status}`。
Event: `{id,entity_id,entity_name,title,summary,type,published_at,observed_at,reviewed_at,review_status,evidence_ids:[],is_demo}`。type `release|capability|pricing|deployment|issue|discovery|correction`。
Task: `{id,title,problem,must_have,flexible,uncertainties,reevaluate_when,phase:'selection'|'adopted',status:'researching'|'trial'|'adopted'|'watching'|'rejected',candidate_ids:[],created_at,updated_at}`。文本约束均为字符串。Task 私有。
Watch: `{id,entity_id,entity,reason,event_types:[],frequency:'daily'|'weekly'|'in_app',paused,last_read_at,unread_count,events:[]}`。
Note: `{id,entity_id,task_id,body,status,created_at}` 私有。
Digest: `{id,title,created_at,events:[],status,is_demo}`。
User: `{id,name,email,role:'user'|'editor'|'admin',email_opt_in}`。

## 公开

- GET `/health` 返回 `{status,mode,version}`
- GET `/session` 返回 `{user:null|User,mode:'demo'|'production',csrf_token?,capabilities:{auth:{github_enabled,demo_enabled,login_available,unavailable_reason?},collection_scope:{kind:'curated_public_repositories',automatic_discovery:false,realtime:false}}}`。能力字段不包含密钥；登录不可用时页面解释当前可浏览范围。
- POST `/auth/demo` 创建独立演示账户，返回 `{user}`；POST `/auth/logout`
- GET `/auth/github` 与 `/auth/github/callback` 生产 OAuth
- GET `/feed?period=24h|7d&topic=&language=&q=&kind=` 返回 `{data:Entity[],events:Event[],stats:{repositories,products,events,sources},as_of,coverage,warnings,mode}`
- GET `/repositories`、`/products`、`/entities` 支持 q/topic/language/period/sort/limit
- GET `/entities/:id` 返回 Entity（包含 editions/assertions/relations/events）
- GET `/entities/:id/changes`、`/entities/:id/relations` 返回列表
- GET `/evidence/:id` 返回 Evidence
- POST `/analytics` body `{event,entity_id?,task_id?,phase?,channel?,cohort?}` 仅允许白名单事件

## 私有

- GET/POST `/research-tasks`; GET/PATCH/DELETE `/research-tasks/:id`
- POST `/research-tasks/:id/candidates` body `{entity_id}`；DELETE `/research-tasks/:id/candidates/:entity_id`；最多5项
- GET `/research-tasks/:id/comparison` 返回 `{task,candidates:Entity[],dimensions:[{id,label}],rows:[{dimension,label,cells:[{entity_id,status,value,scope,evidence_ids:[]}]}],warnings:[]}`
- GET/POST `/watches`; PATCH/DELETE `/watches/:id`；POST `/watches/:id/read`
- GET/POST `/notes`; PATCH/DELETE `/notes/:id`
- GET `/digests`; GET `/digests/:id`; POST `/digests/generate`
- POST `/corrections` body `{entity_id?,evidence_id?,description,url?}` 始终待审核
- PATCH `/preferences` body `{email_opt_in,timezone?}`；GET `/account/export`；DELETE `/account`
- GET `/unsubscribe?token=` 退订且停止排队投递

## 后台（服务端角色校验）

- GET `/admin/overview` 返回 `{sources:[],jobs:[],corrections:[],pending_events:[],relations:[],audit:[],metrics:{},costs:[],orders:[],budget:{},quality:{}}`
- PATCH `/admin/sources/:id` `{status,reason}`；POST `/admin/jobs/:id/retry`
- POST `/admin/events/:id/review` `{action:'publish'|'retract'|'correct',reason,title?,summary?}`
- POST `/admin/relations/:id/review` `{status:'confirmed'|'rejected'|'needs_review',reason}`
- POST `/admin/corrections/:id/review` `{status:'resolved'|'rejected',reason}`
- POST `/admin/evidence/:id/delete` `{reason}` 传播撤回衍生内容
- POST `/admin/costs` `{category,amount,minutes,note}`
- POST `/admin/orders` `{user_id,amount,currency:'CNY',reference,days:30}` 人工记录已核款订单；POST `/admin/orders/:id/refund` `{reason}`
- PATCH `/admin/budget` `{daily_limit,monthly_limit}`

首版响应添加字段保持向后兼容。用户界面不根据缺少字段自行推断事实。演示数据库和实采数据库用独立路径，禁止混合排名。

### 2026-09-22 检查后补充

- `/feed` 增加 `content_status:{repositories,products,published_events,pending_events,pending_release_events}`；实体详情也提供与该实体对应的事件计数及 `collection`。待审内容只公开计数，正文仍需编辑权限。
- 列表响应增加 `sort:{requested,effective,period,comparable_count}`，页面按服务端实际排序解释。缺少增长对照时不得显示增长名次。
- 比较单元格存在不同版本、套餐或条件的判断时，返回 `status:'unknown'`、范围提示和 `variants:[{id,status,value,scope,evidence_ids}]`，不任取第一条结论。
- `/admin/overview` 增加 `capabilities.business_admin`。编辑可处理内容，但 `costs/orders/outbox` 为空、`budget` 为 null，用户与经营统计及相关审计不返回。来源启停、任务重试、删除、订单与预算变更仅管理员可执行。
- 每次身份校验都按当前管理员 GitHub 数值 ID 名单核对权限；移除名单后旧会话不保留管理员身份。
- 多来源内容只有在全部引用均可展示时才能公开。公开关系不返回内部审核 `reason`。

## 编辑录入（已落地）

以下接口需要编辑或管理员角色；新增/启用来源、经营和预算变更仅管理员。

- POST `/admin/sources`：`{id,name,url,terms_url?,collection_method:'manual'|'public_api'|'official_page'|'rss',reason,retention_days?}`。来源默认暂停、权限待审。审核并启用来源同时确认统一权限状态；必须记录原因。
- POST `/admin/entities`：`{kind,name,slug,description,topic,owner?,language?,license?,website?,repository_url?,docs_url?}`。基本档案由编辑建档；版本和能力另附证据。
- POST `/admin/evidence`：`{entity_id,source_id,title,url,excerpt,published_at?}`。待审，不自动请求用户提供的 URL。
- POST `/admin/evidence/:id/review`：`{status:'published'|'rejected',reason}`。来源必须允许使用。
- POST `/admin/events`：`{entity_id,title,summary,type,evidence_ids,published_at?}`。先待审核，再通过 event review 发布。没有源发布时间保留空。
- POST `/admin/assertions`：`{entity_id,dimension,label,status,value,scope,evidence_ids}`。scope 明确版本、套餐、部署；非 unknown 必须引用已审核证据。
- POST `/admin/editions`：`{entity_id,name,deployment:'self_hosted'|'cloud'|'hybrid'|'unknown',version,price?,currency?,billing_period?,evidence_ids}`。未知价格留空；币种 CNY/USD/EUR/GBP/JPY；周期 one_time/month/year/usage/free。
- POST `/admin/relations`：`{entity_id,target_entity_id,type,reason?,evidence_ids}`。type 为 official_product/hosted_version/developed_by/compatible_with/alternative/candidate；仅创建待复核关系。

`admin/overview` 还提供 `entities`、`evidence`、`outbox`，待审证据仅通过授权后台返回。公开关系返回 `related_entity_id/related_name/direction` 以正确显示双向关联。列表最大 200 条，当前为首版有界列表，尚无完整 cursor 翻页接口。

## 行为名称

实现使用 feed_view/entity_view/evidence_view/task_created/candidate_added/comparison_view/watch_created/digest_view/note_created/decision_updated/correction_submitted 等白名单名称；与原规格 sample_viewed/source_opened/comparison_viewed/watch_added/action_reported 做语义映射。仅记录对象、阶段、渠道与分组，不发送笔记正文。手工订单/退款来自后台核验，前端点击不能伪造支付完成埋点。
