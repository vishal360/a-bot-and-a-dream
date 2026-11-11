import { test, expect } from 'bun:test';
import { replayKlines, type Kline } from '../src/backtest-klines';
import { StrategyRegistry } from '../src/strategies/registry';
import { breakoutV1 } from '../src/strategies/builtin';
import type { Strategy, StrategyContext } from '../src/strategies/types';

const t0 = Date.parse('2026-01-02T00:00:00Z');
const k = (i: number, open: number, close: number): Kline => ({ openTime: t0 + i * 1000, open, high: Math.max(open, close) * 1.001, low: Math.min(open, close) * 0.999, close, volume: 10, closeTime: t0 + i * 1000 + 999 });

function registryWith(strategy: Strategy) {
  const registry = new StrategyRegistry();
  registry.register(strategy);
  return registry;
}

test('kline replay is no-look-ahead: a proposal on candle i fills at candle i+1 open', () => {
  // Opens buy once the window has 3 samples (after candle index 2), closes while holding.
  let opened = false;
  const strategy: Strategy = { id: 'open-close-stub', name: 'Stub', description: 'test', params: [],
    evaluate: (ctx: StrategyContext) => {
      if (ctx.position) return { action: 'close', fraction: 1, rationale: 'close' };
      if (!opened && ctx.window.length >= 3) { opened = true; return { action: 'open', side: 'buy', rationale: 'open' }; }
      return { action: 'hold', rationale: 'warmup' };
    } };
  const klines = [k(0, 100, 100), k(1, 100, 100), k(2, 100, 100), k(3, 101, 102), k(4, 103, 104), k(5, 105, 105), k(6, 105, 105)];
  const result = replayKlines({ registry: registryWith(strategy), strategyId: 'open-close-stub', params: {},
    klines, symbol: 'BTC', capital: 10000, feeBps: 0, spreadBps: 0, notionalPerOrderUsd: 100, source: 'unit-test' });
  // Proposal formed on candle 2 (close 100) executes at candle 3's open (101), NOT at 100.
  expect(result.trades).toHaveLength(1);
  expect(result.trades[0].entry).toBeCloseTo(101, 10);
  expect(result.trades[0].quantity).toBeCloseTo(100 / 101, 10);
  // The position is visible at candle 3's evaluation, so its close fills at candle 4's open (103).
  expect(result.trades[0].exit).toBeCloseTo(103, 10);
  const expected = (103 - 101) * (100 / 101);
  expect(result.netPnl).toBeCloseTo(expected, 9);
  expect(result.equity).toHaveLength(klines.length);
});

test('context exposes candle closes as marks/mids, a growing window, and venue funding as a signal', () => {
  const seen: StrategyContext[] = [];
  const strategy: Strategy = { id: 'spy-stub', name: 'Spy', description: 'test', params: [],
    evaluate: (ctx: StrategyContext) => { seen.push({ ...ctx, window: [...ctx.window] }); return { action: 'hold', rationale: 'spy' }; } };
  const klines = [k(0, 100, 101), k(1, 101, 102), k(2, 102, 103), k(3, 103, 104), k(4, 104, 105)];
  const funding = [{ time: t0, rate: 0.01 }, { time: t0 + 3 * 1000, rate: -0.02 }];
  const result = replayKlines({ registry: registryWith(strategy), strategyId: 'spy-stub', params: {},
    klines, funding, symbol: 'BTC', capital: 10000, feeBps: 2, notionalPerOrderUsd: 100, source: 'unit-test' });
  expect(result.trades).toHaveLength(0);
  expect(seen).toHaveLength(klines.length);
  expect(seen[2]!.stats!.mark).toBeCloseTo(103, 10);      // candle close as mark
  expect(seen[2]!.window.length).toBe(3);                  // one sample per candle
  expect(seen[2]!.window[2]!.mid).toBeCloseTo(103, 10);    // close as the sampled mid
  expect(seen[1]!.stats!.fundingRate).toBeCloseTo(0.01, 10);   // event at t0 covers candles before t0+3s
  expect(seen[3]!.stats!.fundingRate).toBeCloseTo(-0.02, 10);  // event at t0+3s takes over
  // Book mid equals the close (symmetric synthetic spread).
  expect((seen[2]!.book!.bids[0]!.price + seen[2]!.book!.asks[0]!.price) / 2).toBeCloseTo(103, 10);
});

test('fees and mark-to-close accounting are exact on a hand-computed round trip', () => {
  const strategy: Strategy = { id: 'fee-stub', name: 'Fee', description: 'test', params: [],
    evaluate: (ctx: StrategyContext) => ctx.window.length >= 2 ? { action: 'open', side: 'buy', rationale: 'go' } : { action: 'hold', rationale: 'wait' } };
  const klines = [k(0, 100, 100), k(1, 100, 100), k(2, 101, 101), k(3, 103, 103), k(4, 103, 103)];
  const result = replayKlines({ registry: registryWith(strategy), strategyId: 'fee-stub', params: {},
    klines, symbol: 'BTC', capital: 10000, feeBps: 10, spreadBps: 0, notionalPerOrderUsd: 100, source: 'unit-test' });
  // Open fills at candle 2's open (101) with $100 notional; position closes at end-of-history (close 103).
  const quantity = 100 / 101;
  const openFee = 101 * quantity * 10 / 10000;   // = 0.1
  const closeFee = 103 * quantity * 10 / 10000;  // = ~0.1020
  const pnl = (103 - 101) * quantity;
  expect(result.feesUsd).toBeCloseTo(openFee + closeFee, 9);
  expect(result.netPnl).toBeCloseTo(pnl - openFee - closeFee, 9);
  expect(result.trades[0].reason).toBe('end of history');
});

