import type { Store } from './store';
import { LighterBook, type BookClock, type StreamMarket } from './lighter-book';
import { parseStats, type MarketStats } from './lighter-stats';
import { parseTrades, type PublicTrade } from './lighter-trades';
import { LighterEvidence, type EvidenceLimits } from './lighter-evidence';

export const lighterStreamUrl = 'wss://mainnet.zklighter.elliot.ai/stream?readonly=true';
export type StreamSocket = Pick<WebSocket, 'readyState' | 'send' | 'close' | 'onopen' | 'onmessage' | 'onerror' | 'onclose'>;
type Options = { connect?: () => StreamSocket; clock?: () => BookClock; random?: () => number; staleMs?: number; retryMs?: number; tickMs?: number; retention?: number; marketStats?: boolean; tradeEvidence?: boolean; evidenceLimits?: EvidenceLimits; onUpdate?: () => void };
class Samples {
  private values: number[] = [];
  add(n: number) { this.values.push(n); if (this.values.length > 512) this.values.shift(); }
  status() { const a = [...this.values].sort((a, b) => a - b), p = (q: number) => a.length ? a[Math.ceil(a.length * q) - 1] : null; return { samples: a.length, p50: p(.5), p95: p(.95), p99: p(.99) }; }
}

/** Read-only ingestion. Validated, recorded data can authorize local paper only. */
export class LighterStream {
  private books = new Map<number, LighterBook>();
  private stats = new Map<number, MarketStats>();
  // Display-only last validated values. Execution always uses read(), never this cache.
  private displayQuotes = new Map<number, { market: StreamMarket; bid: number; ask: number; time: string; receivedMono: number; stats: MarketStats | null }>();
  private tradeNonces = new Map<number, number>();
  private tradeReceived = new Map<number, BookClock>();
  readonly evidence: LighterEvidence | null;
  private revision = 0;
  private socket: StreamSocket | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private fatal = false;
  private epoch = '';
  // Evidence capture identity: starts as the epoch and rolls to <epoch>-r<N> whenever a
  // capture hits capacity, so recording stays continuous within one connection
  // (docs/DATA_ENGINE.md). The stream epoch itself remains the connection identity.
  private captureId: string | null = null;
  private captureRoll = 0;
  private state = 'stopped';
  private error: string | null = null;
  private nextRetry = 0;
  private attempts = 0;
  private opened = 0;
  private lastMessage = 0;
  private lastPing = 0;
  private connected = false;
  private snapshots = new Set<number>();
  private applyMs = new Samples();
  private recordMs = new Samples();
  private processingMs = new Samples();
  private arrivalMs = new Samples();
  private previousBookMessage: number | null = null;
  private counts = { connections: 0, disconnects: 0, gaps: 0, stale: 0, invalid: 0, frames: 0, accepted: 0, tradeFrames: 0, recordingFailures: 0 };
  private clock: () => BookClock;
  private staleMs: number;
  private retention: number;
  constructor(private store: Store, private options: Options = {}) {
    this.clock = options.clock ?? (() => ({ wall: Date.now(), mono: performance.now() }));
    this.staleMs = options.staleMs ?? 5000; this.retention = options.retention ?? 5000;
    if (!Number.isInteger(this.retention) || this.retention < 1 || this.retention > 100000 || !Number.isFinite(this.staleMs) || this.staleMs < 1) throw new Error('Invalid stream limits');
    store.db.exec('CREATE TABLE IF NOT EXISTS lighter_feed_journal (id INTEGER PRIMARY KEY AUTOINCREMENT,epoch TEXT NOT NULL,received_ms INTEGER NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL)');
    this.evidence = options.tradeEvidence ? new LighterEvidence(store, options.evidenceLimits, this.clock().wall) : null;
  }
  watch(markets: StreamMarket[]) {
    if (markets.length > 32 || new Set(markets.map(m => m.market_id)).size !== markets.length) throw new Error('Streaming watch limit/duplicate market');
    const ordered = [...markets].sort((a, b) => a.market_id - b.market_id);
    if (JSON.stringify(ordered) === JSON.stringify([...this.books.values()].map(b => b.market))) return;
    // Validate the complete replacement before touching the active connection.
    const next = new Map(ordered.map(m => [m.market_id, new LighterBook(m, this.staleMs)]));
    for (const [id, quote] of this.displayQuotes) if (JSON.stringify(next.get(id)?.market) !== JSON.stringify(quote.market)) this.displayQuotes.delete(id);
    this.disconnect('Watch set changed', false); this.books = next; this.nextRetry = 0;
    if (!this.books.size && this.running && !this.fatal) this.state = 'waiting for markets';
    if (this.running && !this.fatal && this.books.size) this.open();
  }
  start() {
    if (this.running || this.fatal) return;
    this.running = true; this.state = 'waiting for markets';
    this.timer = setInterval(() => this.tick(), this.options.tickMs ?? 1000);
    this.tick();
  }
  stop() {
    this.running = false; if (this.timer) clearInterval(this.timer); this.timer = null;
    this.disconnect('Stopped', false); this.state = this.fatal ? 'recording failed' : 'stopped';
  }
  private record(kind: string, payload: unknown, received = this.clock(), data?: { raw: string; trades: PublicTrade[] }) {
    const start = this.clock();
    this.store.db.transaction(() => {
      this.store.db.query('INSERT INTO lighter_feed_journal (epoch,received_ms,kind,payload) VALUES (?,?,?,?)').run(this.epoch, received.wall, kind, JSON.stringify(payload));
      // IDs are monotonic and never reused: avoid scanning thousands of rows on EVERY tick.
      this.store.db.query('DELETE FROM lighter_feed_journal WHERE id <= (SELECT COALESCE(MAX(id),0)-? FROM lighter_feed_journal)').run(this.retention);
      if (kind === 'connect') { this.captureId = this.epoch; this.captureRoll = 0; this.evidence?.begin(this.captureId, [...this.books.values()].map(b => b.market), this.staleMs, !!this.options.marketStats, received); }
      if (data && this.evidence && this.captureId) {
        const state = this.evidence.append(this.captureId, data.raw, received, data.trades);
        if (state === 'limited') {
          // Capacity ended this capture: begin the successor immediately so recording stays continuous.
          this.captureRoll += 1;
          this.captureId = `${this.epoch}-r${this.captureRoll}`;
          this.evidence.begin(this.captureId, [...this.books.values()].map(b => b.market), this.staleMs, !!this.options.marketStats, received);
          this.evidence.append(this.captureId, data.raw, received, data.trades);
        }
      }
    }).immediate();
    this.recordMs.add(this.clock().mono - start.mono);
  }
  private recordingFailed() {
    this.fatal = true; this.counts.recordingFailures++; this.error = 'Durable feed recording failed; restart after repairing storage';
    this.disconnect(this.error, false); this.state = 'recording failed';
  }
  private disconnect(reason: string, retry = true) {
    const socket = this.socket; this.socket = null; this.connected = false; this.snapshots.clear(); this.previousBookMessage = null;
    for (const book of this.books.values()) book.invalidate(reason);
    this.stats.clear(); this.tradeNonces.clear(); this.tradeReceived.clear(); this.revision++;
    if (socket) { socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null; try { socket.close(); } catch {} }
    this.error = reason;
    if (this.captureId && this.evidence && !this.fatal) {
      try { this.store.db.transaction(() => this.evidence!.finish(this.captureId!, reason, this.clock().wall)).immediate(); }
      catch { this.recordingFailed(); return; }
      this.captureId = null;
    }
    if (retry && this.running && !this.fatal) {
      this.counts.disconnects++; this.state = 'reconnecting';
      this.nextRetry = this.clock().mono + Math.min(30000, (this.options.retryMs ?? 500) * 2 ** Math.min(this.attempts++, 6)) * (1 + (this.options.random ?? Math.random)() * .25);
      try { this.record('disconnect', { reason }); } catch { this.recordingFailed(); }
    }
    this.options.onUpdate?.();
  }
  private open() {
    this.epoch = crypto.randomUUID(); this.state = 'connecting'; this.opened = this.clock().mono; this.lastMessage = this.opened;
    try { this.record('connect', { markets: [...this.books.values()].map(b => b.market) }); }
    catch { this.recordingFailed(); return; }
    try {
      const socket = (this.options.connect ?? (() => new WebSocket(lighterStreamUrl)))(); this.socket = socket;
      socket.onopen = () => {
        if (this.socket !== socket) return;
        try {
          this.connected = true; this.state = 'awaiting snapshots'; this.counts.connections++; this.opened = this.clock().mono; this.lastPing = this.opened;
          for (const id of this.books.keys()) {
            socket.send(JSON.stringify({ type: 'subscribe', channel: `order_book/${id}` }));
            if (this.options.marketStats) socket.send(JSON.stringify({ type: 'subscribe', channel: `market_stats/${id}` }));
            if (this.evidence) socket.send(JSON.stringify({ type: 'subscribe', channel: `trade/${id}` }));
          }
        } catch { this.disconnect('Subscription failed'); }
      };
      socket.onmessage = event => { if (this.socket === socket) this.message(event.data); };
      socket.onerror = () => { if (this.socket === socket) this.disconnect('WebSocket error'); };
      socket.onclose = () => { if (this.socket === socket) this.disconnect('WebSocket disconnected'); };
    } catch { this.disconnect('Connection failed'); }
  }
  private message(raw: unknown) {
    const start = this.clock(); this.lastMessage = start.mono; this.counts.frames++;
    let frame: any, fault: string | null = null, trades: PublicTrade[] = [], isTrade = false;
    try {
      if (typeof raw !== 'string' || raw.length > 131072) throw new Error('Invalid/oversized WebSocket frame');
      frame = JSON.parse(raw);
      if (frame?.type === 'ping') { this.socket?.send(JSON.stringify({ type: 'pong' })); return; }
      if (['connected', 'pong'].includes(frame?.type)) return;
      if (frame?.type === 'shutdown' || frame?.error || frame?.type === 'error') throw new Error('Venue shutdown/error');
      const statsFrame = this.options.marketStats && ['subscribed/market_stats', 'update/market_stats'].includes(frame?.type);
      isTrade = !!this.evidence && ['subscribed/trade', 'update/trade'].includes(frame?.type);
      if (!statsFrame && !isTrade && !['subscribed/order_book', 'update/order_book'].includes(frame?.type)) throw new Error('Unexpected WebSocket message');
      const match = /^(order_book|market_stats|trade):(\d+)$/.exec(frame.channel ?? ''), id = match ? Number(match[2]) : -1, book = this.books.get(id);
      if (!book) throw new Error('Unexpected book channel');
      if (isTrade) {
        const batch = parseTrades(frame, book.market, start, this.tradeNonces.get(id));
        try { this.evidence!.checkTrades(batch.trades); }
        catch (error) {
          if ((error as Error).message !== 'Conflicting public trade ID') { this.recordingFailed(); return; }
          throw error;
        }
        trades = batch.trades;
        this.tradeNonces.set(id, batch.nonce); this.tradeReceived.set(id, start);
      } else if (statsFrame) {
        const next = parseStats(frame, book.market, start, this.staleMs), previous = this.stats.get(id);
        if (previous && next.publicationTimeMs < previous.publicationTimeMs) throw new Error('Regressing market stats timestamp');
        this.stats.set(id, next);
      } else { book.apply(frame, start); this.snapshots.add(id); }
      this.applyMs.add(this.clock().mono - start.mono);
      if (!statsFrame && !isTrade) {
        if (this.previousBookMessage !== null) this.arrivalMs.add(start.mono - this.previousBookMessage);
        this.previousBookMessage = start.mono;
      }
    } catch (error) { fault = (error as Error).message; }
    try { this.record('frame', { raw: typeof raw === 'string' ? raw.slice(0, 131072) : null, accepted: !fault, error: fault }, start, !fault ? { raw: raw as string, trades } : undefined); }
    catch { this.recordingFailed(); return; }
    this.processingMs.add(this.clock().mono - start.mono);
    if (fault) {
      if (fault.includes('Sequence gap')) this.counts.gaps++; else if (fault.includes('Stale')) this.counts.stale++; else this.counts.invalid++;
      this.disconnect(fault); return;
    }
    this.counts.accepted++;
    const displayId = Number(/:(\d+)$/.exec(frame.channel)?.[1]), displayBook = this.books.get(displayId);
    if (displayBook) {
      const id = displayId, book = displayBook;
      const view = book.view(start, 1), previous = this.displayQuotes.get(id), stats = this.stats.get(id) ?? previous?.stats ?? null;
      if (view.status === 'healthy') this.displayQuotes.set(id, { market: book.market, bid: view.bids[0].price, ask: view.asks[0].price,
        time: view.receivedAt!, receivedMono: start.mono - view.ageMs!, stats });
      else if (previous && stats !== previous.stats) this.displayQuotes.set(id, { ...previous, stats });
    }
    if (isTrade) this.counts.tradeFrames++;
    this.revision++;
    if (this.snapshots.size === this.books.size) { this.state = 'streaming'; this.error = null; this.attempts = 0; }
    // Consumers can only observe a validated AND durably recorded update.
    this.options.onUpdate?.();
  }
  /** Timer and status callers enforce freshness independently of heartbeat/pong traffic. */
  tick() {
    if (!this.running || this.fatal || !this.books.size) return;
    const clock = this.clock();
    if (!this.socket) { if (clock.mono >= this.nextRetry) this.open(); return; }
    if ((!this.connected || this.snapshots.size < this.books.size || (this.options.marketStats && this.stats.size < this.books.size)) && clock.mono - this.opened > 10000) { this.disconnect('Connection/snapshot timeout'); return; }
    if ([...this.books.values()].some(b => b.health(clock).status === 'stale')) { this.counts.stale++; this.disconnect('Stale book: snapshot required'); return; }
    if (this.options.marketStats && [...this.stats.values()].some(s => clock.mono - s.receivedMono > this.staleMs || clock.wall - s.publicationTimeMs > this.staleMs)) { this.counts.stale++; this.disconnect('Stale market stats: snapshot required'); return; }
    if (clock.mono - this.lastMessage > 90000) { this.disconnect('Heartbeat timeout'); return; }
    if (this.connected && clock.mono - this.lastPing >= 30000) {
      try { this.socket.send(JSON.stringify({ type: 'ping' })); this.lastPing = clock.mono; } catch { this.disconnect('Heartbeat send failed'); }
    }
  }
  read(marketId: number, limit = 5000) {
    if (this.fatal || !this.connected || !this.snapshots.has(marketId)) return null;
    const clock = this.clock(), book = this.books.get(marketId)?.view(clock, limit), stats = this.stats.get(marketId);
    if (!book || book.status !== 'healthy') return null;
    const statsAge = stats ? clock.mono - stats.receivedMono : Infinity;
    const freshStats = stats && statsAge >= 0 && statsAge <= this.staleMs && clock.wall - stats.publicationTimeMs <= this.staleMs && stats.publicationTimeMs - clock.wall <= 2000 ? stats : null;
    return { ...book, stats: freshStats, epoch: this.epoch, revision: this.revision };
  }
  display(marketId: number) {
    const quote = this.displayQuotes.get(marketId), live = this.read(marketId, 1), clock = this.clock();
    return { ...(quote ?? {}), stale: !live?.stats, displayOnly: !live?.stats,
      ageMs: quote ? clock.mono - quote.receivedMono : null,
      statsAgeMs: quote?.stats ? clock.mono - quote.stats.receivedMono : null,
      reason: live?.stats ? null : this.error ?? 'Fresh depth and market stats required', state: this.state };
  }
  status() {
    const books = [...this.books.values()].map(b => b.view(this.clock()));
    return { mode: this.options.marketStats ? 'read-only public feed / paper authority' : 'read-only shadow', executionSource: this.options.marketStats ? 'validated WebSocket / paper only' : 'REST (unchanged)', executionEnabled: false, agentsEnabled: false, state: this.state, error: this.error, epoch: this.epoch || null,
      healthy: this.state === 'streaming' && books.length > 0 && books.every(b => b.status === 'healthy' && (!this.options.marketStats || !!this.read(b.market.market_id, 1)?.stats)), books, counts: { ...this.counts },
      limits: { markets: 32, levelsPerSide: 5000, frameCharacters: 131072, staleMs: this.staleMs, journalRecords: this.retention, metricSamples: 512 },
      stats: [...this.books.keys()].map(id => ({ marketId: id, stats: this.read(id, 1)?.stats ?? null })), revision: this.revision,
      evidence: this.evidence?.status() ?? { enabled: false },
      trades: [...this.books.keys()].map(id => ({ marketId: id, nonce: this.tradeNonces.get(id) ?? null,
        receivedAt: this.tradeReceived.has(id) ? new Date(this.tradeReceived.get(id)!.wall).toISOString() : null,
        receiveAgeMs: this.tradeReceived.has(id) ? this.clock().mono - this.tradeReceived.get(id)!.mono : null, continuity: 'unproven' })),
      latencyMs: { receiveToApply: this.applyMs.status(), durableRecord: this.recordMs.status(), receiveToRecorded: this.processingMs.status(), interBookArrival: this.arrivalMs.status() } };
  }
}