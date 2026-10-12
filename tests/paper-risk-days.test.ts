import { test, expect } from 'bun:test';
import { Store } from '../src/store';
import { PaperRiskDays } from '../src/paper-risk-days';
import type { Fill } from '../src/ledger';
import { Operations } from '../src/operations';
import { ExecutionRisk } from '../src/execution-risk';
import { Paper } from '../src/paper';
import type { FundingEvent } from '../src/paper-ledger';

const day = '2026-10-12', now = Date.parse(`${day}T12:00:00Z`);
const session = { capital: 1000, createdAt: '2026-10-10T00:00:00.000Z' };
const fill = (id: string, side: 'buy' | 'sell', price: number, time: string): Fill => ({
  id, side, price, time, quantity: 1, fee: 1, account: 'paper-mainnet', botId: 'orion',
  symbol: 'BTC-USD', multiplier: 1, source: 'paper', reason: 'fixture',
});
const entry = fill('entry', 'buy', 100, '2026-10-11T20:00:00Z');
const exit = fill('exit', 'sell', 110, '2026-10-11T23:59:59Z');

test('flat UTC boundaries reconstruct exact fixed-capital opening equity including prior fees', () => {
  const s = new Store(':memory:'); const days = new PaperRiskDays(s);
  try {
    const r = days.ensure(day, 999000000n, [entry, exit], session, now)!;
    expect(r).toMatchObject({ equityMicros: '1008000000', kind: 'flat-ledger-boundary', midnightVerified: true });
    expect(r.sha256).toHaveLength(64); expect(r.evidenceSha256).toHaveLength(64);
    // Later losses, new-day trades and restart cannot silently rebase the day.
    expect(new PaperRiskDays(s).ensure(day, 1n, [entry, exit], session, now + 1)).toEqual(r);
    expect(s.get(`paperBaselineMicros:${day}`)).toBe('1008000000');
  } finally { s.db.close(); }
});

test('delayed prior-day funding cannot silently rebase a locked UTC opening baseline', () => {
  const s = new Store(':memory:'), days = new PaperRiskDays(s);
  const time = '2026-10-11T21:00:00.000Z';
  const event: FundingEvent = { version: 1, id: 'funding', symbol: 'BTC-USD', marketId: 1, timestamp: Date.parse(time) / 1000, time,
    rate: '0.1', direction: 'long', valuePerUnit: '0.5', positionAtoms: '100000000', paymentMicros: '-500000', source: 'test', raw: {}, sha256: '', recordedAt: new Date(now + 1000).toISOString() };
  try {
    const baseline = days.ensure(day, null, [entry, exit], session, now)!;
    expect(() => days.ensure(day, null, [entry, exit], session, now + 1000, { funding: [event] })).toThrow('Delayed funding');
    expect(days.get(day)).toEqual(baseline);
  } finally { s.db.close(); }
});

test('explicit delayed-funding reconciliation preserves the baseline and never lowers the loss threshold', () => {
  for (const direction of ['long', 'short'] as const) {
    const s = new Store(':memory:'), days = new PaperRiskDays(s);
    const time = '2026-10-11T21:00:00.000Z';
    const event: FundingEvent = { version: 1, id: 'funding', symbol: 'BTC-USD', marketId: 1, timestamp: Date.parse(time) / 1000, time,
      rate: '0.1', direction, valuePerUnit: '0.5', positionAtoms: '100000000', paymentMicros: direction === 'long' ? '-500000' : '500000',
      source: 'test', raw: {}, sha256: '', recordedAt: new Date(now + 1000).toISOString() };
    try {
      const baseline = days.ensure(day, null, [entry, exit], session, now, { funding: [] })!;
      const events = { funding: [event] };
      s.set('paperBaselineHalt', true); s.set('paperBaselineIssue', { day, error: 'Delayed funding changes the immutable opening baseline; reconciliation required' });
      const reconciled = days.reconcile([entry, exit], session, events, now + 2000);
      expect(reconciled.correctedEquityMicros).toBe(direction === 'long' ? '1007500000' : '1008500000');
      expect(reconciled.effectiveEquityMicros).toBe(direction === 'long' ? baseline.equityMicros : '1008500000');
      expect(days.get(day)).toEqual(baseline); expect(days.status(day).blocked).toBe(false);
      expect(new PaperRiskDays(s).ensure(day, null, [entry, exit], session, now + 3000, events)).toEqual(baseline);
      expect(days.effective(day, events)).toBe(reconciled.effectiveEquityMicros);
      expect(() => days.ensure(day, null, [entry, exit], session, now + 4000, { funding: [{ ...event, recordedAt: new Date(now + 3500).toISOString() }] })).toThrow('Delayed funding');
    } finally { s.db.close(); }
  }
});