test('kline validation fails closed', () => {
  const registry = registryWith(breakoutV1);
  expect(() => replayKlines({ registry, strategyId: 'breakout-v1', params: {}, klines: [k(0, 1, 1)], symbol: 'BTC', capital: 10000, feeBps: 2, notionalPerOrderUsd: 100, source: 't' })).toThrow('at least 2');
  expect(() => replayKlines({ registry, strategyId: 'breakout-v1', params: {}, klines: [k(0, 1, 1), k(0, 1, 1)], symbol: 'BTC', capital: 10000, feeBps: 2, notionalPerOrderUsd: 100, source: 't' })).toThrow('ascending');
  const bad = k(1, 1, -5);
  expect(() => replayKlines({ registry, strategyId: 'breakout-v1', params: {}, klines: [k(0, 1, 1), bad], symbol: 'BTC', capital: 10000, feeBps: 2, notionalPerOrderUsd: 100, source: 't' })).toThrow('Invalid kline');
  expect(result_warnings()).toContain('DIFFERENT venue');
  function result_warnings() {
    return replayKlines({ registry, strategyId: 'breakout-v1', params: {}, klines: Array.from({ length: 50 }, (_, i) => k(i, 100, 100)), symbol: 'BTC', capital: 10000, feeBps: 2, notionalPerOrderUsd: 100, source: 'binance-spot' }).warnings.join(' ');
  }
});

for (const side of ['buy', 'sell'] as const) {
  test(`taker ${side}: repeated partial closes conserve basis and allocate both fees`, () => {
    const seen: StrategyContext[] = [];
    let i = 0;
    const strategy: Strategy = { id: 'partial-stub', name: 'Partial', description: 'test', params: [],
      evaluate(ctx) {
        seen.push({ ...ctx, window: [...ctx.window] });
        const step = i++;
        if (step === 0) return { action: 'open', side, rationale: 'enter' };
        if (step === 1 || step === 2) return { action: 'close', fraction: 0.5, rationale: 'partial' };
        return { action: 'hold', rationale: 'wait' };
      } };
    const result = replayKlines({ registry: registryWith(strategy), strategyId: strategy.id, params: {},
      klines: [k(0, 100, 100), k(1, 100, 100), k(2, 110, 110), k(3, 120, 120), k(4, 130, 130)],
      symbol: 'BTC', capital: 10000, feeBps: 10, spreadBps: 0, notionalPerOrderUsd: 100, source: 'test' });
    const sign = side === 'buy' ? 1 : -1;
    expect(seen[1].position!.quantity).toBe(sign);
    expect(seen[2].position!.quantity).toBe(sign * 0.5);
    expect(seen[3].position!.quantity).toBe(sign * 0.25);
    expect(seen[3].position!.average).toBe(100);
    expect(result.trades.map(t => t.quantity)).toEqual([0.5, 0.25, 0.25]);
    expect(result.trades.every(t => t.entry === 100)).toBe(true);
    expect(result.trades[0].pnl).toBeCloseTo(sign * 5 - 0.055 - 0.05, 10);
    expect(result.trades[1].pnl).toBeCloseTo(sign * 5 - 0.03 - 0.025, 10);
    expect(result.trades[2].pnl).toBeCloseTo(sign * 7.5 - 0.0325 - 0.025, 10);
    expect(result.netPnl).toBeCloseTo(sign * 17.5 - 0.2175, 9);
    expect(result.trades.reduce((s, t) => s + t.pnl, 0)).toBeCloseTo(result.netPnl, 9);
    expect(result.equity.at(-1)).toBeCloseTo(10000 + result.netPnl, 9);
  });
}

test('terminal equity and drawdown include forced exit fee, and fees turn flat trades into losses', () => {
  const strategy: Strategy = { id: 'flat-stub', name: 'Flat', description: 'test', params: [],
    evaluate: () => ({ action: 'open', side: 'buy', rationale: 'enter' }) };
  const result = replayKlines({ registry: registryWith(strategy), strategyId: strategy.id, params: {},
    klines: [k(0, 100, 100), k(1, 100, 100)], symbol: 'BTC', capital: 10000,
    feeBps: 10, spreadBps: 0, notionalPerOrderUsd: 100, source: 'test' });
  expect(result.equity.at(-1)).toBeCloseTo(9999.8, 9);
  expect(result.netPnl).toBeCloseTo(-0.2, 9);
  expect(result.trades[0].pnl).toBeCloseTo(-0.2, 9);
  expect(result.maxDrawdown).toBeCloseTo(0.2 / 10000, 12);
  expect(result.winRate).toBe(0);
  expect(result.profitFactor).toBe(0);
});

