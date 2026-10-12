import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LighterBook, type StreamMarket } from '../src/lighter-book';
import { LighterStream, type StreamSocket } from '../src/lighter-stream';
import { Store } from '../src/store';

const market: StreamMarket = { symbol: 'BTC', market_id: 1, supported_price_decimals: 2, supported_size_decimals: 5 };
const clock = { wall: 1791700000000, mono: 100 };
function frame(nonce = 10, begin = 9, snapshot = true, bids = [{ price: '100', size: '1' }], asks = [{ price: '101', size: '1' }]) {
  return { type: snapshot ? 'subscribed/order_book' : 'update/order_book', channel: 'order_book:1', timestamp: clock.wall, offset: 999999,
    order_book: { code: 0, nonce, begin_nonce: begin, bids, asks, last_updated_at: clock.wall * 1000 - 1000 } };
}
class FakeSocket {
  readyState = 1;
  onopen: StreamSocket['onopen'] = null; onmessage: StreamSocket['onmessage'] = null;
  onerror: StreamSocket['onerror'] = null; onclose: StreamSocket['onclose'] = null;
  sent: any[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; }
  open() { this.onopen?.call(this as any, {} as Event); }
  emit(data: any) { this.onmessage?.call(this as any, { data: typeof data === 'string' ? data : JSON.stringify(data) } as MessageEvent); }
  drop() { this.onclose?.call(this as any, {} as CloseEvent); }
}
function fixture(retention = 5000) {
  const s = new Store(':memory:'), time = { ...clock }, sockets: FakeSocket[] = [];
  const f = new LighterStream(s, { clock: () => ({ ...time }), connect: () => { const ws = new FakeSocket(); sockets.push(ws); return ws; }, random: () => 0, retryMs: 10, tickMs: 60000, retention });
  f.watch([market]); f.start(); sockets[0].open();
  return { s, f, time, sockets, close: () => { f.stop(); s.db.close(); } };
}

test('sequenced book applies absolute sizes/deletes with exact precision; offset is not continuity', () => {
  const b = new LighterBook(market); b.apply(frame(), clock);
  expect(b.view(clock).bids[0].quantity).toBe(1);
  const update = frame(12, 10, false, [{ price: '100.00', size: '0' }, { price: '99.5', size: '0.12345' }], [{ price: '101', size: '2' }]);
  update.offset = 1; b.apply(update, clock);
  expect(b.view(clock).nonce).toBe(12); expect(b.view(clock).bids).toEqual([{ price: 99.5, quantity: .12345 }]);
  expect(b.view(clock).asks[0].quantity).toBe(2);
  expect(b.view(clock).executionTimeUs).toBe(clock.wall * 1000 - 1000);
  expect(b.view(clock).publicationTimeMs).toBe(clock.wall);
});

test('sequence gaps, delta-before-snapshot and duplicate/stale nonces invalidate all visible depth', () => {
  const b = new LighterBook(market);
  expect(() => b.apply(frame(12, 10, false), clock)).toThrow('Sequence gap');
  b.apply(frame(), clock);
  expect(() => b.apply(frame(12, 11, false), clock)).toThrow('Sequence gap');
  expect(b.view(clock).bids).toEqual([]); expect(b.view(clock).nonce).toBeNull();
  b.apply(frame(), clock);
  expect(() => b.apply(frame(9, 10, false), clock)).toThrow('Sequence gap');
  b.apply(frame(), clock);
  expect(() => b.apply(frame(10, 10, false, [{ price: '100', size: '2' }]), clock)).toThrow('without nonce advance');
  b.apply(frame(), clock); b.apply(frame(10, 10, false, [], []), clock); // unchanged heartbeat is safe
  expect(b.view(clock).status).toBe('healthy');
});

test('malformed/crossed/empty/oversized/precision-invalid books fail closed atomically', () => {
  const cases = [
    frame(11, 10, false, [{ price: '102', size: '1' }]),
    frame(11, 10, false, [{ price: '100', size: '0' }]),
    frame(11, 10, false, [{ price: '100.001', size: '1' }]),
    frame(11, 10, false, [{ price: '100', size: '-1' }]),
    frame(11, 10, false, [{ price: '99', size: '1' }, { price: '99.00', size: '2' }]),
    { ...frame(), order_book: { ...frame().order_book, nonce: Number.MAX_SAFE_INTEGER + 1 } },
    { ...frame(), channel: 'order_book:2' },
    { ...frame(), timestamp: clock.wall - 5001 },
    { ...frame(), timestamp: clock.wall + 2001 },
  ];
  for (const bad of cases) {
    const b = new LighterBook(market); b.apply(frame(), clock);
    expect(() => b.apply(bad, clock)).toThrow(); expect(b.view(clock).asks).toEqual([]);
  }
  const b = new LighterBook(market, 5000, 1); b.apply(frame(), clock);
  expect(() => b.apply(frame(11, 10, false, [{ price: '99', size: '1' }]), clock)).toThrow('limit');
});

