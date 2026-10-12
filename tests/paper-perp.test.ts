import { test, expect } from 'bun:test';
import { floorDiv, fundingPayment, positionEffect, cashFlowDelta, type CashFlow } from '../src/paper-ledger';
import { paperBalance, paperAnalytics, type FundingEvent } from '../src/paper-ledger';
import { paperMargin } from '../src/paper-margin';
import { PaperFunding, readPaperEvents } from '../src/paper-funding';
import { Store } from '../src/store';
import type { Fill } from '../src/ledger';

const hour = Date.parse('2026-01-01T01:00:00Z');
const fill = (id: string, side: Fill['side'], q: number, quote: number, effect: 'open' | 'reduce', ms = hour - 1000, fee = 0, leverage = 10): Fill => ({
  id, account: 'paper-mainnet', botId: 'orion', symbol: 'BTC-USD', multiplier: 1, side, quantity: q, price: quote / q, fee, time: new Date(ms).toISOString(), source: 'paper', reason: 'test',
  settlement: { version: 2, effect, quantityAtoms: String(q * 1e8), quoteMicros: String(quote * 1e6), feeMicros: String(fee * 1e6), leverage },
});
const marks = (price: number, ms = hour + 1000) => [{ account: 'paper-mainnet', symbol: 'BTC-USD', price, time: new Date(ms).toISOString(), source: 'test' }];
const funding = (held: bigint, direction: 'long' | 'short' = 'long'): FundingEvent => ({ version: 1, id: '1:' + hour / 1000, marketId: 1, symbol: 'BTC-USD', timestamp: hour / 1000, time: new Date(hour).toISOString(),
  rate: '0.1', direction, valuePerUnit: '0.5', positionAtoms: held.toString(), paymentMicros: fundingPayment(held, '0.5', direction).toString(), source: 'test', raw: {}, sha256: '', recordedAt: new Date(hour + 3600000).toISOString() });

test('floorDiv rounds toward negative infinity', () => {
  expect(floorDiv(7n, 2n)).toBe(3n);
  expect(floorDiv(-7n, 2n)).toBe(-4n);
  expect(floorDiv(7n, -2n)).toBe(-4n);
  expect(floorDiv(-6n, 2n)).toBe(-3n);
});

test('funding follows the paying side and rounds against the account', () => {
  // 1 BTC long, longs pay 0.5 USDC per unit -> -0.5 USDC.
  expect(fundingPayment(100000000n, '0.5', 'long')).toBe(-500000n);
  // Same hour, 1 BTC short receives it.
  expect(fundingPayment(-100000000n, '0.5', 'long')).toBe(500000n);
  // Shorts pay: short is debited, long credited.
  expect(fundingPayment(-100000000n, '0.5', 'short')).toBe(-500000n);
  expect(fundingPayment(100000000n, '0.5', 'short')).toBe(500000n);
  // Sub-micro amounts: debit rounds up in magnitude, credit rounds down.
  expect(fundingPayment(1n, '0.00000001', 'long')).toBe(-1n);
  expect(fundingPayment(-1n, '0.00000001', 'long')).toBe(0n);
  expect(fundingPayment(0n, '1.25', 'long')).toBe(0n);
  expect(() => fundingPayment(1n, '1', 'both' as 'long')).toThrow('Invalid funding direction');
});

test('position effect opens, increases or reduces and refuses to flip', () => {
  expect(positionEffect('buy', 5n, 0n)).toBe('open');
  expect(positionEffect('sell', 5n, 0n)).toBe('open');
  expect(positionEffect('buy', 5n, 10n)).toBe('open');
  expect(positionEffect('sell', 5n, -10n)).toBe('open');
  expect(positionEffect('sell', 10n, 10n)).toBe('reduce');
  expect(positionEffect('buy', 4n, -10n)).toBe('reduce');
  expect(() => positionEffect('sell', 11n, 10n)).toThrow('cannot flip');
  expect(() => positionEffect('buy', 11n, -10n)).toThrow('cannot flip');
});

