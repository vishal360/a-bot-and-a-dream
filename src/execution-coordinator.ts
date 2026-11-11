import { Database } from 'bun:sqlite';

/** Standalone fixture/testnet OMS. No Paper dependency, signer, HTTP, or server routes. */
export type ExecutionEnvironment = 'fixture' | 'testnet';
export type OrderState = 'prepared' | 'submitting' | 'unknown' | 'acknowledged' | 'partial' | 'filled' | 'canceled' | 'rejected';
export interface AccountBinding { environment: ExecutionEnvironment; accountId: string; apiKeyId: string; chainId: string; generation: string }
export interface TrustedAccountSnapshot extends AccountBinding {
  verified: true; sequence: number; observedAt: number; nextNonce: number;
  equity: number; available: number; grossNotional: number;
  /** Signed quantities, in the same integer units as orders. */
  positions: Record<string, number>;
}
export interface ExecutionLimits {
  maxNotional: number; maxTotalNotional: number; maxPendingOrders: number;
  snapshotMaxAgeMs: number; leaseTtlMs: number;
}
export interface ExecutionIntent {
  clientId: string; symbol: string; side: 'buy' | 'sell'; quantity: number;
  /** Conservative worst execution price; adapter MUST enforce as a limit. */
  worstPrice: number; margin: number; reduceOnly: boolean;
}
export interface DurableOrder extends ExecutionIntent {
  binding: AccountBinding; fingerprint: string; state: OrderState; nonce: number | null;
  filledQuantity: number; reservedNotional: number; reservedMargin: number;
  snapshotSequence: number; createdAt: number; updatedAt: number;
  fence: number | null; leaseOwner: string | null; venueOrderId?: string; transactionId?: string; conflict?: string;
  /** Restarted un-dispatched preparations may only be canceled locally. */
  localCancelOnly?: boolean;
}
export interface SendRequest {
  order: Readonly<DurableOrder>; nonce: number; fence: number; leaseOwner: string;
  /** Signing adapter must check immediately before dispatch; never retry internally. */
  assertCurrentLease: () => void;
}
export interface VenueSigningAdapter {
  /** HTTP acceptance is NOT execution. Any error is ambiguous; no automatic resend. */
  send(request: SendRequest): Promise<{ accepted: true; transactionId: string }>;
}
export interface VerifiedExecutionEvidence extends AccountBinding {
  verified: true; evidenceId: string; clientId: string; nonce: number; venueOrderId: string;
  kind: 'acknowledged' | 'partial' | 'filled' | 'canceled' | 'rejected';
  /** At least one explicit venue transaction or order reference is mandatory. */
  transactionId?: string; orderEvidenceId?: string; observedAt: number;
  /** Complete cumulative fill set, not a delta; unique venue fill IDs. */
  fills: { fillId: string; quantity: number }[];
}
const terminal = (state: OrderState) => ['filled', 'canceled', 'rejected'].includes(state);
const integer = (n: number, name: string, positive = false) => {
  if (!Number.isSafeInteger(n) || n < (positive ? 1 : 0)) throw new Error(`Invalid ${name}`);
};
const bindingKey = (b: AccountBinding) => JSON.stringify([b.environment, b.accountId, b.apiKeyId, b.chainId, b.generation]);
const keyId = (b: AccountBinding) => JSON.stringify([b.environment, b.chainId, b.accountId, b.apiKeyId]);
const accountKey = (b: AccountBinding) => JSON.stringify([b.environment, b.chainId, b.accountId]);
const snapshotKey = (b: AccountBinding) => accountKey(b);
const fingerprint = (i: ExecutionIntent, b: AccountBinding) => JSON.stringify([bindingKey(b), i.clientId, i.symbol, i.side, i.quantity, i.worstPrice, i.margin, i.reduceOnly]);

