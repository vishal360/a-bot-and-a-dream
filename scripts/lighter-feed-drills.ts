import { closeSync, copyFileSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store';
import { LighterStream, type StreamSocket } from '../src/lighter-stream';
import { LighterAcceptance, type CaptureCheck } from '../src/lighter-acceptance';
import { replayCapture } from '../src/lighter-evidence';
import type { BookClock, StreamMarket } from '../src/lighter-book';
import { observeAcceptance } from './lighter-acceptance-observation';
import { AcceptanceProgress } from './lighter-acceptance-progress';

const markets: StreamMarket[] = [
  { symbol: 'BTC', market_id: 1, supported_price_decimals: 2, supported_size_decimals: 5 },
  { symbol: 'ETH', market_id: 0, supported_price_decimals: 2, supported_size_decimals: 4 },
];
export const feedDrillNames = [
  'disconnect-resnapshot', 'sequence-gap', 'stale-stats', 'future-publication',
  'recording-failure', 'connect-recording-failure', 'restart-restore',
  'slow-heartbeat', 'loopback-disconnect',
] as const;
type DrillName = typeof feedDrillNames[number];
type Check = { name: string; passed: boolean; observed: unknown };
export type FeedDrillResult = { name: DrillName; passed: boolean; checks: Check[]; artifacts: string[]; error: string | null };

/** Flush before publishing; a missing final report is never a completed drill suite. */
function publish(directory: URL, name: string, record: unknown) {
  const temporary = new URL(`${name}.tmp`, directory);
  const fd = openSync(temporary, 'wx');
  try { writeFileSync(fd, JSON.stringify(record, null, 2)); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temporary, new URL(name, directory));
}

class FixtureSocket {
  readyState = 1;
  onopen: StreamSocket['onopen'] = null; onmessage: StreamSocket['onmessage'] = null;
  onerror: StreamSocket['onerror'] = null; onclose: StreamSocket['onclose'] = null;
  send(_raw: string) {}
  close() { this.readyState = 3; }
  open() { this.onopen?.call(this as unknown as WebSocket, {} as Event); }
  emit(frame: unknown) { this.onmessage?.call(this as unknown as WebSocket, { data: JSON.stringify(frame) } as MessageEvent); }
  drop() { this.onclose?.call(this as unknown as WebSocket, {} as CloseEvent); }
}
const book = (market: StreamMarket, clock: BookClock, snapshot = true, nonce = 1, begin = nonce - 1) => ({
  type: `${snapshot ? 'subscribed' : 'update'}/order_book`, channel: `order_book:${market.market_id}`, timestamp: clock.wall,
  order_book: { code: 0, nonce, begin_nonce: begin,
    bids: snapshot ? [{ price: '100', size: '1' }] : [], asks: snapshot ? [{ price: '101', size: '1' }] : [] },
});
const stats = (market: StreamMarket, clock: BookClock) => ({
  type: 'subscribed/market_stats', channel: `market_stats:${market.market_id}`, timestamp: clock.wall,
  market_stats: { market_id: market.market_id, symbol: market.symbol, mark_price: '100', index_price: '100', last_trade_price: '100',
    funding_rate: '0', current_funding_rate: '0', funding_timestamp: clock.wall - 3600000 },
});
const trade = (market: StreamMarket, clock: BookClock, id: number) => ({
  type: 'subscribed/trade', channel: `trade:${market.market_id}`, nonce: id, liquidation_trades: [],
  trades: [{ trade_id: id, trade_id_str: String(id), market_id: market.market_id, type: 'trade', price: '100', size: '0.001',
    is_maker_ask: true, timestamp: clock.wall, transaction_time: clock.wall * 1000, tx_hash: 'a'.repeat(64), block_height: id }],
});
function fixture(directory: URL, name: string, start = true) {
  const store = new Store(fileURLToPath(new URL(`${name}.sqlite`, directory)));
  const time = { wall: 1800000000000, mono: 100 }, sockets: FixtureSocket[] = [];
  const feed = new LighterStream(store, { marketStats: true, tradeEvidence: true, clock: () => ({ ...time }),
    tickMs: 60000, retryMs: 1, random: () => 0,
    connect: () => { const socket = new FixtureSocket(); sockets.push(socket); return socket; } });
  feed.watch(markets);
  if (start) { feed.start(); sockets[0].open(); }
  let tradeId = 0;
  const prime = (firstId?: number) => {
    if (firstId !== undefined) tradeId = firstId;
    const socket = sockets.at(-1)!;
    for (const market of markets) { socket.emit(book(market, time)); socket.emit(stats(market, time)); socket.emit(trade(market, time, ++tradeId)); }
  };
  const advance = (ms: number) => { time.mono += ms; time.wall += ms; };
  const recover = () => { advance(1000); feed.tick(); sockets.at(-1)!.open(); prime(); };
  const sample = (acceptance: LighterAcceptance) => {
    const status = feed.status();
    acceptance.sample({ wall: time.wall, mono: time.mono, healthy: status.healthy, ...status.counts });
    return time.mono;
  };
  const close = () => { try { feed.stop(); return feed.status().state; } finally { store.db.close(); } };
  return { store, feed, time, sockets, prime, advance, recover, sample, close };
}
type Fixture = ReturnType<typeof fixture>;
function captureChecks(f: Fixture): CaptureCheck[] {
  return f.feed.evidence!.list().map(m => {
    const replay = replayCapture(f.feed.evidence!.export(m.id));
    return { id: m.id, snapshotRooted: replay.snapshotRooted, statsCovered: replay.statsCovered,
      frames: replay.frames, stateSha256: replay.stateSha256, error: null };
  });
}
function fixtureReport(f: Fixture, acceptance: LighterAcceptance, duration: number, error: string | null = null) {
  return { ...acceptance.report(duration, captureChecks(f), markets.map(m => ({ marketId: m.market_id,
    tradesObserved: f.feed.evidence!.recentTrades(m.market_id).length > 0 })), error),
    source: 'isolated BTC/ETH fixture; NOT mainnet acceptance' };
}
function unavailable(feed: LighterStream) { return !feed.status().healthy && markets.every(m => feed.read(m.market_id) === null); }
function rejected(store: Store) {
  return (store.db.query("SELECT COUNT(*) AS n FROM lighter_feed_journal WHERE kind='frame' AND json_extract(payload,'$.accepted')=0").get() as { n: number }).n;
}

/** Fixture-only engineering drills. No operator database, Paper, credentials or order adapter. */
export async function runFeedDrills(directory: URL) {
  // A new directory is mandatory: never overwrite an older report or another observer.
  mkdirSync(directory);
  const startedAt = new Date().toISOString(), results: FeedDrillResult[] = [];
  const sourceFiles = ['scripts/lighter-feed-drills.ts', 'scripts/lighter-acceptance-observation.ts',
    'scripts/lighter-acceptance-progress.ts', 'src/lighter-stream.ts', 'src/lighter-book.ts',
    'src/lighter-stats.ts', 'src/lighter-trades.ts', 'src/lighter-evidence.ts', 'src/lighter-acceptance.ts', 'src/store.ts'];
  const sources = await Promise.all(sourceFiles.map(async file => {
    const bytes = await Bun.file(new URL(`../${file}`, import.meta.url)).arrayBuffer();
    return { file, bytes: bytes.byteLength, sha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex') };
  }));
  const run = async (name: DrillName, exercise: (check: (name: string, passed: boolean, observed: unknown) => void, artifacts: string[]) => void | Promise<void>) => {
    const checks: Check[] = [], artifacts: string[] = [];
    let error: string | null = null;
    try { await exercise((name, passed, observed) => { checks.push({ name, passed, observed }); }, artifacts); }
    catch (e) { error = (e as Error).message; }
    results.push({ name, passed: error === null && checks.length > 0 && checks.every(c => c.passed), checks, artifacts, error });
  };
  const recorded = async (name: DrillName, exercise: (f: Fixture, check: (name: string, passed: boolean, observed: unknown) => void, artifacts: string[]) => void | Promise<void>, start = true) => {
    await run(name, async (check, artifacts) => {
      const f = fixture(directory, name, start);
      artifacts.push(`${name}.sqlite`);
      let stoppedState: string;
      try { await exercise(f, check, artifacts); }
      finally { stoppedState = f.close(); }
      check('stream stopped', stoppedState === 'stopped' || stoppedState === 'recording failed', stoppedState);
      check('owned socket cleanup', f.sockets.every(s => s.readyState === 3), f.sockets.map(s => s.readyState));
    });
  };
  await recorded('disconnect-resnapshot', (f, check) => {
    f.prime(); const epoch = f.feed.status().epoch, a = new LighterAcceptance(); f.sample(a);
    check('initial depth, stats and trades healthy', f.feed.status().healthy && f.feed.status().counts.tradeFrames === 2, f.feed.status().counts);
    const old = f.sockets[0], callback = old.onmessage;
    old.drop(); check('disconnect invalidates every executable book', unavailable(f.feed), f.feed.status().state);
    f.advance(1000); f.feed.tick(); const next = f.sockets.at(-1)!; next.open();
    for (const market of markets) { next.emit(stats(market, f.time)); next.emit(trade(market, f.time, 10 + market.market_id)); }
    next.emit(book(markets[1], f.time));
    check('partial resnapshot cannot declare whole feed healthy', !f.feed.status().healthy && f.feed.read(1) === null, f.feed.status().healthy);
    const accepted = f.feed.status().counts.accepted;
    callback?.call(old as unknown as WebSocket, { data: JSON.stringify(book(markets[0], f.time)) } as MessageEvent);
    check('late old-epoch callback ignored', f.feed.status().counts.accepted === accepted, f.feed.status().counts.accepted);
    next.emit(book(markets[0], f.time)); f.sample(a);
    const report = fixtureReport(f, a, 1000);
    check('fresh complete roots restore feed in a new epoch', f.feed.status().healthy && f.feed.status().epoch !== epoch, f.feed.status().epoch);
    check('recovery between samples still counts as unhealthy', report.unhealthyMs === 1000 && !report.samplePassed, report.unhealthyMs);
    check('both epochs replay from their own roots', captureChecks(f).length === 2 && captureChecks(f).every(c => c.snapshotRooted && c.statsCovered), captureChecks(f));
  });
  await recorded('sequence-gap', (f, check) => {
    f.prime(); f.sockets[0].emit(book(markets[0], f.time, false, 3, 99));
    check('gap invalidates execution and records rejection', unavailable(f.feed) && f.feed.status().counts.gaps === 1 && rejected(f.store) === 1,
      { counts: f.feed.status().counts, rejected: rejected(f.store) });
    f.recover(); check('fresh roots recover without accepting bad delta', f.feed.status().healthy && f.feed.status().counts.gaps === 1, f.feed.status().counts);
    check('accepted prefixes remain replayable', captureChecks(f).every(c => c.snapshotRooted && c.statsCovered), captureChecks(f));
  });
  await recorded('stale-stats', (f, check) => {
    f.prime(); f.advance(4000);
    for (const market of markets) f.sockets[0].emit(book(market, f.time, false, 2));
    f.advance(1001); f.feed.tick();
    check('fresh book cannot bypass expired stats', unavailable(f.feed) && f.feed.status().counts.stale === 1 && f.feed.status().error?.includes('Stale market stats') === true,
      { error: f.feed.status().error, counts: f.feed.status().counts });
    f.recover(); check('fresh snapshot and stats restore health', f.feed.status().healthy, f.feed.status().state);
  });
  await recorded('future-publication', (f, check) => {
    f.prime(); f.sockets[0].emit({ ...stats(markets[0], f.time), timestamp: f.time.wall + 2001 });
    check('unchanged two-second future tolerance enforced', unavailable(f.feed) && rejected(f.store) === 1 && f.feed.status().error?.includes('Stale/future') === true,
      { error: f.feed.status().error, rejected: rejected(f.store) });
    f.recover(); check('valid timestamps recover without clock offsets', f.feed.status().healthy, f.feed.status().state);
  });
  await recorded('recording-failure', async (f, check, artifacts) => {
    f.prime(); const a = new LighterAcceptance();
    const before = (f.store.db.query('SELECT COUNT(*) AS n FROM lighter_feed_journal').get() as { n: number }).n;
    let error: string | null = null;
    try {
      await observeAcceptance(2000, { now: () => f.time.mono, progress: async () => {},
        sample: () => { const mono = f.sample(a); if (f.feed.status().counts.recordingFailures) throw new Error('Recording failed; acceptance stopped'); return mono; },
        sleep: async ms => { f.advance(ms); f.store.db.exec('PRAGMA query_only=ON'); f.sockets[0].emit(book(markets[0], f.time, false, 2)); } });
    } catch (e) { error = (e as Error).message; }
    const after = (f.store.db.query('SELECT COUNT(*) AS n FROM lighter_feed_journal').get() as { n: number }).n;
    check('write refusal rolls back recording and invalidates depth', unavailable(f.feed) && before === after && f.feed.status().counts.recordingFailures === 1,
      { before, after, counts: f.feed.status().counts });
    f.store.db.exec('PRAGMA query_only=OFF'); f.advance(100000); f.feed.start(); f.feed.tick();
    check('storage repair alone cannot resume fatal instance', f.sockets.length === 1 && unavailable(f.feed), f.feed.status().state);
    const report = fixtureReport(f, a, 2000, error);
    check('patched observer propagates recording failure without completion', error === 'Recording failed; acceptance stopped' && !report.samplePassed && report.elapsedMs < 2000 && !report.sustainedFeedAccepted,
      { error, elapsedMs: report.elapsedMs, failures: report.failures });
    publish(directory, 'recording-failure-acceptance.json', report); artifacts.push('recording-failure-acceptance.json');
  });
  await recorded('connect-recording-failure', (f, check) => {
    f.store.db.exec('PRAGMA query_only=ON'); f.feed.start();
    check('connect write failure prevents transport creation', f.sockets.length === 0 && f.feed.status().counts.recordingFailures === 1 && unavailable(f.feed), f.feed.status().state);
    f.store.db.exec('PRAGMA query_only=OFF'); f.advance(100000); f.feed.tick();
    check('fatal connect failure does not retry', f.sockets.length === 0, f.sockets.length);
  }, false);
  await run('restart-restore', (check, artifacts) => {
    const f = fixture(directory, 'restart-original');
    let capture: ReturnType<NonNullable<LighterStream['evidence']>['export']>;
    try {
      f.prime(); capture = f.feed.evidence!.export(f.feed.status().epoch!);
      publish(directory, 'restart-before.json', capture); artifacts.push('restart-before.json', 'restart-original.sqlite');
      // Refuse finalization to leave a capturing manifest, as an unclean restart would.
      // This is an injection, NOT an OS kill/power-loss durability claim.
      f.store.db.exec('PRAGMA query_only=ON');
    } finally { f.close(); }
    copyFileSync(new URL('restart-original.sqlite', directory), new URL('restart-restored.sqlite', directory));
    artifacts.push('restart-restored.sqlite');
    for (const name of ['restart-original', 'restart-restored']) {
      const reopened = fixture(directory, name, false);
      try {
        const saved = reopened.feed.evidence!.export(capture.manifest.id);
        check(`${name}: unclean prefix retained and marked interrupted`, saved.manifest.state === 'interrupted' && JSON.stringify(saved.frames) === JSON.stringify(capture.frames),
          { state: saved.manifest.state, frames: saved.frames.length });
        check(`${name}: restart cannot inherit live depth`, unavailable(reopened.feed), reopened.feed.status().state);
        check(`${name}: interrupted prefix still replays`, replayCapture(saved).snapshotRooted && replayCapture(saved).statsCovered, replayCapture(saved).stateSha256);
        reopened.advance(1000); reopened.feed.start(); reopened.sockets[0].open();
        check(`${name}: transport open still needs fresh roots`, unavailable(reopened.feed), reopened.feed.status().state);
        reopened.prime(100);
        check(`${name}: fresh roots establish new epoch`, reopened.feed.status().healthy && reopened.feed.status().epoch !== capture.manifest.id,
          reopened.feed.status().epoch);
        publish(directory, `${name}-interrupted.json`, saved); artifacts.push(`${name}-interrupted.json`);
      } finally { reopened.close(); }
      check(`${name}: owned sockets closed`, reopened.sockets.every(s => s.readyState === 3), reopened.sockets.map(s => s.readyState));
    }
  });
  await recorded('slow-heartbeat', async (f, check, artifacts) => {
    f.prime(); const acceptance = new LighterAcceptance();
    const lifecycleDirectory = new URL('slow-heartbeat/', directory); mkdirSync(lifecycleDirectory);
    const lifecycle = new AcceptanceProgress(lifecycleDirectory, { startedAt, pid: process.pid, requestedSeconds: 2, symbols: ['BTC', 'ETH'] });
    let start = 0;
    await observeAcceptance(2000, { now: () => f.time.mono, sample: () => f.sample(acceptance),
      sleep: async ms => { f.advance(ms); }, progress: async mono => {
        start = mono;
        await lifecycle.update({ phase: 'observing', observationElapsedMs: f.time.mono - start, warmupMs: 0,
          state: f.feed.status().state, healthy: f.feed.status().healthy, counts: f.feed.status().counts });
        f.advance(3000); // Deterministic simulated I/O stall, not measured filesystem latency.
      } });
    const report = fixtureReport(f, acceptance, 2000);
    await lifecycle.finish(report);
    const final = await Bun.file(new URL('report.json', lifecycleDirectory)).json();
    const heartbeat = await Bun.file(new URL('run.json', lifecycleDirectory)).json();
    check('stall crossing deadline still records final sample', report.samples === 2 && report.elapsedMs === 3001, { samples: report.samples, elapsedMs: report.elapsedMs });
    check('slow heartbeat cannot qualify healthy evidence', !final.samplePassed && final.maximumSampleGapMs === 3001 && final.failures.includes('Observer sampling gap exceeded policy'), final.failures);
    check('durable failed report completes lifecycle, not acceptance', heartbeat.complete === true && !heartbeat.samplePassed && !heartbeat.sustainedFeedAccepted && !heartbeat.automationAuthorized && !heartbeat.executionEnabled,
      { complete: heartbeat.complete, samplePassed: heartbeat.samplePassed });
    artifacts.push('slow-heartbeat/report.json', 'slow-heartbeat/run.json');
  });
  await run('loopback-disconnect', async (check, artifacts) => {
    const store = new Store(fileURLToPath(new URL('loopback.sqlite', directory)));
    artifacts.push('loopback.sqlite');
    let subscriptions = 0, connections = 0, tradeId = 1000;
    const peers = new Set<{ close: () => void }>();
    let server: ReturnType<typeof Bun.serve> | null = null, feed: LighterStream | null = null, stoppedState: string | null = null;
    try {
      server = Bun.serve({ hostname: '127.0.0.1', port: 0,
        fetch(req, server) { return server.upgrade(req, { data: undefined }) ? undefined : new Response('upgrade required', { status: 400 }); },
        websocket: { open(ws) { peers.add(ws); connections++; }, close(ws) { peers.delete(ws); }, message(ws, raw) {
          const message = JSON.parse(String(raw));
          if (message.type !== 'subscribe') return;
          const [kind, id] = message.channel.split('/'), market = markets.find(m => m.market_id === Number(id));
          if (!market) throw new Error('Unexpected fixture subscription');
          subscriptions++;
          const clock = { wall: Date.now(), mono: performance.now() };
          ws.send(JSON.stringify(kind === 'order_book' ? book(market, clock) : kind === 'market_stats' ? stats(market, clock) : trade(market, clock, ++tradeId)));
        } },
      });
      const url = `ws://127.0.0.1:${server.port}`;
      feed = new LighterStream(store, { marketStats: true, tradeEvidence: true, retryMs: 1, random: () => 0,
        connect: () => new WebSocket(url), tickMs: 60000 });
      const wait = async (condition: () => boolean) => {
        const deadline = performance.now() + 3000;
        while (!condition()) { if (performance.now() >= deadline) throw new Error('Loopback fixture timed out'); await Bun.sleep(5); }
      };
      feed.watch(markets); feed.start(); await wait(() => feed!.status().healthy && feed!.status().counts.tradeFrames >= 2);
      const epoch = feed.status().epoch;
      check('real local transport subscribes to all six channels', subscriptions === 6 && connections === 1, { subscriptions, connections });
      for (const peer of peers) peer.close();
      await wait(() => feed!.status().counts.disconnects === 1);
      check('real transport disconnect invalidates execution', unavailable(feed), feed.status().state);
      await Bun.sleep(5); feed.tick();
      await wait(() => feed!.status().healthy && feed!.status().counts.tradeFrames >= 4);
      check('real reconnect uses new epoch and all fresh channels', feed.status().epoch !== epoch && subscriptions === 12 && connections === 2,
        { subscriptions, connections, epoch: feed.status().epoch });
      const captures = feed.evidence!.list().map(m => feed!.evidence!.export(m.id));
      check('real transport prefixes replay for both epochs', captures.length === 2 && captures.every(c => { const r = replayCapture(c); return r.snapshotRooted && r.statsCovered; }), captures.map(c => c.manifest.id));
      for (const [index, capture] of captures.entries()) { const name = `loopback-${index}.json`; publish(directory, name, capture); artifacts.push(name); }
      check('loopback feed cannot enable agents or execution', feed.status().executionEnabled === false && feed.status().agentsEnabled === false,
        { executionEnabled: feed.status().executionEnabled, agentsEnabled: feed.status().agentsEnabled });
    } finally {
      try { feed?.stop(); stoppedState = feed?.status().state ?? null; }
      finally { server?.stop(true); store.db.close(); }
    }
    check('owned loopback feed stopped', stoppedState === 'stopped', stoppedState);
  });
  const artifacts = await Promise.all([...new Set(results.flatMap(r => r.artifacts))].map(async file => {
    const bytes = await Bun.file(new URL(file, directory)).arrayBuffer();
    return { file, bytes: bytes.byteLength, sha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex') };
  }));
  const report = { version: 1, complete: true, passed: results.length === feedDrillNames.length && results.every(r => r.passed),
    startedAt, endedAt: new Date().toISOString(), source: 'isolated BTC/ETH fixtures and loopback WebSocket; NOT mainnet acceptance',
    runtime: { bun: Bun.version, platform: process.platform }, sources, artifacts, results,
    limitations: ['Injected write refusal, not physical disk/power-loss certification',
      'Interrupted-manifest restart and closed-database restore, not process-kill or online-backup certification',
      'Fixture clocks and deterministic stall are not venue time, mainnet uptime or 24-hour evidence',
      'Funding ordering, units, rounding, finality and overnight marks remain unverified'],
    samplePassed: false, sustainedFeedAccepted: false, strategyValidated: false,
    automationAuthorized: false, agentsEnabled: false, executionEnabled: false, liveSigningEnabled: false };
  publish(directory, 'report.json', report);
  return report;
}