import { mkdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { backtest, syntheticBars, type Bar, type Config } from './domain';
import { Store } from './store';
import { Vault } from './vault';
import { Operations } from './operations';
import { LighterMarkets } from './lighter';
import { ExecutionRisk } from './execution-risk';
import { readiness } from './readiness';
import { Paper } from './paper';
import { LighterStream } from './lighter-stream';
import { replayCapture } from './lighter-evidence';
import { PaperUpdates } from './paper-updates';
import { DecisionJournal } from './journal';
import { FeedHealthGuard } from './feed-health';
import { StrategyRegistry } from './strategies/registry';
import { builtinStrategies } from './strategies/builtin';
import { FleetManager } from './fleet';
import { framesFromCapture, replayStrategy } from './backtest-replay';
import { loadPromotionGate } from './promotion';
mkdirSync('data', { recursive: true });
const store = new Store('data/terminal.sqlite');
const operations = new Operations(store, new Vault('data/vault.key'));
const executionRisk = new ExecutionRisk(store);
const feed = new LighterStream(store, { marketStats: true, tradeEvidence: true, onUpdate: () => {
  updates.request();
  void paper.monitor().then(() => updates.request()).catch(() => {});
} });
const paper = new Paper(store, fetch, feed);
const updates = new PaperUpdates(() => paper.status());
const journal = new DecisionJournal(store);
const strategyRegistry = new StrategyRegistry();
for (const strategy of builtinStrategies) strategyRegistry.register(strategy);
const feedGuard = new FeedHealthGuard(store);
const promotion = loadPromotionGate('research/promotions.json', 'research/spa_verify.py');
const fleet = new FleetManager(store, paper, feed, journal, strategyRegistry, feedGuard, { onWatchChange: () => { void paper.refreshWatched().catch(() => {}); } }, undefined, promotion);
fleet.start();
feed.start();
void paper.refreshWatched().catch(() => {});
setInterval(() => { void paper.refreshWatched().catch(() => {}); }, 1000);
const markets = new LighterMarkets();
void markets.refresh();
setInterval(() => void markets.refresh(), 10000);
// Synthetic fills remain a legacy demo only; never advance them as market data.
// A restart never silently resumes runners, even though the emergency latch persists.
store.set('bots', store.get('bots').map((b: any) => ({ ...b, status: store.get('halted') ? 'halted' : 'paused' })));
// Agents share the fleet's restart rule: automation authorization never survives a restart.
if (store.get('agentEnabled')) { store.set('agentEnabled', false); store.audit('AGENT_AUTOMATION_OFF', 'Restart cleared agent automation authorization'); }
store.audit('SERVER_START', 'Local paper control plane; all runners paused or halted.');
const port = Number(process.env.PORT || 3000), origin = `http://127.0.0.1:${port}`;
const dist = resolve('dist');
const syncLocks = new Set<string>();
const server = Bun.serve({
  hostname: '127.0.0.1', port, maxRequestBodySize: 12 * 1024 * 1024,
  async fetch(req) {
    const url = new URL(req.url);
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'" };
    const json = (data: unknown, status = 200) => Response.json(data, { status, headers });
    if (![new URL(origin).host, `localhost:${port}`].includes(req.headers.get('host') || '')) return json({ error: 'Invalid host' }, 403);
    try {
      if (url.pathname.startsWith('/api/')) {
        if (req.method === 'POST' && url.pathname.startsWith('/api/ingest/')) {
          const token = req.headers.get('authorization')?.replace(/^Bearer /, '') || '';
          if (!operations.authorized(token)) return json({ error: 'Invalid ingestion token' }, 401);
          const body = await req.json();
          if (url.pathname === '/api/ingest/fill') return json({ inserted: operations.ingest({ ...body, source: 'imported' }) });
          if (url.pathname === '/api/ingest/heartbeat') { operations.heartbeat(body); return json({ ok: true, halted: store.get('halted') }); }
           if (url.pathname === '/api/ingest/mark') { if (['paper', 'paper-mainnet'].includes(body.account)) throw new Error('External mark cannot overwrite paper feed'); operations.mark({ ...body, source: 'external' }); return json({ ok: true }); }
          return json({ error: 'Unknown ingestion endpoint' }, 404);
        }
        if (req.method === 'POST') {
          if (![origin, `http://localhost:${port}`].includes(req.headers.get('origin') || '') || !req.headers.get('content-type')?.startsWith('application/json')) return json({ error: 'Same-origin JSON requests required' }, 403);
          const body = await req.json();
          if (url.pathname === '/api/stats/reset') return json(operations.resetStats(body.confirm));
          if (url.pathname === '/api/paper/session') return json(paper.configure(body));
          if (url.pathname === '/api/paper/baseline-reconcile') return json(await paper.reconcileBaseline(body));
          if (url.pathname === '/api/paper/market') return json(await paper.select(body));
          if (url.pathname === '/api/paper/protection') return json(paper.protect(body));
          if (url.pathname === '/api/paper/leverage') return json(paper.setLeverage(body));
          if (url.pathname === '/api/paper/mainnet-order') return json(await paper.order(body));
          if (url.pathname === '/api/paper/cancel') return json(paper.cancel(body));
          if (url.pathname === '/api/risk/allocation') return json(operations.saveAllocation(body));
          if (url.pathname === '/api/connections/save') return json({ id: operations.saveConnection(body) });
          else if (url.pathname === '/api/lighter/save') { operations.saveLighter(body); executionRisk.invalidate(); }
          else if (url.pathname === '/api/lighter/delete') { operations.deleteLighter(); executionRisk.invalidate(); }
          else if (url.pathname === '/api/lighter/sync') return json(await operations.syncLighter());
          else if (url.pathname === '/api/connections/delete') operations.removeConnection(body.id);
          else if (url.pathname === '/api/connections/sync') {
            if (syncLocks.has(body.id)) throw new Error('Sync already in progress');
            syncLocks.add(body.id); try { return json({ status: await operations.sync(body.id) }); } finally { syncLocks.delete(body.id); }
          }
          else if (url.pathname === '/api/ingestion-token') return json({ token: operations.rotateToken() });
          else if (url.pathname === '/api/fills/import') {
            if (!Array.isArray(body.fills) || body.fills.length > 10000) throw new Error('Expected at most 10,000 fills');
            const count = store.db.transaction(() => body.fills.reduce((n: number, f: any) => n + Number(operations.ingest({ ...f, source: 'imported' })), 0))(); return json({ inserted: count });
          }
          else if (url.pathname === '/api/bots/add') operations.addBot(body);
          else if (url.pathname === '/api/risk/save') operations.risk(body);
           else if (url.pathname === '/api/paper/order' || url.pathname === '/api/paper/flatten') throw new Error('Legacy synthetic execution disabled. Use the separate mainnet paper account.');
          else if (url.pathname === '/api/alerts/acknowledge') operations.acknowledge(body.id);
          else if (url.pathname === '/api/command') { if (body.action === 'start') throw new Error('Synthetic runners disabled; authenticated venue execution not enabled'); store.command(body.id, body.action); }
          else if (url.pathname === '/api/halt') store.halt();
          else if (url.pathname === '/api/reset') { if (body.confirm !== 'RESET') throw new Error('Explicit RESET confirmation required'); store.reset(); }
          else if (url.pathname === '/api/backtest') {
            const config = body.config as Config;
            const bars: Bar[] = body.bars ?? syntheticBars(config.asset);
            const source = body.bars ? 'user-uploaded / unverified' : 'synthetic';
            const result = backtest(bars, config, source); return json({ id: store.saveRun(result), result });
          } else if (url.pathname === '/api/promote') return json({ hash: store.promote(body.id) });
          else if (url.pathname === '/api/fleet/enable') return json(fleet.enable(body));
          else if (url.pathname === '/api/fleet/disable') return json(fleet.disable());
          else if (url.pathname === '/api/fleet/create') return json(fleet.create(body));
          else if (url.pathname === '/api/fleet/update') return json(fleet.update(body));
          else if (url.pathname === '/api/fleet/delete') return json(fleet.delete(body));
          else if (url.pathname === '/api/fleet/start') return json(fleet.startBot(body));
          else if (url.pathname === '/api/fleet/pause') return json(fleet.pauseBot(body));
          else if (url.pathname === '/api/fleet/backtest') {
            const captureId = typeof body.captureId === 'string' ? body.captureId : null;
            if (!/^[a-f0-9-]{36}$/.test(captureId ?? '')) throw new Error('Valid capture ID required');
            const capture = feed.evidence!.export(captureId!);
            const market = capture.manifest.markets.find((m: any) => m.symbol === body.symbol);
            if (!market) throw new Error('Capture does not include that market');
            const result = replayStrategy({ registry: strategyRegistry, strategyId: body.strategyId, params: body.params ?? {},
              market, frames: framesFromCapture(capture), staleMs: capture.manifest.staleMs, marketStats: capture.manifest.marketStats,
              capital: body.capital ?? 10000, feeBps: Number.isInteger(body.feeBps) ? body.feeBps : 2,
              leverage: body.leverage ?? 1, notionalPerOrderUsd: body.notionalPerOrderUsd ?? Math.min(1000, (body.capital ?? 10000) - 1), captureId });
            return json({ id: store.saveRun({ ...result, source: 'recorded-feed-replay' } as any), result });
          }
          else return json({ error: 'Unknown endpoint' }, 404);
          return json({ ok: true });
        }
        if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
        if (url.pathname === '/api/state') return json(store.snapshot());
        if (url.pathname === '/api/readiness') return json(readiness(paper.status().riskDays));
        if (url.pathname === '/api/risk/execution') return json(executionRisk.status());
        if (url.pathname === '/api/operations') return json(operations.snapshot(paper.currentMarks()));
        if (url.pathname === '/api/paper/session') return json(paper.status());
        if (url.pathname === '/api/paper/risk-days') return json(paper.status().riskDays);
        if (url.pathname === '/api/paper/events') {
          const requestOrigin = req.headers.get('origin'), site = req.headers.get('sec-fetch-site');
          if ((requestOrigin && ![origin, `http://localhost:${port}`].includes(requestOrigin)) || (site && !['same-origin', 'none'].includes(site))) return json({ error: 'Same-origin paper updates required' }, 403);
          return updates.response(headers);
        }
        if (url.pathname === '/api/feeds/lighter') return json(feed.status());
        if (url.pathname === '/api/fleet') return json(fleet.status());
        if (url.pathname === '/api/fleet/journal') return json({ entries: journal.list({ botId: url.searchParams.get('botId') ?? undefined, limit: Number(url.searchParams.get('limit') ?? 200) }) });
        if (url.pathname === '/api/feeds/lighter/trades') {
          const marketId = url.searchParams.get('marketId');
          if (!marketId || !/^\d{1,10}$/.test(marketId)) throw new Error('Valid marketId required');
          return json({ source: 'public evidence only', continuity: 'unproven', trades: feed.evidence!.recentTrades(Number(marketId)) });
        }
        if (url.pathname === '/api/feeds/lighter/captures') return json(feed.evidence!.status());
        if (['/api/feeds/lighter/capture', '/api/feeds/lighter/replay'].includes(url.pathname)) {
          const id = url.searchParams.get('id') ?? '';
          if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Valid capture ID required');
          const capture = feed.evidence!.export(id);
          return json(url.pathname.endsWith('/replay') ? replayCapture(capture) : capture);
        }
        if (url.pathname === '/api/risk/allocation') return json(operations.allocationPolicy());
        if (url.pathname === '/api/risk/allocation/preview') return json(operations.allocationPreview());
        if (url.pathname === '/api/stats/archives') return json(operations.archives());
        if (url.pathname === '/api/stats/archive') return json(operations.archive(url.searchParams.get('id') || ''));
        if (url.pathname === '/api/markets') return json(markets.state);
        if (url.pathname === '/api/lighter') return json({ config: operations.lighterConfig(), account: store.get('lighterAccount') });
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