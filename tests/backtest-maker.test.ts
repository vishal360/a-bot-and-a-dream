import { test, expect } from 'bun:test';
import { replayKlines, type Kline } from '../src/backtest-klines';
import { StrategyRegistry } from '../src/strategies/registry';
import type { Strategy, StrategyContext, StrategyProposal } from '../src/strategies/types';

const MIN = 60 * 1000;
const T0 = Date.parse('2026-10-01T00:00:00Z');
const k = (i: number, close: number, low = close, high = close, volume = 10): Kline =>
  ({ openTime: T0 + i * MIN, open: close, high: Math.max(high, close), low: Math.min(low, close), close, volume, closeTime: T0 + i * MIN + MIN - 1 });

/** A scripted strategy: pops one proposal per evaluation, 'hold' when the script is empty. */
const scriptedStrategy = (script: StrategyProposal[]): Strategy => ({
  id: 'scripted-v1', name: 'Scripted', description: 'test double',
  params: [{ key: 'noop', label: 'noop', min: 0, max: 1, default: 0 }],
  evaluate(_ctx: StrategyContext): StrategyProposal { return script.length ? script.shift()! : { action: 'hold', rationale: 'done' }; },
});

const harness = (script: StrategyProposal[], klines: Kline[], options: Record<string, unknown> = {}) => {
  const registry = new StrategyRegistry();
  registry.register(scriptedStrategy(script));
  return replayKlines({ registry, strategyId: 'scripted-v1', params: {}, klines, symbol: 'BTC',
    capital: 10000, feeBps: 0, notionalPerOrderUsd: 1000, source: 'test', ...options });
};

test('taker model (default) still fills at the next open with spread', () => {
  const klines = [k(0, 100), k(1, 101), k(2, 102), k(3, 103)];
  const result = harness([{ action: 'open', side: 'buy', rationale: 'r' }], klines);
  expect(result.trades).toHaveLength(1); // forced close at end of history
  expect(result.trades[0].entry).toBeCloseTo(101 * (1 + 2 / 20000), 6); // next open + half spread
  expect(result.config.executionModel).toBe('taker');
});

test('maker-conservative: a touch does NOT fill, only a strict trade-through does', () => {
  // Decision at close of candle 0 (100) -> buy limit at 100.
  // Candle 1 touches 100 exactly (low == limit): NO fill.
  // Candle 2 trades through (low 99.5): fills AT 100, not at 99.5.
  const klines = [k(0, 100), k(1, 100.5, 100, 101), k(2, 100.2, 99.5, 100.8), k(3, 100.4), k(4, 100.6), k(5, 100.8), k(6, 101)];
  const result = harness([{ action: 'open', side: 'buy', rationale: 'r' }], klines, { executionModel: 'maker-conservative', limitTtlCandles: 5 });
  expect(result.trades).toHaveLength(1);
  expect(result.trades[0].entry).toBe(100); // the limit price, never the trade-through extreme
  expect(result.trades[0].side).toBe('long');
});

test('maker-conservative: an unfilled limit cancels after the TTL and no position opens', () => {
  const klines = [k(0, 100), k(1, 101), k(2, 102), k(3, 103), k(4, 104), k(5, 105), k(6, 106), k(7, 107)];
  const result = harness([{ action: 'open', side: 'buy', rationale: 'r' }], klines, { executionModel: 'maker-conservative', limitTtlCandles: 2 });
  expect(result.trades).toHaveLength(0);
  expect(result.netPnl).toBe(0);
  expect(result.warnings.some(w => w.includes('expired unfilled'))).toBe(true);
});

test('maker-conservative: a stale closing limit falls back to a taker exit instead of holding forever', () => {
  // Open long at 100 (candle 2 trades through), then decide to close at candle 3 close (100.5).
  // No candle ever trades above 100.5 within TTL -> taker fallback exit at a later open.
  const klines = [k(0, 100), k(1, 100.2, 99.5, 100.3), k(2, 100.1, 99.9, 100.2), k(3, 100.5), k(4, 100.4), k(5, 100.3), k(6, 100.2), k(7, 100.1), k(8, 100)];
  const script: StrategyProposal[] = [
    { action: 'open', side: 'buy', rationale: 'enter' },
    { action: 'hold', rationale: 'wait' },
    { action: 'hold', rationale: 'wait' },
    { action: 'close', fraction: 1, rationale: 'exit' },
  ];
  const result = harness(script, klines, { executionModel: 'maker-conservative', limitTtlCandles: 2 });
  // One closed round trip: entered at the 100 limit, exited by the taker fallback.
  expect(result.trades).toHaveLength(1);
  expect(result.trades[0].entry).toBe(100);
  expect(result.trades[0].reason).toBe('limit expired: taker exit');
});

