import { units } from './paper-math';

export type StreamMarket = { symbol: string; market_id: number; supported_price_decimals: number; supported_size_decimals: number };
export type BookClock = { wall: number; mono: number };
const counter = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

/** Wire prices/sizes, never SDK display/multiplier values. No cached book survives a fault. */
export class LighterBook {
  private bids = new Map<bigint, bigint>();
  private asks = new Map<bigint, bigint>();
  private nonce: number | null = null;
  private received: BookClock | null = null;
  private published: number | null = null;
  private executedUs: number | null = null;
  private reason = 'Snapshot required';
  constructor(readonly market: StreamMarket, private staleMs = 5000, private maxLevels = 5000) {
    if (!counter(market.market_id) || !market.symbol || [market.supported_price_decimals, market.supported_size_decimals].some(n => !Number.isInteger(n) || n < 0 || n > 8)) throw new Error('Invalid streaming metadata');
  }
  invalidate(reason: string) { this.nonce = null; this.bids.clear(); this.asks.clear(); this.received = null; this.reason = reason; }
  apply(frame: any, clock: BookClock) {
    try {
      const snapshot = frame?.type === 'subscribed/order_book', book = frame?.order_book;
      if ((!snapshot && frame?.type !== 'update/order_book') || frame.channel !== `order_book:${this.market.market_id}`) throw new Error('Wrong book channel/type');
      if (!book || !counter(book.nonce) || ![0, 200].includes(book.code) || !Array.isArray(book.bids) || !Array.isArray(book.asks)) throw new Error('Invalid book envelope');
      if (!counter(frame.timestamp) || frame.timestamp === 0) throw new Error('Publication timestamp required');
      const publicationAgeMs = clock.wall - frame.timestamp;
      if (publicationAgeMs > this.staleMs || publicationAgeMs < -2000) throw new Error(`Stale/future publication: age ${publicationAgeMs}ms (allowed -2000..${this.staleMs}ms); check host clock synchronization`);
      if (!snapshot && this.published !== null && frame.timestamp < this.published) throw new Error('Regressing book publication timestamp');
      if (snapshot && this.nonce !== null) throw new Error('Unexpected snapshot');
      if (!snapshot && (this.nonce === null || book.begin_nonce !== this.nonce || book.nonce < this.nonce)) throw new Error('Sequence gap: snapshot required');
      // A delta cannot revive a book that went stale between timer/status checks.
      if (!snapshot && this.health(clock).status !== 'healthy') throw new Error('Stale book: snapshot required');
      const merge = (old: Map<bigint, bigint>, rows: any[]) => {
        if (rows.length > this.maxLevels) throw new Error('Book level limit exceeded');
        const next = snapshot ? new Map<bigint, bigint>() : new Map(old), seen = new Set<bigint>();
        for (const row of rows) {
          if (typeof row?.price !== 'string' || typeof row?.size !== 'string' || row.price.length > 40 || row.size.length > 40) throw new Error('Invalid wire level');
          const price = units(row.price, this.market.supported_price_decimals), size = units(row.size, this.market.supported_size_decimals);
          if (price <= 0n || seen.has(price)) throw new Error('Invalid/duplicate price level');
          if (!snapshot && book.nonce === this.nonce && (old.get(price) ?? 0n) !== size) throw new Error('State changed without nonce advance');
          seen.add(price);
          if (size === 0n) next.delete(price); else next.set(price, size);
        }
        if (next.size > this.maxLevels) throw new Error('Book level limit exceeded');
        return next;
      };
      const bids = merge(this.bids, book.bids), asks = merge(this.asks, book.asks);
      if (!bids.size || !asks.size) throw new Error('Empty book side');
      const bestBid = [...bids.keys()].reduce((a, b) => a > b ? a : b), bestAsk = [...asks.keys()].reduce((a, b) => a < b ? a : b);
      if (bestBid >= bestAsk) throw new Error('Crossed book');
      const execution = book.last_updated_at ?? frame.last_updated_at;
      if (execution != null && !counter(execution)) throw new Error('Invalid execution timestamp');
      this.bids = bids; this.asks = asks; this.nonce = book.nonce;
      this.received = clock; this.published = frame.timestamp; this.executedUs = execution || null; this.reason = '';
    } catch (error) { this.invalidate((error as Error).message); throw error; }
  }
  health(clock: BookClock) {
    const ageMs = this.received ? clock.mono - this.received.mono : null;
    const publicationAgeMs = this.published === null ? null : clock.wall - this.published;
    const healthy = this.nonce !== null && ageMs !== null && ageMs >= 0 && ageMs <= this.staleMs && publicationAgeMs !== null && publicationAgeMs >= -2000 && publicationAgeMs <= this.staleMs;
    return { status: healthy ? 'healthy' : this.nonce === null ? 'unavailable' : 'stale', reason: healthy ? null : this.reason || 'Fresh snapshot required', nonce: healthy ? this.nonce : null,
      ageMs, publicationAgeMs, receivedAt: this.received ? new Date(this.received.wall).toISOString() : null, publicationTimeMs: this.published, executionTimeUs: this.executedUs };
  }
  view(clock: BookClock, limit = 8) {
    const health = this.health(clock);
    const levels = (side: Map<bigint, bigint>, direction: number) => health.status === 'healthy' ? [...side].sort(([a], [b]) => a === b ? 0 : (a < b ? -1 : 1) * direction).slice(0, limit).map(([price, size]) => {
      if (price > BigInt(Number.MAX_SAFE_INTEGER) || size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Book reporting overflow');
      return { price: Number(price) / 10 ** this.market.supported_price_decimals, quantity: Number(size) / 10 ** this.market.supported_size_decimals };
    }) : [];
    return { market: this.market, ...health, bids: levels(this.bids, -1), asks: levels(this.asks, 1) };
  }
}