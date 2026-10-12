import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store';
import { LighterStream, type StreamSocket } from '../src/lighter-stream';
import { LighterEvidence, replayCapture } from '../src/lighter-evidence';
import { parseTrades } from '../src/lighter-trades';

const market = { symbol: 'BTC', market_id: 1, supported_price_decimals: 2, supported_size_decimals: 5 };
const clock = { wall: 1791700000000, mono: 100 };
const book = (nonce = 1, snapshot = true) => ({ type: snapshot ? 'subscribed/order_book' : 'update/order_book', channel: 'order_book:1', timestamp: clock.wall,
  order_book: { code: 0, nonce, begin_nonce: nonce - 1, bids: snapshot ? [{ price: '100', size: '1' }] : [], asks: snapshot ? [{ price: '101', size: '1' }] : [] } });
const trade = (id = 1) => ({ trade_id: id, trade_id_str: String(id), market_id: 1, type: 'trade', price: '100.00', size: '0.12345',
  is_maker_ask: true, timestamp: clock.wall - 10000, transaction_time: clock.wall * 1000 - 1000, tx_hash: 'a'.repeat(64), block_height: 1 });
const batch = (nonce = 10, trades = [trade()]) => ({ type: 'update/trade', channel: 'trade:1', nonce, trades, liquidation_trades: [] });
const stats = () => ({ type: 'update/market_stats', channel: 'market_stats:1', timestamp: clock.wall,
  market_stats: { market_id: 1, symbol: 'BTC', mark_price: '100', index_price: '100', last_trade_price: '100', funding_rate: '0', current_funding_rate: '0', funding_timestamp: clock.wall - 3600000 } });
class Socket {
  readyState = 1; sent: any[] = [];
  onopen: StreamSocket['onopen'] = null; onmessage: StreamSocket['onmessage'] = null; onerror: StreamSocket['onerror'] = null; onclose: StreamSocket['onclose'] = null;
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; }
  open() { this.onopen?.call(this as any, {} as Event); }
  emit(frame: unknown) { this.onmessage?.call(this as any, { data: JSON.stringify(frame) } as MessageEvent); }
}
function fixture(limits = {}, retention = 5000) {
  const store = new Store(':memory:'), sockets: Socket[] = [], time = { ...clock };
  const feed = new LighterStream(store, { tradeEvidence: true, marketStats: true, evidenceLimits: limits, retention, clock: () => ({ ...time }),
    tickMs: 60000, retryMs: 1, random: () => 0, connect: () => { const socket = new Socket(); sockets.push(socket); return socket; } });
  feed.watch([market]); feed.start(); sockets[0].open();
  return { store, feed, sockets, time, close: () => { feed.stop(); store.db.close(); } };
}
const rehash = (capture: ReturnType<LighterEvidence['export']>) => {
  capture.sha256 = new Bun.CryptoHasher('sha256').update(JSON.stringify({ manifest: capture.manifest, frames: capture.frames })).digest('hex');
  return capture;
};

test('public trades retain exact units, maker direction and separate ms/us clocks without a publication timestamp', () => {
  const result = parseTrades(batch(), market, clock);
  expect(result.trades[0]).toMatchObject({ id: '1', priceTicks: '10000', quantityUnits: '12345', makerAsk: true,
    blockTimeMs: clock.wall - 10000, executionTimeUs: clock.wall * 1000 - 1000 });
  expect(parseTrades(batch(1000), market, clock, 10).nonce).toBe(1000); // jumps are NOT proven gaps
  expect(parseTrades(batch(10, [{ ...trade(), transaction_time: 0 }]), market, clock).trades[0].executionTimeUs).toBeNull();
  expect(() => parseTrades(batch(9), market, clock, 10)).toThrow('Regressing');
});

test('trade identities, economics, channel and time units reject malformed input', () => {
  for (const mutation of [
    { market_id: 2 }, { trade_id: Number.MAX_SAFE_INTEGER + 1 }, { trade_id_str: '2' }, { type: 'unknown' }, { is_maker_ask: 'true' },
    { price: 100 }, { price: '0' }, { price: '100.001' }, { size: '0' }, { size: '0.000001' }, { size: '1e6' },
    { timestamp: Math.floor(clock.wall / 1000) }, { timestamp: clock.wall + 2001 }, { transaction_time: clock.wall }, { tx_hash: 'invalid' },
  ]) expect(() => parseTrades(batch(10, [{ ...trade(), ...mutation } as any]), market, clock)).toThrow();
  for (const mutation of [{ channel: 'trade:2' }, { nonce: -1 }, { trades: null }, { liquidation_trades: null }, { trades: Array(1001).fill(trade()) }]) {
    expect(() => parseTrades({ ...batch(), ...mutation }, market, clock)).toThrow();
  }
  expect(() => parseTrades(batch(10, [trade(), { ...trade(), size: '1' }]), market, clock)).toThrow('Conflicting');
});