test('monotonic receive age rejects stale data even with a wall-clock adjustment', () => {
  const b = new LighterBook(market); b.apply(frame(), clock);
  expect(b.view({ wall: clock.wall, mono: clock.mono + 5001 }).status).toBe('stale');
  expect(b.view({ wall: clock.wall, mono: clock.mono + 5001 }).bids).toEqual([]);
  expect(b.view({ wall: clock.wall + 5001, mono: clock.mono }).status).toBe('stale');
  expect(() => b.apply(frame(11, 10, false), { wall: clock.wall, mono: clock.mono + 5001 })).toThrow('Stale book');
  expect(b.view(clock).nonce).toBeNull();
});

test('shadow stream journals before publishing and recovers a gap with a new connection/snapshot', () => {
  const { s, f, time, sockets, close } = fixture();
  try {
    expect(sockets[0].sent).toEqual([{ type: 'subscribe', channel: 'order_book/1' }]);
    sockets[0].emit(frame()); expect(f.status().healthy).toBe(true);
    expect((s.db.query("SELECT payload FROM lighter_feed_journal WHERE kind='frame'").get() as any).payload).toContain('"accepted":true');
    const late = sockets[0].onmessage;
    sockets[0].emit(frame(12, 11, false));
    expect(f.status().healthy).toBe(false); expect(f.status().counts.gaps).toBe(1); expect(f.status().books[0].bids).toEqual([]);
    time.mono += 11; f.tick(); sockets[1].open();
    late?.call(sockets[0] as any, { data: JSON.stringify(frame()) } as MessageEvent); // old transport must be fenced
    expect(f.status().healthy).toBe(false);
    sockets[1].emit(frame(25)); expect(f.status().healthy).toBe(true);
    expect(f.status().counts.connections).toBe(2);
    expect(f.status().latencyMs.receiveToRecorded.samples).toBe(3);
    expect(s.get('marks')).toBeNull(); expect(s.get('paperFeed:BTC')).toBeNull(); expect(s.get('paperSession')).toBeNull();
  } finally { close(); }
});

test('pings never freshen book state; staleness and disconnect require fresh snapshots', () => {
  const { f, time, sockets, close } = fixture();
  try {
    sockets[0].emit(frame()); sockets[0].emit({ type: 'ping' }); expect(sockets[0].sent.at(-1)).toEqual({ type: 'pong' });
    time.mono += 5001; sockets[0].emit({ type: 'pong' }); expect(f.status().healthy).toBe(false);
    f.tick(); expect(f.status().counts.stale).toBe(1); expect(sockets[0].readyState).toBe(3);
    time.mono += 11; f.tick(); sockets[1].open(); sockets[1].emit(frame(11, 10, false));
    expect(f.status().healthy).toBe(false); expect(f.status().counts.gaps).toBe(1);
    time.mono += 21; f.tick(); sockets[2].open(); sockets[2].emit(frame()); sockets[2].drop();
    expect(f.status().healthy).toBe(false); expect(f.status().books[0].asks).toEqual([]);
  } finally { close(); }
});

test('watch changes fence old state; invalid replacement metadata cannot modify the active feed', () => {
  const { f, sockets, close } = fixture();
  try {
    sockets[0].emit(frame());
    expect(() => f.watch([market, market])).toThrow('duplicate'); expect(f.status().healthy).toBe(true);
    expect(() => f.watch([{ ...market, supported_size_decimals: 9 }])).toThrow('metadata'); expect(f.status().healthy).toBe(true);
    f.watch([{ ...market, symbol: 'ETH', market_id: 2 }]); expect(sockets[0].readyState).toBe(3);
    sockets[1].open(); expect(sockets[1].sent[0].channel).toBe('order_book/2'); expect(f.status().healthy).toBe(false);
    f.watch([]); expect(f.status().books).toEqual([]); expect(f.status().state).toBe('waiting for markets');
  } finally { close(); }
});

test('all watched markets need snapshots; one malformed or oversized frame invalidates the whole epoch', () => {
  const { f, sockets, close } = fixture();
  try {
    f.watch([market, { ...market, market_id: 2, symbol: 'ETH' }]); sockets[1].open();
    sockets[1].emit(frame()); expect(f.status().healthy).toBe(false);
    sockets[1].emit({ ...frame(), channel: 'order_book:2' }); expect(f.status().healthy).toBe(true);
    sockets[1].emit('x'.repeat(131073));
    expect(f.status().counts.invalid).toBe(1); expect(f.status().healthy).toBe(false);
    expect(f.status().books.every(b => b.bids.length === 0)).toBe(true);
  } finally { close(); }
});

