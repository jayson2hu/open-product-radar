import https from 'node:https';
import dns from 'node:dns';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { calculateTrends } from './trends.mjs';

const API = 'https://api.github.com';
const MAX_BYTES = 1_048_576;
let serial = Promise.resolve();

export class SourceError extends Error {
  constructor(code, message, { retryable = false, retryAt = null } = {}) {
    super(message); this.name = 'SourceError'; this.code = code; this.retryable = retryable; this.retryAt = retryAt;
  }
}

export function validateRepository(owner, repo) {
  if (typeof owner !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner) ||
      typeof repo !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo) || ['.', '..'].includes(repo)) {
    throw new SourceError('INVALID_REPOSITORY', '仓库必须使用有效的 owner/repository 名称');
  }
  return { owner, repo };
}

export function assertAllowedUrl(input) {
  let url;
  try { url = new URL(input); } catch { throw new SourceError('UNSAFE_URL', '无效来源地址'); }
  if (url.protocol !== 'https:' || url.hostname !== 'api.github.com' || url.port || url.username || url.password || url.hash ||
      !/^\/repos\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+(?:\/releases)?$/.test(url.pathname) ||
      (url.search && url.search !== '?per_page=30')) throw new SourceError('UNSAFE_URL', '仅允许 GitHub 官方固定 API 路径');
  const [, , owner, repo] = url.pathname.split('/');
  validateRepository(owner, repo);
  return url;
}

export function isPublicAddress(address) {
  const version = isIP(address);
  if (version === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || b === 2)) ||
      (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (version !== 6) return false;
  // Only global unicast IPv6 is accepted; this excludes mapped/private/link-local/loopback addresses.
  const normalized = address.toLowerCase();
  return /^[23][0-9a-f]{3}:/.test(normalized) &&
    !/^2001:(?::|0:|2:|10:|20:|db8:)/.test(normalized) && !normalized.startsWith('2002:') && !normalized.startsWith('3fff:');
}

/** DNS is validated inside the actual connection lookup, avoiding a check/connect rebinding gap. */
export function safeGithubFetch(input, options = {}) {
  const url = assertAllowedUrl(input);
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: 'GET', headers: options.headers, signal: options.signal,
      lookup(hostname, opts, callback) {
        if (hostname !== 'api.github.com') return callback(new SourceError('UNSAFE_DNS', '来源域名不在允许范围'));
        dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
          if (err) return callback(err);
          if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) return callback(new SourceError('UNSAFE_DNS', '来源解析到非公开地址'));
          if (opts.all) callback(null, addresses);
          else callback(null, addresses[0].address, addresses[0].family);
        });
      },
    }, response => {
      const status = response.statusCode;
      if (status >= 300 && status < 400 && status !== 304) {
        response.destroy(); reject(new SourceError('REDIRECT_BLOCKED', '来源重定向已阻止')); return;
      }
      const length = Number(response.headers['content-length']);
      if (length > maxBytes) { response.destroy(); reject(new SourceError('RESPONSE_TOO_LARGE', '来源响应超过大小限制')); return; }
      let size = 0; const chunks = [];
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) { response.destroy(); reject(new SourceError('RESPONSE_TOO_LARGE', '来源响应超过大小限制')); }
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve(new Response(status === 304 ? null : Buffer.concat(chunks), { status, headers: response.headers })));
    });
    request.on('error', reject);
    request.end();
  });
}

export function retryAfter(headers, now = Date.now(), attempts = 0) {
  const value = headers.get('retry-after');
  let date = value && /^\d+(?:\.\d+)?$/.test(value.trim()) ? now + Number(value) * 1000 : Date.parse(value ?? '');
  const reset = Number(headers.get('x-ratelimit-reset')) * 1000;
  if (headers.get('x-ratelimit-remaining') === '0' && reset > now) date = Math.max(Number.isFinite(date) ? date : 0, reset);
  return new Date(Math.max(now + 1000, Number.isFinite(date) ? date : now + Math.min(3_600_000, 60_000 * 2 ** Math.min(attempts, 6)))).toISOString();
}

async function readJsonLimited(response, maxBytes) {
  const reader = response.body?.getReader();
  let size = 0; const chunks = [];
  if (!reader) throw new SourceError('INVALID_JSON', '来源返回空内容');
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new SourceError('RESPONSE_TOO_LARGE', '来源响应超过大小限制'); }
    chunks.push(Buffer.from(value));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new SourceError('INVALID_JSON', '来源 JSON 无法解析'); }
}