test('both regular and liquidation lists are recorded, with exact duplicates deduplicated durably', () => {
  const f = fixture();
  try {
    expect(f.sockets[0].sent.map(m => m.channel)).toEqual(['order_book/1', 'market_stats/1', 'trade/1']);
    f.sockets[0].emit(book()); f.sockets[0].emit(stats());
    f.sockets[0].emit({ ...batch(), liquidation_trades: [{ ...trade(2), type: 'liquidation' }] });
    f.sockets[0].emit(batch(20));
    expect(f.feed.evidence!.recentTrades(1)).toHaveLength(2);
    expect(f.feed.status().counts.tradeFrames).toBe(2);
    expect(f.feed.status().trades[0]).toMatchObject({ nonce: 20, continuity: 'unproven', receiveAgeMs: 0 });
    const replay = replayCapture(f.feed.evidence!.export(f.feed.status().epoch!));
    expect(replay).toMatchObject({ snapshotRooted: true, statsCovered: true, uniqueTrades: 2, executionEnabled: false, strategyValidationReady: false });
  } finally { f.close(); }
});

test('conflicting retained trade ID is rejected, never overwrites evidence, and invalidates live depth', () => {
  const f = fixture();
  try {
    f.sockets[0].emit(book()); f.sockets[0].emit(stats()); f.sockets[0].emit(batch());
    f.sockets[0].emit(batch(11, [{ ...trade(), price: '99' }]));
    expect(f.feed.read(1)).toBeNull(); expect(f.feed.status().counts.invalid).toBe(1);
    expect(f.feed.evidence!.recentTrades(1)[0].priceTicks).toBe('10000');
    const m = f.feed.evidence!.list()[0]; expect(m.state).toBe('closed'); expect(m.reason).toContain('Conflicting');
    expect(m.frames).toBe(3);
  } finally { f.close(); }
});

test('snapshot-rooted capture replays identically after rolling diagnostics discard its snapshot', () => {
  const f = fixture({}, 2);
  try {
    f.sockets[0].emit(book()); f.sockets[0].emit(stats());
    for (let n = 2; n < 10; n++) f.sockets[0].emit(book(n, false));
    f.sockets[0].emit(batch());
    expect((f.store.db.query('SELECT COUNT(*) AS n FROM lighter_feed_journal').get() as any).n).toBe(2);
    const capture = f.feed.evidence!.export(f.feed.status().epoch!);
    expect(JSON.parse(capture.frames[0].raw).type).toBe('subscribed/order_book');
    const first = replayCapture(capture), second = replayCapture(capture);
    expect(first.stateSha256).toBe(second.stateSha256); expect(first.books[0].nonce).toBe(9);
    expect(first.books[0].bids[0]).toEqual({ price: 100, quantity: 1 });
    expect(f.store.db.query("SELECT name FROM sqlite_master WHERE name IN ('fills','paper_orders','paper_reservations')").all()).toHaveLength(0);
  } finally { f.close(); }
});

test('replay detects modified bytes, sequence, missing roots, clocks and semantic sequence gaps', () => {
  const f = fixture();
  try {
    f.sockets[0].emit(book()); f.sockets[0].emit(book(2, false));
    const original = f.feed.evidence!.export(f.feed.status().epoch!);
    let modified = structuredClone(original); modified.frames[1].raw += ' ';
    expect(() => replayCapture(modified)).toThrow('checksum/size');
    modified = structuredClone(original); modified.frames[1].sequence = 3;
    expect(() => replayCapture(rehash(modified))).toThrow('receive order');
    modified = structuredClone(original); modified.frames[1].clock.mono = 99;
    expect(() => replayCapture(rehash(modified))).toThrow('receive order');
    modified = structuredClone(original);
    const delta = JSON.parse(modified.frames[1].raw); delta.order_book.begin_nonce = 0;
    modified.frames[1].raw = JSON.stringify(delta);
    expect(() => replayCapture(rehash(modified))).toThrow('Sequence gap');
    modified = structuredClone(original); const root = JSON.parse(modified.frames[0].raw); root.type = 'update/order_book';
    modified.frames[0].raw = JSON.stringify(root); modified.manifest.bytes = modified.frames.reduce((n, x) => n + Buffer.byteLength(x.raw), 0);
    expect(() => replayCapture(rehash(modified))).toThrow('Sequence gap');
  } finally { f.close(); }
});

