import type { Store } from './store';
import type { Fill } from './ledger';
import { paperBalance } from './paper-ledger';
import { units, matchIOC } from './paper-math';
import { readPaperEvents } from './paper-funding';

export type PaperReservation = {
  id: string; generation: string; symbol: string; side: 'buy' | 'sell';
  quantityAtoms: string; notionalMicros: string; chargeMicros: string;
};
export type PaperIntent = {
  symbol: string; side: 'buy' | 'sell'; quantity: number; type: 'market' | 'limit';
  limitPrice: number | null; leverage: number | null; source: 'manual' | 'protection' | 'liquidation' | 'bot'; reason: string | null; botId: string | null;
};

/** Local-paper authority only. No venue acknowledgements or live-risk permissions. */
export class PaperOrders {
  readonly generation = crypto.randomUUID();
  constructor(private store: Store) {
    store.db.exec('CREATE TABLE IF NOT EXISTS paper_reservations (id TEXT PRIMARY KEY,payload TEXT NOT NULL)');
    this.recover();
  }
  get(id: string): any {
    const row = this.store.db.query('SELECT payload FROM paper_orders WHERE id=?').get(id) as { payload: string } | null;
    return row ? JSON.parse(row.payload) : null;
  }
  private save(order: any) {
    this.store.db.query('INSERT OR REPLACE INTO paper_orders VALUES (?,?)').run(order.id, JSON.stringify(order));
  }
  active() { return this.store.get('paperOrderGeneration') === this.generation; }
  pending() { return !!this.store.db.query("SELECT id FROM paper_orders WHERE json_extract(payload,'$.status')='pending'").get(); }
  reservations(): PaperReservation[] {
    return this.store.db.query('SELECT payload FROM paper_reservations ORDER BY id').all().map((r: any) => JSON.parse(r.payload));
  }
  status() {
    const reservations = this.reservations();
    return { generation: this.store.get('paperOrderGeneration'), recovery: this.store.get('paperOrderRecovery'),
      blocked: !!this.store.get('paperRecoveryHalt'), pending: this.pending(), reservations,
      chargeMicros: reservations.reduce((n, r) => n + BigInt(r.chargeMicros), 0n).toString(),
      notionalMicros: reservations.reduce((n, r) => n + BigInt(r.notionalMicros), 0n).toString() };
  }
  duplicate(id: string, intent: PaperIntent) {
    const old = this.get(id);
    if (!old) return null;
    const previous = old.intent ?? { symbol: old.symbol ?? 'BTC', side: old.side, quantity: old.quantity,
      type: old.type ?? 'market', limitPrice: old.limitPrice ?? null, leverage: intent.leverage === null ? null : old.leverage ?? 1,
      source: 'manual', reason: null, botId: null };
    if ((Object.keys(intent) as (keyof PaperIntent)[]).some(key => previous[key] !== intent[key])) throw new Error('Conflicting order ID');
    return old; // Pending and terminal duplicates are reads, never execution permission.
  }
  claim(order: any) {
    this.store.db.transaction(() => {
      if (!this.active()) throw new Error('Paper worker superseded by restart');
      if (this.pending()) throw new Error('Paper matcher busy; unresolved pending order');
      this.store.db.query('INSERT INTO paper_orders VALUES (?,?)').run(order.id, JSON.stringify(order));
      this.store.audit('PAPER_ORDER_CLAIM', `${order.id}: ${order.source}`);
    }).immediate();
  }
  assertPending(id: string) {
    const order = this.get(id);
    if (!this.active() || order?.generation !== this.generation) throw new Error('Paper worker superseded by restart');
    if (order.status !== 'pending') throw new Error('Paper order is already terminal');
    return order;
  }
  reserve(reservation: PaperReservation) {
    this.store.db.transaction(() => {
      const order = this.assertPending(reservation.id);
      if (reservation.generation !== this.generation || reservation.symbol !== order.symbol || reservation.side !== order.side ||
          ![reservation.quantityAtoms, reservation.notionalMicros, reservation.chargeMicros].every(n => /^\d+$/.test(n) && BigInt(n) <= BigInt(Number.MAX_SAFE_INTEGER)) ||
          BigInt(reservation.quantityAtoms) !== units(order.quantity, 8)) throw new Error('Invalid paper reservation');
      const old = this.reservations().find(r => r.id === reservation.id);
      if (old && JSON.stringify(old) !== JSON.stringify(reservation)) throw new Error('Conflicting paper reservation');
      this.store.db.query('INSERT OR IGNORE INTO paper_reservations VALUES (?,?)').run(reservation.id, JSON.stringify(reservation));
      this.save({ ...order, phase: 'reserved', reservation });
      this.store.audit('PAPER_ORDER_RESERVED', JSON.stringify(reservation));
    }).immediate();
  }
  assertBudget(id: string, notional: bigint, charge: bigint) {
    this.assertPending(id);
    const reservation = this.reservations().find(r => r.id === id);
    if (!reservation || reservation.generation !== this.generation) throw new Error('Durable paper reservation required');
    if (notional > BigInt(reservation.notionalMicros) || charge > BigInt(reservation.chargeMicros)) throw new Error('Paper reservation exceeded after latency; retry with a new order ID');
  }
  /** Caller commits fill, consumption, protection changes and release in the same SQLite transaction. */
  finish(result: any) {
    return this.store.db.transaction(() => {
      const old = this.get(result.id);
      if (old && old.status !== 'pending') return old;
      this.assertPending(result.id);
      if (!['filled', 'partial-canceled', 'canceled', 'rejected'].includes(result.status)) throw new Error('Invalid paper terminal status');
      const terminal = { ...old, ...result, phase: 'terminal', terminalAt: new Date().toISOString() };
      this.save(terminal);
      this.store.db.query('DELETE FROM paper_reservations WHERE id=?').run(result.id);
      this.store.audit('PAPER_ORDER_TERMINAL', `${result.id}: ${result.status}; reservation released`);
      return terminal;
    }).immediate();
  }
  cancel(id: string) {
    return this.store.db.transaction(() => {
      const order = this.get(id);
      if (!order) throw new Error('Unknown paper order');
      if (order.status !== 'pending') return order;
      if (this.store.db.query("SELECT id FROM fills WHERE account='paper-mainnet' AND id=?").get(id)) throw new Error('Pending order has committed fill evidence; recovery review required');
      return this.finish({ ...order, status: 'canceled', canceled: order.quantity, filled: 0, error: 'Canceled locally before IOC settlement' });
    }).immediate();
  }
  private recover() {
    this.store.db.transaction(() => {
      this.store.set('paperOrderGeneration', this.generation);
      this.store.set('paperSession', { ...this.store.get('paperSession'), enabled: false });
      const issues: string[] = [], recovered: string[] = [];
      const fills = this.store.db.query("SELECT payload FROM fills WHERE account='paper-mainnet' ORDER BY time,rowid").all().map((r: any) => JSON.parse(r.payload) as Fill);
      try { paperBalance(fills, this.store.get('paperSession').capital, readPaperEvents(this.store)); } catch (e) { issues.push(`Ledger: ${(e as Error).message}`); }
      const byId = new Map(fills.map(f => [f.id, f]));
      const rows = this.store.db.query('SELECT payload FROM paper_orders ORDER BY rowid').all() as { payload: string }[];
      const orders = rows.map(r => JSON.parse(r.payload));
      const consumed = new Map<string, bigint>();
      for (const order of orders) {
        const fill = byId.get(order.id);
        if (order.status === 'pending' && !fill) {
          // Paper matching is local and atomic: no committed fill means there is nothing at a venue to replay.
          this.save({ ...order, status: 'rejected', phase: 'terminal', terminalAt: new Date().toISOString(), error: 'Interrupted by restart; not replayed' });
          this.store.db.query('DELETE FROM paper_reservations WHERE id=?').run(order.id);
          recovered.push(order.id);
          continue;
        }
        const executed = ['filled', 'partial-canceled'].includes(order.status);
        try {
          if (executed !== !!fill || !['filled', 'partial-canceled', 'canceled', 'rejected'].includes(order.status)) throw new Error('terminal/fill mismatch');
          if (fill) {
            if (fill.side !== order.side || fill.symbol !== `${order.symbol ?? 'BTC'}-USD` || units(order.filled, 8) !== units(fill.quantity, 8) ||
                (order.quoteMicros !== undefined && order.quoteMicros !== fill.settlement?.quoteMicros) ||
                (order.feeMicros !== undefined && order.feeMicros !== fill.settlement?.feeMicros) ||
                (fill.settlement?.version === 2 && order.effect !== fill.settlement.effect) ||
                (order.leverage ?? 1) !== (fill.settlement?.leverage ?? 1)) throw new Error('fill economics mismatch');
            const evidence = order.observationId ? this.store.db.query('SELECT payload FROM paper_observations WHERE id=?').get(order.observationId) as { payload: string } | null : null;
            if (!evidence || !Array.isArray(order.executions) || !order.executions.length) throw new Error('missing execution evidence');
            const observation = JSON.parse(evidence.payload), market = observation.market;
            if (fill.settlement?.liquidationFeeMicros !== undefined && (order.source !== 'liquidation' ||
                BigInt(fill.settlement.liquidationFeeMicros) !== (BigInt(fill.settlement.quoteMicros) + 99n) / 100n)) throw new Error('liquidation surcharge mismatch');
            if (!Number.isSafeInteger(market?.market_id) || market.symbol !== (order.symbol ?? 'BTC')) throw new Error('execution market mismatch');
            const observedLevels = order.side === 'buy' ? observation.asks : observation.bids;
            if (!Array.isArray(observedLevels)) throw new Error('missing observed depth');
            const eligible = observedLevels.filter((l: any) => order.type !== 'limit' || (order.side === 'buy' ? l.price <= order.limitPrice : l.price >= order.limitPrice));
            if (!eligible.length) throw new Error('execution has no eligible observed depth');
            const best = units(eligible[0].price, market.supported_price_decimals);
            for (const leg of order.executions) {
              const level = eligible.find((l: any) => l.price === leg.price), price = units(leg.price, market.supported_price_decimals);
              const distance = price > best ? price - best : best - price;
              if (!level || units(leg.quantity, 8) > units(level.quantity, 8) || distance * 10000n > best * 50n) throw new Error('execution exceeds observed depth or collar');
            }
            const replay = matchIOC(order.side, fill.quantity, order.executions, market.supported_size_decimals, market.supported_price_decimals, 0);
            const quote = fill.settlement?.quoteMicros ?? units((fill.quantity * fill.price).toFixed(6), 6).toString();
            if (replay.canceled !== 0 || replay.quoteMicros !== quote ||
                order.executions.reduce((n: bigint, leg: any) => n + units(leg.quantity, 8), 0n) !== units(fill.quantity, 8) ||
                units(order.quantity, 8) !== units(fill.quantity, 8) + units(order.canceled ?? 0, 8) ||
                (order.status === 'filled') !== ((order.canceled ?? 0) === 0)) throw new Error('execution totals mismatch');
            for (const leg of order.executions) {
              const key = `${market.market_id}:${order.side}:${leg.price}`;
              consumed.set(key, (consumed.get(key) ?? 0n) + units(leg.quantity, 8));
            }
          }
          this.store.db.query('DELETE FROM paper_reservations WHERE id=?').run(order.id);
        } catch (e) { issues.push(`${order.id}: ${(e as Error).message}`); }
      }
      const ids = new Set(orders.map(o => o.id));
      for (const fill of fills) if (!ids.has(fill.id)) issues.push(`${fill.id}: fill has no order evidence`);
      for (const [key, expected] of consumed) {
        const row = this.store.db.query('SELECT consumed FROM paper_liquidity WHERE key=?').get(key) as { consumed: string } | null;
        if (!row || !/^\d+$/.test(row.consumed) || BigInt(row.consumed) < expected) issues.push(`${key}: missing consumed-liquidity evidence`);
      }
      for (const r of this.reservations()) issues.push(`${r.id}: unresolved reservation`);
      this.store.set('paperRecoveryHalt', issues.length > 0);
      this.store.set('paperOrderRecovery', { time: new Date().toISOString(), status: issues.length ? 'blocked' : 'reconciled', recovered, issues });
      this.store.audit('PAPER_ORDER_RECOVERY', JSON.stringify({ recovered, issues }));
    }).immediate();
  }
}