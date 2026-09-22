import { createApp } from '../server/index.mjs';

// Local-only viewer for the explicitly collected, isolated real-data preview.
const app = createApp({ mode: 'production', dbPath: 'data/radar-local-live.sqlite',
  publicUrl: 'http://127.0.0.1:4189' });
await app.listen(4189, '127.0.0.1');
console.log('真实采集预览：http://127.0.0.1:4189/collection.html');
console.log('项目页面：http://127.0.0.1:4189/#discover');
let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; await app.close(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
