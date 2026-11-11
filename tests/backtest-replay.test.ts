import { test, expect } from 'bun:test';
import { replayStrategy, framesFromCapture } from '../src/backtest-replay';
import { StrategyRegistry } from '../src/strategies/registry';
import { breakoutV1 } from '../src/strategies/builtin';

const market = { symbol: 'BTC', market_id: 0, supported_price_decimals: 2, supported_size_decimals: 4 };
const BASE = Date.parse('2026-10-27T00:00:00Z');
// Updates carry delta semantics: moving the quote must cancel the previous level.
const bookFrame = (offsetMs: number, nonce: number, price: number, snapshot = false, prevPrice = 0) => JSON.stringify({
  type: snapshot ? 'subscribed/order_book' : 'update/order_book', channel: 'order_book:0', timestamp: BASE + offsetMs,
  order_book: { code: 200, nonce, ...(snapshot ? {} : { begin_nonce: nonce - 1 }),
    bids: snapshot ? [{ price: price.toFixed(2), size: '5.0000' }]
      : [...(prevPrice && prevPrice !== price ? [{ price: prevPrice.toFixed(2), size: '0.0000' }] : []), { price: price.toFixed(2), size: '5.0000' }],
    asks: snapshot ? [{ price: (price + 0.2).toFixed(2), size: '5.0000' }]
      : [...(prevPrice && prevPrice !== price ? [{ price: (prevPrice + 0.2).toFixed(2), size: '0.0000' }] : []), { price: (price + 0.2).toFixed(2), size: '5.0000' }] }
});

function captureFrames() {
  const frames = [{ wall: BASE, mono: 0, raw: bookFrame(0, 1, 100, true) }];
  let nonce = 2, price = 100;
  for (let i = 1; i <= 40; i++) frames.push({ wall: BASE + i * 1000, mono: i * 1000, raw: bookFrame(i * 1000, nonce++, 100, false, price) });
  for (const target of [102, 102, 102, 102, 97, 97, 97, 97, 97, 97, 97, 97]) {
    const i = nonce - 1;
    frames.push({ wall: BASE + i * 1000, mono: i * 1000, raw: bookFrame(i * 1000, nonce, target, false, price) });
    price = target; nonce++;
  }
  return frames;
}

const run = (frames: any[], overrides: any = {}) => {
  const registry = new StrategyRegistry();
  registry.register(breakoutV1);
  return replayStrategy({ registry, strategyId: 'breakout-v1', params: { lookbackSeconds: 60, stopPct: 0.006, takeProfitPct: 0.012 },
    market, frames, staleMs: 5000, marketStats: false, capital: 10000, feeBps: 2, leverage: 2, notionalPerOrderUsd: 1000, ...overrides });
};

test('replay fills on the bar after the signal, consuming only DISPLAYED depth', () => {
  const result = run(captureFrames());
  expect(result.kind).toBe('recorded-feed-replay');
  expect(result.trades).toHaveLength(1);
  const trade = result.trades[0];
  // The breakout signal appears at mid 102.1; the fill waits for arrival (decision +
  // 300ms lands on the NEXT book update, 1000ms later) and crosses the spread.
  expect(trade.side).toBe('long');
  expect(trade.entry).toBe(102.2);
  expect(trade.exit).toBe(97);
  expect(trade.reason).toContain('stop');
  // The displayed ask only holds 5.0 units: the IOC consumes what EXISTS (5.0) and
  // cancels the remainder â€” unlimited top-of-book liquidity is a backtest fantasy.
  expect(trade.quantity).toBe(5);
  expect(result.execution.partials).toBeGreaterThanOrEqual(1);
  const expectedFees = (102.2 * trade.quantity + 97 * trade.quantity) * 2 / 10000;
  expect(result.feesUsd).toBeCloseTo(expectedFees, 8);
  expect(result.netPnl).toBeCloseTo((97 - 102.2) * trade.quantity - expectedFees, 8);
  expect(result.winRate).toBe(0);
  expect(result.maxDrawdown).toBeGreaterThan(0);
  expect(result.equity.length).toBeGreaterThan(40);
  expect(result.warnings.some(w => w.includes('bounded capture prefix'))).toBe(true);
  expect(result.warnings.some(w => w.includes('Arrival-time execution'))).toBe(true);
});

