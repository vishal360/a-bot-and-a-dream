import { test, expect } from 'bun:test';
import { paperBalance, markedMicros, paperAnalytics } from '../src/paper-ledger';
import type { Fill } from '../src/ledger';
const fill = (side: 'buy' | 'sell', quantity: number, quote: string, fee = '1'): Fill => ({
  id: crypto.randomUUID(), account: 'paper-mainnet', botId: 'orion', symbol: 'BTC-USD', side, quantity,
  price: Number(quote) / 1e6 / quantity, fee: Number(fee) / 1e6, multiplier: 1,
  time: new Date().toISOString(), source: 'paper', reason: 'test',
  settlement: { version: 1, quantityAtoms: String(Math.round(quantity * 1e8)), quoteMicros: quote, feeMicros: fee }
});

test('integer inventory conserves cash, cost basis and residual micro-dollars across partial closes', () => {
  const history = [fill('buy', .00000003, '10'), fill('sell', .00000001, '5'), fill('sell', .00000001, '5')];
  const partial = paperBalance(history, 1);
  expect(partial.quantity).toBe(1n); expect(partial.basis).toBe(4n);
  expect(partial.cash).toBe(999997n); expect(partial.realized).toBe(1n);
  const closed = paperBalance([...history, fill('sell', .00000001, '5')], 1);
  expect(closed.quantity).toBe(0n); expect(closed.basis).toBe(0n);
  expect(closed.cash).toBe(1000001n); expect(closed.realized).toBe(1n);
  expect([...closed.daily.values()]).toEqual([1n]);
  expect(markedMicros(200000n, 50000)).toBe(100000000n);
});

test('legacy replay rounds monetary values without mutating stored history', () => {
  const old = fill('buy', .002, '100030000', '20006'); delete old.settlement;
  const original = JSON.stringify(old), b = paperBalance([old], 10000);
  expect(b.cash).toBe(9899949994n); expect(b.basis).toBe(100030000n);
  expect(b.legacyFills).toBe(1); expect(JSON.stringify(old)).toBe(original);
});

test('corrupt settlements, oversells and negative cash fail closed', () => {
  expect(() => paperBalance([fill('sell', .01, '1000000')], 100)).toThrow('oversell');
  expect(() => paperBalance([fill('buy', .01, '1000000')], 1)).toThrow('negative cash');
  const corrupted = fill('buy', .01, '1000000'); corrupted.settlement!.quantityAtoms = '1';
  expect(() => paperBalance([corrupted], 100)).toThrow('settlement');
  corrupted.settlement!.quantityAtoms = '1000000'; corrupted.settlement!.feeMicros = '-1';
  expect(() => paperBalance([corrupted], 100)).toThrow('settlement');
});

test('reports reconcile mixed legacy buys, repeated closes, fees and UTC rollover exactly', () => {
  const first = fill('buy', .00000003, '10', '2'); delete first.settlement;
  const second = fill('buy', .00000002, '11', '3');
  const history = [first, second, fill('sell', .00000001, '6', '1'), fill('sell', .00000001, '6', '1'), fill('sell', .00000003, '18', '2')];
  history.forEach((f, i) => f.time = i < 2 ? '2026-01-02T23:59:59Z' : '2026-01-03T00:00:00Z');
  const b = paperBalance(history, 1), a = paperAnalytics(history, [], 1, new Date('2026-01-03T12:00:00Z'));
  expect(a.realized).toBe(Number(b.realized) / 1e6);
  expect(a.bots[0].realized).toBe(a.realized);
  expect(a.curve.at(-1)!.value).toBe(a.equity!);
  expect(a.cash).toBe(a.equity!); expect(a.positions).toHaveLength(0);
  expect(a.trades.reduce((n, t) => n + Math.round(t.pnl * 1e6), 0)).toBe(Number(b.realized));
  expect(a.daily).toEqual([{ day: '2026-01-02', pnl: -.000005 }, { day: '2026-01-03', pnl: .000005 }]);
  expect(a.today).toBe(.000005); expect(a.accounting.legacyFills).toBe(1);
  expect(a.averageBuy).toBeCloseTo(.000021 / .00000005, 8);
  expect(a.averageSell).toBeCloseTo(.000030 / .00000005, 8);
  const open = paperAnalytics(history.slice(0, 2), [], 1);
  expect(open.equity).toBeNull(); expect(open.bots[0].unrealized).toBeNull();
  expect(() => paperAnalytics([history[2]], [], 1)).toThrow('oversell');
  expect(() => paperBalance([first, first], 1)).toThrow('duplicate');
  expect(paperBalance([history[4], history[0], history[1], history[2], history[3]], 1).cash).toBe(b.cash);
});