test('maker-conservative: short entry fills on an upward trade-through and exits on a downward one', () => {
  const klines = [
    k(0, 100),                                        // decision: open short @ 100
    k(1, 101, 100.5, 101.5),                          // high 101.5 > 100: fills short at 100
    k(2, 99),                                         // decision: close @ 99
    k(3, 98.5, 98),                                   // low 98 < 99: buy-back fills at 99
    k(4, 98.6), k(5, 98.7), k(6, 98.8), k(7, 98.9),   // runway for grading
  ];
  const script: StrategyProposal[] = [
    { action: 'open', side: 'sell', rationale: 'short enter' },
    { action: 'hold', rationale: 'wait' },
    { action: 'close', fraction: 1, rationale: 'cover' },
  ];
  const result = harness(script, klines, { executionModel: 'maker-conservative', limitTtlCandles: 4 });
  // One closed round trip, entered and exited exactly at the limit prices.
  expect(result.trades).toHaveLength(1);
  expect(result.trades[0].side).toBe('short');
  expect(result.trades[0].entry).toBe(100);
  expect(result.trades[0].exit).toBe(99);
  expect(result.netPnl).toBe(10); // short 100 -> cover 99 on 1000 notional = 10 units of price gain * 10 quantity
});

test('maker-conservative: a resting limit blocks new decisions (one working order at a time)', () => {
  // Two consecutive open decisions while the first limit is still resting: the second is
  // dropped, never queued. The first limit then expires unfilled - had the second been
  // queued it would fill on candle 7 (low 99.5 < 100), so zero trades proves the drop.
  const klines = [k(0, 100), k(1, 101), k(2, 102), k(3, 103), k(4, 104), k(5, 105), k(6, 99), k(7, 99.5)];
  const script: StrategyProposal[] = [
    { action: 'open', side: 'buy', rationale: 'first' },
    { action: 'open', side: 'buy', rationale: 'second - must be dropped' },
  ];
  const result = harness(script, klines, { executionModel: 'maker-conservative', limitTtlCandles: 5 });
  expect(result.trades).toHaveLength(0);
  expect(result.warnings.some(w => w.includes('expired unfilled'))).toBe(true);
});

for (const side of ['buy', 'sell'] as const) {
  test(`maker ${side}: partial closes preserve entry basis, signed context and allocated fees`, () => {
    let step = 0;
    const seen: StrategyContext[] = [];
    const strategy: Strategy = { id: 'maker-partial', name: 'Partial', description: 'test', params: [],
      evaluate(ctx) {
        seen.push({ ...ctx, window: [...ctx.window] });
        const i = step++;
        if (i === 0) return { action: 'open', side, rationale: 'enter' };
        if (i === 1 || i === 2) return { action: 'close', fraction: 0.5, rationale: 'partial' };
        return { action: 'hold', rationale: 'wait' };
      } };
    const registry = new StrategyRegistry(); registry.register(strategy);
    const result = replayKlines({ registry, strategyId: strategy.id, params: {},
      klines: [k(0, 100), k(1, 100, 99, 101), k(2, 110, 99, 111), k(3, 120, 109, 121), k(4, 130)],
      symbol: 'BTC', capital: 10000, feeBps: 10, notionalPerOrderUsd: 1000, source: 'test', executionModel: 'maker-conservative' });
    const sign = side === 'buy' ? 1 : -1;
    expect(seen[1].position!.quantity).toBe(sign * 10);
    expect(seen[2].position!.quantity).toBe(sign * 5);
    expect(seen[3].position!.quantity).toBe(sign * 2.5);
    expect(seen[3].position!.average).toBe(100);
    expect(result.trades.map(t => t.quantity)).toEqual([5, 2.5, 2.5]);
    expect(result.trades.every(t => t.entry === 100)).toBe(true);
    // Actual limits stay at 100/110; terminal taker exit pays the adverse half-spread.
    const terminalExit = 130 * (1 - sign * 2 / 20000);
    const terminalFee = terminalExit * 2.5 * 10 / 10000;
    expect(result.trades[0].exit).toBe(100);
    expect(result.trades[1].exit).toBe(110);
    expect(result.trades[2].exit).toBeCloseTo(terminalExit, 10);
    expect(result.trades[0].pnl).toBeCloseTo(-1, 10);
    expect(result.trades[1].pnl).toBeCloseTo(sign * 25 - 0.275 - 0.25, 10);
    expect(result.trades[2].pnl).toBeCloseTo(sign * (terminalExit - 100) * 2.5 - terminalFee - 0.25, 10);
    expect(result.feesUsd).toBeCloseTo(1.775 + terminalFee, 10);
    expect(result.netPnl).toBeCloseTo(sign * (25 + (terminalExit - 100) * 2.5) - 1.775 - terminalFee, 9);
    expect(result.trades.reduce((s, t) => s + t.pnl, 0)).toBeCloseTo(result.netPnl, 9);
    expect(result.equity.at(-1)).toBeCloseTo(10000 + result.netPnl, 9);
  });
}

