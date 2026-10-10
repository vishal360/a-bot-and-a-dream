import type { Store } from './store';

// Internal adapter contract only. No HTTP caller may assert reconciliation.
// Money is expressed in integer quote-currency micro-units, not floating dollars.
export type ReconciledRisk = {
  generation: string; day: string; observedAt: number;
  equity: number; usedMargin: number; grossNotional: number;
  startEquity: number; netCashFlow: number;
};
export type Reservation = { id: string; generation: string; margin: number; notional: number };
const uint = (n: number) => Number.isSafeInteger(n) && n >= 0;
function total(a: number, b: number) {
  const n = a + b;
  if (!Number.isSafeInteger(n)) throw new Error('Money overflow');
  return n;
}
export class ExecutionRisk {
  constructor(private store: Store) {
    store.db.exec('CREATE TABLE IF NOT EXISTS risk_reservations (id TEXT PRIMARY KEY, payload TEXT NOT NULL)');
    // Retain unresolved reservations and loss latch; never trust pre-restart snapshots.
    store.set('executionRiskSnapshot', null);
  }
  pending(): Reservation[] {
    return this.store.db.query('SELECT payload FROM risk_reservations ORDER BY id').all().map((r: any) => JSON.parse(r.payload));
  }
  invalidate() { this.store.set('executionRiskSnapshot', null); }
  reconcile(snapshot: ReconciledRisk, now = Date.now()) {
    if (!Number.isSafeInteger(now) || typeof snapshot.generation !== 'string' || !snapshot.generation || snapshot.day !== new Date(now).toISOString().slice(0, 10) ||
        !Number.isSafeInteger(snapshot.observedAt) || now - snapshot.observedAt < 0 || now - snapshot.observedAt > 30000 ||
        ![snapshot.equity, snapshot.usedMargin, snapshot.grossNotional, snapshot.startEquity].every(uint) ||
        snapshot.startEquity === 0 || !Number.isSafeInteger(snapshot.netCashFlow)) throw new Error('Invalid reconciliation');
    // The future venue adapter must supply a verified UTC opening baseline and cumulative cash flows.
    const loss = BigInt(snapshot.startEquity) + BigInt(snapshot.netCashFlow) - BigInt(snapshot.equity);
    this.store.db.transaction(() => {
      const baselineKey = `executionBaseline:${snapshot.generation}:${snapshot.day}`;
      const baseline = this.store.get(baselineKey);
      if (baseline !== null && baseline !== snapshot.startEquity) throw new Error('UTC opening baseline cannot change');
      const watermarkKey = `executionWatermark:${snapshot.generation}`;
      const previous = this.store.get(watermarkKey) as ReconciledRisk | null;
      if (previous && previous.generation === snapshot.generation && previous.observedAt >= snapshot.observedAt &&
          JSON.stringify(previous) !== JSON.stringify(snapshot)) throw new Error('Out-of-order or conflicting reconciliation');
      this.store.set(baselineKey, snapshot.startEquity);
      this.store.set(watermarkKey, snapshot);
      this.store.set('executionRiskSnapshot', snapshot);
      if (loss * 100n >= BigInt(snapshot.startEquity) * 6n) {
        this.store.set('executionLossHalt', true);
        this.store.audit('EXECUTION_LOSS_HALT', '6% cash-flow-adjusted UTC loss reached; no automatic reset');
      }
    }).immediate();
  }
  reserve(intent: Reservation, now = Date.now()) {
    if (!Number.isSafeInteger(now) || typeof intent.id !== 'string' || !intent.id || typeof intent.generation !== 'string' || !intent.generation || !uint(intent.margin) || !uint(intent.notional) || intent.margin === 0 || intent.notional === 0 ||
        BigInt(intent.notional) > BigInt(intent.margin) * 20n) throw new Error('Invalid reservation or leverage above 20x');
    return this.store.db.transaction(() => {
      const existing = this.pending().find(r => r.id === intent.id);
      if (existing) {
        if (existing.generation !== intent.generation || existing.margin !== intent.margin || existing.notional !== intent.notional) throw new Error('Conflicting reservation ID');
        return existing; // Deduplication only, never permission to resubmit an order.
      }
      this.store.db.exec('CREATE TABLE IF NOT EXISTS risk_terminal (id TEXT PRIMARY KEY,payload TEXT NOT NULL)');
      if (this.store.db.query('SELECT id FROM risk_terminal WHERE id=?').get(intent.id)) throw new Error('Terminal order ID cannot be reused');
      if (this.store.get('halted') || this.store.get('executionLossHalt')) throw new Error('Risk halt latched');
      const s = this.store.get('executionRiskSnapshot') as ReconciledRisk | null;
      if (!s || s.generation !== intent.generation || s.day !== new Date(now).toISOString().slice(0, 10) || now < s.observedAt || now - s.observedAt > 30000) throw new Error('Fresh matching reconciliation required');
      const pending = this.pending();
      if (pending.some(r => r.generation !== s.generation)) throw new Error('Unresolved prior connection reservations');
      const pct = this.store.get('allocationPct') ?? 0;
      if (!Number.isInteger(pct) || pct < 0 || pct > 100) throw new Error('Invalid allocation policy');
      const margin = pending.reduce((n, r) => total(n, r.margin), total(s.usedMargin, intent.margin));
      const notional = pending.reduce((n, r) => total(n, r.notional), total(s.grossNotional, intent.notional));
      if (BigInt(margin) * 100n > BigInt(s.equity) * BigInt(pct)) throw new Error('Aggregate margin allocation exceeded');
      if (BigInt(notional) > BigInt(s.equity) * 20n) throw new Error('Aggregate leverage exceeded');
      this.store.db.query('INSERT INTO risk_reservations VALUES (?,?)').run(intent.id, JSON.stringify(intent));
      this.store.audit('RISK_RESERVATION', intent.id);
      return intent;
    }).immediate();
  }
  status() {
    return { executionEnabled: false, adapterConnected: false, lossHalted: !!this.store.get('executionLossHalt'), pendingCount: this.pending().length,
      reconciliation: this.store.get('executionRiskSnapshot') ? 'internal snapshot only' : 'required' };
  }
  /** Internal adapter contract, never HTTP caller-asserted terminal permission.
   * Release and post-order reconciliation commit together, never on timeout.
   */
  settle(id: string, generation: string, terminal: 'filled' | 'canceled' | 'rejected', snapshot: ReconciledRisk, now = Date.now()) {
    if (!['filled', 'canceled', 'rejected'].includes(terminal) || snapshot.generation !== generation) throw new Error('Invalid terminal reconciliation');
    return this.store.db.transaction(() => {
      this.store.db.exec('CREATE TABLE IF NOT EXISTS risk_terminal (id TEXT PRIMARY KEY,payload TEXT NOT NULL)');
      const evidence = { id, generation, terminal, snapshot };
      const old = this.store.db.query('SELECT payload FROM risk_terminal WHERE id=?').get(id) as { payload: string } | null;
      if (old) { if (old.payload !== JSON.stringify(evidence)) throw new Error('Conflicting terminal evidence'); return; }
      const pending = this.pending().find(r => r.id === id);
      if (!pending || pending.generation !== generation) throw new Error('Matching reservation required');
      const previous = this.store.get(`executionWatermark:${generation}`) as ReconciledRisk | null;
      if (previous && snapshot.observedAt <= previous.observedAt) throw new Error('Post-terminal reconciliation must advance observation time');
      this.reconcile(snapshot, now);
      this.store.db.query('INSERT INTO risk_terminal VALUES (?,?)').run(id, JSON.stringify(evidence));
      this.store.db.query('DELETE FROM risk_reservations WHERE id=?').run(id);
      this.store.audit('RISK_TERMINAL', `${id}: ${terminal}`);
    }).immediate();
  }
}