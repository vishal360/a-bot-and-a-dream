import type { Store } from './store';
import type { Fill } from './ledger';
import { paperBalance, type LedgerEvents } from './paper-ledger';
import { units } from './paper-math';

type Session = { capital: number; createdAt: string };
export type PaperRiskDay = {
  version: 1; day: string; equityMicros: string; recordedAt: string;
  kind: 'flat-ledger-boundary' | 'session-inception' | 'first-observed' | 'legacy-unverified';
  midnightVerified: boolean; cashFlowPolicy: 'fixed-capital-no-transfers';
  evidenceSha256: string; sha256: string;
};
const hash = (value: unknown) => new Bun.CryptoHasher('sha256').update(JSON.stringify(value)).digest('hex');
type Reconciliation = { version: 1; day: string; baselineSha256: string; fundingSha256: string; correctedEquityMicros: string; effectiveEquityMicros: string; recordedAt: string; sha256: string };
function boundary(day: string) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Invalid UTC risk day');
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== day) throw new Error('Invalid UTC risk day');
  return ms;
}
function money(value: unknown): value is string {
  return typeof value === 'string' && /^-?(0|[1-9]\d{0,15})$/.test(value) &&
    BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER) && BigInt(value) >= -BigInt(Number.MAX_SAFE_INTEGER);
}