test('flat prices never trade and warmup windows are respected', () => {
  const frames = [{ wall: BASE, mono: 0, raw: bookFrame(0, 1, 100, true) }];
  for (let i = 1; i <= 60; i++) frames.push({ wall: BASE + i * 1000, mono: i * 1000, raw: bookFrame(i * 1000, i + 1, 100) });
  const result = run(frames);
  expect(result.trades).toHaveLength(0);
  expect(result.netPnl).toBe(0);
  expect(result.profitFactor).toBe(null);
});

test('replay validates inputs and frame ordering fail-closed', () => {
  const registry = new StrategyRegistry(); registry.register(breakoutV1);
  const frames = captureFrames();
  expect(() => run(frames, { capital: 50 })).toThrow('capital');
  expect(() => run(frames, { notionalPerOrderUsd: 20000 })).toThrow('notionalPerOrderUsd');
  expect(() => run(frames, { leverage: 25 })).toThrow('leverage');
  expect(() => run([], {})).toThrow('2000 recorded frames');
  const reordered = [...frames.slice().reverse()];
  expect(() => run(reordered)).toThrow('receive order');
  const bad = frames.map((f, i) => i === 3 ? { ...f, raw: f.raw.replace('order_book', 'bogus_frame') } : f);
  // Unknown channels for the target market are skipped, not fatal.
  expect(run(bad).frames).toBe(frames.length);
  expect(() => run(frames, { executionDelayMs: 70000 })).toThrow('executionDelayMs');
});

test('framesFromCapture maps capture records for replay', () => {
  const frames = framesFromCapture({ manifest: {} as any, frames: [{ sequence: 1, clock: { wall: 5, mono: 0.5 }, raw: 'x' }], sha256: 'h' });
  expect(frames).toEqual([{ wall: 5, mono: 0.5, raw: 'x' }]);
});
import type { Strategy, StrategyContext, StrategyProposal } from '../src/strategies/types';

function scripted(evaluate: (ctx: StrategyContext) => StrategyProposal, prices: number[], overrides: any = {}) {
  const registry = new StrategyRegistry();
  registry.register({ id: 'scripted', name: 'scripted', description: 'fixture', params: [], evaluate } satisfies Strategy);
  const frames = prices.map((price, i) => ({ wall: BASE + i * 100, mono: i * 100,
    raw: bookFrame(i * 100, i + 1, price, i === 0, prices[i - 1]) }));
  return replayStrategy({ registry, strategyId: 'scripted', params: {}, market, frames, staleMs: 5000,
    marketStats: false, capital: 10000, feeBps: 0, leverage: 1, notionalPerOrderUsd: 100,
    executionDelayMs: 100, worstPriceBps: 1000, ...overrides });
}
const hold = { action: 'hold', rationale: 'wait' } as const;

test('pending arrival is not overwritten by fast frames or a later hold', () => {
  const seen: StrategyContext[] = [];
  const result = scripted(ctx => {
    seen.push(ctx);
    return seen.length === 1 ? { action: 'open', side: 'buy', rationale: 'first decision' } : hold;
  }, [100, 100, 100, 100, 100], { executionDelayMs: 300 });
  expect(seen.map(ctx => Date.parse(ctx.now) - BASE)).toEqual([0, 300, 400]);
  expect(seen[1].position?.quantity).toBeCloseTo(0.998, 8);
  expect(result.feesUsd).toBe(0);
  expect(result.trades).toHaveLength(0);
  expect(result.warnings.some(w => w.includes('remains open'))).toBe(true);
});

