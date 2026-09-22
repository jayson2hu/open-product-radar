# 数据字典与流转

实际结构以 `server/db.mjs` 中的版本化迁移为准；Worker 的附加租约、缓存与投递表由 `initializeWorkerSchema` 幂等建立。所有数据库时间为 UTC ISO 文本，客户端按显示时区转换。

| 数据组 | 内容与约束 |
|---|---|
| database_meta / schema_migrations | mode 固定 demo 或 production；记录迁移版本，拒绝模式混用 |
| users / sessions / oauth_states | 公开身份、独立邮件订阅、随机会话哈希和限时 OAuth 状态；角色在服务端校验 |
| sources | 来源地址、启停状态、权限、采集方式、最后成功与错误、条款入口 |
| entities | 仓库和产品；实采 GitHub 使用数值稳定 ID，不以名称当身份；首次发现与源创建时间分开 |
| snapshots | 实体、来源、指标版本、scope、观测时间与 Star 总数；失败不会插入零 |
| evidence | 原始出处、允许摘录、内容哈希、源发布时间、获取/审核时间、权限与发布状态 |
| editions / edition_evidence | 交付形态、部署、版本、价格/币种/周期与证据；未知价格留空 |
| assertions / assertion_evidence | 能力维度、支持状态、具体解释、适用范围与多证据关系 |
| relations / relation_evidence | 实体间多对多关系、候选或确认状态；证据不足不能确认 |
| events / event_evidence | 多次版本归属同一实体；去重键防重复；纠错保留操作记录 |
| research_tasks / task_candidates | 用户私有任务、条件、阶段与判断；最多五个不同候选 |
| watches / notes | 用户私有关注理由、事件类型、频率、已读与暂停；笔记可删除 |
| digests / digest_events / outbox | 摘要及事件关联、投递唯一键、排队/预览/已发/失败/不确定状态 |
| jobs / worker_leases | 至少一次任务、尝试数、重试时间、排他租约；来源限流跨任务生效 |
| worker_budget_usage / budget / costs | 请求配额、成本额度、实际金额与工时；上限到达暂停新任务 |
| corrections / audit | 用户纠错、审核状态、操作者与原因；不记录密钥和完整私人笔记 |
| orders | 人工核验订单引用唯一、有效期、退款；演示经营数据与正式数据隔离 |
| analytics | 允许事件、对象、阶段、组别和渠道；不是用户完成真实研究的自动判定 |
| deletion_tombstones / account_deletions | 最小删除标记，用于阻止重复采入并在恢复时重放 |

## 可比较规则

24 小时只接受 23–25 小时基准，7 天只接受 167–169 小时；实体、来源、指标版本和 scope 一致。无基准为 insufficient；有历史但超出区间或口径不一致为 incomparable。负值保留；零基数不算增长率。实际区间保存在 trend_24h / trend_7d，不将 Star 创建历史与总数差相混。

## 发布规则

真实采集保存公开元数据和原始快照，证据及事件先待审核。编辑明确核查后发布。证据撤销时，关联事实失效、关系待复核、事件停止展示、待发摘要取消。暂停来源表示暂不刷新，应保留合法历史并提示最后成功时间。

## 首版模型限制

没有通用全文索引、向量库、多人团队空间或自动实体合并。套餐范围通过 edition 与 assertion scope 表达，尚无任意历史版本查询 UI。独立问题实体、可撤销合并、来源按操作的细粒度权限台账和正式 PostgreSQL 迁移列入后续工作，不能通过通用 JSON 字段宣称全部实现。
