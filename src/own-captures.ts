import type { Kline } from './backtest-klines';

export type CaptureFrame = { sequence?: number; clock?: { wall?: number; mono?: number }; raw: string };
export type CaptureObject = { manifest?: { markets?: { symbol?: string; market_id?: number }[]; startedMs?: number }; frames?: CaptureFrame[] };

export type MidSample = { t: number; mid: number };

/** Extract mid-price samples for ONE market from a capture object. The venue-computed
 *  market_stats mid_price is preferred (it is the venue's own number); the top-of-book
 *  midpoint from order_book frames is the fallback. Non-finite or crossed books are
 *  skipped, never guessed into a price. */
export function captureMidSamples(capture: CaptureObject, marketId: number): MidSample[] {
  if (!capture || !Array.isArray(capture.frames)) return [];
  const out: MidSample[] = [];
  for (const frame of capture.frames) {
    const wall = Number(frame?.clock?.wall);
    if (!Number.isFinite(wall)) continue;
    let msg: any;
    try { msg = JSON.parse(frame.raw); } catch { continue; }
    const channel: string = typeof msg?.channel === 'string' ? msg.channel : '';
    let mid: number | null = null;
    if (channel === `market_stats:${marketId}`) {
      const value = Number(msg.market_stats?.mid_price);
      if (Number.isFinite(value) && value > 0) mid = value;
    } else if (channel === `order_book:${marketId}`) {
      const book = msg.order_book;
      const bestBid = Number(book?.bids?.[0]?.price), bestAsk = Number(book?.asks?.[0]?.price);
      if (Number.isFinite(bestBid) && Number.isFinite(bestAsk) && bestBid > 0 && bestAsk >= bestBid) mid = (bestBid + bestAsk) / 2;
    }
    if (mid !== null) out.push({ t: wall, mid });
  }
  return out.sort((a, b) => a.t - b.t);
}

export type RunningBar = { openTime: number; open: number; high: number; low: number; close: number; volume: number; closeTime: number; samples: number };

/** Merge mid samples into time buckets (Kline-shaped bars). Quote-derived bars carry
 *  volume 0 BY CONSTRUCTION - a book snapshot says nothing about traded volume, and
 *  inventing one would be dishonest; volume-aware strategies must not run on these. */
export function barsFromMidSamples(samples: MidSample[], bucketMs: number, into: Map<number, RunningBar> = new Map()): Map<number, RunningBar> {
  if (!Number.isInteger(bucketMs) || bucketMs < 1000) throw new Error('Invalid bar bucket size');
  for (const { t, mid } of samples) {
    if (!Number.isFinite(t) || !Number.isFinite(mid) || mid <= 0) continue;
    const bucket = Math.floor(t / bucketMs) * bucketMs;
    const bar = into.get(bucket);
    if (!bar) into.set(bucket, { openTime: bucket, open: mid, high: mid, low: mid, close: mid, volume: 0, closeTime: bucket + bucketMs - 1, samples: 1 });
    else {
      bar.high = Math.max(bar.high, mid);
      bar.low = Math.min(bar.low, mid);
      bar.close = mid;
      bar.samples++;
    }
  }
  return into;
}

/** One capture -> bars for one market. Convenience over the two primitives. */
export function captureBars(capture: CaptureObject, marketId: number, bucketMs: number, into?: Map<number, RunningBar>): Map<number, RunningBar> {
  return barsFromMidSamples(captureMidSamples(capture, marketId), bucketMs, into);
}

/** Finalize a bar map into an ascending Kline array (replay-ready). */
export function toKlines(bars: Map<number, RunningBar>): Kline[] {
  return [...bars.values()].sort((a, b) => a.openTime - b.openTime).map(b =>
    ({ openTime: b.openTime, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, closeTime: b.closeTime }));
}

/** Resolve the market id for a symbol from a capture manifest (null if absent). */
export function marketIdFor(capture: CaptureObject, symbol: string): number | null {
  for (const m of capture?.manifest?.markets ?? []) {
    if (m.symbol === symbol && typeof m.market_id === 'number') return m.market_id;
  }
  return null;
}
