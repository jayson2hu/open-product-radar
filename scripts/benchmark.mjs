import { createApp } from '../server/index.mjs';
import { cpus, totalmem, platform, release } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const app = createApp({ dbPath: ':memory:', mode: 'demo' });
try {
  const db = app.db;
  const entity = db.prepare(`INSERT INTO entities(id,kind,name,slug,description,topic,language,stars,delta_24h,delta_7d,trend_status,observed_at,first_seen_at,is_demo,review_status) VALUES(?,'repository',?,?,?,'浏览器自动化','TypeScript',1000,20,100,'comparable',?,?,1,'published')`);
  const snapshot = db.prepare('INSERT INTO snapshots(id,entity_id,stars,observed_at,source_id) VALUES(?,?,?,?,?)');
  const now = new Date();
  db.exec('BEGIN');
  for (let n = 0; n < 1000; n++) {
    const id = `benchmark-${n}`;
    entity.run(id, `Benchmark ${n}`, `benchmark/project-${n}`, 'Synthetic performance fixture; not product evidence', now.toISOString(), now.toISOString());
    for (let h = 0; h < 100; h++) snapshot.run(`${id}-${h}`, id, 1000 + h, new Date(now.getTime() - h * 6 * 3600000).toISOString(), 'github');
  }
  db.exec('COMMIT');
  const { port } = await app.listen(0);
  const origin = `http://127.0.0.1:${port}`;
  await fetch(`${origin}/api/v1/feed`).then(r => r.json());
  const durations = [];
  for (let wave = 0; wave < 5; wave++) {
    const results = await Promise.allSettled(Array.from({ length: 20 }, async (_, index) => {
      const start = performance.now();
      const response = await fetch(`${origin}/api/v1/${index % 2 ? 'feed' : 'repositories'}?limit=50`);
      const body = await response.json();
      if (!response.ok || !Array.isArray(body.data)) throw new Error(`List request failed: ${response.status}`);
      return performance.now() - start;
    }));
    for (const result of results) {
      if (result.status !== 'fulfilled') throw result.reason;
      durations.push(result.value);
    }
  }
  durations.sort((a, b) => a - b);
  const result = {
    created_at: now.toISOString(), fixture: 'Synthetic, isolated in-memory database; no real traffic or production claim',
    environment: { node: process.version, platform: `${platform()} ${release()}`, cpu: cpus()[0]?.model, memory_gib: Math.round(totalmem() / 2 ** 30) },
    entities: db.prepare('SELECT COUNT(*) AS n FROM entities').get().n,
    snapshots: db.prepare('SELECT COUNT(*) AS n FROM snapshots').get().n,
    concurrency: 20, requests: durations.length, cache: 'No application response cache; warm SQLite memory',
    p50_ms: Math.round(durations[Math.floor(durations.length * .50)]),
    p95_ms: Math.round(durations[Math.ceil(durations.length * .95) - 1]),
    max_ms: Math.round(durations.at(-1)), internal_target_ms: 800,
    limits: 'Local synthetic read test only; excludes disk, TLS, OAuth, network sources, email, concurrent writes and durable PostgreSQL. Not a production SLA.',
  };
  result.target_met = result.p95_ms < result.internal_target_ms;
  mkdirSync('artifacts', { recursive: true });
  writeFileSync('artifacts/benchmark.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await app.close(); }