export class ExecutionCoordinator {
  private readonly db: Database;
  private snapshot?: TrustedAccountSnapshot;
  private authorized = false;
  private readonly owner = crypto.randomUUID();
  private readonly binding: AccountBinding;
  private readonly limits: ExecutionLimits;
  constructor(path: string, binding: AccountBinding, limits: ExecutionLimits, private readonly adapter: VenueSigningAdapter, private readonly clock: () => number = Date.now) {
    // Runtime check deliberately ignores all other flags and case variants.
    if (!['fixture', 'testnet'].includes(binding.environment)) throw new Error('MAINNET/unsupported environment denied');
    if ([binding.accountId, binding.apiKeyId, binding.chainId, binding.generation].some(x => typeof x !== 'string' || !x.trim())) throw new Error('Invalid account binding');
    if (binding.environment === 'testnet' && binding.chainId !== '300') throw new Error('Only testnet chain 300 allowed; MAINNET denied');
    for (const k of ['maxNotional','maxTotalNotional','maxPendingOrders','snapshotMaxAgeMs','leaseTtlMs'] as const) integer(limits[k], k, true);
    this.binding = { ...binding }; this.limits = { ...limits };
    this.db = new Database(path, { create: true });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS oms_orders (client_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS oms_leases (key_id TEXT PRIMARY KEY, owner TEXT, fence INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oms_nonces (key_id TEXT NOT NULL, nonce INTEGER NOT NULL, client_id TEXT NOT NULL UNIQUE, PRIMARY KEY(key_id,nonce));
      CREATE TABLE IF NOT EXISTS oms_highwater (key_id TEXT PRIMARY KEY, nonce INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oms_fills (key_id TEXT NOT NULL, fill_id TEXT NOT NULL, client_id TEXT NOT NULL, quantity INTEGER NOT NULL, PRIMARY KEY(key_id,fill_id));
      CREATE TABLE IF NOT EXISTS oms_evidence (evidence_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS oms_snapshots (binding TEXT PRIMARY KEY, sequence INTEGER NOT NULL, observed INTEGER NOT NULL, fingerprint TEXT NOT NULL);`);
    this.atomic(() => {
      // Startup is fail-closed, including overlapping process startup. No old callback can write.
      const keys = new Set<string>();
      for (const o of this.orders()) {
        if (o.state === 'submitting') {
          o.state = 'unknown'; o.updatedAt = this.now(); this.save(o); keys.add(keyId(o.binding));
        } else if (o.state === 'prepared') { o.localCancelOnly = true; this.save(o); }
      }
      for (const key of keys) this.db.query('UPDATE oms_leases SET owner=NULL, fence=fence+1, expires=0 WHERE key_id=?').run(key);
    });
  }
  close() { this.authorized = false; this.snapshot = undefined; this.db.close(); }
  private now() { const n = this.clock(); integer(n, 'clock'); return n; }
  private atomic<T>(fn: () => T): T { return this.db.transaction(fn).immediate(); }
  private save(o: DurableOrder) { this.db.query('INSERT INTO oms_orders VALUES (?,?) ON CONFLICT(client_id) DO UPDATE SET payload=excluded.payload').run(o.clientId, JSON.stringify(o)); }
  get(clientId: string): DurableOrder | null {
    const row = this.db.query('SELECT payload FROM oms_orders WHERE client_id=?').get(clientId) as { payload: string } | null;
    if (!row) return null;
    const o = JSON.parse(row.payload) as DurableOrder;
    if (o.clientId !== clientId || o.fingerprint !== fingerprint(o, o.binding) || !['prepared','submitting','unknown','acknowledged','partial','filled','canceled','rejected'].includes(o.state)) throw new Error('Corrupt durable order');
    for (const [name, value] of Object.entries({ quantity: o.quantity, worstPrice: o.worstPrice, margin: o.margin, filledQuantity: o.filledQuantity, reservedNotional: o.reservedNotional, reservedMargin: o.reservedMargin })) integer(value, name);
    if (!o.quantity || !o.worstPrice || !o.symbol?.trim() || !['buy','sell'].includes(o.side) || typeof o.reduceOnly !== 'boolean' || !['fixture','testnet'].includes(o.binding.environment) || (o.binding.environment === 'testnet' && o.binding.chainId !== '300')) throw new Error('Corrupt intent/binding');
    integer(o.snapshotSequence, 'snapshot sequence'); integer(o.createdAt, 'createdAt'); integer(o.updatedAt, 'updatedAt');
    if (o.nonce !== null) integer(o.nonce, 'nonce');
    if (o.filledQuantity > o.quantity || (o.state === 'filled' && o.filledQuantity !== o.quantity) || (o.state === 'partial' && (!o.filledQuantity || o.filledQuantity >= o.quantity)) || (o.state === 'prepared' && o.nonce !== null) || (terminal(o.state) && (o.reservedNotional !== 0 || o.reservedMargin !== 0)) || (!terminal(o.state) && (o.reservedNotional !== o.quantity * o.worstPrice || o.reservedMargin !== o.margin))) throw new Error('Corrupt reservation');
    return o;
  }
  orders(): DurableOrder[] { return (this.db.query('SELECT client_id FROM oms_orders').all() as { client_id: string }[]).map(r => this.get(r.client_id)!); }
  private matching(b: AccountBinding) { if (bindingKey(b) !== bindingKey(this.binding)) throw new Error('Account/chain/generation binding mismatch'); }
  private validateSnapshot(s: TrustedAccountSnapshot) {
    this.matching(s);
    if (s.verified !== true) throw new Error('Verified snapshot required');
    for (const name of ['sequence','observedAt','nextNonce','equity','available','grossNotional'] as const) integer(s[name], name);
    if (s.available > s.equity || s.observedAt > this.now() || this.now() - s.observedAt > this.limits.snapshotMaxAgeMs) throw new Error('Stale/invalid account snapshot');
    if (!s.positions || typeof s.positions !== 'object') throw new Error('Missing positions');
    for (const q of Object.values(s.positions)) if (!Number.isSafeInteger(q)) throw new Error('Invalid position');
  }
  reconcileAccount(s: TrustedAccountSnapshot) {
    this.validateSnapshot(s);
    this.atomic(() => {
      // Account economics are shared across API keys; nextNonce remains key-specific.
      const b = snapshotKey(s), f = JSON.stringify([s.sequence, s.observedAt, s.equity, s.available, s.grossNotional, Object.entries(s.positions).sort(([a], [z]) => a.localeCompare(z))]);
      const old = this.db.query('SELECT * FROM oms_snapshots WHERE binding=?').get(b) as { sequence: number; observed: number; fingerprint: string } | null;
      if (old && (s.sequence < old.sequence || s.observedAt < old.observed || (s.sequence === old.sequence && f !== old.fingerprint))) throw new Error('Snapshot rollback/conflict');
      this.db.query('INSERT INTO oms_snapshots VALUES (?,?,?,?) ON CONFLICT(binding) DO UPDATE SET sequence=excluded.sequence, observed=excluded.observed, fingerprint=excluded.fingerprint').run(b, s.sequence, s.observedAt, f);
    });
    this.snapshot = structuredClone(s);
  }
  authorizeSession(binding: AccountBinding) { this.matching(binding); this.fresh(); this.authorized = true; }
  revokeSession() { this.authorized = false; }
  private fresh() {
    if (!this.snapshot) throw new Error('Verified account reconciliation required');
    this.validateSnapshot(this.snapshot);
    const latest = this.db.query('SELECT sequence FROM oms_snapshots WHERE binding=?').get(snapshotKey(this.binding)) as { sequence: number } | null;
    if (!latest || latest.sequence !== this.snapshot.sequence) throw new Error('Stale reconciliation generation/sequence');
    return this.snapshot;
  }
  prepare(intent: ExecutionIntent): DurableOrder {
    return this.atomic(() => {
      const old = this.get(intent.clientId);
      if (old) { if (old.fingerprint !== fingerprint(intent, this.binding)) throw new Error('Immutable client ID fingerprint mismatch'); return old; }
      const s = this.fresh();
      if (!this.authorized) throw new Error('Session authorization required');
      if (!intent.clientId?.trim() || !intent.symbol?.trim() || !['buy','sell'].includes(intent.side) || typeof intent.reduceOnly !== 'boolean') throw new Error('Invalid intent');
      integer(intent.quantity, 'quantity', true); integer(intent.worstPrice, 'worstPrice', true); integer(intent.margin, 'margin');
      const notional = intent.quantity * intent.worstPrice; integer(notional, 'notional', true);
      const all = this.orders();
      const pending = all.filter(o => !terminal(o.state));
      if (all.some(o => accountKey(o.binding) === accountKey(this.binding) && o.conflict) || pending.some(o => accountKey(o.binding) === accountKey(this.binding) && bindingKey(o.binding) !== bindingKey(this.binding))) throw new Error('Unresolved prior generation/conflicting evidence');
      if (!intent.reduceOnly && pending.some(o => accountKey(o.binding) === accountKey(this.binding) && o.state === 'unknown')) throw new Error('Unresolved unknown blocks opens');
      const own = pending.filter(o => accountKey(o.binding) === accountKey(this.binding));
      if (own.length >= this.limits.maxPendingOrders) throw new Error('Pending order cap');
      if (notional > this.limits.maxNotional || (!intent.reduceOnly && s.grossNotional + own.reduce((n,o) => n + o.reservedNotional, 0) + notional > this.limits.maxTotalNotional)) throw new Error('Conservative notional cap');
      if (own.reduce((n,o) => n + o.reservedMargin, 0) + intent.margin > Math.min(s.available, s.equity)) throw new Error('Insufficient equity/available reservation');
      if (intent.reduceOnly) {
        const position = s.positions[intent.symbol] ?? 0;
        const already = own.filter(o => o.reduceOnly && o.symbol === intent.symbol).reduce((n,o) => n + o.quantity, 0);
        if (!position || (position > 0 ? intent.side !== 'sell' : intent.side !== 'buy') || intent.quantity + already > Math.abs(position)) throw new Error('reduceOnly exceeds position/pending reductions; no flip');
      }
      const o: DurableOrder = { ...intent, binding: { ...this.binding }, fingerprint: fingerprint(intent, this.binding), state: 'prepared', nonce: null, filledQuantity: 0, reservedNotional: notional, reservedMargin: intent.margin, snapshotSequence: s.sequence, createdAt: this.now(), updatedAt: this.now(), fence: null, leaseOwner: null };
      this.save(o); return o;
    });
  }
  private assertLease(o: DurableOrder) {
    const lease = this.db.query('SELECT * FROM oms_leases WHERE key_id=?').get(keyId(o.binding)) as { owner: string; fence: number; expires: number } | null;
    const current = this.get(o.clientId);
    if (!lease || lease.owner !== o.leaseOwner || lease.fence !== o.fence || lease.expires <= this.now() || current?.state !== 'submitting' || current.fence !== o.fence || current.leaseOwner !== o.leaseOwner) throw new Error('Stale lease/fencing token');
  }
  async submit(clientId: string): Promise<DurableOrder> {
    let acquired = false;
    const o = this.atomic(() => {
      const order = this.get(clientId); if (!order) throw new Error('Unknown client ID'); this.matching(order.binding);
      // Never retransmit a nonce, including unknown, rejected, or acknowledged orders.
      if (order.state !== 'prepared') return order;
      if (order.localCancelOnly) throw new Error('Recovered preparation may only be locally canceled');
      if (!this.authorized) throw new Error('Session authorization required');
      const s = this.fresh();
      const related = this.orders().filter(x => accountKey(x.binding) === accountKey(this.binding));
      if (related.some(x => x.conflict)) throw new Error('Unresolved conflicting evidence');
      if (!order.reduceOnly && related.some(x => x.state === 'unknown')) throw new Error('Unresolved unknown blocks opens');
      // Changed positions/baseline require a new explicit intent instead of sending stale risk decisions.
      if (s.sequence !== order.snapshotSequence) throw new Error('Prepared intent requires original fresh reconciliation');
      const key = keyId(this.binding), now = this.now();
      const lease = this.db.query('SELECT * FROM oms_leases WHERE key_id=?').get(key) as { fence: number; expires: number } | null;
      if (lease && lease.expires > now) throw new Error('API key lease busy');
      // An expired submitting send remains ambiguous and blocks further opens.
      const expired = this.orders().filter(x => keyId(x.binding) === key && x.state === 'submitting');
      for (const x of expired) { x.state = 'unknown'; x.updatedAt = now; this.save(x); }
      if (expired.length) return order; // recovery commits; caller must reconcile before trying any send
      const fence = (lease?.fence ?? 0) + 1;
      this.db.query('INSERT INTO oms_leases VALUES (?,?,?,?) ON CONFLICT(key_id) DO UPDATE SET owner=excluded.owner,fence=excluded.fence,expires=excluded.expires').run(key, this.owner, fence, now + this.limits.leaseTtlMs);
      const high = this.db.query('SELECT nonce FROM oms_highwater WHERE key_id=?').get(key) as { nonce: number } | null;
      const nonce = Math.max(s.nextNonce, (high?.nonce ?? -1) + 1); integer(nonce, 'nonce');
      this.db.query('INSERT INTO oms_nonces VALUES (?,?,?)').run(key, nonce, order.clientId);
      this.db.query('INSERT INTO oms_highwater VALUES (?,?) ON CONFLICT(key_id) DO UPDATE SET nonce=excluded.nonce').run(key, nonce);
      order.state = 'submitting'; order.nonce = nonce; order.fence = fence; order.leaseOwner = this.owner; order.updatedAt = now;
      this.save(order); acquired = true; return order;
    });
    if (!acquired) return o;
    try {
      this.assertLease(o);
      const response = await this.adapter.send({ order: structuredClone(o), nonce: o.nonce!, fence: o.fence!, leaseOwner: this.owner, assertCurrentLease: () => this.assertLease(o) });
      this.atomic(() => {
        this.assertLease(o);
        if (response.accepted !== true || !response.transactionId?.trim()) throw new Error('Ambiguous adapter response');
        o.state = 'acknowledged'; o.transactionId = response.transactionId; o.updatedAt = this.now(); this.save(o);
      });
    } catch {
      this.atomic(() => {
        const current = this.get(o.clientId)!;
        if (current.state === 'submitting' && current.fence === o.fence && current.leaseOwner === this.owner) { current.state = 'unknown'; current.updatedAt = this.now(); this.save(current); }
      });
    } finally {
      this.db.query('UPDATE oms_leases SET owner=NULL,expires=0 WHERE key_id=? AND owner=? AND fence=?').run(keyId(this.binding), this.owner, o.fence!);
    }
    return this.get(clientId)!;
  }
  cancelPrepared(clientId: string) {
    return this.atomic(() => {
      const o = this.get(clientId); if (!o) throw new Error('Unknown client ID'); this.matching(o.binding);
      if (o.state !== 'prepared' || o.nonce !== null || this.db.query('SELECT client_id FROM oms_nonces WHERE client_id=?').get(clientId)) throw new Error('Cannot prove never dispatched');
      o.state = 'canceled'; o.reservedMargin = 0; o.reservedNotional = 0; o.updatedAt = this.now(); this.save(o); return o;
    });
  }
  reconcileOrder(e: VerifiedExecutionEvidence, snapshot: TrustedAccountSnapshot): DurableOrder {
    this.matching(e); this.validateSnapshot(snapshot);
    if (e.verified !== true || !e.evidenceId?.trim() || !e.venueOrderId?.trim() || !(e.transactionId?.trim() || e.orderEvidenceId?.trim()) || !['acknowledged','partial','filled','canceled','rejected'].includes(e.kind)) throw new Error('Explicit verified venue evidence required');
    integer(e.observedAt, 'evidence time');
    if (e.observedAt > this.now() || this.now() - e.observedAt > this.limits.snapshotMaxAgeMs || snapshot.observedAt < e.observedAt) throw new Error('Stale evidence/snapshot');
    const result = this.atomic((): DurableOrder | Error => {
      const o = this.get(e.clientId); if (!o) throw new Error('Unknown client ID'); this.matching(o.binding);
      const fail = (message: string) => { o.conflict = message; this.save(o); this.authorized = false; return new Error(message); };
      if (o.conflict) return new Error('Conflicting evidence latch requires operator investigation');
      if (o.nonce === null || e.nonce !== o.nonce || (o.venueOrderId && o.venueOrderId !== e.venueOrderId) || (o.transactionId && e.transactionId !== o.transactionId)) return fail('Contradictory venue order/nonce/transaction');
      const priorEvidence = this.db.query('SELECT fingerprint FROM oms_evidence WHERE evidence_id=?').get(e.evidenceId) as { fingerprint: string } | null;
      const ef = JSON.stringify(e);
      if (priorEvidence) return priorEvidence.fingerprint === ef ? o : fail('Contradictory evidence ID');
      if (snapshot.sequence <= o.snapshotSequence || e.observedAt < o.createdAt || snapshot.observedAt <= o.createdAt) throw new Error('Post-order snapshot must advance');
      let filled = 0; const ids = new Set<string>();
      for (const f of e.fills) {
        integer(f.quantity, 'fill quantity', true);
        if (!f.fillId?.trim() || ids.has(f.fillId)) return fail('Duplicate fill IDs in cumulative evidence');
        ids.add(f.fillId); filled += f.quantity; integer(filled, 'filled quantity');
        const prior = this.db.query('SELECT client_id,quantity FROM oms_fills WHERE key_id=? AND fill_id=?').get(keyId(this.binding), f.fillId) as { client_id: string; quantity: number } | null;
        if (prior && (prior.client_id !== o.clientId || prior.quantity !== f.quantity)) return fail('Contradictory fill identity');
      }
      const existingFills = this.db.query('SELECT fill_id FROM oms_fills WHERE client_id=?').all(o.clientId) as { fill_id: string }[];
      if (existingFills.some(f => !ids.has(f.fill_id)) || filled > o.quantity || filled < o.filledQuantity || (e.kind === 'filled' && filled !== o.quantity) || (e.kind === 'partial' && (filled <= 0 || filled >= o.quantity)) || (['acknowledged','rejected'].includes(e.kind) && filled !== 0) || (terminal(o.state) && (o.state !== e.kind || o.filledQuantity !== filled))) return fail('Contradictory terminal/fill evidence');
      if (o.state === 'partial' && e.kind === 'acknowledged') return fail('Order lifecycle regression');
      // Store snapshot and order/fills in one outer SQLite transaction.
      this.reconcileAccount(snapshot);
      for (const f of e.fills) this.db.query('INSERT OR IGNORE INTO oms_fills VALUES (?,?,?,?)').run(keyId(this.binding), f.fillId, o.clientId, f.quantity);
      this.db.query('INSERT INTO oms_evidence VALUES (?,?)').run(e.evidenceId, ef);
      o.state = e.kind; o.filledQuantity = filled; o.venueOrderId = e.venueOrderId; o.updatedAt = this.now(); o.snapshotSequence = snapshot.sequence;
      if (terminal(o.state)) { o.reservedMargin = 0; o.reservedNotional = 0; }
      this.save(o); return o;
    });
    if (result instanceof Error) throw result;
    return result;
  }
  status() {
    const orders = this.orders();
    return { environment: this.binding.environment, authorized: this.authorized, orders,
      pendingCount: orders.filter(o => !terminal(o.state)).length,
      reservedMargin: orders.reduce((n,o) => n + o.reservedMargin, 0),
      alerts: ['NATIVE_PROTECTION_GAP: no verified venue-native stop/protection management; not a production OMS',
        ...orders.filter(o => o.state === 'unknown' || o.conflict).map(o => `RECONCILIATION_REQUIRED:${o.clientId}${o.conflict ? ':CONFLICT' : ''}`)] };
  }
}
