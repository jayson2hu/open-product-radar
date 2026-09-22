#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const array = value => Array.isArray(value) ? value : [];
const count = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US') : '—';
const safeUrl = value => {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
};
const time = (value, compact = false) => {
  if (value == null || value === '') return '暂无记录';
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return '暂无记录';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    ...(!compact ? { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' } : {}),
  }).format(parsed);
};
const external = (url, label, className = '') => {
  const href = safeUrl(url);
  return href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"${className ? ` class="${escapeHtml(className)}"` : ''}>${escapeHtml(label)} <span aria-hidden="true">↗</span></a>` : `<span${className ? ` class="${escapeHtml(className)}"` : ''}>${escapeHtml(label)} <span class="unavailable">（暂无有效链接）</span></span>`;
};
const entityLink = repository => typeof repository.id === 'string' && repository.id
  ? `/#entity/${encodeURIComponent(repository.id)}` : null;
const delta = value => typeof value === 'number' && Number.isFinite(value)
  ? `<strong class="${value < 0 ? 'negative' : value > 0 ? 'positive' : ''}">${value > 0 ? '+' : ''}${count(value)}</strong>`
  : '<span class="history">待对比</span>';

function releaseCard(release) {
  const status = ({ pending: '待审核', draft: '待审核', published: '已审核发布', approved: '已审核', reviewed: '已核查', rejected: '审核未通过', retracted: '已撤回' })[release.review_status];
  return `<li class="release">
    <div class="release-heading">${external(release.url, release.title || '未提供版本标题', 'release-title')}<div class="release-badges"><span class="badge ${['published', 'approved', 'reviewed'].includes(release.review_status) ? 'verified' : 'review'}">${escapeHtml(status || '审核状态未提供')}</span>${release.prerelease === true || release.prerelease === 1 ? '<span class="badge preview">预发布</span>' : ''}</div></div>
    <p>原始发布时间：<time>${escapeHtml(time(release.published_at))}</time></p>
  </li>`;
}

function repositoryCard(repository, index) {
  const releases = array(repository.releases).slice().sort((left, right) => {
    const a = Date.parse(left.published_at), b = Date.parse(right.published_at);
    return (Number.isFinite(b) ? b : -Infinity) - (Number.isFinite(a) ? a : -Infinity);
  }).slice(0, 3);
  const name = repository.name || repository.slug || '未提供仓库名称';
  const detail = entityLink(repository);
  return `<article class="repository">
    <div class="repository-top"><div class="repository-identity"><span class="rank">${String(index + 1).padStart(2, '0')}</span><div><h2>${detail ? `<a href="${escapeHtml(detail)}">${escapeHtml(name)} <span aria-hidden="true">↗</span></a>` : escapeHtml(name)}</h2>${repository.slug && repository.slug !== name ? `<p class="slug">${escapeHtml(repository.slug)}</p>` : ''}</div></div>${detail ? `<a class="profile-link" href="${escapeHtml(detail)}">查看项目档案 <span aria-hidden="true">→</span></a>` : ''}</div>
    <dl class="repository-facts"><div><dt>当前 Stars</dt><dd class="stars">${count(repository.stars)}</dd></div><div><dt>24 小时净变化</dt><dd>${delta(repository.delta_24h)}</dd></div><div><dt>7 天净变化</dt><dd>${delta(repository.delta_7d)}</dd></div><div><dt>主要语言</dt><dd>${escapeHtml(repository.language || '暂无信息')}</dd></div><div><dt>许可证</dt><dd>${escapeHtml(repository.license || '暂无信息')}</dd></div></dl>
    <div class="observation"><span>本次观察：${escapeHtml(time(repository.observed_at))}</span>${external(repository.url, 'GitHub 原始仓库')}</div>
    <div class="releases-heading"><h3>最新版本记录</h3><span>${typeof repository.release_count === 'number' ? `本次收录 ${count(repository.release_count)} 条` : '收录数量未提供'}${releases.length ? ` · 展示最新 ${releases.length} 条` : ''}</span></div>
    ${releases.length ? `<ol class="release-list">${releases.map(releaseCard).join('')}</ol>` : '<p class="no-releases">本次未获得可展示的版本记录；不能据此判断该项目没有发布版本。</p>'}
  </article>`;
}