test('capture frame/byte caps seal a prefix without trimming its root or disabling paper data', () => {
  for (const limits of [{ captureFrames: 2 }, { captureBytes: Buffer.byteLength(JSON.stringify(book())) }]) {
    const f = fixture(limits);
    try {
      f.sockets[0].emit(book()); f.sockets[0].emit(stats()); f.sockets[0].emit(book(2, false)); f.sockets[0].emit(batch());
      const capture = f.feed.evidence!.export(f.feed.status().epoch!);
      expect(capture.manifest.state).toBe('limited'); expect(capture.frames.length).toBeLessThanOrEqual(2);
      expect(replayCapture(capture).snapshotRooted).toBe(true);
      expect(f.feed.status().healthy).toBe(true); expect(f.feed.evidence!.recentTrades(1)).toHaveLength(1);
    } finally { f.close(); }
  }
});

test('capture and trade retention evicts whole captures, never orphaning a delta prefix', () => {
  const f = fixture({ captures: 2, tradeRecords: 2 });
  try {
    const first = f.feed.status().epoch!;
    for (let n = 1; n <= 4; n++) {
      const ws = f.sockets.at(-1)!; ws.emit(book()); ws.emit(stats()); ws.emit(batch(10, [trade(n)]));
      if (n !== 4) { ws.onclose?.call(ws as any, {} as CloseEvent); f.time.mono += 100; f.feed.tick(); f.sockets.at(-1)!.open(); }
    }
    expect(f.feed.evidence!.list()).toHaveLength(2); expect(() => f.feed.evidence!.export(first)).toThrow('evicted');
    expect(f.feed.evidence!.recentTrades(1).map(t => t.id)).toEqual(['4', '3']);
    expect((f.store.db.query('SELECT COUNT(DISTINCT capture_id) AS n FROM lighter_capture_frames').get() as any).n).toBe(2);
    for (const m of f.feed.evidence!.list()) expect(replayCapture(f.feed.evidence!.export(m.id)).snapshotRooted).toBe(true);
  } finally { f.close(); }
});

test('disconnect and watch changes close captures; fenced old callbacks cannot append', () => {
  const f = fixture();
  try {
    const ws = f.sockets[0], stale = ws.onmessage!; ws.emit(book()); ws.emit(stats()); ws.emit(batch());
    const id = f.feed.status().epoch!;
    f.feed.watch([{ ...market, symbol: 'ETH', market_id: 2 }]);
    stale.call(ws as any, { data: JSON.stringify(batch(11, [trade(2)])) } as MessageEvent);
    expect(f.feed.evidence!.export(id).manifest).toMatchObject({ state: 'closed', reason: 'Watch set changed', frames: 3 });
    expect(f.feed.evidence!.recentTrades(1)).toHaveLength(1); expect(f.feed.status().trades[0].nonce).toBeNull();
  } finally { f.close(); }
});

test('quiet trade channels never freshen stale books or claim complete coverage', () => {
  const f = fixture();
  try {
    f.sockets[0].emit(book()); f.sockets[0].emit(stats());
    expect(f.feed.status().healthy).toBe(true); expect(f.feed.status().trades[0].receivedAt).toBeNull();
    f.time.mono += 5001; f.time.wall += 5001; f.sockets[0].emit(batch());
    expect(f.feed.read(1)).toBeNull(); f.feed.tick();
    expect(f.feed.status().healthy).toBe(false); expect(f.feed.evidence!.list()[0].reason).toContain('Stale');
  } finally { f.close(); }
});

test('evidence storage failure rolls back diagnostic/trade writes and latches the authority off', () => {
  const f = fixture();
  try {
    f.sockets[0].emit(book()); f.sockets[0].emit(stats());
    const before = (f.store.db.query('SELECT COUNT(*) AS n FROM lighter_feed_journal').get() as any).n;
    f.store.db.exec('DROP TABLE lighter_capture_frames'); f.sockets[0].emit(batch());
    expect(f.feed.status().state).toBe('recording failed'); expect(f.feed.read(1)).toBeNull();
    expect((f.store.db.query('SELECT COUNT(*) AS n FROM lighter_feed_journal').get() as any).n).toBe(before);
    expect(f.feed.evidence!.recentTrades(1)).toHaveLength(0);
    f.time.mono += 100000; f.feed.tick(); expect(f.sockets).toHaveLength(1);
  } finally { f.close(); }
});

