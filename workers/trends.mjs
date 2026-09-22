const HOUR = 3_600_000;

/** Counts are comparable only within the published window and metric definition. */
export function calculateTrend(current, history = [], { hours = 24, toleranceHours = 1 } = {}) {
  const empty = { delta: null, rate: null, status: 'insufficient', interval_hours: null, baseline_at: null };
  if (![24, 168].includes(hours) || toleranceHours < 0) throw new TypeError('Unsupported trend window');
  if (!valid(current)) return { ...empty, status: 'incomparable' };
  const currentTime = Date.parse(current.observed_at);
  const older = history.filter(valid).filter(s => Date.parse(s.observed_at) < currentTime)
    .map(s => ({ snapshot: s, hours: (currentTime - Date.parse(s.observed_at)) / HOUR }))
    .sort((a, b) => Math.abs(a.hours - hours) - Math.abs(b.hours - hours) || a.snapshot.observed_at.localeCompare(b.snapshot.observed_at));
  if (!older.length) return empty;
  const comparable = older.find(({ snapshot: s, hours: elapsed }) =>
    elapsed >= hours - toleranceHours && elapsed <= hours + toleranceHours &&
    s.entity_id === current.entity_id && s.source_id === current.source_id &&
    s.metric_version === current.metric_version && s.scope === current.scope);
  const selected = comparable ?? older[0];
  if (!comparable) return { ...empty, status: 'incomparable', interval_hours: selected.hours, baseline_at: selected.snapshot.observed_at };
  const delta = current.stars - selected.snapshot.stars;
  return { delta, rate: selected.snapshot.stars > 0 ? delta / selected.snapshot.stars : null,
    status: 'comparable', interval_hours: selected.hours, baseline_at: selected.snapshot.observed_at };
}

function valid(snapshot) {
  return snapshot && Number.isSafeInteger(snapshot.stars) && snapshot.stars >= 0 &&
    Number.isFinite(Date.parse(snapshot.observed_at)) && snapshot.entity_id && snapshot.source_id && snapshot.metric_version && snapshot.scope;
}

export function calculateTrends(current, history = []) {
  const day = calculateTrend(current, history);
  const week = calculateTrend(current, history, { hours: 168 });
  return { delta_24h: day.delta, delta_7d: week.delta, trend_status: day.status, trend_24h: day, trend_7d: week };
}