test('valid but stale-separated book frames cannot fill an order across a data gap', () => {
  const frames = [0, 10000].map((offset, i) => ({ wall: BASE + offset, mono: offset,
    raw: bookFrame(offset, i + 1, 100, i === 0, 100) }));
  let calls = 0;
  const result = scripted(() => ++calls === 1 ? { action: 'open', side: 'buy', rationale: 'pre-gap' } : hold,
    [100, 100], { frames });
  expect(result.execution.rejects).toBe(1);
  expect(result.netPnl).toBe(0);
  expect(result.warnings.some(w => w.includes('gap exceeded freshness'))).toBe(true);
});

test('arrival guard is anchored to the decision quote and rejects adverse movement', () => {
  let calls = 0;
  const result = scripted(() => ++calls === 1 ? { action: 'open', side: 'buy', rationale: 'buy' } : hold,
    [100, 102, 102], { worstPriceBps: 10 });
  expect(result.execution.rejects).toBe(1);
  expect(result.netPnl).toBe(0);
  expect(result.trades).toHaveLength(0);
});

test('short contexts have negative quantity and use the decision bid for sizing', () => {
  const seen: StrategyContext[] = [];
  const result = scripted(ctx => {
    seen.push(ctx);
    if (!ctx.position && seen.length === 1) return { action: 'open', side: 'sell', rationale: 'short' };
    if (ctx.position && Date.parse(ctx.now) === BASE + 100) return { action: 'close', fraction: 1, rationale: 'cover' };
    return hold;
  }, [100, 100, 99]);
  expect(seen[1].position?.quantity).toBe(-1);
  expect(result.trades).toHaveLength(1);
  expect(result.trades[0].side).toBe('short');
  expect(result.trades[0].quantity).toBe(1);
  expect(result.netPnl).toBeCloseTo(0.8, 8);
  expect(result.equity.at(-1)).toBeCloseTo(10000.8, 8);
});

test('partial closes preserve average basis and allocate every entry and exit fee once', () => {
  const seen: StrategyContext[] = [];
  const result = scripted(ctx => {
    seen.push(ctx);
    const offset = Date.parse(ctx.now) - BASE;
    if (offset === 0) return { action: 'open', side: 'buy', rationale: 'entry' };
    if (offset === 100) return { action: 'close', fraction: 0.5, rationale: 'half' };
    if (offset === 200) return { action: 'close', fraction: 1, rationale: 'rest' };
    return hold;
  }, [99.8, 99.8, 110, 120], { feeBps: 10 });
  expect(seen[2].position?.quantity).toBe(0.5);
  expect(seen[2].position?.average).toBeCloseTo(100, 8);
  expect(result.trades.map(t => t.entry)).toEqual([100, 100]);
  expect(result.trades.map(t => t.quantity)).toEqual([0.5, 0.5]);
  expect(result.feesUsd).toBeCloseTo(0.215, 8);
  expect(result.netPnl).toBeCloseTo(14.785, 8);
  expect(result.trades.reduce((sum, trade) => sum + trade.pnl, 0)).toBeCloseTo(result.netPnl, 8);
  expect(result.equity.at(-1)).toBeCloseTo(10000 + result.netPnl, 8);
});

test('capture end neither fabricates liquidation nor misses open marked PnL', () => {
  const result = scripted(ctx => Date.parse(ctx.now) === BASE ? { action: 'open', side: 'buy', rationale: 'entry' } : hold,
    [99.8, 99.8, 109.8], { feeBps: 10 });
  expect(result.trades).toHaveLength(0);
  expect(result.feesUsd).toBeCloseTo(0.1, 8);
  expect(result.netPnl).toBeCloseTo(9.8, 8);
  expect(result.equity.at(-1)).toBeCloseTo(10009.8, 8);
  expect(result.equity).toHaveLength(3);
});

test('execution validation rejects invalid depth and negative price guards without coercion', () => {
  for (const maxDepthLevels of [0, -1, 1.5, NaN, Infinity, 5001])
    expect(() => run(captureFrames(), { maxDepthLevels })).toThrow('maxDepthLevels');
  expect(() => run(captureFrames(), { worstPriceBps: -1 })).toThrow('worstPriceBps');
});