test('maker expired close allocates remaining entry fee into trade pnl and terminal equity', () => {
  const result = harness([
    { action: 'open', side: 'buy', rationale: 'enter' },
    { action: 'close', fraction: 1, rationale: 'exit' },
  ], [k(0, 100), k(1, 100, 99, 100), k(2, 100), k(3, 100)],
  { executionModel: 'maker-conservative', limitTtlCandles: 1, feeBps: 10 });
  expect(result.trades).toHaveLength(1);
  expect(result.trades[0].reason).toBe('limit expired: taker exit');
  const exit = 100 * (1 - 2 / 20000);
  const pnl = (exit - 100) * 10 - 1 - exit * 10 * 10 / 10000;
  expect(result.trades[0].exit).toBeCloseTo(exit, 10);
  expect(result.trades[0].pnl).toBeCloseTo(pnl, 10);
  expect(result.netPnl).toBeCloseTo(pnl, 9);
  expect(result.equity.at(-1)).toBeCloseTo(10000 + pnl, 9);
  expect(result.maxDrawdown).toBeCloseTo(-pnl / 10000, 12);
});

test('maker cancels resting entry across an explicit gap and resets feature warmup', () => {
  const lengths: number[] = [];
  const strategy: Strategy = { id: 'maker-gap', name: 'Gap', description: 'test', params: [],
    evaluate(ctx) { lengths.push(ctx.window.length); return ctx.window.length === 2
      ? { action: 'open', side: 'buy', rationale: 'warm' } : { action: 'hold', rationale: 'wait' }; } };
  const registry = new StrategyRegistry(); registry.register(strategy);
  const klines = [k(0, 100), k(1, 100), k(2, 100, 90, 110)];
  klines[1].closeTime -= 100;
  const result = replayKlines({ registry, strategyId: strategy.id, params: {}, klines, symbol: 'BTC',
    capital: 10000, feeBps: 0, notionalPerOrderUsd: 1000, source: 'test', executionModel: 'maker-conservative' });
  expect(lengths).toEqual([1, 2, 1]);
  expect(result.trades).toHaveLength(0);
  expect(result.warnings.some(w => w.includes('explicit gap'))).toBe(true);
});

test('maker gap cancels resting exit without inventing a fill or forced gap liquidation', () => {
  const klines = [k(0, 100), k(1, 100, 99, 100), k(3, 110), k(4, 120)];
  const result = harness([{ action: 'open', side: 'buy', rationale: 'enter' },
    { action: 'close', fraction: 1, rationale: 'pre-gap exit' }], klines, { executionModel: 'maker-conservative' });
  expect(result.trades).toHaveLength(1);
  expect(result.trades[0].reason).toBe('end of history');
  expect(result.trades[0].exit).toBeCloseTo(120 * (1 - 2 / 20000), 10);
  expect(result.warnings.some(w => w.includes('Existing positions remain exposed'))).toBe(true);
});

for (const fraction of [0, -1, 2, NaN, Infinity]) {
  test(`maker rejects invalid close fraction ${fraction} without corrupting a position`, () => {
    const result = harness([{ action: 'open', side: 'buy', rationale: 'enter' },
      { action: 'close', fraction, rationale: 'invalid' }],
      [k(0, 100), k(1, 100, 99, 101), k(2, 110), k(3, 120)], { executionModel: 'maker-conservative' });
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].reason).toBe('end of history');
    expect(result.trades[0].quantity).toBe(10);
    expect(result.netPnl).toBeCloseTo((120 * (1 - 2 / 20000) - 100) * 10, 9);
  });
}

test('invalid TTL configuration is rejected', () => {
  const registry = new StrategyRegistry();
  registry.register(scriptedStrategy([]));
  expect(() => replayKlines({ registry, strategyId: 'scripted-v1', params: {}, klines: [k(0, 100), k(1, 101)],
    symbol: 'BTC', capital: 10000, feeBps: 0, notionalPerOrderUsd: 1000, source: 'test', executionModel: 'maker-conservative', limitTtlCandles: 0 }))
    .toThrow('limitTtlCandles');
});