for (const side of ['buy', 'sell'] as const) {
  for (const terminal of [false, true]) {
    test(`taker ${side}: ${terminal ? 'terminal' : 'next-open'} exit pays opposite-side half-spread and fees`, () => {
      let step = 0;
      const strategy: Strategy = { id: 'spread-stub', name: 'Spread', description: 'test', params: [],
        evaluate() {
          const i = step++;
          if (i === 0) return { action: 'open', side, rationale: 'enter' };
          if (!terminal && i === 1) return { action: 'close', fraction: 1, rationale: 'exit' };
          return { action: 'hold', rationale: 'wait' };
        } };
      const result = replayKlines({ registry: registryWith(strategy), strategyId: strategy.id, params: {},
        klines: [k(0, 100, 100), k(1, 100, 100), k(2, 110, 120)], symbol: 'BTC', capital: 10000,
        feeBps: 10, spreadBps: 20, notionalPerOrderUsd: 100, source: 'test' });
      const sign = side === 'buy' ? 1 : -1;
      const entry = 100 * (1 + sign * 0.001);
      const exit = (terminal ? 120 : 110) * (1 - sign * 0.001);
      const quantity = 100 / entry;
      const fees = 0.1 + exit * quantity * 0.001;
      const pnl = sign * (exit - entry) * quantity - fees;
      expect(result.trades[0].entry).toBeCloseTo(entry, 10);
      expect(result.trades[0].exit).toBeCloseTo(exit, 10);
      expect(result.feesUsd).toBeCloseTo(fees, 10);
      expect(result.trades[0].pnl).toBeCloseTo(pnl, 10);
      expect(result.netPnl).toBeCloseTo(pnl, 9);
      expect(result.equity.at(-1)).toBeCloseTo(10000 + pnl, 9);
      expect(result.warnings.some(w => w.includes('Terminal liquidation assumption'))).toBe(true);
    });
  }
}

test('explicit close-to-open gaps cancel taker proposals and reset warmup even with regular open spacing', () => {
  const windows: number[] = [];
  const strategy: Strategy = { id: 'gap-stub', name: 'Gap', description: 'test', params: [],
    evaluate(ctx) { windows.push(ctx.window.length); return ctx.window.length >= 2
      ? { action: 'open', side: 'buy', rationale: 'warm' } : { action: 'hold', rationale: 'warmup' }; } };
  const klines = [k(0, 100, 100), k(2, 100, 100), k(4, 200, 200)].map(bar => ({ ...bar, closeTime: bar.openTime + 1999 }));
  klines[1].closeTime -= 100; // Count and open cadence look complete, but coverage is not.
  const result = replayKlines({ registry: registryWith(strategy), strategyId: strategy.id, params: {},
    klines, symbol: 'BTC', capital: 10000, feeBps: 0, spreadBps: 0, notionalPerOrderUsd: 100, source: 'test' });
  expect(windows).toEqual([1, 2, 1]);
  expect(result.trades).toHaveLength(0);
  expect(result.warnings.some(w => w.includes('1 explicit gap'))).toBe(true);
});

test('malformed OHLC, closeTime, overlapping candles and unknown execution models fail closed', () => {
  const replay = (klines: Kline[], executionModel?: any) => replayKlines({ registry: registryWith(breakoutV1),
    strategyId: breakoutV1.id, params: {}, klines, executionModel, symbol: 'BTC', capital: 10000,
    feeBps: 0, notionalPerOrderUsd: 100, source: 'test' });
  for (const patch of [{ high: 99 }, { low: 101 }, { closeTime: NaN }, { closeTime: Infinity },
    { closeTime: t0 - 1 }, { closeTime: t0 + 0.5 }, { closeTime: 8.64e15 + 1 }, { closeTime: t0 + 1000 }]) {
    expect(() => replay([{ ...k(0, 100, 100), ...patch }, k(1, 100, 100)])).toThrow('Invalid kline');
  }
  for (const model of ['', 'unknown', null]) {
    expect(() => replay([k(0, 100, 100), k(1, 100, 100)], model)).toThrow('executionModel');
  }
});

test('downloader kline parsing validates venue rows', async () => {
  const { parseKlineRow } = await import('../scripts/download-history');
  const good = [1704163200000, '100.5', '101', '100', '100.8', '12.5', 1704163200999];
  const parsed = parseKlineRow(good);
  expect(parsed.open).toBe(100.5); expect(parsed.close).toBe(100.8); expect(parsed.volume).toBe(12.5);
  expect(() => parseKlineRow([1704163200000, '100'])).toThrow('Invalid kline row');
  expect(() => parseKlineRow([1704163200.5, '1', '1', '1', '1', '1', 1704163200999])).toThrow('Invalid kline');
  expect(() => parseKlineRow([1704163200000, '0', '1', '1', '1', '1', 1704163200999])).toThrow('Invalid kline');
  expect(() => parseKlineRow([1704163200000, '1', '1', '1', '1', '-1', 1704163200999])).toThrow('Invalid kline');
});