test('cash flows are signed and validated', () => {
  const flow = (kind: CashFlow['kind'], amountMicros: string): CashFlow => ({ version: 1, seq: 1, id: 'x', kind, amountMicros, time: new Date(0).toISOString(), reason: 't', previousSha256: '', sha256: '' });
  expect(cashFlowDelta(flow('deposit', '2500000'))).toBe(2500000n);
  expect(cashFlowDelta(flow('withdrawal', '2500000'))).toBe(-2500000n);
  for (const bad of ['0', '-1', '01', '1.5', '']) expect(() => cashFlowDelta(flow('deposit', bad))).toThrow('Invalid paper cash flow');
  expect(() => cashFlowDelta(flow('transfer' as CashFlow['kind'], '1'))).toThrow('Invalid paper cash flow');
});

test('short collateral is reserved, sale proceeds never become cash, and unscaled PnL closes exactly', () => {
  const fills = [fill('short-entry', 'sell', 2, 200, 'open', hour - 1000, .2)];
  const b = paperBalance(fills, 100);
  expect(b.cash).toBe(79800000n); expect(b.quantity).toBe(-200000000n); expect(b.basis).toBe(200000000n);
  const a = paperAnalytics(fills, marks(90), 100, new Date(hour + 1000));
  expect(a).toMatchObject({ cash: 79.8, marginUsed: 20, equity: 119.8, realized: -.2, unrealized: 20 });
  expect(a.positions[0]).toMatchObject({ side: 'short', average: 100, quantity: -2, openNetPnl: 19.8 });
  fills.push(fill('short-half', 'buy', 1, 90, 'reduce', hour + 2000, .09));
  expect(paperBalance(fills, 100).cash).toBe(99710000n);
  fills.push(fill('short-final', 'buy', 1, 110, 'reduce', hour + 3000, .11));
  const closed = paperBalance(fills, 100);
  expect(closed.cash).toBe(99600000n); expect(closed.realized).toBe(-400000n);
  expect(closed.quantity).toBe(0n); expect(closed.basis).toBe(0n);
  expect(closed.tradeMicros).toEqual([9810000n, -10210000n]);
});

test('flat-then-reopen reversal is explicit; flips and mismatched intent are rejected', () => {
  const entry = fill('long', 'buy', 1, 100, 'open');
  expect(() => paperBalance([entry, fill('flip', 'sell', 2, 200, 'reduce', hour)], 100)).toThrow('cannot flip');
  expect(() => paperBalance([entry, fill('wrong', 'sell', 1, 100, 'open', hour)], 100)).toThrow('effect mismatch');
  const b = paperBalance([entry, fill('close', 'sell', 1, 100, 'reduce', hour), fill('short', 'sell', 1, 100, 'open', hour)], 100);
  expect(b.quantity).toBe(-100000000n); expect(b.cash).toBe(90000000n);
  expect(() => paperBalance([fill('unfunded-short', 'sell', 2, 200, 'open')], 1)).toThrow('negative cash');
});

test('funding settles against pre-boundary holdings, is allocated to exits, and never multiplies by leverage', () => {
  for (const side of ['buy', 'sell'] as const) {
    const sign = side === 'buy' ? 1n : -1n, f = funding(200000000n * sign);
    const fills = [fill('entry', side, 2, 200, 'open'), fill('half', side === 'buy' ? 'sell' : 'buy', 1, 100, 'reduce', hour)];
    const b = paperBalance(fills, 100, { funding: [f] });
    expect(b.funding).toBe(-1000000n * sign);
    expect(b.tradeMicros).toEqual([-500000n * sign]);
    expect(b.inventory.get('BTC-USD')!.funding).toBe(-500000n * sign);
    expect(b.realized).toBe(b.funding);
    expect(() => paperBalance(fills, 100, { funding: [f, f] })).toThrow('Invalid funding');
    expect(() => paperBalance(fills, 100, { funding: [{ ...f, positionAtoms: '1' }] })).toThrow('snapshot');
  }
  expect(() => paperBalance([fill('entry-at-boundary', 'buy', 1, 100, 'open', hour)], 100, { funding: [funding(100000000n)] })).toThrow('snapshot');
});

