import { test, expect } from 'bun:test';
import { StrategyRegistry, artifactHash } from '../src/strategies/registry';
import { breakoutV1, meanReversionV1, fundingCarryV1 } from '../src/strategies/builtin';
import { validateParams, midPrice, type StrategyContext } from '../src/strategies/types';

const registry = () => { const r = new StrategyRegistry(); for (const s of [breakoutV1, meanReversionV1, fundingCarryV1]) r.register(s); return r; };
const book = (bid: number, ask: number) => ({ bids: [{ price: bid, quantity: 10 }], asks: [{ price: ask, quantity: 10 }], time: '2026-10-27T10:00:00Z' });

const ctx = (overrides: any = {}) => ({
  symbol: 'BTC', book: book(100, 100.2), stats: { mark: 100.1, index: 100, fundingRate: 0.001, last: 100 },
  trades: [], window: [], position: null, equityUsd: 10000,
  params: { lookbackSeconds: 900, stopPct: 0.006, takeProfitPct: 0.012, windowSeconds: 600, entryZ: 2.5, exitZ: 0.5, entryFundingPct: 0.005, exitFundingPct: 0.0015 },
  now: '2026-10-27T10:00:00Z', ...overrides
} as StrategyContext);

test('registry validates ids, rejects duplicates and freezes artifact hashes', () => {
  const r = registry();
  expect(r.list().map(s => s.id)).toEqual(['breakout-v1', 'mean-reversion-v1', 'funding-carry-v1']);
  expect(r.get('breakout-v1').name).toBeTruthy();
  expect(() => r.get('nope')).toThrow('Unknown strategy');
  expect(() => r.get('Bad_ID')).toThrow('Invalid strategy id');
  expect(() => { r.register(breakoutV1); }).toThrow('Duplicate');
  const hash = artifactHash(breakoutV1);
  expect(hash).toHaveLength(64);
  expect(artifactHash({ ...breakoutV1, description: 'changed' })).not.toBe(hash);
});

test('parameter validation is bounded and never invents values', () => {
  expect(validateParams(breakoutV1, {}).lookbackSeconds).toBe(900);
  expect(validateParams(breakoutV1, { lookbackSeconds: 60 })).toEqual({ lookbackSeconds: 60, stopPct: 0.006, takeProfitPct: 0.012 });
  for (const bad of [{ lookbackSeconds: 10 }, { stopPct: 1 }, { nope: 1 }, { lookbackSeconds: 90.5 }] as Record<string, number>[])
    expect(() => validateParams(breakoutV1, bad)).toThrow();
});

test('breakout enters beyond the prior channel and exits on opposite break, stop and target', () => {
  const window = (mids: number[]) => mids.map((m, i) => ({ time: new Date(Date.parse('2026-10-27T10:00:00Z') + i * 1000).toISOString(), mid: m }));
  const flat = window(Array.from({ length: 40 }, () => 100.1));
  const s = { ...breakoutV1 } as any;
  expect(s.evaluate(ctx({ window: flat.slice(0, 29) })).action).toBe('hold');
  expect(s.evaluate(ctx({ window: flat })).action).toBe('hold');
  expect(s.evaluate(ctx({ window: flat, book: book(101.5, 101.7) }))).toMatchObject({ action: 'open', side: 'buy' });
  expect(s.evaluate(ctx({ window: flat, book: book(98, 98.2) }))).toMatchObject({ action: 'open', side: 'sell' });
  const long = { quantity: 0.5, average: 101.6, leverage: 2, unrealized: null };
  expect(s.evaluate(ctx({ window: flat, book: book(101.5, 101.7), position: long })).action).toBe('hold');
  expect(s.evaluate(ctx({ window: flat, book: book(103, 103.2), position: long }))).toMatchObject({ action: 'close', rationale: expect.stringContaining('Take profit') });
  expect(s.evaluate(ctx({ window: flat, book: book(99.9, 100.1), position: { ...long, average: 100.4 } }))).toMatchObject({ action: 'close', rationale: expect.stringContaining('channel break') });
  expect(s.evaluate(ctx({ window: flat, book: book(97, 97.2), position: long }))).toMatchObject({ action: 'close', rationale: expect.stringContaining('stop') });
  expect(s.evaluate(ctx({ window: flat, book: book(101, 101.2), position: long })).action).toBe('hold');
});

test('mean reversion fades stretched z-scores and exits on normalization', () => {
  const s = { ...meanReversionV1 } as any;
  const base = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 5) * 0.1);
  const window = base.map((m, i) => ({ time: new Date(Date.parse('2026-10-27T10:00:00Z') - (60 - i) * 1000).toISOString(), mid: m }));
  expect(s.evaluate(ctx({ window })).action).toBe('hold');
  expect(s.evaluate(ctx({ window, book: book(110, 110.2) }))).toMatchObject({ action: 'open', side: 'sell' });
  expect(s.evaluate(ctx({ window, book: book(90, 90.2) }))).toMatchObject({ action: 'open', side: 'buy' });
  const short = { quantity: -0.5, average: 110, leverage: 2, unrealized: null };
  expect(s.evaluate(ctx({ window, book: book(99.95, 100.05), position: short })).action).toBe('close');
  expect(s.evaluate(ctx({ window, book: book(115, 115.2), position: short }))).toMatchObject({ action: 'close', rationale: expect.stringContaining('stop') });
});

test('funding carry collects the paid side and exits on normalization', () => {
  const s = { ...fundingCarryV1 } as any;
  expect(s.evaluate(ctx({ stats: { mark: 100, index: 100, fundingRate: 0.01, last: 100 } }))).toMatchObject({ action: 'open', side: 'sell' });
  expect(s.evaluate(ctx({ stats: { mark: 100, index: 100, fundingRate: -0.01, last: 100 } }))).toMatchObject({ action: 'open', side: 'buy' });
  expect(s.evaluate(ctx({ stats: { mark: 100, index: 100, fundingRate: 0.001, last: 100 } })).action).toBe('hold');
  expect(s.evaluate(ctx({ stats: null })).rationale).toContain('funding');
  const short = { quantity: -0.5, average: 100, leverage: 2, unrealized: null };
  expect(s.evaluate(ctx({ stats: { mark: 100, index: 100, fundingRate: 0.01, last: 100 }, position: short })).action).toBe('hold');
  expect(s.evaluate(ctx({ stats: { mark: 100, index: 100, fundingRate: -0.001, last: 100 }, position: short })).action).toBe('close');
  expect(s.evaluate(ctx({ stats: { mark: 100, index: 100, fundingRate: 0.01, last: 100 }, position: short, book: book(106, 106.2) }))).toMatchObject({ action: 'close', rationale: expect.stringContaining('stop') });
});

test('mid price rejects crossed or empty books', () => {
  expect(midPrice(book(100, 100.2))).toBe(100.1);
  expect(midPrice(null)).toBe(null);
  expect(midPrice({ bids: [], asks: [], time: null })).toBe(null);
  expect(midPrice(book(100.5, 100.2))).toBe(null);
});