test('unarrived orders are cancelled with a rejection and no synthetic end fill', () => {
  const result = scripted(() => ({ action: 'open', side: 'buy', rationale: 'entry' }), [100, 100], { executionDelayMs: 300 });
  expect(result.execution.rejects).toBe(1);
  expect(result.netPnl).toBe(0);
  expect(result.trades).toHaveLength(0);
});

test('depth walks fill only guarded displayed size at size precision', () => {
  let calls = 0;
  const raw = JSON.parse(bookFrame(100, 2, 100));
  raw.order_book.asks = [{ price: '100.20', size: '0.2000' }, { price: '100.25', size: '0.3000' }, { price: '101.00', size: '9.0000' }];
  const frames = [{ wall: BASE, mono: 0, raw: bookFrame(0, 1, 100, true) },
    { wall: BASE + 100, mono: 100, raw: JSON.stringify(raw) }];
  const result = scripted(() => ++calls === 1 ? { action: 'open', side: 'buy', rationale: 'depth' } : hold,
    [], { frames, worstPriceBps: 10, feeBps: 10 });
  expect(result.execution.partials).toBe(1);
  expect(result.feesUsd).toBeCloseTo((100.2 * 0.2 + 100.25 * 0.3) * 0.001, 8);
  expect(result.netPnl).toBeCloseTo(100.1 * 0.5 - (100.2 * 0.2 + 100.25 * 0.3) - result.feesUsd, 8);
});

test('unchanged recorded levels cannot supply the same counterfactual liquidity twice', () => {
  const frames = [0, 100, 200, 300].map((offset, i) => {
    const raw = JSON.parse(bookFrame(offset, i + 1, 99.8, i === 0));
    if (i > 1) raw.order_book.asks = []; // entry ask has not replenished
    return { wall: BASE + offset, mono: offset, raw: JSON.stringify(raw) };
  });
  let calls = 0;
  const result = scripted(ctx => {
    calls++;
    if (calls === 1 || calls === 3) return { action: 'open', side: 'buy', rationale: 'entry' };
    if (ctx.position) return { action: 'close', fraction: 1, rationale: 'exit' };
    return hold;
  }, [], { frames, notionalPerOrderUsd: 500 });
  expect(result.trades).toHaveLength(1);
  expect(result.trades[0].quantity).toBe(5);
  expect(result.execution.rejects).toBe(1); // second buy has no remaining ask
});

test('wall clock jumps do not make an order arrive before monotonic delay', () => {
  let calls = 0;
  const frames = [{ wall: BASE, mono: 0, raw: bookFrame(0, 1, 100, true) },
    { wall: BASE + 1000, mono: 100, raw: bookFrame(1000, 2, 100) }];
  const result = scripted(() => ++calls === 1 ? { action: 'open', side: 'buy', rationale: 'entry' } : hold,
    [], { frames, executionDelayMs: 300, feeBps: 10 });
  expect(result.feesUsd).toBe(0);
  expect(result.execution.rejects).toBe(1);
});

test('zero simulated delay still cannot fill on its decision frame', () => {
  const result = scripted(() => ({ action: 'open', side: 'buy', rationale: 'entry' }), [100], { executionDelayMs: 0 });
  expect(result.feesUsd).toBe(0);
  expect(result.netPnl).toBe(0);
  expect(result.execution.rejects).toBe(1);
});

test('a sequence fault cancels pre-fault pending orders before snapshot recovery', () => {
  let calls = 0;
  const frames = [{ wall: BASE, mono: 0, raw: bookFrame(0, 1, 100, true) },
    { wall: BASE + 100, mono: 100, raw: bookFrame(100, 5, 100) }, // begin_nonce 4 is a gap
    { wall: BASE + 400, mono: 400, raw: bookFrame(400, 6, 100, true) }];
  const result = scripted(() => ++calls === 1 ? { action: 'open', side: 'buy', rationale: 'pre-gap' } : hold,
    [], { frames, executionDelayMs: 300, feeBps: 10 });
  expect(result.feesUsd).toBe(0);
  expect(result.netPnl).toBe(0);
  expect(result.execution.rejects).toBe(1);
  expect(result.warnings.some(w => w.includes('invalid and skipped'))).toBe(true);
});