test('reconciliation rejects unrelated halts, corrupt baselines and changed opening provenance atomically', () => {
  const s = new Store(':memory:'), days = new PaperRiskDays(s);
  try {
    const baseline = days.ensure(day, null, [entry, exit], session, now, { funding: [] })!;
    s.set('paperBaselineHalt', true); s.set('paperBaselineIssue', { day, error: 'Invalid paper risk baseline evidence' });
    expect(() => days.reconcile([entry, exit], session, { funding: [] }, now)).toThrow('integrity');
    s.set('paperBaselineIssue', { day, error: 'Delayed funding changes' });
    expect(() => days.reconcile([entry, exit], { ...session, createdAt: '2026-10-09T00:00:00Z' }, { funding: [] }, now)).toThrow('provenance');
    s.db.exec("CREATE TRIGGER fail_reconcile BEFORE INSERT ON audit WHEN NEW.action='PAPER_BASELINE_RECONCILED' BEGIN SELECT RAISE(ABORT,'storage failed'); END");
    expect(() => days.reconcile([entry, exit], session, { funding: [] }, now)).toThrow('storage failed');
    expect(s.get('paperBaselineHalt')).toBe(true); expect(days.get(day)).toEqual(baseline);
    expect(s.db.query('SELECT day FROM paper_risk_reconciliations').get()).toBeNull();
  } finally { s.db.close(); }
});

test('pre-funding v1 evidence reconciles only its exact original flat ledger hash', () => {
  const s = new Store(':memory:'), days = new PaperRiskDays(s);
  try {
    const baseline = days.ensure(day, null, [entry, exit], session, now)!;
    const { sha256: _sha, ...content } = baseline;
    content.evidenceSha256 = new Bun.CryptoHasher('sha256').update(JSON.stringify({ session, prior: [entry, exit], kind: baseline.kind, observedEquityMicros: null })).digest('hex');
    const old = { ...content, sha256: new Bun.CryptoHasher('sha256').update(JSON.stringify(content)).digest('hex') };
    s.db.query('UPDATE paper_risk_days SET payload=? WHERE day=?').run(JSON.stringify(old), day);
    s.set('paperBaselineHalt', true); s.audit('PAPER_BASELINE_HALT', 'Delayed funding changes');
    // Historical audit time can differ from this fixed fixture's day.
    s.set('paperBaselineIssue', { day, error: 'Delayed funding changes' });
    expect(days.reconcile([entry, exit], session, { funding: [] }, now).effectiveEquityMicros).toBe(old.equityMicros);
    expect(days.get(day)).toEqual(old);
  } finally { s.db.close(); }
});

test('subsequent reconciliations cannot lower an earlier effective threshold', () => {
  const s = new Store(':memory:'), days = new PaperRiskDays(s);
  const time = '2026-10-11T21:00:00.000Z';
  const event: FundingEvent = { version: 1, id: 'credit', symbol: 'BTC-USD', marketId: 1, timestamp: Date.parse(time) / 1000, time,
    rate: '-0.1', direction: 'short', valuePerUnit: '0.5', positionAtoms: '100000000', paymentMicros: '500000', source: 'test', raw: {}, sha256: '', recordedAt: new Date(now + 1000).toISOString() };
  try {
    days.ensure(day, null, [entry, exit], session, now, { funding: [] });
    const latch = () => { s.set('paperBaselineHalt', true); s.set('paperBaselineIssue', { day, error: 'Delayed funding changes' }); };
    latch(); expect(days.reconcile([entry, exit], session, { funding: [event] }, now + 2000).effectiveEquityMicros).toBe('1008500000');
    const debit = { ...event, id: 'debit', timestamp: event.timestamp + 3600, time: '2026-10-11T22:00:00.000Z', direction: 'long' as const, paymentMicros: '-500000', recordedAt: new Date(now + 3000).toISOString() };
    latch();
    const second = days.reconcile([entry, exit], session, { funding: [event, debit] }, now + 4000);
    expect(second.correctedEquityMicros).toBe('1008000000'); expect(second.effectiveEquityMicros).toBe('1008500000');
    expect(days.effective(day, { funding: [event, debit] })).toBe('1008500000');
  } finally { s.db.close(); }
});

