import type { PublicTrade } from '../lighter-trades';

/** Strategies are deterministic direction proposals. They never size orders, touch
 *  the executor or see credentials: the fleet runner sizes, risk-checks and journals
 *  every proposal. IOC market orders only; no resting limits. */
export type StrategyBook = { bids: { price: number; quantity: number }[]; asks: { price: number; quantity: number }[]; time: string | null };
export type StrategyStats = { mark: number | null; index: number | null; fundingRate: number | null; last: number | null };
export type StrategyPosition = { quantity: number; average: number; leverage: number; unrealized: number | null };

export type StrategyContext = {
  symbol: string;
  book: StrategyBook | null;
  stats: StrategyStats | null;
  trades: PublicTrade[];
  /** One-second mid-price samples for this market, oldest first. */
  window: { time: string; mid: number }[];
  position: StrategyPosition | null;
  equityUsd: number | null;
  params: Record<string, number>;
  now: string;
};

export type StrategyProposal =
  | { action: 'hold'; rationale: string }
  | { action: 'open'; side: 'buy' | 'sell'; rationale: string }
  | { action: 'close'; fraction: number; rationale: string };

export type ParamSpec = { key: string; label: string; min: number; max: number; default: number; integer?: boolean }[];

export interface Strategy {
  id: string;
  name: string;
  description: string;
  params: ParamSpec;
  evaluate(ctx: StrategyContext): StrategyProposal;
}

export function validateParams(strategy: Strategy, params: Record<string, number>): Record<string, number> {
  const resolved: Record<string, number> = {};
  const extra = Object.keys(params).filter(k => !strategy.params.some(p => p.key === k));
  if (extra.length) throw new Error(`Unknown ${strategy.id} parameters: ${extra.join(', ')}`);
  for (const spec of strategy.params) {
    const value = params[spec.key] ?? spec.default;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < spec.min || value > spec.max || (spec.integer && !Number.isInteger(value)))
      throw new Error(`Invalid ${strategy.id}.${spec.key}: expected ${spec.min}–${spec.max}${spec.integer ? ' (whole number)' : ''}`);
    resolved[spec.key] = value;
  }
  return resolved;
}

/** Shared numeric helpers. All read only the validated context. */
export function midPrice(book: StrategyBook | null): number | null {
  if (!book || !book.bids.length || !book.asks.length) return null;
  const bid = book.bids[0].price, ask = book.asks[0].price;
  return bid > 0 && ask > 0 && ask >= bid ? (bid + ask) / 2 : null;
}
export function windowSlice(ctx: StrategyContext, seconds: number) {
  const cutoff = Date.parse(ctx.now) - seconds * 1000;
  return ctx.window.filter(s => Date.parse(s.time) >= cutoff);
}
export function mean(values: number[]) { return values.length ? values.reduce((s, v) => s + v, 0) / values.length : null; }
export function stdev(values: number[]) {
  if (values.length < 2) return null;
  const m = mean(values)!;
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1));
}
export function highest(values: number[]) { return values.length ? Math.max(...values) : null; }
export function lowest(values: number[]) { return values.length ? Math.min(...values) : null; }