test('process restart preserves replay bytes and marks unfinished capture interrupted without resuming', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-evidence-')), path = join(dir, 'test.sqlite');
  let store = new Store(path);
  try {
    let evidence = new LighterEvidence(store, {}, clock.wall);
    store.db.transaction(() => {
      evidence.begin('restart-test', [market], 5000, false, clock);
      evidence.append('restart-test', JSON.stringify(book()), clock, []);
    }).immediate();
    const before = replayCapture(evidence.export('restart-test')).stateSha256;
    store.db.close(); store = new Store(path); evidence = new LighterEvidence(store, {}, clock.wall + 1000);
    const capture = evidence.export('restart-test'); expect(capture.manifest.state).toBe('interrupted');
    expect(replayCapture(capture).stateSha256).toBe(before);
    store.db.transaction(() => evidence.append('restart-test', JSON.stringify(book(2, false)), clock, [])).immediate();
    expect(evidence.export('restart-test').frames).toHaveLength(1);
  } finally { store.db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('replay flags absent per-market snapshot/stats coverage instead of claiming readiness', () => {
  const f = fixture();
  try {
    f.sockets[0].emit(batch());
    expect(replayCapture(f.feed.evidence!.export(f.feed.status().epoch!))).toMatchObject({ snapshotRooted: false, statsCovered: false, strategyValidationReady: false });
  } finally { f.close(); }
});

test('evidence limits and inspection queries are strictly bounded', () => {
  const store = new Store(':memory:');
  try {
    for (const limits of [{ captureFrames: 2001 }, { captureBytes: Infinity }, { captures: 0 }, { tradeRecords: 10001 }]) expect(() => new LighterEvidence(store, limits)).toThrow('limits');
    const evidence = new LighterEvidence(store);
    expect(() => evidence.recentTrades(-1)).toThrow('query'); expect(() => evidence.recentTrades(1, 101)).toThrow('query');
    expect(() => evidence.export('unknown')).toThrow('Unknown');
  } finally { store.db.close(); }
});

test('all watched markets need their own snapshot and stats in replay coverage', () => {
  const f = fixture();
  try {
    f.feed.watch([market, { ...market, symbol: 'ETH', market_id: 2 }]); f.time.mono += 100; f.feed.tick();
    const ws = f.sockets.at(-1)!; ws.open(); ws.emit(book()); ws.emit(stats());
    const id = f.feed.status().epoch!;
    expect(replayCapture(f.feed.evidence!.export(id))).toMatchObject({ snapshotRooted: false, statsCovered: false });
    ws.emit({ ...book(), channel: 'order_book:2' });
    expect(replayCapture(f.feed.evidence!.export(id))).toMatchObject({ snapshotRooted: true, statsCovered: false });
    const nextStats = stats(); ws.emit({ ...nextStats, channel: 'market_stats:2', market_stats: { ...nextStats.market_stats, market_id: 2, symbol: 'ETH' } });
    expect(replayCapture(f.feed.evidence!.export(id))).toMatchObject({ snapshotRooted: true, statsCovered: true });
  } finally { f.close(); }
});

test('missing trade storage latches recording failure rather than a reconnect loop', () => {
  const f = fixture();
  try {
    f.sockets[0].emit(book()); f.sockets[0].emit(stats());
    f.store.db.exec('DROP TABLE lighter_public_trades'); f.sockets[0].emit(batch());
    expect(f.feed.status().state).toBe('recording failed'); expect(f.feed.status().counts.recordingFailures).toBe(1);
    f.time.mono += 100000; f.feed.tick(); expect(f.sockets).toHaveLength(1);
  } finally { f.close(); }
});

test('real loopback WebSocket delivers all evidence channels and exported CLI replay has no transport', async () => {
  const store = new Store(':memory:'), channels = new Set<string>();
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch(req, server) { return server.upgrade(req) ? undefined : new Response('upgrade required', { status: 400 }); },
    websocket: { message(ws, raw) {
      const message = JSON.parse(String(raw));
      if (message.type !== 'subscribe') return;
      channels.add(message.channel);
      ws.send(JSON.stringify(message.channel.startsWith('order_book') ? book() : message.channel.startsWith('market_stats') ? stats() : batch()));
    } },
  });
  const feed = new LighterStream(store, { tradeEvidence: true, marketStats: true, clock: () => clock, connect: () => new WebSocket(`ws://127.0.0.1:${server.port}`) });
  const dir = mkdtempSync(join(tmpdir(), 'dream-replay-cli-'));
  try {
    feed.watch([market]); feed.start();
    for (let n = 0; n < 100 && (!feed.status().healthy || feed.status().counts.tradeFrames === 0); n++) await Bun.sleep(10);
    expect([...channels].sort()).toEqual(['market_stats/1', 'order_book/1', 'trade/1']);
    expect(feed.status().healthy).toBe(true); expect(feed.evidence!.recentTrades(1)).toHaveLength(1);
    const capture = feed.evidence!.export(feed.status().epoch!), expected = replayCapture(capture);
    const path = join(dir, 'capture.json'); await Bun.write(path, JSON.stringify(capture));
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL('../scripts/replay-lighter.ts', import.meta.url)), path], { stdout: 'pipe', stderr: 'pipe', timeout: 10000 });
    const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(err).toBe(''); expect(exit).toBe(0); expect(JSON.parse(out).stateSha256).toBe(expected.stateSha256);
  } finally { feed.stop(); server.stop(true); store.db.close(); rmSync(dir, { recursive: true, force: true }); }
}, 15000);