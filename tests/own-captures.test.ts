import { test, expect } from 'bun:test';
import { captureMidSamples, barsFromMidSamples, toKlines, marketIdFor, type CaptureObject } from '../src/own-captures';

const MIN = 60 * 1000;
const T0 = Date.parse('2026-11-01T00:00:00Z');
const frame = (t: number, raw: object) => ({ clock: { wall: t }, raw: JSON.stringify(raw) });
const statsFrame = (t: number, mid: number, marketId = 1) => frame(t, { channel: `market_stats:${marketId}`, market_stats: { mid_price: String(mid) } });
const bookFrame = (t: number, bid: number, ask: number, marketId = 1) =>
  frame(t, { channel: `order_book:${marketId}`, order_book: { bids: [{ price: String(bid), size: '1' }], asks: [{ price: String(ask), size: '1' }] } });

const capture = (frames: object[]): CaptureObject => ({
  manifest: { markets: [{ symbol: 'BTC', market_id: 1 }, { symbol: 'ETH', market_id: 2 }], startedMs: T0 },
  frames: frames as any,
});

test('market_stats mid_price is preferred and samples sort by time', () => {
  const samples = captureMidSamples(capture([statsFrame(T0 + 2000, 100), statsFrame(T0 + 1000, 99), bookFrame(T0 + 3000, 98, 98.2)]), 1);
  expect(samples).toHaveLength(3);
  expect(samples.map(s => s.t)).toEqual([T0 + 1000, T0 + 2000, T0 + 3000]);
  expect(samples[2].mid).toBeCloseTo(98.1, 10); // order_book fallback: midpoint of best quotes
});

test('markets are separated by id and crossed/garbage frames are skipped, never guessed', () => {
  const frames = [
    statsFrame(T0 + 1000, 100, 1),
    statsFrame(T0 + 1000, 50, 2),      // ETH market: different id
    statsFrame(T0 + 2000, -1, 1),      // negative mid: skipped
    bookFrame(T0 + 3000, 105, 104, 1), // crossed book: skipped
    frame(T0 + 4000, { channel: 'order_book:1' }), // malformed book: skipped
    frame(T0 + 5000, { channel: 'trade:1' }),      // irrelevant channel
  ];
  const btc = captureMidSamples(capture(frames), 1);
  expect(btc).toHaveLength(1);
  expect(btc[0].mid).toBe(100);
  const eth = captureMidSamples(capture(frames), 2);
  expect(eth).toHaveLength(1);
  expect(eth[0].mid).toBe(50);
});

test('bars bucket correctly: open from the first sample, close from the last, high/low across', () => {
  const samples = [
    { t: T0 + 1000, mid: 100 }, { t: T0 + 2000, mid: 102 }, { t: T0 + 30000, mid: 99 },
    { t: T0 + 61000, mid: 105 }, // next bucket
  ];
  const klines = toKlines(barsFromMidSamples(samples, MIN));
  expect(klines).toHaveLength(2);
  expect(klines[0]).toMatchObject({ openTime: T0, open: 100, high: 102, low: 99, close: 99, volume: 0 });
  expect(klines[1]).toMatchObject({ openTime: T0 + MIN, open: 105, close: 105 });
});

test('merging a second capture refreshes close but never resets open, and volume stays 0', () => {
  const bars = barsFromMidSamples([{ t: T0 + 1000, mid: 100 }, { t: T0 + 2000, mid: 103 }], MIN);
  barsFromMidSamples([{ t: T0 + 5000, mid: 101 }], MIN, bars); // rolling re-capture over the same bucket
  expect(bars.get(T0)).toMatchObject({ open: 100, high: 103, low: 100, close: 101, volume: 0, samples: 3 });
  const klines = toKlines(bars);
  expect(klines).toHaveLength(1);
  expect(klines[0]).toMatchObject({ open: 100, high: 103, low: 100, close: 101, volume: 0 });
});

test('bucket size is validated and the manifest resolver is exact', () => {
  expect(() => barsFromMidSamples([], 500)).toThrow('bucket');
  const c = capture([]);
  expect(marketIdFor(c, 'BTC')).toBe(1);
  expect(marketIdFor(c, 'SOL')).toBeNull();
});
