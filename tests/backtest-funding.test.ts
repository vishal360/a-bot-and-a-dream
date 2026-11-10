import { test, expect } from 'bun:test';
import { replayStrategy } from '../src/backtest-replay';
import { StrategyRegistry } from '../src/strategies/registry';
import { fundingCarryV1 } from '../src/strategies/builtin';

const market = { symbol: 'BTC', market_id: 0, supported_price_decimals: 2, supported_size_decimals: 4 };
const BASE = Date.parse('2026-10-27T00:00:00Z');
const snapFrame = (offsetMs: number, nonce: number, price: number) => JSON.stringify({
  type: 'subscribed/order_book', channel: 'order_book:0', timestamp: BASE + offsetMs,
  order_book: { code: 200, nonce, bids: [{ price: price.toFixed(2), size: '50.0000' }], asks: [{ price: (price + 0.2).toFixed(2), size: '50.0000' }] }
});
const bookFrame = (offsetMs: number, nonce: number, price: number) => JSON.stringify({
  type: 'update/order_book', channel: 'order_book:0', timestamp: BASE + offsetMs,
  order_book: { code: 200, nonce, begin_nonce: nonce - 1, bids: [{ price: price.toFixed(2), size: '50.0000' }], asks: [{ price: (price + 0.2).toFixed(2), size: '50.0000' }] }
});
const statsFrame = (offsetMs: number, rate: string) => JSON.stringify({
  type: 'update/market_stats', channel: 'market_stats:0', timestamp: BASE + offsetMs,
  market_stats: { market_id: 0, symbol: 'BTC', index_price: '100.00', mark_price: '100.00', last_trade_price: '100.00',
    current_funding_rate: rate, funding_rate: rate, funding_timestamp: BASE + offsetMs }
});
const runner = (overrides: any = {}) => {
  const registry = new StrategyRegistry();
  registry.register({ ...fundingCarryV1, evaluate: () => ({ action: 'open', side: 'sell', rationale: 'short to collect positive funding' }) });
  return replayStrategy({
    registry, strategyId: 'funding-carry-v1', params: { entryFundingPct: 0.0005, exitFundingPct: 0.0001, stopPct: 0.03 },
    market, frames: [], staleMs: 5000, marketStats: true, capital: 10000, feeBps: 0, leverage: 1, notionalPerOrderUsd: 1000, ...overrides,
  });
};

test('funding accrues position-weighted per stats frame: shorts RECEIVE positive funding', () => {
  const frames: any[] = [{ wall: BASE, mono: 0, raw: snapFrame(0, 1, 100) }];
  frames.push({ wall: BASE + 1000, mono: 1000, raw: statsFrame(1000, '0.01') });   // starts the accrual clock
  frames.push({ wall: BASE + 2000, mono: 2000, raw: bookFrame(2000, 2, 100) });    // arrival: short opens
  frames.push({ wall: BASE + 3600000, mono: 3600000, raw: statsFrame(3600000, '0.01') }); // ~1h later
  const result = runner({ frames, executionDelayMs: 300 });
  expect(result.trades).toHaveLength(1); // closed at end of capture
  expect(result.trades[0].side).toBe('short');
  expect(result.fundingSamples).toBe(2);
  // Short ~1000 notional for ~1h at 1% hourly funding: receives ~10 USD (prorated from open).
  expect(result.fundingUsd).toBeGreaterThan(5);
  expect(result.fundingUsd).toBeLessThan(11);
  // netPnl = fundingUsd minus the spread paid on entry (ask 100.2 -> exit bid 100.0).
  expect(Math.abs(result.netPnl - (result.fundingUsd - 1.996))).toBeLessThan(0.05);
  expect(result.fundingIneligible).toBe(false);
});

test('a funding-DEPENDENT strategy over zero funding samples is marked ineligible', () => {
  const frames: any[] = [{ wall: BASE, mono: 0, raw: snapFrame(0, 1, 100) }];
  frames.push({ wall: BASE + 1000, mono: 1000, raw: bookFrame(1000, 2, 100) });
  const result = runner({ frames, executionDelayMs: 300 });
  expect(result.fundingSamples).toBe(0);
  expect(result.fundingIneligible).toBe(true);
  expect(result.warnings.some(w => w.includes('INELIGIBLE'))).toBe(true);
});

test('long positions PAY positive funding (signed accrual)', () => {
  const frames: any[] = [{ wall: BASE, mono: 0, raw: snapFrame(0, 1, 100) }];
  frames.push({ wall: BASE + 1000, mono: 1000, raw: statsFrame(1000, '0.02') });
  frames.push({ wall: BASE + 2000, mono: 2000, raw: bookFrame(2000, 2, 100) });   // arrival: long opens
  frames.push({ wall: BASE + 3600000, mono: 3600000, raw: statsFrame(3600000, '0.02') });
  const registry = new StrategyRegistry();
  registry.register({ ...fundingCarryV1, evaluate: () => ({ action: 'open', side: 'buy', rationale: 'forced long' }) });
  const result = replayStrategy({
    registry, strategyId: 'funding-carry-v1', params: { entryFundingPct: 0.0005, exitFundingPct: 0.0001, stopPct: 0.03 },
    market, frames, staleMs: 5000, marketStats: true, capital: 10000, feeBps: 0, leverage: 1, notionalPerOrderUsd: 1000, executionDelayMs: 300,
  });
  expect(result.trades).toHaveLength(1);
  expect(result.trades[0].side).toBe('long');
  expect(result.fundingUsd).toBeLessThan(-5); // long PAYS: negative funding P&L
  // netPnl = fundingUsd minus the spread paid on entry (ask 100.2 -> exit bid 100.0).
  expect(Math.abs(result.netPnl - (result.fundingUsd - 1.996))).toBeLessThan(0.05);
});
