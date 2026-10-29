import type { Store } from './store';
import { LighterBook, type BookClock, type StreamMarket } from './lighter-book';
import { parseStats, type MarketStats } from './lighter-stats';
import { parseTrades, type PublicTrade } from './lighter-trades';

export type EvidenceLimits = { captureFrames?: number; captureBytes?: number; captures?: number; tradeRecords?: number };
type Manifest = {
  version: 1; id: string; source: string; markets: StreamMarket[]; staleMs: number; marketStats: boolean;
  startedMs: number; endedMs: number | null; state: 'capturing' | 'closed' | 'interrupted' | 'limited'; reason: string | null;
  frames: number; bytes: number;
};
type RecordedFrame = { sequence: number; clock: BookClock; raw: string };
export type ReplayCapture = { manifest: Manifest; frames: RecordedFrame[]; sha256: string };
const hash = (value: unknown) => new Bun.CryptoHasher('sha256').update(JSON.stringify(value)).digest('hex');
const source = 'wss://mainnet.zklighter.elliot.ai/stream?readonly=true';

/** Bounded evidence store. Whole captures are evicted; roots are never trimmed. */
export class LighterEvidence {
  readonly limits: { captureFrames: number; captureBytes: number; captures: number; tradeRecords: number };
  constructor(private store: Store, limits: EvidenceLimits = {}, now = Date.now()) {
    this.limits = { captureFrames: limits.captureFrames ?? 2000, captureBytes: limits.captureBytes ?? 8 * 1024 * 1024,
      captures: limits.captures ?? 4, tradeRecords: limits.tradeRecords ?? 5000 };
    const maxima = { captureFrames: 2000, captureBytes: 8 * 1024 * 1024, captures: 4, tradeRecords: 10000 };
    for (const key of Object.keys(maxima) as (keyof typeof maxima)[]) {
      if (!Number.isSafeInteger(this.limits[key]) || this.limits[key] < 1 || this.limits[key] > maxima[key]) throw new Error('Invalid evidence limits');
    }
    store.db.exec(`CREATE TABLE IF NOT EXISTS lighter_captures (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lighter_capture_frames (capture_id TEXT NOT NULL, sequence INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(capture_id,sequence));
      CREATE TABLE IF NOT EXISTS lighter_public_trades (sequence INTEGER PRIMARY KEY AUTOINCREMENT, market_id INTEGER NOT NULL, trade_id TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(market_id,trade_id));`);
    store.db.transaction(() => {
      for (const m of this.list()) if (m.state === 'capturing') this.finish(m.id, 'Process restart; continuity not resumed', now, 'interrupted');
      this.trim();
    }).immediate();
  }
  private save(m: Manifest) { this.store.db.query('INSERT INTO lighter_captures VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(m.id, JSON.stringify(m)); }
  private get(id: string): Manifest {
    const row = this.store.db.query('SELECT payload FROM lighter_captures WHERE id=?').get(id) as { payload: string } | null;
    if (!row) throw new Error('Unknown or evicted replay capture');
    return JSON.parse(row.payload);
  }
  list(): Manifest[] { return this.store.db.query('SELECT payload FROM lighter_captures ORDER BY rowid DESC').all().map((r: any) => JSON.parse(r.payload)); }
  private trim() {
    for (const m of this.list().slice(this.limits.captures)) {
      this.store.db.query('DELETE FROM lighter_capture_frames WHERE capture_id=?').run(m.id);
      this.store.db.query('DELETE FROM lighter_captures WHERE id=?').run(m.id);
    }
    this.trimTrades();
  }
  private trimTrades() {
    this.store.db.query('DELETE FROM lighter_public_trades WHERE sequence <= (SELECT sequence FROM lighter_public_trades ORDER BY sequence DESC LIMIT 1 OFFSET ?)').run(this.limits.tradeRecords);
  }
  begin(id: string, markets: StreamMarket[], staleMs: number, marketStats: boolean, clock: BookClock) {
    this.save({ version: 1, id, source, markets, staleMs, marketStats, startedMs: clock.wall, endedMs: null, state: 'capturing', reason: null, frames: 0, bytes: 0 });
    this.trim();
  }
  finish(id: string, reason: string, now: number, state: Manifest['state'] = 'closed') {
    const m = this.get(id);
    if (m.state !== 'capturing') return;
    this.save({ ...m, endedMs: now, state, reason });
  }
  checkTrades(trades: PublicTrade[]) {
    for (const t of trades) {
      const row = this.store.db.query('SELECT payload FROM lighter_public_trades WHERE market_id=? AND trade_id=?').get(t.marketId, t.id) as { payload: string } | null;
      if (row && row.payload !== JSON.stringify(t)) throw new Error('Conflicting public trade ID');
    }
  }
  /** Called inside the same immediate transaction as the diagnostic journal. Returns the
   *  capture state after the append so the stream can roll to a successor capture when
   *  capacity ends this one ('limited'); appends to non-capturing captures are dropped. */
  append(id: string, raw: string, clock: BookClock, trades: PublicTrade[]): Manifest['state'] {
    this.checkTrades(trades);
    for (const t of trades) this.store.db.query('INSERT OR IGNORE INTO lighter_public_trades (market_id,trade_id,payload) VALUES (?,?,?)').run(t.marketId, t.id, JSON.stringify(t));
    const m = this.get(id), bytes = Buffer.byteLength(raw, 'utf8');
    if (m.state === 'capturing') {
      if (m.frames + 1 > this.limits.captureFrames || m.bytes + bytes > this.limits.captureBytes) {
        this.finish(id, 'Capture capacity reached; later frames excluded', clock.wall, 'limited');
      } else {
        const next: RecordedFrame = { sequence: m.frames + 1, clock, raw };
        this.store.db.query('INSERT INTO lighter_capture_frames VALUES (?,?,?)').run(id, next.sequence, JSON.stringify(next));
        this.save({ ...m, frames: next.sequence, bytes: m.bytes + bytes });
      }
    }
    if (trades.length) this.trimTrades();
    return m.state === 'capturing' ? this.get(id).state : m.state;
  }
  recentTrades(marketId: number, limit = 100): PublicTrade[] {
    if (!Number.isSafeInteger(marketId) || marketId < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid trade query');
    return this.store.db.query('SELECT payload FROM lighter_public_trades WHERE market_id=? ORDER BY sequence DESC LIMIT ?').all(marketId, limit).map((r: any) => JSON.parse(r.payload));
  }
  export(id: string): ReplayCapture {
    const manifest = this.get(id);
    const frames = this.store.db.query('SELECT payload FROM lighter_capture_frames WHERE capture_id=? ORDER BY sequence').all(id).map((r: any) => JSON.parse(r.payload) as RecordedFrame);
    return { manifest, frames, sha256: hash({ manifest, frames }) };
  }
  status() { return { enabled: true, limits: this.limits, captures: this.list(), tradeContinuity: 'unproven', replayAuthorizesOrders: false }; }
}

/** Pure reconstruction: no Store, Paper, reservations, fills or outbound transport. */
export function replayCapture(capture: ReplayCapture) {
  const { manifest: m, frames } = capture ?? {};
  if (!m || m.version !== 1 || m.source !== source || !Array.isArray(frames) || frames.length > 2000 ||
      !Array.isArray(m.markets) || !m.markets.length || m.markets.length > 32 || new Set(m.markets.map(x => x.market_id)).size !== m.markets.length ||
      !Number.isFinite(m.staleMs) || m.staleMs < 1 || typeof m.marketStats !== 'boolean' ||
      frames.length !== m.frames || !['capturing', 'closed', 'interrupted', 'limited'].includes(m.state)) throw new Error('Invalid replay manifest');
  let bytes = 0;
  for (const f of frames) {
    if (typeof f?.raw !== 'string' || f.raw.length > 524288) throw new Error('Invalid replay frame size');
    bytes += Buffer.byteLength(f.raw, 'utf8');
    if (bytes > 8 * 1024 * 1024) throw new Error('Replay byte limit exceeded');
  }
  if (bytes !== m.bytes || capture.sha256 !== hash({ manifest: m, frames })) throw new Error('Replay checksum/size mismatch');
  const books = new Map(m.markets.map(x => [x.market_id, new LighterBook(x, m.staleMs)]));
  const stats = new Map<number, MarketStats>(), nonces = new Map<number, number>(), trades = new Map<string, string>(), snapshots = new Set<number>();
  let lastMono = -Infinity, lastClock: BookClock = { wall: m.startedMs, mono: 0 };
  for (const [index, f] of frames.entries()) {
    if (f.sequence !== index + 1 || !Number.isSafeInteger(f.clock?.wall) || !Number.isFinite(f.clock?.mono) || f.clock.mono < 0 || f.clock.mono < lastMono) throw new Error('Invalid replay receive order/clock');
    lastClock = f.clock; lastMono = f.clock.mono;
    const frame = JSON.parse(f.raw), match = /^(order_book|market_stats|trade):(\d+)$/.exec(frame.channel ?? ''), id = match ? Number(match[2]) : -1, book = books.get(id);
    if (!book) throw new Error('Unexpected replay market');
    if (['subscribed/order_book', 'update/order_book'].includes(frame.type)) { book.apply(frame, f.clock); snapshots.add(id); }
    else if (m.marketStats && ['subscribed/market_stats', 'update/market_stats'].includes(frame.type)) {
      const next = parseStats(frame, book.market, f.clock, m.staleMs), old = stats.get(id);
      if (old && next.publicationTimeMs < old.publicationTimeMs) throw new Error('Regressing replay stats');
      stats.set(id, next);
    } else if (['subscribed/trade', 'update/trade'].includes(frame.type)) {
      const batch = parseTrades(frame, book.market, f.clock, nonces.get(id)); nonces.set(id, batch.nonce);
      for (const t of batch.trades) {
        const key = `${id}:${t.id}`, old = trades.get(key), payload = JSON.stringify(t);
        if (old && old !== payload) throw new Error('Conflicting replay trade ID');
        trades.set(key, payload);
      }
    } else throw new Error('Unexpected replay message');
  }
  const finalBooks = [...books.values()].map(b => b.view(lastClock, 5000));
  return { captureId: m.id, result: 'validated-prefix', frames: frames.length, uniqueTrades: trades.size,
    snapshotRooted: snapshots.size === books.size, statsCovered: !m.marketStats || stats.size === books.size,
    state: m.state, boundaryReason: m.reason, tradeContinuity: 'unproven', strategyValidationReady: false, executionEnabled: false,
    stateSha256: hash({ books: finalBooks, stats: [...stats], trades: [...trades] }), books: finalBooks.map(b => ({ ...b, bids: b.bids.slice(0, 8), asks: b.asks.slice(0, 8) })) };
}