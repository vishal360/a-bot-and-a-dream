import { test, expect } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StreamMarket } from '../src/lighter-book';
import { LighterEvidence } from '../src/lighter-evidence';
import { LighterStream, type StreamSocket } from '../src/lighter-stream';
import { DataEngine } from '../src/data-engine';
import { Store } from '../src/store';

const market: StreamMarket = { symbol: 'BTC', market_id: 1, supported_price_decimals: 2, supported_size_decimals: 5 };
const baseWall = 1791700000000;
const clock = { wall: baseWall, mono: 100 };
const rawFrame = (n: number, pad = '') => JSON.stringify({ type: 'subscribed/order_book', channel: 'order_book:1', nonce: n, pad });

function fixture(root: string, engineOptions: Record<string, unknown> = {}) {
  const s = new Store(':memory:');
  const evidence = new LighterEvidence(s, {}, clock.wall);
  const engine = new DataEngine(s, evidence, { root, ...engineOptions });
  return { s, evidence, engine, close: () => s.db.close() };
}

const readIndex = (root: string) => readFileSync(join(root, 'index.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));

test('terminal captures are exported once, indexed, and never duplicated', () => {
  const root = join(tmpdir(), `abad-archive-${crypto.randomUUID()}`);
  try {
    const { evidence, engine, close } = fixture(root);
    evidence.begin('cap-a', [market], 5000, false, clock);
    for (let n = 1; n <= 3; n++) evidence.append('cap-a', rawFrame(n), { wall: baseWall + n, mono: clock.mono + n }, []);
    evidence.finish('cap-a', 'test closed', baseWall + 9);
    evidence.begin('cap-live', [market], 5000, false, { wall: baseWall + 20, mono: 120 });
    evidence.append('cap-live', rawFrame(1), { wall: baseWall + 21, mono: 121 }, []);

    const first = engine.tick();
    expect(first.archived).toEqual(['cap-a']); // capturing captures are skipped
    const records = readIndex(root);
    expect(records).toHaveLength(1);
    expect(records[0].captureId).toBe('cap-a');
    expect(records[0].frames).toBe(3);
    expect(records[0].markets).toEqual(['BTC']);
    expect(records[0].state).toBe('closed');
    expect(existsSync(records[0].file)).toBe(true);
    const stored = JSON.parse(readFileSync(records[0].file, 'utf8'));
    expect(stored.manifest.id).toBe('cap-a');
    expect(stored.frames).toHaveLength(3);
    expect(stored.sha256).toBe(records[0].sha256);

    expect(engine.tick().archived).toEqual([]); // no duplicates on repeated cycles
    expect(readIndex(root)).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('interrupted captures (restarts) are archived too, and a restarted engine does not re-archive', () => {
  const root = join(tmpdir(), `abad-archive-${crypto.randomUUID()}`);
  try {
    const { s, evidence, engine, close } = fixture(root);
    evidence.begin('cap-x', [market], 5000, false, clock);
    evidence.append('cap-x', rawFrame(1), { wall: baseWall + 1, mono: 101 }, []);
    // Simulate a process restart: a fresh evidence instance closes live captures as interrupted.
    const revived = new LighterEvidence(s, {}, baseWall + 5000);
    expect(evidence.list().find(m => m.id === 'cap-x')!.state).toBe('interrupted');
    expect(engine.tick().archived).toEqual(['cap-x']);
    // A fresh engine on the same root loads the index and archives nothing again.
    const second = new DataEngine(s, revived, { root });
    expect(second.tick().archived).toEqual([]);
    expect(readIndex(root)).toHaveLength(1);
    second.stop();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('retention prunes oldest captures first under age and byte caps', () => {
  const root = join(tmpdir(), `abad-archive-${crypto.randomUUID()}`);
  try {
    const { evidence, engine, close } = fixture(root, { keepDays: 30, keepBytes: 4096 });
    const old = baseWall - 40 * 86400000; // beyond keepDays
    evidence.begin('cap-old-big', [market], 5000, false, { wall: old, mono: 1 });
    for (let n = 1; n <= 40; n++) evidence.append('cap-old-big', rawFrame(n, 'x'.repeat(200)), { wall: old + n, mono: 1 + n }, []);
    evidence.finish('cap-old-big', 'test', old + 100);
    evidence.begin('cap-new-small', [market], 5000, false, { wall: baseWall, mono: 2 });
    evidence.append('cap-new-small', rawFrame(1), { wall: baseWall + 1, mono: 3 }, []);
    evidence.finish('cap-new-small', 'test', baseWall + 2);

    const result = engine.tick();
    expect(result.archived).toEqual(['cap-new-small', 'cap-old-big']); // ring lists newest first; both archived
    expect(result.pruned).toEqual(['cap-old-big']); // age cap prunes the old one
    const records = readIndex(root);
    expect(records.map(r => r.captureId)).toEqual(['cap-new-small']);
    expect(existsSync(records[0].file)).toBe(true);
    expect(existsSync(records[0].file.replace(/cap-new-small\.json$/, 'cap-old-big.json'))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

class FakeSocket {
  readyState = 1;
  onopen: StreamSocket['onopen'] = null; onmessage: StreamSocket['onmessage'] = null;
  onerror: StreamSocket['onerror'] = null; onclose: StreamSocket['onclose'] = null;
  send(raw: string) { void raw; }
  close() { this.readyState = 3; }
  open() { this.onopen?.call(this as any, {} as Event); }
  emit(data: any) { this.onmessage?.call(this as any, { data: typeof data === 'string' ? data : JSON.stringify(data) } as MessageEvent); }
  drop() { this.onclose?.call(this as any, {} as CloseEvent); }
}

test('the stream rolls captures on capacity: recording stays continuous within one connection', () => {
  const s = new Store(':memory:'), time = { ...clock }, sockets: FakeSocket[] = [];
  const f = new LighterStream(s, { clock: () => ({ ...time }), connect: () => { const ws = new FakeSocket(); sockets.push(ws); return ws; }, random: () => 0, retryMs: 10, tickMs: 60000, tradeEvidence: true, evidenceLimits: { captureFrames: 3 } });
  f.watch([market]); f.start(); sockets[0].open();
  try {
    const emit = (nonce: number, begin: number, snapshot: boolean) => sockets[0].emit({ type: snapshot ? 'subscribed/order_book' : 'update/order_book', channel: 'order_book:1', timestamp: time.wall, offset: 999999, order_book: { code: 0, nonce, begin_nonce: begin, bids: [{ price: '100', size: '1' }], asks: [{ price: '101', size: '1' }], last_updated_at: time.wall * 1000 - 1000 } });
    emit(10, 9, true); emit(11, 10, false); emit(12, 11, false); // fills the first capture (3 frames)
    emit(13, 12, false); // capacity hit on the previous frame: this frame must land in the successor
    const captures = f.evidence!.list();
    expect(captures.filter(c => c.state === 'limited')).toHaveLength(1);
    const successor = captures.find(c => c.state === 'capturing')!;
    expect(successor.id).toContain('-r1');
    expect(successor.frames).toBe(1);
    emit(14, 13, false);
    expect(f.evidence!.list().find(c => c.state === 'capturing')!.frames).toBe(2);
  } finally { f.stop(); s.db.close(); }
});