export function assertSourcePermission(source) {
  if (!source || !['approved', 'active'].includes(source.status) || source.permission_status !== 'approved') {
    throw new SourceError('SOURCE_NOT_APPROVED', '来源访问和保存权限尚未批准或已停用');
  }
  if (source.allowed_operations && !['fetch_metadata', 'store_evidence'].every(operation => source.allowed_operations.includes(operation))) {
    throw new SourceError('SOURCE_SCOPE_DENIED', '来源未允许本次采集和保存操作');
  }
}

export function createGithubClient({ token, fetchImpl = safeGithubFetch, now = () => Date.now(), timeoutMs = 30_000, maxBytes = MAX_BYTES, cache = [], source, attempts = 0 } = {}) {
  const cached = new Map(cache.map(entry => [entry.url, entry]));
  const updates = [];
  let blockedUntil = null;
  return {
    updates,
    async get(input) {
      assertSourcePermission(source);
      const url = assertAllowedUrl(input).href;
      const work = async () => {
        assertSourcePermission(source);
        if (blockedUntil && Date.parse(blockedUntil) > now()) throw new SourceError('RATE_LIMITED', '来源配额已用尽', { retryable: true, retryAt: blockedUntil });
        const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'OpenProductRadar/0.1' };
        if (token) headers.Authorization = `Bearer ${token}`;
        const previous = cached.get(url);
        if (previous?.etag) headers['If-None-Match'] = previous.etag;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetchImpl(url, { headers, redirect: 'error', signal: controller.signal, maxBytes });
          if (response.redirected || (response.status >= 300 && response.status < 400 && response.status !== 304)) throw new SourceError('REDIRECT_BLOCKED', '来源重定向已阻止');
          if (response.headers.get('x-ratelimit-remaining') === '0') blockedUntil = retryAfter(response.headers, now(), attempts);
          if (response.status === 429 || (response.status === 403 && (blockedUntil || response.headers.has('retry-after')))) {
            blockedUntil = retryAfter(response.headers, now(), attempts);
            throw new SourceError('RATE_LIMITED', 'GitHub 限流，采集已退避', { retryable: true, retryAt: blockedUntil });
          }
          if (response.status === 403) {
            const rejected = await readJsonLimited(response, maxBytes);
            if (/rate limit|abuse detection|secondary rate/i.test(rejected?.message ?? '')) {
              blockedUntil = retryAfter(response.headers, now(), attempts);
              throw new SourceError('RATE_LIMITED', 'GitHub 次级限流，采集已退避', { retryable: true, retryAt: blockedUntil });
            }
          }
          if (response.status === 401 || response.status === 403) throw new SourceError('ACCESS_DENIED', '来源拒绝访问，请人工核查权限');
          if (response.status === 404) throw new SourceError('NOT_FOUND', '公开仓库不存在或已不可访问');
          if (response.status >= 500) throw new SourceError('UPSTREAM_UNAVAILABLE', 'GitHub 暂时不可用', { retryable: true, retryAt: retryAfter(response.headers, now(), attempts) });
          let body;
          if (response.status === 304) {
            if (!previous?.body) throw new SourceError('INVALID_CACHE', '来源返回未变更但本地缓存不存在');
            body = previous.body;
          } else {
            if (!response.ok) throw new SourceError('UPSTREAM_ERROR', `来源响应状态 ${response.status}`);
            if (!/\b(?:application\/json|application\/[^;]+\+json)\b/i.test(response.headers.get('content-type') ?? '')) throw new SourceError('INVALID_CONTENT_TYPE', '来源未返回 JSON');
            body = await readJsonLimited(response, maxBytes);
          }
          const record = { url, etag: response.headers.get('etag') ?? previous?.etag ?? null, body, checked_at: new Date(now()).toISOString() };
          cached.set(url, record); updates.push(record);
          return { body, notModified: response.status === 304 };
        } catch (error) {
          if (error instanceof SourceError) throw error;
          if (controller.signal.aborted || error.name === 'AbortError') throw new SourceError('TIMEOUT', `GitHub ${url.includes('/releases?') ? '版本列表' : '仓库资料'}请求超时（${timeoutMs / 1000} 秒）`, { retryable: true, retryAt: retryAfter(new Headers(), now(), attempts) });
          throw new SourceError('NETWORK_ERROR', '来源网络请求失败', { retryable: true, retryAt: retryAfter(new Headers(), now(), attempts) });
        } finally { clearTimeout(timer); }
      };
      const job = serial.then(work, work);
      serial = job.catch(() => {});
      return job;
    },
  };
}

