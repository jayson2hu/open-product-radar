import { getCollectionStatus } from '../server/collection-status.mjs';

/** Report current per-repository outcomes, keeping historical failures in the job ledger. */
export function summarizeLocalCollection(db, { startedAt, now = Date.now() } = {}) {
  const collection = getCollectionStatus(db, { now });
  const github = collection.sources.find(source => source.source_id === 'github');
  const cachedEndpointCount = db.prepare('SELECT count(*) n FROM github_http_cache WHERE checked_at>=?').get(startedAt).n;
  return {
    collection,
    failures: (github?.failures || []).map(failure => ({ repository: failure.repository,
      status: failure.retry_at ? 'retry' : 'failed', code: failure.code, error: failure.message, retry_at: failure.retry_at })),
    // Compatibility field; it was historically named request_count but is not an HTTP counter.
    request_count: cachedEndpointCount,
    request_count_basis: 'distinct_cached_endpoints_not_http_requests',
    cached_endpoint_count: cachedEndpointCount,
    request_budget_reserved: db.prepare('SELECT COALESCE(SUM(requests),0) n FROM worker_budget_usage WHERE created_at>=?').get(startedAt).n,
  };
}
