import type { BookClock, StreamMarket } from './lighter-book';
import { units } from './paper-math';

export type MarketStats = { marketId: number; symbol: string; mark: number; index: number; last: number; fundingRate: number; fundingTimestamp: number; estimatedFundingRate: number; publicationTimeMs: number; receivedAt: string; receivedMono: number };
export function parseStats(frame: any, market: StreamMarket, clock: BookClock, staleMs: number): MarketStats {
  const s = frame?.market_stats;
  if (!['subscribed/market_stats', 'update/market_stats'].includes(frame?.type) || frame.channel !== `market_stats:${market.market_id}` || s?.market_id !== market.market_id || s.symbol !== market.symbol) throw new Error('Invalid market stats channel/identity');
  if (!Number.isSafeInteger(frame.timestamp) || frame.timestamp <= 0) throw new Error('Invalid market stats publication timestamp');
  const publicationAgeMs = clock.wall - frame.timestamp;
  if (publicationAgeMs > staleMs || publicationAgeMs < -2000) throw new Error(`Stale/future market stats: publication age ${publicationAgeMs}ms (allowed -2000..${staleMs}ms); check host clock synchronization`);
  const price = (v: unknown) => {
    if (typeof v !== 'string' || v.length > 40 || !/^\d+(\.\d+)?$/.test(v) || !Number.isFinite(Number(v)) || Number(v) <= 0 || Number(v) > 1e9) throw new Error('Invalid stats price');
    units(v, 8); // Must be exactly representable by integer valuation accounting.
    return Number(v);
  };
  const rate = (v: unknown) => {
    if (typeof v !== 'string' || v.length > 40 || !/^-?\d+(\.\d+)?$/.test(v) || !Number.isFinite(Number(v)) || Math.abs(Number(v)) > 100) throw new Error('Invalid funding rate');
    return Number(v);
  };
  // The documented market_stats funding timestamp and publication time are milliseconds.
  if (!Number.isSafeInteger(s.funding_timestamp) || s.funding_timestamp < 0 || s.funding_timestamp > clock.wall + 2000) throw new Error('Invalid funding timestamp');
  return { marketId: market.market_id, symbol: market.symbol, mark: price(s.mark_price), index: price(s.index_price), last: price(s.last_trade_price),
    fundingRate: rate(s.funding_rate), estimatedFundingRate: rate(s.current_funding_rate), fundingTimestamp: s.funding_timestamp,
    publicationTimeMs: frame.timestamp, receivedAt: new Date(clock.wall).toISOString(), receivedMono: clock.mono };
}