const finite = value => typeof value === 'number' && Number.isFinite(value);

export function trendPresentation(entity, period = '24h') {
  const windowName = period === '7d' ? '7 天' : '24 小时';
  const detail = period === '7d' ? entity.trend_7d : entity.trend_24h;
  const value = period === '7d' ? entity.delta_7d : entity.delta_24h;
  const status = detail?.status || entity.trend_status;
  if (status === 'comparable' && finite(value)) {
    return { comparable: true, value, windowName, label: '已有增长对比', reason: '', description: `用最新 Star 总量减去约 ${windowName} 前的记录，得到这段时间的净变化。负数表示累计 Stars 减少。` };
  }
  if (!finite(entity.stars)) {
    return { comparable: false, windowName, label: '暂无总量', reason: '尚无有效记录', description: '目前尚未取得有效的 Star 总量，因此也无法计算净变化。请查看来源采集状态。' };
  }
  if (status === 'incomparable') {
    const interval = finite(detail?.interval_hours) ? `现有记录相隔 ${Number(detail.interval_hours.toFixed(1))} 小时，` : '';
    return { comparable: false, windowName, label: '暂不能比', reason: '记录条件不符', description: `${interval}还不能代表所选的 ${windowName}。需要时间间隔合适、统计范围相同的前后两次记录；这不代表零增长。` };
  }
  return { comparable: false, windowName, label: '待对比', reason: '缺少早期记录', description: `当前 Star 总量已经采集，但缺少约 ${windowName} 前的有效记录，暂时无法算出这段时间增加或减少了多少。这不代表零增长，也不代表本次采集失败。` };
}

export function scheduleExplanation(collection) {
  const sources = Array.isArray(collection?.sources) ? collection.sources : [];
  if (sources.length && sources.every(source => source.schedule_status === 'disabled')) {
    return '持续采集尚未启用。仅等待 24 小时或 7 天不会自动产生增长数据；需要在之后再次采集，才能形成前后对比。';
  }
  if (sources.some(source => source.schedule_status === 'blocked')) {
    return '部分来源的持续采集受阻。需要恢复采集并取得合适时间的记录，才能更新增长对比。';
  }
  if (sources.some(source => source.schedule_status === 'unverified')) {
    return '尚未确认持续采集已在运行。经过 24 小时或 7 天并不保证页面自动更新，还需要后续实际采集的记录。';
  }
  return '增长对比需要前后两次实际采集。仅仅经过 24 小时或 7 天，并不会产生新的记录。';
}

export function loginPresentation(session) {
  const auth = session.capabilities?.auth;
  const demo = session.mode === 'demo' && auth?.demo_enabled !== false;
  const github = session.mode === 'production' && auth?.github_enabled === true && auth?.login_available === true;
  return {
    demo, github, available: demo || github,
    confirmed: !!session.mode,
    reason: auth?.unavailable_reason || (session.mode === 'production'
      ? '当前预览尚未开放账户登录。你可以继续查看真实项目和原始出处；研究任务、跟踪和私有笔记需在登录开放后保存。'
      : '尚未确认登录服务是否可用，请稍后重试。'),
  };
}

export function sortingPresentation(sort, entities, period, kind) {
  const comparable = entities.filter(entity => entity.kind === 'repository' && trendPresentation(entity, period).comparable).length;
  const effective = sort?.effective;
  if (effective === 'growth' && comparable > 0) return `${period === '7d' ? '7 天' : '24 小时'} Star 净变化`;
  if (effective === 'stars') return '当前 Star 总量';
  if (effective === 'recent') return '最近收录时间';
  if (effective === 'name' || comparable === 0) return `${kind === 'product' ? '产品' : '项目'}名称 · 非增长排名`;
  return '按来源返回顺序浏览';
}

export function productEmptyPresentation(content = {}, events = false) {
  const hasRepositories = finite(content.repositories) && content.repositories > 0;
  const noProducts = content.products === 0;
  const pending = finite(content.pending_release_events) && content.pending_release_events > 0 ? content.pending_release_events : 0;
  return {
    title: noProducts && hasRepositories ? '仓库已采集，产品档案尚待整理' : events ? '暂无已发布的产品变化' : '这个范围暂无产品档案',
    description: noProducts && hasRepositories
      ? '当前已收录开源仓库。仓库与独立产品分别建档，采集仓库不会自动生成产品档案。'
      : '这里展示已建档产品及审核后发布的内容；尚未展示不等于没有发布或更新。',
    nextStep: pending
      ? `另有 ${pending.toLocaleString('zh-CN')} 条仓库版本记录待审核。审核通过前，它们不会显示为已发布事件。`
      : '可以先查看开源项目及其原始仓库，了解已采集的资料。',
  };
}