test('conservative residual basis, fees and funding reconcile across many partial short exits', () => {
  const fills = [fill('entry', 'sell', .03, 3.000001, 'open', hour - 1000, .000007)];
  const f = { ...funding(-3000000n), valuePerUnit: '0.0001', paymentMicros: '3' };
  for (let i = 0; i < 3; i++) fills.push(fill('close-' + i, 'buy', .01, 1, 'reduce', hour + i * 1000, .000001));
  const b = paperBalance(fills, 100, { funding: [f] });
  expect(b.quantity).toBe(0n); expect(b.basis).toBe(0n);
  expect(b.cash).toBe(99999994n); expect(b.realized).toBe(-6n);
  expect(b.tradeMicros.reduce((a, b) => a + b, 0n)).toBe(b.realized);
});

test('margin is account-level absolute exposure; thresholds, missing marks and metadata fail conservatively', () => {
  const b = paperBalance([fill('short', 'sell', 10, 1000, 'open')], 100);
  const market = [{ symbol: 'BTC', min_initial_margin_fraction: 1000, maintenance_margin_fraction: 600, closeout_margin_fraction: 400 }];
  expect(paperMargin(b, marks(100), market, hour + 1000)).toMatchObject({ state: 'healthy', equity: 100, initial: 100, maintenance: 60, closeout: 40, exposure: 1000, approximate: false });
  expect(paperMargin(b, marks(103), market, hour + 1000).state).toBe('reduce-only');
  expect(paperMargin(b, marks(105), market, hour + 1000).state).toBe('liquidating');
  expect(paperMargin(b, marks(107), market, hour + 1000).state).toBe('closeout');
  expect(paperMargin(b, [], market, hour + 1000).state).toBe('unknown');
  expect(paperMargin(b, marks(100), [], hour + 1000).approximate).toBe(true);
  expect(paperMargin(b, marks(100), market, hour + 16001).state).toBe('unknown');
});

test('liquidation surcharge is separate, charged exactly once, and losses may exceed collateral', () => {
  const close = fill('liquidation', 'buy', 10, 1200, 'reduce', hour + 1000);
  close.settlement!.liquidationFeeMicros = '12000000';
  const b = paperBalance([fill('short', 'sell', 10, 1000, 'open'), close], 100);
  expect(b.cash).toBe(-112000000n); expect(b.fees).toBe(12000000n); expect(b.liquidationFees).toBe(12000000n);
  expect(b.tradeMicros).toEqual([-212000000n]);
});

test('funding history ignores the current hour, catches closed exposure and is restart-idempotent', async () => {
  const s = new Store(':memory:'), fills = [fill('entry', 'buy', 1, 100, 'open'), fill('close', 'sell', 1, 100, 'reduce', hour + 1000)];
  const raw = { timestamp: hour / 1000, value: '0.5', rate: '0.1', direction: 'long' };
  let calls = 0;
  const get = async () => { calls++; return { code: 200, resolution: '1h', fundings: [raw, { ...raw, timestamp: hour / 1000 + 3600, value: '99' }] }; };
  try {
    const a = new PaperFunding(s);
    await a.refresh(fills, 100, [{ symbol: 'BTC', market_id: 1 }], get, () => true, hour + 1000);
    expect(calls).toBe(0); expect(readPaperEvents(s).funding).toHaveLength(0);
    const b = new PaperFunding(s);
    await b.refresh(fills, 100, [{ symbol: 'BTC', market_id: 1 }], get, () => true, hour + 3600000);
    expect(readPaperEvents(s).funding).toHaveLength(1);
    expect(paperBalance(fills, 100, readPaperEvents(s)).cash).toBe(99500000n);
    const c = new PaperFunding(s);
    await c.refresh(fills, 100, [{ symbol: 'BTC', market_id: 1 }], get, () => true, hour + 7200000);
    expect(calls).toBe(1); expect(readPaperEvents(s).funding).toHaveLength(1);
    s.db.exec("UPDATE paper_funding SET payload=json_set(payload,'$.paymentMicros','123')");
    expect(() => readPaperEvents(s)).toThrow('immutable funding');
  } finally { s.db.close(); }
});

