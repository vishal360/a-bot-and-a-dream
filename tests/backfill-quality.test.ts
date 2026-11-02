import { test, expect } from 'bun:test';
import { assessDayQuality } from '../src/backfill-quality';
import type { Kline } from '../src/backtest-klines';

const SECOND = 1000;
const day = (i: number) => Date.parse('2026-10-01T00:00:00Z') + i * SECOND;
const k = (openTime: number, volume = 10, close = 100): Kline =>
  ({ openTime, open: close, high: close, low: close, close, volume, closeTime: openTime + SECOND - 1 });

test('a clean day passes', () => {
  const klines = Array.from({ length: 86400 }, (_, i) => k(day(i)));
  const quality = assessDayQuality(klines, '2026-10-01');
  expect(quality.verdict).toBe('ok');
  expect(quality.candles).toBe(86400);
  expect(quality.intervalMs).toBe(SECOND);
  expect(quality.problems).toHaveLength(0);
});

test('duplicate timestamps are instantly fatal', () => {
  const klines = Array.from({ length: 100 }, (_, i) => k(day(i)));
  klines[50] = k(day(49));
  const quality = assessDayQuality(klines, '2026-10-01');
  expect(quality.verdict).toBe('bad');
  expect(quality.problems[0].kind).toBe('duplicate');
});

test('a one-hour hole is fatal; small gaps degrade', () => {
  const base = Array.from({ length: 5000 }, (_, i) => k(day(i)));
  // 2-minute hole: degraded (over the 5-minute cumulative budget? 2 min < 5 min budget -> ok)
  const small = [...base.slice(0, 1000), ...base.slice(1000).map(kk => ({ ...kk, openTime: kk.openTime + 2 * 60 * SECOND }))];
  expect(assessDayQuality(small, 'd').verdict).toBe('ok');
  // cumulative gaps over 5 minutes: degraded
  const drift = base.map((kk, i) => ({ ...kk, openTime: kk.openTime + Math.floor(i / 100) * 2 * 60 * SECOND }));
  expect(assessDayQuality(drift, 'd').verdict).toBe('degraded');
  // one 90-minute hole: bad
  const hole = [...base.slice(0, 1000), ...base.slice(1000).map(kk => ({ ...kk, openTime: kk.openTime + 90 * 60 * SECOND }))];
  const verdict = assessDayQuality(hole, 'd');
  expect(verdict.verdict).toBe('bad');
  expect(verdict.problems[0].kind).toBe('gap');
});

test('zero-volume runs degrade, hour-long zero volume is fatal', () => {
  const flat = Array.from({ length: 4000 }, (_, i) => k(day(i)));
  const shortRun = flat.map((kk, i) => (i >= 100 && i < 100 + 240 ? { ...kk, volume: 0 } : kk)); // 4 min: under the 5-min budget
  expect(assessDayQuality(shortRun, 'd').verdict).toBe('ok');
  const longRun = flat.map((kk, i) => (i >= 100 && i < 100 + 360 ? { ...kk, volume: 0 } : kk)); // 6 min: degraded
  const verdict = assessDayQuality(longRun, 'd');
  expect(verdict.verdict).toBe('degraded');
  expect(verdict.problems[0].kind).toBe('zero-volume-run');
  const fatalRun = flat.map((kk, i) => (i >= 100 && i < 100 + 3700 ? { ...kk, volume: 0 } : kk)); // > 1h: bad
  expect(assessDayQuality(fatalRun, 'd').verdict).toBe('bad');
});