/** Local fixed-capital paper evidence, NOT venue reconciliation or funding accounting. */
export class PaperRiskDays {
  constructor(private store: Store) {
    store.db.exec('CREATE TABLE IF NOT EXISTS paper_risk_days (day TEXT PRIMARY KEY,payload TEXT NOT NULL)');
    store.db.exec('CREATE TABLE IF NOT EXISTS paper_risk_reconciliations (day TEXT PRIMARY KEY,payload TEXT NOT NULL)');
  }
  get(day: string): PaperRiskDay | null {
    boundary(day);
    const row = this.store.db.query('SELECT payload FROM paper_risk_days WHERE day=?').get(day) as { payload: string } | null;
    if (!row) return null;
    const record = JSON.parse(row.payload) as PaperRiskDay;
    const { sha256, ...content } = record;
    if (record.version !== 1 || record.day !== day || !money(record.equityMicros) || sha256 !== hash(content) ||
      typeof record.evidenceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.evidenceSha256) ||
      typeof record.recordedAt !== 'string' || !Number.isFinite(Date.parse(record.recordedAt)) || new Date(record.recordedAt).toISOString().slice(0, 10) !== day ||
      record.cashFlowPolicy !== 'fixed-capital-no-transfers' || record.midnightVerified !== (record.kind === 'flat-ledger-boundary') ||
      !['flat-ledger-boundary', 'session-inception', 'first-observed', 'legacy-unverified'].includes(record.kind)) throw new Error('Invalid paper risk baseline evidence');
    const old = this.store.get(`paperBaselineMicros:${day}`);
    if (old !== record.equityMicros) throw new Error('Conflicting immutable paper risk baseline');
    return record;
  }
  ensure(day: string, equity: bigint | null, fills: Fill[], session: Session, now = Date.now(), events: LedgerEvents = {}) {
    const start = boundary(day);
    if (!Number.isSafeInteger(now) || new Date(now).toISOString().slice(0, 10) !== day) throw new Error('Current UTC risk day required');
    return this.store.db.transaction(() => {
      const previous = this.get(day);
      if (previous) {
        if (events.funding?.some(f => Date.parse(f.time) < start && Date.parse(f.recordedAt) > Date.parse(previous.recordedAt)) && !this.reconciled(previous, events))
          throw new Error('Delayed funding changes the immutable opening baseline; reconciliation required');
        return previous;
      }
      const created = Date.parse(session.createdAt), capital = units(session.capital, 6);
      if (!Number.isFinite(created) || created > now || capital <= 0n) throw new Error('Invalid paper session provenance');
      const prior = fills.filter(f => Date.parse(f.time) < start);
      const openingEvents = { funding: events.funding?.filter(f => Date.parse(f.time) < start), cashFlows: events.cashFlows?.filter(f => Date.parse(f.time) < start) };
      const opening = paperBalance(prior, session.capital, openingEvents);
      const flat = [...opening.inventory.values()].every(p => p.quantity === 0n);
      const legacyMicros = this.store.get(`paperBaselineMicros:${day}`), legacyDollars = this.store.get(`paperBaseline:${day}`);
      let amount: bigint, kind: PaperRiskDay['kind'];
      if (legacyMicros !== null || legacyDollars !== null) {
        if (legacyMicros !== null && !money(legacyMicros)) throw new Error('Invalid legacy paper risk baseline');
        amount = legacyMicros === null ? units(legacyDollars, 6) : BigInt(legacyMicros);
        kind = 'legacy-unverified'; // Never silently certify or rebase an existing policy.
      } else if (created <= start && flat) {
        amount = opening.cash; kind = 'flat-ledger-boundary';
      } else if (created >= start && prior.length === 0) {
        amount = capital; kind = 'session-inception'; // Known initial capital, not midnight equity.
      } else {
        if (equity === null) return null; // An open overnight position needs a mark; do not invent one.
        amount = equity; kind = 'first-observed';
      }
      if (!money(amount.toString())) throw new Error('Paper risk baseline overflow');
      const content: Omit<PaperRiskDay, 'sha256'> = {
        version: 1, day, equityMicros: amount.toString(), recordedAt: new Date(now).toISOString(), kind,
        midnightVerified: kind === 'flat-ledger-boundary', cashFlowPolicy: 'fixed-capital-no-transfers',
        evidenceSha256: hash({ session: { capital: session.capital, createdAt: session.createdAt }, prior, openingEvents, kind,
          observedEquityMicros: kind === 'first-observed' ? amount.toString() : null }),
      };
      const record: PaperRiskDay = { ...content, sha256: hash(content) };
      this.store.db.query('INSERT INTO paper_risk_days VALUES (?,?)').run(day, JSON.stringify(record));
      this.store.set(`paperBaselineMicros:${day}`, amount.toString());
      this.store.audit('PAPER_RISK_DAY', `${day}: ${kind}; fixed-capital local ledger only`);
      return record;
    }).immediate();
  }
  private reconciled(baseline: PaperRiskDay, events: LedgerEvents): Reconciliation | null {
    const row = this.store.db.query('SELECT payload FROM paper_risk_reconciliations WHERE day=?').get(baseline.day) as { payload: string } | null;
    if (!row) return null;
    const r = JSON.parse(row.payload) as Reconciliation, { sha256, ...content } = r;
    if (r.version !== 1 || r.day !== baseline.day || r.baselineSha256 !== baseline.sha256 || sha256 !== hash(content) ||
      !money(r.correctedEquityMicros) || !money(r.effectiveEquityMicros) || !Number.isFinite(Date.parse(r.recordedAt)) ||
      BigInt(r.effectiveEquityMicros) < BigInt(r.correctedEquityMicros) || BigInt(r.effectiveEquityMicros) < BigInt(baseline.equityMicros))
      throw new Error('Invalid paper baseline reconciliation evidence');
    return r.fundingSha256 === hash(events.funding?.filter(f => Date.parse(f.time) < boundary(baseline.day)) ?? []) ? r : null;
  }
  effective(day: string, events: LedgerEvents) {
    const baseline = this.get(day);
    return baseline ? this.reconciled(baseline, events)?.effectiveEquityMicros ?? baseline.equityMicros : null;
  }
  /** Explicit, conservative repair for delayed funding only. Never rewrite a locked baseline. */
  reconcile(fills: Fill[], session: Session, events: LedgerEvents, now = Date.now()) {
    return this.store.db.transaction(() => {
      const halt = this.store.get('paperBaselineIssue') ?? this.store.db.query("SELECT time,detail FROM audit WHERE action='PAPER_BASELINE_HALT' ORDER BY id DESC LIMIT 1").get() as { time?: string; detail?: string; day?: string; error?: string } | null;
      if (!this.store.get('paperBaselineHalt')) throw new Error('No paper baseline halt to reconcile');
      if (!(halt?.error ?? halt?.detail)?.startsWith('Delayed funding changes')) throw new Error('Baseline integrity requires manual evidence repair; cannot clear this halt');
      const day = halt?.day ?? halt?.time?.slice(0, 10);
      if (!day) throw new Error('Baseline halt provenance required');
      const baseline = this.get(day), start = boundary(day);
      if (!baseline || baseline.kind !== 'flat-ledger-boundary' || Date.parse(session.createdAt) > start)
        throw new Error('Exact flat opening evidence required; overnight baselines cannot be reconciled automatically');
      const prior = fills.filter(f => Date.parse(f.time) < start);
      const funding = events.funding?.filter(f => Date.parse(f.time) < start) ?? [];
      const cashFlows = events.cashFlows?.filter(f => Date.parse(f.time) < start);
      if (cashFlows?.length) throw new Error('Transfer provenance required');
      const originalEvents = { funding: events.funding === undefined ? undefined : funding.filter(f => Date.parse(f.recordedAt) <= Date.parse(baseline.recordedAt)), cashFlows };
      const original = paperBalance(prior, session.capital, originalEvents);
      const corrected = paperBalance(prior, session.capital, { funding, cashFlows });
      if ([...corrected.inventory.values()].some(p => p.quantity !== 0n) || original.cash.toString() !== baseline.equityMicros)
        throw new Error('Opening ledger conflicts with immutable baseline');
      const evidence = { session: { capital: session.capital, createdAt: session.createdAt }, prior, kind: baseline.kind, observedEquityMicros: null };
      // Pre-funding risk-day v1 omitted openingEvents. Accept only that exact historical
      // hash with no original funding/transfers, not arbitrary missing provenance.
      if (baseline.evidenceSha256 !== hash({ session: evidence.session, prior, openingEvents: originalEvents, kind: baseline.kind, observedEquityMicros: null }) &&
        (originalEvents.funding?.length || cashFlows?.length || baseline.evidenceSha256 !== hash(evidence)))
        throw new Error('Opening evidence provenance conflicts with immutable baseline');
      const previousRow = this.store.db.query('SELECT payload FROM paper_risk_reconciliations WHERE day=?').get(day) as { payload: string } | null;
      if (previousRow) this.reconciled(baseline, events); // Validate even if newer funding invalidates the snapshot.
      const previousEffective = previousRow ? BigInt(JSON.parse(previousRow.payload).effectiveEquityMicros) : original.cash;
      const effective = [corrected.cash, original.cash, previousEffective].reduce((a, b) => a > b ? a : b);
      const content = { version: 1 as const, day, baselineSha256: baseline.sha256, fundingSha256: hash(funding),
        correctedEquityMicros: corrected.cash.toString(), effectiveEquityMicros: effective.toString(), recordedAt: new Date(now).toISOString() };
      this.store.db.query('INSERT OR REPLACE INTO paper_risk_reconciliations VALUES (?,?)').run(day, JSON.stringify({ ...content, sha256: hash(content) }));
      this.store.audit('PAPER_BASELINE_RECONCILED', JSON.stringify(content));
      this.store.set('paperBaselineHalt', false); this.store.set('paperBaselineIssue', null);
      return content;
    }).immediate();
  }
  status(day = new Date().toISOString().slice(0, 10)) {
    try {
      return { current: this.get(day), blocked: !!this.store.get('paperBaselineHalt'), transfersEnabled: false,
        perpetualAccountingComplete: false, automationAuthorized: false,
        error: this.store.get('paperBaselineHalt') ? this.store.get('paperBaselineIssue')?.error ?? 'A prior paper baseline halt needs explicit reconciliation' : null as string | null };
    } catch (error) {
      return { current: null, blocked: true, transfersEnabled: false, perpetualAccountingComplete: false,
        automationAuthorized: false, error: (error as Error).message };
    }
  }
}