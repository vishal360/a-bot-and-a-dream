import { describe, test, expect } from 'bun:test';
import { backtest, defaultConfig, syntheticBars, validateBars, validateConfig, type Bar } from '../src/domain';
describe('research engine', () => {
  test('synthetic data and results are deterministic and explicitly labeled', () => {
    const bars = syntheticBars('crypto');
    expect(bars).toEqual(syntheticBars('crypto'));
    const result = backtest(bars, { ...defaultConfig, asset: 'crypto' }, 'synthetic');
    expect(result).toEqual(backtest(bars, { ...defaultConfig, asset: 'crypto' }, 'synthetic'));
    expect(result.warnings.join(' ')).toContain('SYNTHETIC');
    expect(result.equity).toHaveLength(bars.length);
    expect(result.trades.reduce((s, t) => s + t.pnl, 0)).toBeCloseTo(result.netPnl, 6);
  });
  test('rejects unsafe and malformed configurations', () => {
    for (const patch of [{ riskPct: .02 }, { capital: NaN }, { stopPct: 0 }, { lookback: 2.5 }, { feeBps: -1 }, { asset: 'options' }]) expect(() => validateConfig({ ...defaultConfig, ...patch } as any)).toThrow();
  });
  test('rejects impossible candles, duplicates, reverse time and short datasets', () => {
    expect(() => validateBars([])).toThrow();
    const bars = syntheticBars('crypto', 40);
    expect(() => validateBars([{ ...bars[0], high: 1 }, ...bars.slice(1)])).toThrow();
    expect(() => validateBars([bars[0], bars[0], ...bars.slice(2)])).toThrow();
    expect(() => validateBars([...bars].reverse())).toThrow();
  });
  test('flat market has no fabricated trades or profit', () => {
    const bars = syntheticBars('futures', 50).map(b => ({ ...b, open: 100, high: 100, low: 100, close: 100 }));
    const r = backtest(bars, defaultConfig, 'uploaded');
    expect(r.trades).toEqual([]); expect(r.netPnl).toBe(0); expect(r.maxDrawdown).toBe(0); expect(r.profitFactor).toBeNull();
  });
  test('uses next-open entry, whole futures contracts and gap-aware stop fills', () => {
    const bars: Bar[] = syntheticBars('futures', 40).map(b => ({ ...b, open: 100, high: 101, low: 99, close: 100 }));
    bars[10] = { ...bars[10], high: 103, close: 102 };
    bars[11] = { ...bars[11], open: 104, high: 105, low: 103, close: 104 };
    bars[12] = { ...bars[12], open: 80, high: 81, low: 79, close: 80 };
    const r = backtest(bars, { ...defaultConfig, riskPct: .01, lookback: 3, stopPct: .1, feeBps: 0, slippageBps: 0 }, 'fixture');
    expect(r.trades[0].entryTime).toBe(bars[11].time); expect(r.trades[0].entry).toBe(104); expect(r.trades[0].exit).toBe(80);
    expect(Number.isInteger(r.trades[0].quantity)).toBe(true);
  });
  test('future changes cannot affect prior equity', () => {
    const bars = syntheticBars('crypto');
    const altered = bars.map((b, i) => i < 500 ? b : { ...b, open: b.open * 2, high: b.high * 2, low: b.low * 2, close: b.close * 2 });
    const c = { ...defaultConfig, asset: 'crypto' as const };
    expect(backtest(bars, c, 'fixture').equity.slice(0, 500)).toEqual(backtest(altered, c, 'fixture').equity.slice(0, 500));
  });
  test('too little capital yields no fractional futures contract', () => {
    const r = backtest(syntheticBars('futures'), { ...defaultConfig, capital: 100 }, 'synthetic');
    expect(r.trades.length).toBe(0);
  });
});