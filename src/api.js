let csrfToken = '';
export function setCsrf(value) { csrfToken = value || ''; }
export async function api(path, options = {}) {
  const response = await fetch(`/api/v1${path}`, {
    credentials: 'include',
    ...options,
    headers: { 'Content-Type': 'application/json', ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}), ...options.headers },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error?.message || `请求失败（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return payload;
}
export const list = value => Array.isArray(value) ? value : value?.data || [];
export const item = value => value?.data && !Array.isArray(value.data) ? value.data : value;
export const navigate = path => { window.location.hash = path; };
export const number = value => value == null ? '—' : Number(value).toLocaleString('en-US');
export const shortNumber = value => value == null ? '—' : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
export const date = value => value ? new Date(value).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) : '暂无记录';
export const datetime = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '暂无记录';
export const safeUrl = value => { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined; } catch { return undefined; } };
const analyticsSeen = new Set();
export function track(event, context = {}, once = false) {
  const key = JSON.stringify([event, context]);
  if (once && analyticsSeen.has(key)) return;
  if (once) analyticsSeen.add(key);
  api('/analytics', { method: 'POST', body: { event, ...context } }).catch(() => {});
}