test('missing funding hour, malformed economics and superseded workers never fabricate settlements', async () => {
  for (const mode of ['missing', 'duplicate', 'precision', 'restart']) {
    const s = new Store(':memory:'), a = new PaperFunding(s); let active = true;
    const raw = { timestamp: hour / 1000, value: mode === 'precision' ? '0.000000001' : '0.5', rate: '0.1', direction: 'long' };
    try {
      await a.refresh([fill('entry', 'buy', 1, 100, 'open')], 100, [{ symbol: 'BTC', market_id: 1 }], async () => {
        if (mode === 'restart') active = false;
        return { code: 200, resolution: '1h', fundings: mode === 'missing' ? [] : mode === 'duplicate' ? [raw, raw] : [raw] };
      }, () => active, hour + 3600000);
      expect(readPaperEvents(s).funding).toHaveLength(0);
      if (active) expect(s.get('paperFundingState').blocked).toBe(true);
    } finally { s.db.close(); }
  }
});

test('late funding debits preserve previously committed openings but show insolvency honestly', () => {
  const f = { ...funding(100000000n), valuePerUnit: '20', paymentMicros: '-20000000', recordedAt: new Date(hour + 3600000).toISOString() };
  const fills = [fill('first', 'buy', 1, 100, 'open', hour - 1000, 0, 1), fill('increase-before-history', 'buy', .5, 50, 'open', hour + 1000, 0, 1)];
  const b = paperBalance(fills, 150, { funding: [f] });
  expect(b.cash).toBe(-20000000n); expect(b.realized).toBe(-20000000n);
  expect(() => paperBalance([...fills, fill('new-unfunded', 'buy', .1, 10, 'open', hour + 3601000, 0, 1)], 150, { funding: [f] })).toThrow('negative cash');
});

test('funding persistence and audit roll back together on storage failure', async () => {
  const s = new Store(':memory:'), a = new PaperFunding(s);
  try {
    s.db.exec("CREATE TRIGGER reject_funding_audit BEFORE INSERT ON audit WHEN NEW.action='PAPER_FUNDING_SETTLED' BEGIN SELECT RAISE(ABORT,'storage failed'); END");
    await a.refresh([fill('entry', 'buy', 1, 100, 'open')], 100, [{ symbol: 'BTC', market_id: 1 }], async () => ({ code: 200, resolution: '1h', fundings: [{ timestamp: hour / 1000, value: '0.5', rate: '0.1', direction: 'long' }] }), () => true, hour + 3600000);
    expect(readPaperEvents(s).funding).toHaveLength(0);
    expect(s.get('paperFundingState').blocked).toBe(true);
  } finally { s.db.close(); }
});

test('funding catches a missing earlier hour even when later settlement evidence exists', async () => {
  const s = new Store(':memory:'), fills = [fill('entry', 'buy', 1, 100, 'open')];
  const raw = { value: '0.5', rate: '0.1', direction: 'long' };
  const get = async () => ({ code: 200, resolution: '1h', fundings: [0, 1].map(i => ({ ...raw, timestamp: hour / 1000 + i * 3600 })) });
  try {
    await new PaperFunding(s).refresh(fills, 100, [{ symbol: 'BTC', market_id: 1 }], get, () => true, hour + 7200000);
    expect(readPaperEvents(s).funding).toHaveLength(2);
    s.db.query('DELETE FROM paper_funding WHERE timestamp=?').run(hour / 1000);
    await new PaperFunding(s).refresh(fills, 100, [{ symbol: 'BTC', market_id: 1 }], get, () => true, hour + 7200000);
    expect(readPaperEvents(s).funding).toHaveLength(2); expect(s.get('paperFundingState').blocked).toBe(false);
    s.db.exec('UPDATE paper_funding SET market_id=9');
    expect(() => readPaperEvents(s)).toThrow('storage identity');
  } finally { s.db.close(); }
});
