import { mkdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { backtest, syntheticBars, type Bar, type Config } from './domain';
import { Store } from './store';
mkdirSync('data', { recursive: true });
const store = new Store('data/terminal.sqlite');
// A restart never silently resumes runners, even though the emergency latch persists.
store.set('bots', store.get('bots').map((b: any) => ({ ...b, status: store.get('halted') ? 'halted' : 'paused' })));
store.audit('SERVER_START', 'Local paper control plane; all runners paused or halted.');
const port = Number(process.env.PORT || 3000), origin = `http://127.0.0.1:${port}`;
const dist = resolve('dist');
const server = Bun.serve({
  hostname: '127.0.0.1', port, maxRequestBodySize: 12 * 1024 * 1024,
  async fetch(req) {
    const url = new URL(req.url);
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'" };
    const json = (data: unknown, status = 200) => Response.json(data, { status, headers });
    if (![new URL(origin).host, `localhost:${port}`].includes(req.headers.get('host') || '')) return json({ error: 'Invalid host' }, 403);
    try {
      if (url.pathname.startsWith('/api/')) {
        if (req.method === 'POST') {
          if (![origin, `http://localhost:${port}`].includes(req.headers.get('origin') || '') || !req.headers.get('content-type')?.startsWith('application/json')) return json({ error: 'Same-origin JSON requests required' }, 403);
          const body = await req.json();
          if (url.pathname === '/api/command') store.command(body.id, body.action);
          else if (url.pathname === '/api/halt') store.halt();
          else if (url.pathname === '/api/reset') { if (body.confirm !== 'RESET') throw new Error('Explicit RESET confirmation required'); store.reset(); }
          else if (url.pathname === '/api/backtest') {
            const config = body.config as Config;
            const bars: Bar[] = body.bars ?? syntheticBars(config.asset);
            const source = body.bars ? 'user-uploaded / unverified' : 'synthetic';
            const result = backtest(bars, config, source); return json({ id: store.saveRun(result), result });
          } else if (url.pathname === '/api/promote') return json({ hash: store.promote(body.id) });
          else return json({ error: 'Unknown endpoint' }, 404);
          return json({ ok: true });
        }
        if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
        if (url.pathname === '/api/state') return json(store.snapshot());
        if (url.pathname === '/api/health') return json({ status: 'ok', liveTrading: false, brokerConnected: false });
        return json({ error: 'Unknown endpoint' }, 404);
      }
      if (!['GET', 'HEAD'].includes(req.method)) return json({ error: 'Method not allowed' }, 405);
      const path = resolve(dist, '.' + decodeURIComponent(url.pathname));
      if (path !== dist && !path.startsWith(dist + sep)) return json({ error: 'Forbidden path' }, 403);
      let file = Bun.file(path);
      if (!(await file.exists()) || path === dist) file = Bun.file(resolve(dist, 'index.html'));
      if (!(await file.exists())) return new Response('Build the terminal first: bun run build', { status: 503 });
      return new Response(req.method === 'HEAD' ? null : file, { headers });
    } catch (error) { return json({ error: error instanceof Error ? error.message : 'Request failed' }, 400); }
  }
});
console.log(`A Bot and a Dream: ${origin} — PAPER ONLY (port ${server.port})`);