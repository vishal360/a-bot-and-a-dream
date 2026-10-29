import { test, expect } from 'bun:test';
import { splitWalkForward, walkForwardVerdict } from '../src/walkforward';
import type { Kline } from '../src/backtest-klines';

const t0 = Date.parse('2026-01-01T00:00:00Z');
const kline = (i: number): Kline => ({ openTime: t0 + i * 60000, open: 100, high: 101, low: 99, close: 100, volume: 1, closeTime: t0 + i * 60000 + 59999 });
// 10 days of 1-minute candles = 14,400
const tenDays = Array.from({ length: 14400 }, (_, i) => kline(i));

test('walk-forward split is contiguous, ordered and exact', () => {
  const { train, holdout } = splitWalkForward(tenDays, 7, 3);
  expect(holdout.length).toBe(3 * 1440);
  expect(train.length).toBe(7 * 1440);
  expect(train[0].openTime).toBe(t0);
  expect(train[train.length - 1].openTime).toBe(t0 + (train.length - 1) * 60000);
  expect(holdout[0].openTime).toBe(train[train.length - 1].openTime + 60000); // no gap, no overlap
  expect(holdout[holdout.length - 1].openTime).toBe(t0 + 14399 * 60000);
});

test('walk-forward split fails closed on insufficient history and bad arguments', () => {
  expect(() => splitWalkForward(tenDays.slice(0, 2000), 7, 3)).toThrow('Not enough history');
  expect(() => splitWalkForward(tenDays, 0, 3)).toThrow('whole positive');
  expect(() => splitWalkForward([], 1, 1)).toThrow('needs klines');
});

test('the two-tier verdict: train survivor AND positive holdout, nothing else', () => {
  const verdict = walkForwardVerdict({
    candidates: ['a', 'b', 'c', 'd'],
    trainSurvivors: ['a', 'b'],
    holdout: [{ id: 'a', netPnl: 12.5 }, { id: 'b', netPnl: -3 }, { id: 'c', netPnl: 99 }],
  });
  expect(verdict.verified).toEqual([{ id: 'a', holdoutNetPnl: 12.5 }]);
  const reasons = Object.fromEntries(verdict.rejected.map(r => [r.id, r.reason]));
  expect(reasons['b']).toBe('holdout-negative');
  expect(reasons['c']).toBe('train-eliminated');
  expect(reasons['d']).toBe('train-eliminated'); // missing holdout result is never a pass
  expect(verdict.rejected.find(r => r.id === 'b')!.holdoutNetPnl).toBe(-3);
});

test('no survivors on train means nothing is verified', () => {
  const verdict = walkForwardVerdict({ candidates: ['a', 'b'], trainSurvivors: [], holdout: [{ id: 'a', netPnl: 10 }, { id: 'b', netPnl: 10 }] });
  expect(verdict.verified).toEqual([]);
  expect(verdict.rejected).toHaveLength(2);
});
