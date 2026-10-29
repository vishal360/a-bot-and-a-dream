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