test('inception is known initial capital, never a fabricated midnight valuation', () => {
  const s = new Store(':memory:'); const days = new PaperRiskDays(s);
  try {
    const r = days.ensure(day, 900000000n, [], { ...session, createdAt: `${day}T11:00:00Z` }, now)!;
    expect(r).toMatchObject({ kind: 'session-inception', midnightVerified: false, equityMicros: '1000000000' });
    expect(days.status(day).automationAuthorized).toBe(false);
  } finally { s.db.close(); }
});

test('overnight exposure never substitutes a later or stale mark for midnight', () => {
  const s = new Store(':memory:'); const days = new PaperRiskDays(s);
  try {
    expect(days.ensure(day, null, [entry], session, now)).toBeNull();
    expect(s.get(`paperBaselineMicros:${day}`)).toBeNull();
    const r = days.ensure(day, 950000000n, [entry], session, now)!;
    expect(r).toMatchObject({ kind: 'first-observed', midnightVerified: false, equityMicros: '950000000' });
    expect(days.ensure(day, 1000000000n, [entry], session, now + 1)).toEqual(r);
  } finally { s.db.close(); }
});

test('midnight fills belong to the new day and cannot change flat opening cash', () => {
  const s = new Store(':memory:'); const days = new PaperRiskDays(s);
  try {
    const r = days.ensure(day, null, [fill('at-boundary', 'buy', 100, `${day}T00:00:00Z`)], session, now)!;
    expect(r.equityMicros).toBe('1000000000'); expect(r.midnightVerified).toBe(true);
  } finally { s.db.close(); }
});

test('legacy baselines retain economics and unverified provenance, with no silent upgrade', () => {
  for (const integer of [true, false]) {
    const s = new Store(':memory:'); const days = new PaperRiskDays(s);
    try {
      s.set(integer ? `paperBaselineMicros:${day}` : `paperBaseline:${day}`, integer ? '900000000' : 900);
      expect(days.ensure(day, 1000000000n, [], session, now)).toMatchObject({ kind: 'legacy-unverified', equityMicros: '900000000', midnightVerified: false });
    } finally { s.db.close(); }
  }
});

test('conflicting or corrupted baseline evidence blocks authority instead of rebasing', () => {
  const s = new Store(':memory:'); const days = new PaperRiskDays(s);
  try {
    const r = days.ensure(day, null, [], session, now)!;
    s.set(`paperBaselineMicros:${day}`, '999');
    expect(() => days.ensure(day, null, [], session, now)).toThrow('Conflicting');
    expect(days.status(day).blocked).toBe(true);
    s.set(`paperBaselineMicros:${day}`, r.equityMicros);
    s.db.query('UPDATE paper_risk_days SET payload=? WHERE day=?').run(JSON.stringify({ ...r, equityMicros: '1' }), day);
    expect(() => days.get(day)).toThrow('Invalid');
    expect(days.status(day).blocked).toBe(true);
  } finally { s.db.close(); }
});

test('invalid days, clocks, session provenance and legacy money fail closed', () => {
  const s = new Store(':memory:'); const days = new PaperRiskDays(s);
  try {
    for (const bad of ['2026-02-30', '2026-1-1', 'invalid']) expect(() => days.get(bad)).toThrow('UTC');
    expect(() => days.ensure(day, null, [], session, now - 86400000)).toThrow('Current');
    expect(() => days.ensure(day, null, [], { ...session, createdAt: 'invalid' }, now)).toThrow('provenance');
    s.set(`paperBaselineMicros:${day}`, 'not-money');
    expect(() => days.ensure(day, null, [], session, now)).toThrow('legacy');
    expect(s.db.query('SELECT day FROM paper_risk_days').get()).toBeNull();
  } finally { s.db.close(); }
});

