import { describe, expect, test } from 'bun:test';
import type { StrategyContext } from '../src/strategies/types';
import { validateParams } from '../src/strategies/types';
import { channelTrendResearchV1, completedResearchBars, pullbackContinuationResearchV1, researchStrategies, squeezeExpansionResearchV1, zscoreReversionResearchV1 } from '../src/strategies/research';

const NOW = Date.parse('2026-01-01T12:00:30.000Z');
function context(closes: number[], widths = closes.map(() => 0.02)): StrategyContext {
  const end = Math.floor(NOW / 60_000) * 60_000;
  const window = closes.flatMap((close, i) => Array.from({ length: 60 }, (_, second) => ({
    time: new Date(end - (closes.length - i) * 60_000 + second * 1000).toISOString(),
    mid: second === 59 ? close : close + (second % 2 ? widths[i] : -widths[i])
  })));
  return { symbol: 'TEST', now: new Date(NOW).toISOString(), window, book: {
    bids: [{ price: closes.at(-1)! - 0.001, quantity: 1 }], asks: [{ price: closes.at(-1)! + 0.001, quantity: 1 }], time: new Date(NOW).toISOString()
  }, position: null, stats: null, trades: [], equityUsd: 1000, params: {} };
}
const cases = [
  { strategy: channelTrendResearchV1, closes: [100, 100.1, 100, 100.1, 100, 102], side: 'buy', params: { lookbackMinutes: 5 } },
  { strategy: zscoreReversionResearchV1, closes: [100, 100.1, 100, 100.1, 100, 102], side: 'sell', params: { lookbackMinutes: 5 } },
  { strategy: pullbackContinuationResearchV1, closes: [100, 100.2, 100.4, 100.6, 100.8, 100.9, 102], side: 'buy', params: { lookbackMinutes: 5, fastMinutes: 2 } },
  { strategy: squeezeExpansionResearchV1, closes: [100, 100.1, 100, 100.1, 100, 100, 100, 102], widths: [0.5, 0.5, 0.5, 0.5, 0.5, 0.05, 0.05, 0.2], side: 'buy', params: { lookbackMinutes: 5, squeezeMinutes: 2 } }
] as const;
function signalContext(item: typeof cases[number], invert = false) {
  const ctx = context(item.closes.map(x => invert ? 200 - x : x), 'widths' in item ? [...item.widths] : undefined);
  ctx.params = validateParams(item.strategy, { ...item.params, maxVolPct: 0.05 });
  return ctx;
}
function freezeDeep(value: unknown): void {
  if (value && typeof value === 'object') { Object.values(value).forEach(freezeDeep); Object.freeze(value); }
}
describe('research-only deterministic completed-minute strategies', () => {
  for (const item of cases) {
    const { strategy } = item;
    test(`${strategy.id}: mirrored long/short signals with frozen context`, () => {
      for (const invert of [false, true]) {
        const ctx = signalContext(item, invert); freezeDeep(ctx);
        const result = strategy.evaluate(ctx);
        expect(result.action).toBe('open');
        if (result.action === 'open') expect(result.side).toBe(invert ? (item.side === 'buy' ? 'sell' : 'buy') : item.side);
        expect(strategy.evaluate(ctx)).toEqual(result);
        expect(strategy.researchOnly).toBe(true);
        expect(strategy.artifactSources).toContain('src/strategies/research.ts');
      }
    });
    test(`${strategy.id}: protective stops and targets precede warmup, spread and volatility filters`, () => {
      for (const quantity of [1, -1]) for (const target of [false, true]) {
        const ctx = signalContext(item);
        ctx.window = []; ctx.params.minVolPct = 0.01; ctx.params.maxVolPct = 0.001;
        ctx.position = { quantity, average: 100, leverage: 1, unrealized: null };
        const price = quantity > 0 ? (target ? 103 : 97) : (target ? 97 : 103);
        ctx.book!.bids[0].price = price - 0.1; ctx.book!.asks[0].price = price + 0.1;
        const result = strategy.evaluate(ctx);
        expect(result).toEqual({ action: 'close', fraction: 1, rationale: target ? 'Protective target' : 'Protective stop' });
      }
    });
    test(`${strategy.id}: invalid quotes hold even for a stop; stale/future quotes reject`, () => {
      for (const kind of ['nan', 'infinity', 'crossed', 'stale', 'future', 'missing-time']) {
        const ctx = signalContext(item); ctx.position = { quantity: 1, average: 200, leverage: 1, unrealized: null };
        if (kind === 'nan') ctx.book!.bids[0].price = NaN;
        if (kind === 'infinity') ctx.book!.asks[0].price = Infinity;
        if (kind === 'crossed') ctx.book!.bids[0].price = 1000;
        if (kind === 'stale') ctx.book!.time = new Date(NOW - 10_001).toISOString();
        if (kind === 'future') ctx.book!.time = new Date(NOW + 1).toISOString();
        if (kind === 'missing-time') ctx.book!.time = null;
        expect(strategy.evaluate(ctx).action).toBe('hold');
      }
    });
    test(`${strategy.id}: spread filter suppresses entries, never adds to position`, () => {
      const ctx = signalContext(item); ctx.book!.bids[0].price -= 1; ctx.book!.asks[0].price += 1;
      expect(strategy.evaluate(ctx)).toEqual({ action: 'hold', rationale: 'Entry spread filter' });
      const holding = signalContext(item); holding.position = { quantity: 1, average: holding.book!.bids[0].price, leverage: 1, unrealized: null };
      expect(strategy.evaluate(holding).action).toBe('hold');
    });
    test(`${strategy.id}: stale, future, malformed and gappy histories cannot signal`, () => {
      for (const kind of ['stale', 'future', 'gap', 'nan', 'unordered', 'oversized']) {
        const ctx = signalContext(item);
        if (kind === 'stale') ctx.window = ctx.window.map(s => ({ ...s, time: new Date(Date.parse(s.time) - 120_000).toISOString() }));
        if (kind === 'future') ctx.window.push({ time: new Date(NOW + 1000).toISOString(), mid: 100 });
        if (kind === 'gap') ctx.window.splice(ctx.window.length - 30, 15);
        if (kind === 'nan') ctx.window[0].mid = NaN;
        if (kind === 'unordered') ctx.window.reverse();
        if (kind === 'oversized') ctx.window = Array.from({ length: 3601 }, () => ctx.window[0]);
        expect(strategy.evaluate(ctx).action).toBe('hold');
      }
    });
    test(`${strategy.id}: flat / short history holds, schema validates normal bounded params`, () => {
      const flat = context(Array(50).fill(100)); flat.params = validateParams(strategy, {});
      expect(strategy.evaluate(flat).action).toBe('hold');
      flat.window = flat.window.slice(-120); expect(strategy.evaluate(flat).action).toBe('hold');
      for (const spec of strategy.params) {
        expect(Number.isFinite(spec.default)).toBe(true);
        for (const invalid of [NaN, Infinity, spec.min - 1, spec.max + 1, ...(spec.integer ? [spec.min + 0.5] : [])])
          expect(() => validateParams(strategy, { [spec.key]: invalid })).toThrow();
      }
      expect(() => validateParams(strategy, { unknown: 1 })).toThrow();
      const invalid = signalContext(item); invalid.params.stopPct = NaN;
      expect(strategy.evaluate(invalid).action).toBe('hold');
    });
  }
  test('bars strictly exclude current minute, retain no future points, and need elapsed coverage not count', () => {
    const ctx = context([100, 101, 102, 103, 104, 105]);
    const original = completedResearchBars(ctx);
    ctx.window.push({ time: new Date(NOW).toISOString(), mid: 1_000_000 });
    expect(completedResearchBars(ctx)).toEqual(original);
    ctx.window.push({ time: new Date(NOW + 1).toISOString(), mid: 1 });
    expect(completedResearchBars(ctx).error).toMatch(/future/);
    const burst = context([100]);
    const start = Date.parse(burst.window[0].time);
    burst.window = Array.from({ length: 60 }, (_, i) => ({ time: new Date(start + i).toISOString(), mid: 100 + i }));
    expect(completedResearchBars(burst).bars).toHaveLength(0);
  });
  test('current-minute samples and trade quantities cannot influence directional features', () => {
    for (const item of cases) {
      const ctx = signalContext(item), original = item.strategy.evaluate(ctx);
      ctx.window.push({ time: new Date(NOW).toISOString(), mid: 1_000_000 });
      // Strategies do not consume trades or infer volume from mid samples.
      ctx.trades = [{ quantity: Infinity, price: NaN } as unknown as StrategyContext['trades'][number]];
      expect(item.strategy.evaluate(ctx)).toEqual(original);
      ctx.position = { quantity: 1, average: 200, leverage: 1, unrealized: null };
      ctx.window.push({ time: new Date(NOW + 1).toISOString(), mid: NaN });
      expect(item.strategy.evaluate(ctx)).toEqual({ action: 'close', fraction: 1, rationale: 'Protective stop' });
    }
  });
  test('full 3600 sample one-hour context accepted; old samples do not fill recent missing minutes', () => {
    const ctx = context(Array.from({ length: 60 }, (_, i) => 100 + i / 100));
    expect(ctx.window).toHaveLength(3600);
    expect(completedResearchBars(ctx).bars).toHaveLength(59); // oldest minute crosses rolling 1h cutoff
    ctx.window = ctx.window.slice(0, -60);
    expect(completedResearchBars(ctx).bars).toHaveLength(0);
  });
  test('strategy-specific trend, degenerate range, invalid relationship and volatility gates', () => {
    const trend = context([100, 101, 102, 103, 104, 106]);
    trend.params = validateParams(zscoreReversionResearchV1, { lookbackMinutes: 5, maxVolPct: 0.05 });
    expect(zscoreReversionResearchV1.evaluate(trend).rationale).toMatch(/trend too strong/);
    const pullback = signalContext(cases[2]); pullback.params.fastMinutes = 5;
    expect(pullbackContinuationResearchV1.evaluate(pullback).action).toBe('hold');
    const flat = context([100, 100, 100, 100, 100, 100, 100, 102], Array(8).fill(0));
    flat.params = validateParams(squeezeExpansionResearchV1, { lookbackMinutes: 5, squeezeMinutes: 2, maxVolPct: 0.05 });
    expect(squeezeExpansionResearchV1.evaluate(flat).rationale).toMatch(/nondegenerate/);
    for (const item of cases) {
      const ctx = signalContext(item); ctx.params.maxVolPct = 0.0001;
      expect(item.strategy.evaluate(ctx).rationale).toMatch(/volatility/);
    }
    expect(researchStrategies).toHaveLength(4);
  });
});