const dateOrNull = value => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const text = (value, max = 10_000) => typeof value === 'string' ? value.slice(0, max) : '';
const safeLink = value => { try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; } };
const hash = input => createHash('sha256').update(input).digest('hex').slice(0, 20);

export async function collectRepository({ owner, repo, token, source, fetchImpl, now = () => Date.now(), cache = [], history = [], attempts = 0, timeoutMs, maxBytes } = {}) {
  validateRepository(owner, repo);
  assertSourcePermission(source);
  const client = createGithubClient({ token, source, fetchImpl, now, cache, attempts, timeoutMs, maxBytes });
  const base = `${API}/repos/${owner}/${repo}`;
  const metadata = await client.get(base);
  const raw = metadata.body;
  if (!Number.isSafeInteger(raw?.id) || raw.id <= 0 || !Number.isSafeInteger(raw.stargazers_count) || raw.stargazers_count < 0 || raw.private !== false) throw new SourceError('INVALID_REPOSITORY_DATA', '仓库元数据不完整或不是公开仓库');
  validateRepository(raw.owner?.login, raw.name);
  const releasesResponse = await client.get(`${base}/releases?per_page=30`);
  if (!Array.isArray(releasesResponse.body)) throw new SourceError('INVALID_RELEASE_DATA', '版本接口返回格式不正确');
  const observed = new Date(now()).toISOString();
  const id = `gh:${raw.id}`;
  const snapshot = { id: `snapshot:${id}:${observed}`, entity_id: id, stars: raw.stargazers_count, observed_at: observed, source_id: 'github', metric_version: 'github.stargazers_count.v1', scope: 'public' };
  const canonicalUrl = `https://github.com/${raw.owner.login}/${raw.name}`;
  const repository = { id, kind: 'repository', name: raw.name, owner: raw.owner.login, slug: `${raw.owner.login}/${raw.name}`, description: text(raw.description), original_description: text(raw.description), topic: raw.topics?.[0] ?? '未分类', language: text(raw.language, 100) || null, license: raw.license?.spdx_id ?? null, website: safeLink(raw.homepage), repository_url: canonicalUrl, docs_url: null, stars: raw.stargazers_count, observed_at: observed, first_seen_at: observed, created_at: dateOrNull(raw.created_at), is_demo: false, featured: false, review_status: 'published', tags: Array.isArray(raw.topics) ? raw.topics.filter(t => typeof t === 'string').slice(0, 30) : [], ...calculateTrends(snapshot, history) };
  const evidence = [{ id: `gh:repo:${raw.id}:${hash(JSON.stringify(raw))}`, title: `${raw.owner.login}/${raw.name} 官方仓库元数据`, url: canonicalUrl, excerpt: text(raw.description), source_name: 'GitHub 官方 API', source_id: 'github', published_at: null, fetched_at: observed, reviewed_at: null, review_status: 'pending', is_demo: false, permission_status: 'approved' }];
  const events = [];
  const seen = new Set();
  for (const release of releasesResponse.body.slice(0, 30)) {
    if (!Number.isSafeInteger(release?.id) || release.id <= 0 || release.draft || seen.has(release.id)) continue;
    seen.add(release.id);
    const published = dateOrNull(release.published_at);
    if (!published) continue;
    const releaseUrl = `${canonicalUrl}/releases/tag/${encodeURIComponent(text(release.tag_name, 200))}`;
    const evidenceId = `evidence:gh:release:${release.id}:${hash(JSON.stringify(release))}`;
    evidence.push({ id: evidenceId, title: text(release.name || release.tag_name, 250), url: releaseUrl, excerpt: text(release.body), source_name: 'GitHub Releases', source_id: 'github', published_at: published, fetched_at: observed, reviewed_at: null, review_status: 'pending', is_demo: false, permission_status: 'approved' });
    events.push({ id: `gh:release:${release.id}`, entity_id: id, entity_name: raw.name, title: `${raw.name} ${text(release.name || release.tag_name, 200)}`, summary: text(release.body, 2000), type: 'release', published_at: published, observed_at: observed, reviewed_at: null, review_status: 'pending', evidence_ids: [evidenceId], is_demo: false });
  }
  return { repository, snapshot, events, evidence, http_cache: client.updates, unchanged: metadata.notModified && releasesResponse.notModified };
}