test('checksummed records still require valid evidence hashes and same-day recording provenance', () => {
  const s = new Store(':memory:'); const days = new PaperRiskDays(s);
  try {
    const { sha256, ...content } = days.ensure(day, null, [], session, now)!;
    for (const mutation of [{ evidenceSha256: 'not-a-hash' }, { evidenceSha256: null },
      { recordedAt: 'invalid' }, { recordedAt: '2026-10-11T12:00:00.000Z' }, { recordedAt: null }]) {
      const changed = { ...content, ...mutation };
      const checksum = new Bun.CryptoHasher('sha256').update(JSON.stringify(changed)).digest('hex');
      s.db.query('UPDATE paper_risk_days SET payload=? WHERE day=?').run(JSON.stringify({ ...changed, sha256: checksum }), day);
      expect(() => days.get(day)).toThrow('Invalid paper risk baseline evidence');
      expect(days.status(day).blocked).toBe(true);
    }
  } finally { s.db.close(); }
});

test('baseline writes and audit are atomic; failed persistence leaves no partial baseline', () => {
  const s = new Store(':memory:'); const days = new PaperRiskDays(s);
  try {
    s.db.exec("CREATE TRIGGER fail_risk_day BEFORE INSERT ON audit WHEN NEW.action='PAPER_RISK_DAY' BEGIN SELECT RAISE(FAIL,'audit unavailable'); END");
    expect(() => days.ensure(day, null, [], session, now)).toThrow('audit unavailable');
    expect(days.get(day)).toBeNull(); expect(s.get(`paperBaselineMicros:${day}`)).toBeNull();
    s.db.exec('DROP TRIGGER fail_risk_day');
    expect(days.ensure(day, null, [], session, now)?.midnightVerified).toBe(true);
  } finally { s.db.close(); }
});

test('corrupted baseline latches new paper exposure off across reset/restart but permits a halted exit', async () => {
  const s = new Store(':memory:'); new Operations(s, {} as any); new ExecutionRisk(s);
  const request = (async (url: any) => Response.json(String(url).includes('orderBookDetails')
    ? { code: 200, order_book_details: [{ symbol: 'BTC', status: 'active', market_id: 1, supported_size_decimals: 5, supported_price_decimals: 2, min_base_amount: '.00001', min_quote_amount: '0' }] }
    : { code: 200, bids: [{ price: '100', remaining_base_amount: '10' }], asks: [{ price: '101', remaining_base_amount: '10' }] })) as typeof fetch;
  const p = new Paper(s, request);
  try {
    s.set('allocationPct', 100); s.set('paperSession', { ...s.get('paperSession'), latencyMs: 0 }); p.configure({ enabled: true });
    expect((await p.order({ id: 'baseline-entry-01', side: 'buy', quantity: 1 })).status).toBe('filled');
    const today = new Date().toISOString().slice(0, 10);
    const record = p.status().riskDays.current!;
    s.db.query('UPDATE paper_risk_days SET payload=? WHERE day=?').run(JSON.stringify({ ...record, equityMicros: '1' }), today);
    await p.observe();
    expect(s.get('paperBaselineHalt')).toBe(true); s.reset();
    expect(() => p.configure({ enabled: true })).toThrow('baseline');
    await Bun.sleep(1001);
    const rejected = await p.order({ id: 'baseline-blocked-01', side: 'buy', quantity: 1 });
    expect(rejected.status).toBe('rejected'); expect(rejected.error).toContain('baseline');
    const restarted = new Paper(s, request); s.halt();
    expect(restarted.status().riskDays.blocked).toBe(true);
    expect((await restarted.order({ id: 'baseline-exit-01', side: 'sell', quantity: 1 })).status).toBe('filled');
    expect(restarted.summary().positions).toHaveLength(0); expect(s.get('paperBaselineHalt')).toBe(true);
  } finally { s.db.close(); }
}, 10000);