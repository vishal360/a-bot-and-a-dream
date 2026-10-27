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

test('replay fills on the bar after the signal and books the round trip', () => {
  const result = run(captureFrames());
  expect(result.kind).toBe('recorded-feed-replay');
  expect(result.trades).toHaveLength(1);
  const trade = result.trades[0];
  // The breakout signal appears at mid 102.1; the fill must wait for the NEXT book and cross the spread.
  expect(trade.side).toBe('long');
  expect(trade.entry).toBe(102.2);
  expect(trade.exit).toBe(97);
  expect(trade.reason).toContain('stop');
  expect(trade.quantity).toBe(Math.floor(1000 / 102.2 * 10000) / 10000);
  const expectedFees = (102.2 * trade.quantity + 97 * trade.quantity) * 2 / 10000;
  expect(result.feesUsd).toBeCloseTo(expectedFees, 8);
  expect(result.netPnl).toBeCloseTo((97 - 102.2) * trade.quantity - expectedFees, 8);
  expect(result.winRate).toBe(0);
  expect(result.maxDrawdown).toBeGreaterThan(0);
  expect(result.equity.length).toBeGreaterThan(40);
  expect(result.warnings.some(w => w.includes('bounded capture prefix'))).toBe(true);
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
  expect(() => run([], {})).toThrow('1–2000');
  const reordered = [...frames.slice().reverse()];
  expect(() => run(reordered)).toThrow('receive order');
  const bad = frames.map((f, i) => i === 3 ? { ...f, raw: f.raw.replace('order_book', 'bogus_frame') } : f);
  // Unknown channels for the target market are skipped, not fatal.
  expect(run(bad).frames).toBe(frames.length);
});

test('framesFromCapture maps capture records for replay', () => {
  const frames = framesFromCapture({ manifest: {} as any, frames: [{ sequence: 1, clock: { wall: 5, mono: 0.5 }, raw: 'x' }], sha256: 'h' });
  expect(frames).toEqual([{ wall: 5, mono: 0.5, raw: 'x' }]);
});