/** Render exactly the supplied collection result. No remote requests or synthetic metrics. */
export function renderCollectionReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) throw new TypeError('采集报告必须是 JSON 对象');
  const repositories = array(report.repositories);
  const failures = array(report.failures);
  const totals = report.totals && typeof report.totals === 'object' ? report.totals : {};
  const scope = typeof report.scope === 'string' ? report.scope : report.scope == null ? '未提供采集范围' : JSON.stringify(report.scope);
  const status = failures.length ? `有 ${failures.length} 个对象未完成采集` : report.completed_at ? '本次采集已完成' : '尚未提供完成记录';
  const summary = [
    ['库内真实仓库', totals.repositories, '当前真实资料库的仓库记录'],
    ['已保存快照', totals.snapshots, '当前库内可追溯的观察记录'],
    ['库内版本草稿', totals.release_drafts, '待核查后再决定是否发布'],
    ['已保存证据', totals.evidence, '当前库内保留的原始依据'],
  ];
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="color-scheme" content="light"><title>本次真实采集 · 开源产品雷达</title>
<style>
:root{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:#263449;background:#f6f8fb;line-height:1.65;font-synthesis:none}*{box-sizing:border-box}body{margin:0}a{color:inherit;text-decoration:none}a:hover{color:#4f46ad}a:focus-visible{outline:3px solid #aaa3ed;outline-offset:5px;border-radius:3px}h1,h2,h3,p,dl,dd,ol{margin:0}button,a{-webkit-tap-highlight-color:transparent}.site-header{background:#fff;border-bottom:1px solid #e3e8f0}.header-inner{max-width:1240px;margin:auto;padding:21px 34px;display:flex;justify-content:space-between;align-items:center;gap:20px}.brand{display:flex;align-items:center;gap:10px;font-size:16px;font-weight:650;letter-spacing:.2px}.radar{position:relative;display:inline-block;width:31px;height:31px;border:1.5px solid #857ac7;border-radius:50%;background:#f1eefb}.radar:before{content:"";position:absolute;inset:5px;border:1px solid #aea5d9;border-radius:50%}.radar:after{content:"";position:absolute;left:14px;top:3px;height:13px;width:1.5px;background:#857ac7;transform:rotate(38deg);transform-origin:bottom}.header-label{font-size:12px;color:#64748b}.container{max-width:1240px;padding:39px 34px 45px;margin:auto}.eyebrow{font-size:11px;letter-spacing:1.7px;color:#776c9f;font-weight:600;display:flex;align-items:center;gap:8px}.eyebrow:before{content:"";height:1px;width:22px;background:#998cbd}.hero{display:flex;justify-content:space-between;align-items:flex-start;gap:25px;margin:16px 0 17px}.hero h1{font-size:32px;font-weight:650;line-height:1.4;letter-spacing:-.8px}.hero p{font-size:14px;color:#64748b;margin-top:12px;max-width:735px;line-height:1.85}.button{display:inline-flex;align-items:center;gap:17px;min-height:41px;flex-shrink:0;border-radius:6px;padding:9px 14px;color:#565071;background:#fff;border:1px solid #dce1ec;font-size:13px;margin-top:5px}.button:hover{border-color:#aca0d4;background:#fbfaff}.collection-status{display:flex;align-items:center;gap:9px;flex-wrap:wrap;font-size:12px;color:#64748b;margin-bottom:25px}.status-dot{width:6px;height:6px;border-radius:50%;background:#4d896e;display:inline-block}.real-badge{background:#eaf3ee;color:#376d55;border:1px solid #d5e5db;font-size:11px;font-weight:500;border-radius:4px;padding:2px 7px}.separator{color:#bdc5d2;margin:0 3px}.summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:15px;margin:0 0 20px}.stat{background:#fff;border:1px solid #e3e8f0;border-radius:8px;padding:18px 20px}.stat-label{font-size:12px;color:#65748a}.stat-value{font-size:30px;line-height:1.5;font-weight:650;font-variant-numeric:tabular-nums;letter-spacing:-.7px;margin:5px 0;color:#303d51}.stat-caption{font-size:11px;color:#6e7c90}.collection-metadata{padding:15px 18px;background:#fff;border:1px solid #e3e8f0;border-radius:7px;display:grid;grid-template-columns:1fr 1fr;gap:11px 22px;font-size:12px}.collection-metadata>div{display:flex;align-items:flex-start;gap:13px;min-width:0}.collection-metadata dt{color:#748198;flex-shrink:0;min-width:85px}.collection-metadata dd{color:#495971;overflow-wrap:anywhere}.collection-metadata .scope{grid-column:1/-1}.scope dd{line-height:1.9}.boundary-note{background:#f6f2e9;border:1px solid #e8e0cc;border-radius:7px;padding:16px 19px;margin:19px 0 29px;color:#766749}.boundary-note h2{font-size:13px;font-weight:600;margin-bottom:6px}.boundary-note p{font-size:12px;line-height:1.9}.section-heading{display:flex;align-items:baseline;justify-content:space-between;gap:14px;margin-bottom:16px}.section-heading h2{font-size:18px;font-weight:600}.section-heading p{font-size:12px;color:#6b7a90}.repository-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}.repository{background:#fff;border:1px solid #e1e7ef;border-radius:9px;padding:22px 23px;overflow:hidden;min-width:0}.repository-top{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;margin-bottom:22px}.repository-identity{display:flex;align-items:flex-start;gap:11px;min-width:0}.rank{font-size:11px;color:#8e9bae;border:1px solid #e3e8f1;border-radius:5px;min-width:27px;height:27px;display:grid;place-items:center;margin-top:1px}.repository h2{font-size:18px;line-height:1.5;font-weight:600;overflow-wrap:anywhere;color:#33435c}.repository h2 a>span{font-size:12px;color:#8a80b4;vertical-align:middle}.slug{font-size:11px;color:#718198;overflow-wrap:anywhere;margin-top:4px}.profile-link{font-size:11px;white-space:nowrap;color:#7b6ca3;padding-top:5px}.repository-facts{display:grid;grid-template-columns:1fr 1fr 1fr;gap:15px 17px;padding-bottom:18px;border-bottom:1px solid #edf0f5}.repository-facts dt{font-size:11px;color:#758397;margin-bottom:4px}.repository-facts dd{font-size:13px;color:#4e6078;overflow-wrap:anywhere}.repository-facts .stars{font-size:20px;line-height:1.4;font-weight:600;font-variant-numeric:tabular-nums;color:#33475e}.repository-facts strong{font-weight:500;font-variant-numeric:tabular-nums}.repository-facts .positive{color:#2d7855}.repository-facts .negative{color:#ac4d53}.history{font-size:12px;color:#78859a}.observation{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:11px;color:#718095;margin:13px 0 19px}.observation>a{color:#7f709f}.releases-heading{display:flex;justify-content:space-between;align-items:center;gap:8px;border-top:1px solid #edf0f5;padding-top:16px;margin-bottom:2px}.releases-heading h3{font-size:12px;font-weight:600;color:#637189}.releases-heading>span{font-size:10px;color:#79869b}.release-list{list-style:none;padding:0}.release{padding:13px 0;border-bottom:1px solid #eef1f6}.release:last-child{border-bottom:0;padding-bottom:0}.release-heading{display:flex;align-items:flex-start;gap:9px;justify-content:space-between}.release-title{font-size:13px;font-weight:500;color:#566780;overflow-wrap:anywhere}.release-title>span{font-size:11px;color:#9b90b5}.release-badges{display:flex;align-items:center;gap:4px;flex-wrap:wrap;flex-shrink:0;justify-content:flex-end;max-width:140px}.badge{display:inline-block;white-space:nowrap;font-size:10px;line-height:1.6;border:1px solid;border-radius:4px;padding:1px 5px}.review{color:#947d46;border-color:#e9dfc7;background:#fcf8ee}.verified{color:#417958;border-color:#d6e6d9;background:#f0f7f0}.preview{color:#88739d;border-color:#e5deee;background:#f6f2fb}.release p{font-size:11px;color:#7b899d;margin-top:6px;font-variant-numeric:tabular-nums}.no-releases{font-size:12px;color:#76879b;line-height:1.9;padding-top:13px}.unavailable{font-size:11px;font-weight:400;color:#7b879a}.failures{background:#fff;border:1px solid #eccfcb;border-radius:8px;padding:22px;margin:24px 0}.failures h2{font-size:16px;color:#9e5d56;margin-bottom:8px}.failures>p{font-size:12px;color:#7d706e;margin-bottom:16px}.failure{padding:13px 0;border-top:1px solid #f0e5e3;display:grid;grid-template-columns:1fr 90px;gap:6px 15px}.failure strong{font-size:13px;font-weight:500;overflow-wrap:anywhere}.failure .failure-status{font-size:12px;color:#a16f63;text-align:right}.failure p{grid-column:1/-1;font-size:12px;color:#856f6b;overflow-wrap:anywhere}.empty{background:#fff;border:1px dashed #d9e0eb;padding:37px 25px;border-radius:8px;text-align:center;font-size:14px;color:#73849c}.footer{display:flex;align-items:center;justify-content:space-between;gap:20px;padding-top:24px;margin-top:24px;border-top:1px solid #dfe5ef;color:#718198;font-size:11px;line-height:1.8}.footer a{color:#796799;white-space:nowrap}.footer p{max-width:870px}
@media(max-width:1000px){.container{padding:30px 25px}.header-inner{padding:19px 25px}.hero h1{font-size:28px}.repository{padding:20px}.repository-top{flex-wrap:wrap;gap:7px}.profile-link{margin-left:38px;padding-top:0}.summary{gap:12px}.stat{padding:16px}.stat-caption{font-size:11px}.release-heading{flex-wrap:wrap;gap:6px}.release-badges{justify-content:flex-start;max-width:none}.releases-heading{flex-wrap:wrap;gap:4px}}
@media(max-width:720px){.repository-grid{grid-template-columns:1fr;gap:17px}.summary{grid-template-columns:1fr 1fr;gap:11px}.hero{flex-direction:column;gap:12px}.hero h1{font-size:27px}.hero p{font-size:14px}.button{margin-top:0;min-height:42px}.repository-top{flex-wrap:nowrap}.profile-link{margin-left:0;white-space:nowrap;padding-top:4px}.repository-facts{grid-template-columns:repeat(3,minmax(0,1fr));gap:15px}.collection-metadata{grid-template-columns:1fr;gap:12px;padding:16px}.collection-metadata .scope{grid-column:auto}.release-heading{flex-wrap:nowrap}.releases-heading{flex-wrap:nowrap}.footer{align-items:flex-start}.footer a{font-size:12px}.header-label{font-size:11px}.section-heading{align-items:flex-start}.section-heading p{max-width:185px;text-align:right;font-size:11px}.boundary-note{margin-bottom:24px}}
@media(max-width:440px){.header-inner{padding:17px 18px;gap:10px}.brand{font-size:14px;gap:8px}.radar{width:28px;height:28px}.radar:after{left:12px;height:11px}.header-label{font-size:11px;max-width:86px;text-align:right}.container{padding:26px 17px 32px}.eyebrow{font-size:10px;letter-spacing:1.1px}.hero{margin:15px 0 16px}.hero h1{font-size:27px;letter-spacing:-.5px}.hero p{font-size:13px;line-height:1.95;margin-top:11px}.collection-status{font-size:12px;gap:7px;line-height:1.9;margin-bottom:20px}.real-badge{font-size:11px}.summary{gap:10px}.stat{padding:14px}.stat-label{font-size:12px}.stat-value{font-size:29px;margin:4px 0}.stat-caption{font-size:12px;line-height:1.7}.collection-metadata{font-size:12px}.collection-metadata>div{gap:11px}.collection-metadata dt{min-width:74px}.boundary-note{padding:15px}.boundary-note h2{font-size:13px}.boundary-note p{font-size:12px;line-height:1.95}.section-heading{flex-direction:column;gap:4px}.section-heading h2{font-size:18px}.section-heading p{max-width:none;text-align:left;font-size:12px}.repository{padding:18px 16px}.repository-top{gap:11px;flex-wrap:wrap;margin-bottom:18px}.repository h2{font-size:18px}.rank{font-size:11px;min-width:25px;height:26px}.profile-link{margin-left:36px;min-height:30px;padding-top:2px;font-size:12px}.slug{font-size:12px}.repository-facts{gap:15px 8px}.repository-facts dt{font-size:12px;line-height:1.7}.repository-facts dd{font-size:13px}.repository-facts .stars{font-size:20px}.history{font-size:12px}.observation{font-size:12px;gap:9px;line-height:1.8}.observation>a{min-height:28px;display:inline-flex;align-items:center;gap:4px}.releases-heading{gap:4px;flex-wrap:wrap}.releases-heading h3{font-size:13px}.releases-heading>span{font-size:12px}.release-heading{flex-wrap:wrap;gap:6px}.release-title{font-size:14px;line-height:1.7}.release-badges{gap:5px}.badge{font-size:11px}.release p{font-size:12px;line-height:1.8}.release{padding:14px 0}.no-releases{font-size:13px}.footer{flex-direction:column;gap:13px;font-size:12px;line-height:1.9}.footer a{font-size:13px;min-height:32px}.failures{padding:18px 16px}.failure{grid-template-columns:1fr 75px}.failure p{font-size:13px}.failure .failure-status{font-size:12px}.failure strong{font-size:14px}}
@media print{body{background:#fff}.site-header,.button,.profile-link,.footer a{display:none}.container{padding:0;max-width:none}.repository{break-inside:avoid}.repository-grid{grid-template-columns:1fr 1fr}.repository a:after{content:""}.boundary-note{background:#fff}.stat{break-inside:avoid}}
</style></head><body>
<header class="site-header"><div class="header-inner"><a class="brand" href="/#discover"><span class="radar" aria-hidden="true"></span>开源产品雷达</a><span class="header-label">采集记录 · 原始来源可追溯</span></div></header>
<main class="container"><div class="eyebrow">A REAL OBSERVATION, WITH CLEAR LIMITS</div><div class="hero"><div><h1>今天，从真实数据开始。</h1><p>查看本次采集到的公开仓库、观察快照与版本记录。每一个数字都有观察时间，每一条版本记录都保留原始出处。</p></div><a class="button" href="/#discover">返回发现页 <span aria-hidden="true">→</span></a></div>
<div class="collection-status"><span class="real-badge">真实采集记录</span><span class="status-dot" aria-hidden="true"></span><span>${escapeHtml(status)}</span><span class="separator">/</span><span>全部时间为北京时间 UTC+8</span></div>
<section class="summary" aria-label="本地真实资料库当前记录统计">${summary.map(([label, value, caption]) => `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${count(value)}</div><p class="stat-caption">${caption}</p></div>`).join('')}</section>
<dl class="collection-metadata"><div><dt>开始采集</dt><dd>${escapeHtml(time(report.started_at))}</dd></div><div><dt>完成采集</dt><dd>${escapeHtml(time(report.completed_at))}</dd></div><div><dt>已缓存接口</dt><dd>${count(report.cached_endpoint_count ?? report.request_count)} <span>条不同接口的成功记录</span></dd></div><div><dt>展示仓库数</dt><dd>${repositories.length}</dd></div><div class="scope"><dt>采集范围</dt><dd>${escapeHtml(scope)}</dd></div></dl>
<aside class="boundary-note" aria-label="数据边界"><h2>先读清楚这次数据的边界</h2><p>这是一次手动执行的采集结果，尚未启用持续采集；不是全量 GitHub 数据，也不是 GitHub Trending。上方统计为本地真实资料库的当前记录数，“已缓存接口”按接口地址去重，不代表实际请求次数。版本的原始发布时间可以早于今天；本次发现不等于今天首次发布。当前 Star 总量已经采集；缺少约 24 小时或 7 天前的记录时，净变化显示“待对比”。需要之后再采集才能计算增长，仅等待时间过去不会自动补齐。版本草稿须经审核后才可作为公开研究判断；Star 数不代表用户量、收入或产品质量。</p></aside>
<section aria-labelledby="repositories-title"><div class="section-heading"><h2 id="repositories-title">本次采集到的项目</h2><p>按报告原有顺序呈现 · 非热度排名</p></div>${repositories.length ? `<div class="repository-grid">${repositories.map(repositoryCard).join('')}</div>` : '<div class="empty">本次报告尚无成功采集的仓库记录，请查看采集状态与失败原因。</div>'}</section>
${failures.length ? `<section class="failures" aria-labelledby="failures-title"><h2 id="failures-title">未完成的采集</h2><p>以下对象的结果可能不完整；采集失败不代表项目没有变化。</p>${failures.map(failure => `<article class="failure"><strong>${escapeHtml(failure.repository || '未提供仓库名称')}</strong><span class="failure-status">${escapeHtml(failure.status ?? '状态未提供')}</span><p>${escapeHtml(failure.error || '未提供失败详情')}</p></article>`).join('')}</section>` : ''}
<footer class="footer"><p>开源产品雷达 · 本页保存本次采集的静态结果，不会自动刷新。字段缺失显示“暂无信息”或“—”；请结合原始出处、采集时间和后续核查使用。</p><a href="/#discover">进入研究工作台 <span aria-hidden="true">↗</span></a></footer></main></body></html>`;
}

async function main() {
  const [inputArg, outputArg = 'dist/collection.html'] = process.argv.slice(2);
  if (!inputArg || inputArg === '--help' || inputArg === '-h') {
    process.stdout.write('用法：node scripts/render-collection-report.mjs <采集结果.json> [报告.html]\n默认输出：dist/collection.html\n');
    if (!inputArg) process.exitCode = 1;
    return;
  }
  const inputPath = resolve(inputArg), outputPath = resolve(outputArg);
  if (inputPath === outputPath) throw new Error('输入与输出路径不能相同');
  const report = JSON.parse((await readFile(inputPath, 'utf8')).replace(/^\uFEFF/, ''));
  const html = renderCollectionReport(report);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html, 'utf8');
  process.stdout.write(`采集报告已生成：${outputPath}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`生成失败：${error.message}\n`); process.exitCode = 1; });
}
