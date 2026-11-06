import { test, expect } from 'bun:test';
import { splitByBars, splitWalkForward } from '../src/walkforward';
import type { Kline } from '../src/backtest-klines';

const MIN = 60000;
const T0 = Date.parse('2026-11-01T00:00:00Z');
const k = (i: number): Kline => ({ openTime: T0 + i * MIN, open: 100, high: 100, low: 100, close: 100, volume: 0, closeTime: T0 + i * MIN + MIN - 1 });

test('splitByBars: contiguous first-N train, remainder holdout', () => {
  const klines = Array.from({ length: 1000 }, (_, i) => k(i));
  const { train, holdout } = splitByBars(klines, 700);
  expect(train).toHaveLength(700);
  expect(holdout).toHaveLength(300);
  expect(train[0].openTime).toBe(T0);
  expect(holdout[0].openTime).toBe(T0 + 700 * MIN); // strictly after train: no overlap
  expect(holdout.at(-1)!.openTime).toBe(T0 + 999 * MIN);
});

test('splitByBars: minimum sizes enforced (train >= 100, holdout >= 50)', () => {
  const klines = Array.from({ length: 1000 }, (_, i) => k(i));
  expect(() => splitByBars(klines, 99)).toThrow('>= 100');
  expect(() => splitByBars(klines, 951)).toThrow('Holdout too small');
  expect(() => splitByBars(klines, 950)).not.toThrow();
});

test('splitByBars: handles gappy corpora day-count splits cannot', () => {
  // Bars from a recorder that was off for days: huge time holes, but bar ORDER is intact.
  const klines = [k(0), k(1), ...Array.from({ length: 198 }, (_, i) => k(1440 * 3 + i))]; // 2 bars, 3-day hole, 198 bars
  expect(() => splitWalkForward(klines, 2, 1)).toThrow(); // day-count split refuses
  const { train, holdout } = splitByBars(klines, 150);    // bars-mode still works
  expect(train).toHaveLength(150);
  expect(holdout).toHaveLength(50);
});