test('connection and snapshot deadlines back off instead of opening duplicate sockets', () => {
  const { f, time, sockets, close } = fixture();
  try {
    time.mono += 10001; f.tick(); expect(f.status().error).toContain('snapshot timeout');
    f.tick(); expect(sockets).toHaveLength(1);
    time.mono += 11; f.tick(); expect(sockets).toHaveLength(2);
    f.tick(); expect(sockets).toHaveLength(2);
    time.mono += 10001; f.tick(); expect(f.status().state).toBe('reconnecting');
    time.mono += 11; f.tick(); expect(sockets).toHaveLength(2); // second retry is doubled
    time.mono += 10; f.tick(); expect(sockets).toHaveLength(3);
  } finally { close(); }
});

test('client sends periodic keepalive without extending a book age, and treats venue shutdown as a fault', () => {
  const s = new Store(':memory:'), time = { ...clock }, ws = new FakeSocket();
  const f = new LighterStream(s, { connect: () => ws, clock: () => ({ ...time }), staleMs: 120000 });
  try {
    f.watch([market]); f.start(); ws.open(); ws.emit(frame());
    time.mono += 30001; time.wall += 30001; f.tick(); expect(ws.sent.at(-1)).toEqual({ type: 'ping' });
    expect(f.status().books[0].ageMs).toBe(30001);
    ws.emit({ type: 'shutdown' }); expect(f.status().healthy).toBe(false); expect(f.status().error).toContain('shutdown');
  } finally { f.stop(); s.db.close(); }
});

test('failed connect recording latches ingestion off before constructing a transport', () => {
  const s = new Store(':memory:'); let connections = 0;
  const f = new LighterStream(s, { connect: () => { connections++; return new FakeSocket(); } });
  try {
    f.watch([market]); s.db.exec('DROP TABLE lighter_feed_journal'); f.start();
    expect(f.status().state).toBe('recording failed'); expect(connections).toBe(0);
  } finally { f.stop(); s.db.close(); }
});

test('journal/metric retention is bounded; corrupt frames are durably marked rejected', () => {
  const { s, f, sockets, close } = fixture(8);
  try {
    sockets[0].emit(frame());
    for (let n = 11; n < 530; n++) sockets[0].emit(frame(n, n - 1, false, [], []));
    expect((s.db.query('SELECT COUNT(*) AS n FROM lighter_feed_journal').get() as any).n).toBe(8);
    expect(f.status().latencyMs.receiveToApply.samples).toBe(512);
    sockets[0].emit('{broken'); expect(f.status().healthy).toBe(false);
    expect((s.db.query("SELECT payload FROM lighter_feed_journal WHERE kind='frame' ORDER BY id DESC LIMIT 1").get() as any).payload).toContain('"accepted":false');
  } finally { close(); }
});

test('storage failure disables shadow ingestion instead of publishing unrecorded depth or retrying', () => {
  const { s, f, time, sockets, close } = fixture();
  try {
    s.db.exec('DROP TABLE lighter_feed_journal'); sockets[0].emit(frame());
    expect(f.status().state).toBe('recording failed'); expect(f.status().healthy).toBe(false);
    expect(f.status().books[0].bids).toEqual([]); expect(f.status().counts.recordingFailures).toBe(1);
    time.mono += 100000; f.tick(); expect(sockets).toHaveLength(1);
  } finally { close(); }
});

test('durable journal survives restart but in-memory book continuity never does', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-feed-')), path = join(dir, 'feed.sqlite');
  let s = new Store(path), ws = new FakeSocket(), f = new LighterStream(s, { clock: () => clock, connect: () => ws });
  try {
    f.watch([market]); f.start(); ws.open(); ws.emit(frame()); f.stop(); s.db.close();
    s = new Store(path); ws = new FakeSocket(); f = new LighterStream(s, { clock: () => clock, connect: () => ws });
    f.watch([market]); expect(f.status().healthy).toBe(false); expect(f.status().books[0].nonce).toBeNull();
    expect((s.db.query("SELECT COUNT(*) AS n FROM lighter_feed_journal WHERE kind='frame'").get() as any).n).toBe(1);
  } finally { f.stop(); s.db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('real local WebSocket transport subscribes, answers ping, and exposes sequenced shadow depth', async () => {
  const s = new Store(':memory:'); let subscribed = false, pong = false;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch(req, server) { return server.upgrade(req) ? undefined : new Response('upgrade required', { status: 400 }); },
    websocket: { message(ws, raw) {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'subscribe') { subscribed = msg.channel === 'order_book/1'; ws.send(JSON.stringify({ ...frame(), timestamp: Date.now() })); ws.send('{"type":"ping"}'); }
      if (msg.type === 'pong') pong = true;
    } },
  });
  const f = new LighterStream(s, { connect: () => new WebSocket(`ws://127.0.0.1:${server.port}`) });
  try {
    f.watch([market]); f.start();
    for (let i = 0; i < 100 && (!f.status().healthy || !pong); i++) await Bun.sleep(10);
    expect(subscribed).toBe(true); expect(pong).toBe(true); expect(f.status().healthy).toBe(true);
  } finally { f.stop(); server.stop(true); s.db.close(); }
});