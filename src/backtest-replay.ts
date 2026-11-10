import { LighterBook, type StreamMarket, type BookClock } from './lighter-book';
import { parseStats } from './lighter-stats';
import { parseTrades, type PublicTrade } from './lighter-trades';
import type { ReplayCapture } from './lighter-evidence';
import type { StrategyRegistry } from './strategies/registry';
import { validateParams, midPrice, type StrategyContext, type StrategyProposal } from './strategies/types';

export type ReplayFrame = { wall: number; mono: number; raw: string };
export type ReplayTrade = { entryTime: string; exitTime: string; side: 'long' | 'short'; entry: number; exit: number; quantity: number; pnl: number; reason: string };
export const REPLAY_SIMULATOR_VERSION = 'replay-v2-arrival-depth-funding';
export type ReplayResult = {
  kind: 'recorded-feed-replay'; strategyId: string; params: Record<string, number>; symbol: string; frames: number;
  trades: ReplayTrade[]; equity: number[]; netPnl: number; maxDrawdown: number; winRate: number; profitFactor: number | null;
  feesUsd: number; fundingUsd: number; fundingSamples: number; fundingIneligible: boolean;
  execution: { delayMs: number; depthLevels: number; worstPriceBps: number; partials: number; rejects: number };
  warnings: string[]; config: { capital: number; asset: 'crypto'; lookback: number; stopPct: number; riskPct: number; feeBps: number; slippageBps: number };
};

export function framesFromCapture(capture: ReplayCapture): ReplayFrame[] {
  return capture.frames.map(f => ({ wall: f.clock.wall, mono: f.clock.mono, raw: f.raw }));
}

const MAX_FRAMES = 2000;

/** Deterministic strategy replay over validated recorded Lighter frames.
 *
 *  Execution model (v2, arrival-time + depth):
 *  - Proposals are evaluated on book frame i (the decision) and CANNOT fill before
 *    decisionWall + executionDelayMs — the simulated order-arrival time (default
 *    300 ms, the published Standard-tier taker latency). Fills happen on the first
 *    book frame at or after arrival.
 * - Fills walk the requested depth levels, consume displayed size, and accept
 *    partial fills (IOC remainder cancelled). A worst-acceptable-price guard in bps
 *    clips levels beyond the guard, also producing partials.
 *  - Funding: market_stats frames carry the venue funding rate; an open position
 *    accrues positionNotional x rate x elapsed-hours per stats frame (positive rate:
 *    longs pay, shorts receive). A funding-dependent strategy (fundingDependent flag)
 *    over a capture with ZERO funding samples is marked fundingIneligible — missing
 *    funding is never treated as zero funding.
 *  Recorded captures are bounded prefixes: evidence replay, not execution-quality proof. */
export function replayStrategy(input: {
  registry: StrategyRegistry;
  strategyId: string; params: Record<string, number>;
  market: StreamMarket;
  frames: ReplayFrame[];
  staleMs: number; marketStats: boolean;
  capital: number; feeBps: number; leverage: number; notionalPerOrderUsd: number;
  executionDelayMs?: number; maxDepthLevels?: number; worstPriceBps?: number;
  captureId?: string | null;
}): ReplayResult {
  const { registry, strategyId, market, frames, staleMs, marketStats } = input;
  const minBaseAmount = Number((market as any).min_base_amount ?? 0);
  const strategy = registry.get(strategyId);
  const params = validateParams(strategy, input.params ?? {});
  const fundingDependent = strategy.fundingDependent === true;
  const executionDelayMs = input.executionDelayMs ?? 300;
  const maxDepthLevels = Math.max(1, Math.trunc(input.maxDepthLevels ?? 5));
  const worstPriceBps = Math.max(0, input.worstPriceBps ?? 10);
  if (!Number.isInteger(executionDelayMs) || executionDelayMs < 0 || executionDelayMs > 60000) throw new Error('Invalid executionDelayMs (0..60000)');
  if (!Number.isInteger(worstPriceBps) || worstPriceBps < 0 || worstPriceBps > 1000) throw new Error('Invalid worstPriceBps (0..1000)');
  if (!Number.isFinite(input.capital) || input.capital < 100 || input.capital > 1e8) throw new Error('Invalid replay capital');
  if (!Number.isInteger(input.feeBps) || input.feeBps < 0 || input.feeBps > 100) throw new Error('Invalid replay feeBps');
  if (!Number.isInteger(input.leverage) || input.leverage < 1 || input.leverage > 20) throw new Error('Invalid replay leverage');
  if (!Number.isFinite(input.notionalPerOrderUsd) || input.notionalPerOrderUsd < 10 || input.notionalPerOrderUsd > input.capital) throw new Error('Invalid notionalPerOrderUsd');
  if (!Array.isArray(frames) || !frames.length || frames.length > MAX_FRAMES) throw new Error(`Replay needs 1–${MAX_FRAMES} recorded frames`);
  for (const f of frames) if (typeof f?.raw !== 'string' || !f.raw.length || f.raw.length > 524288 || !Number.isFinite(f.wall) || !Number.isFinite(f.mono) || f.mono < 0) throw new Error('Invalid replay frame');

  const book = new LighterBook(market, staleMs);
  const batch: PublicTrade[] = [];
  let lastWall = -Infinity, lastMono = -Infinity, nonce: number | undefined;
  let position: { quantity: number; basis: number; side: 'long' | 'short'; entryTime: string; openWall: number } | null = null;
  let cash = input.capital, peak = cash, maxDrawdown = 0, feesUsd = 0, fundingUsd = 0, rejectedFrames = 0, partials = 0;
  const closed: ReplayTrade[] = [], equity: number[] = [], window: { time: string; mid: number }[] = [];
  let pending: (StrategyProposal & { decisionWall: number }) | null = null;
  let stats: { mark: number; index: number; fundingRate: number | null; last: number | null } | null = null;
  let lastFundingWall: number | null = null, fundingSamples = 0;
  let lastTop: { bid: number; ask: number; time: string } | null = null;
  const warnings = [
    'Recorded public-data replay on a bounded capture prefix; not a venue-certified or execution-realistic result.',
    `Arrival-time execution: fills no earlier than decision + ${executionDelayMs} ms (simulated order arrival), depth-walked up to ${maxDepthLevels} level(s) with size consumption, partial IOC fills, and a ${worstPriceBps} bps worst-price guard. Recorded depth is public: the counterfactual book after your own orders is unknowable.`,
    `Funding: open positions accrue the recorded market_stats funding rate position-weighted per stats frame (positive rate: longs pay). Missing funding data never counts as zero funding${fundingDependent ? ' — this strategy is funding-DEPENDENT and is marked ineligible without funding samples' : ''}.`,
    'No account risk limits, halts or liquidation modeling; strategies see only this capture window.',
    'In-sample replay: no walk-forward, holdout or statistical validation.'
  ];

  const context = (view: { bids: { price: number; quantity: number }[]; asks: { price: number; quantity: number }[] }, time: string): StrategyContext => ({
    symbol: market.symbol, book: { ...view, time }, stats: stats ? { ...stats } : null, trades: batch.slice(-100),
    window: window.slice(), params,
    position: position ? { quantity: position.quantity, average: position.basis / Math.abs(position.quantity), leverage: input.leverage, unrealized: null } : null,
    equityUsd: equity.at(-1) ?? input.capital, now: time
  });
  const markEquity = (time: string) => {
    let value = cash;
    if (position && lastTop) {
      const mid = (lastTop.bid + lastTop.ask) / 2, signed = position.side === 'long' ? 1 : -1;
      value += signed * (mid - position.basis / position.quantity) * position.quantity;
    }
    equity.push(value);
    peak = Math.max(peak, value);
    maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - value) / peak : 0);
    void time;
  };
  const closeAt = (price: number, quantity: number, time: string, reason: string) => {
    if (!position || quantity <= 0) return;
    const signed = position.side === 'long' ? 1 : -1, avg = position.basis / position.quantity;
    const fee = price * quantity * input.feeBps / 10000;
    feesUsd += fee;
    cash += signed * (price - avg) * quantity - fee;
    closed.push({ entryTime: position.entryTime, exitTime: time, side: position.side, entry: avg, exit: price, quantity, pnl: signed * (price - avg) * quantity - fee, reason });
    position.quantity = Number((position.quantity - quantity).toFixed(8));
    if (position.quantity <= 0) position = null;
  };
  /** Arrival-time depth-walk IOC fill: consume displayed size level by level within the
   *  worst-price guard; returns the filled quantity and average price (0 = reject). */
  const walkFill = (side: 'buy' | 'sell', view: { bids: { price: number; quantity: number }[]; asks: { price: number; quantity: number }[] }, quantity: number): { quantity: number; price: number } => {
    const levels = side === 'buy' ? view.asks.slice(0, maxDepthLevels) : view.bids.slice(0, maxDepthLevels);
    if (!levels.length) return { quantity: 0, price: 0 };
    const guard = side === 'buy' ? levels[0].price * (1 + worstPriceBps / 10000) : levels[0].price * (1 - worstPriceBps / 10000);
    let remaining = quantity, filledQty = 0, cost = 0;
    for (const level of levels) {
      const priced = side === 'buy' ? level.price <= guard : level.price >= guard;
      if (!priced) break;
      const take = Math.min(level.quantity, remaining);
      if (take <= 0) continue;
      cost += take * level.price;
      filledQty += take;
      remaining = Number((remaining - take).toFixed(10));
      if (remaining <= 0) break;
    }
    if (filledQty <= 0) return { quantity: 0, price: 0 };
    const price = cost / filledQty;
    if (filledQty < quantity) partials++;
    return { quantity: filledQty, price };
  };

  for (const frame of frames) {
    if (frame.wall < lastWall || frame.mono < lastMono) throw new Error('Replay frames must be in receive order');
    lastWall = frame.wall; lastMono = frame.mono;
    const clock: BookClock = { wall: frame.wall, mono: frame.mono };
    let parsed: any;
    try { parsed = JSON.parse(frame.raw); } catch { throw new Error('Invalid recorded frame JSON'); }
    const match = /^(order_book|market_stats|trade):(\d+)$/.exec(parsed?.channel ?? ''), channelId = match ? Number(match[2]) : -1;
    if (channelId !== market.market_id) continue;
    const time = new Date(frame.wall).toISOString();
    try {
      if (['subscribed/order_book', 'update/order_book'].includes(parsed.type)) {
        book.apply(parsed, clock);
        const view = book.view(clock, maxDepthLevels);
        if (!view.bids.length || !view.asks.length) continue;
        lastTop = { bid: view.bids[0].price, ask: view.asks[0].price, time };
        const mid = midPrice({ bids: view.bids, asks: view.asks, time });
        if (mid !== null) {
          const last = window.at(-1);
          if (!last || frame.wall - Date.parse(last.time) >= 1000) {
            window.push({ time, mid });
            if (window.length > 3600) window.shift();
          }
        }
        // Execute the queued proposal only once the simulated order has ARRIVED:
        // fills are eligible from decisionWall + executionDelayMs onward.
        if (pending && frame.wall >= pending.decisionWall + executionDelayMs && !book.view(clock, 1).reason) {
          const proposal = pending; pending = null;
          if (proposal.action === 'close' && position) {
            const fraction = proposal.fraction;
            if (Number.isFinite(fraction) && fraction > 0 && fraction <= 1) {
              const wanted = Math.floor(Math.abs(position.quantity) * fraction * 10 ** market.supported_size_decimals) / 10 ** market.supported_size_decimals;
              const fill = walkFill(position.side === 'long' ? 'sell' : 'buy', view, wanted);
              const quantity = Math.floor(fill.quantity * 10 ** market.supported_size_decimals) / 10 ** market.supported_size_decimals;
              if (quantity >= minBaseAmount) closeAt(fill.price, quantity, time, proposal.rationale.slice(0, 120));
            }
          } else if (proposal.action === 'open' && !position) {
            const wanted = Math.floor(input.notionalPerOrderUsd / view.asks[0].price * 10 ** market.supported_size_decimals) / 10 ** market.supported_size_decimals;
            const fill = walkFill(proposal.side, view, wanted);
            const quantity = Math.floor(fill.quantity * 10 ** market.supported_size_decimals) / 10 ** market.supported_size_decimals;
            if (quantity >= minBaseAmount) {
              const fee = fill.price * quantity * input.feeBps / 10000;
              feesUsd += fee; cash -= fee;
              position = { quantity, basis: fill.price * quantity, side: proposal.side === 'buy' ? 'long' : 'short', entryTime: time, openWall: frame.wall };
            }
          }
        }
        try { pending = { ...strategy.evaluate(context({ bids: view.bids.slice(0, maxDepthLevels), asks: view.asks.slice(0, maxDepthLevels) }, time)), decisionWall: frame.wall }; }
        catch { pending = null; }
        markEquity(time);
      } else if (marketStats && ['subscribed/market_stats', 'update/market_stats'].includes(parsed.type)) {
        stats = parseStats(parsed, market, clock, staleMs);
        if (stats.fundingRate !== null) {
          fundingSamples++;
          if (position && lastFundingWall !== null) {
            // Position-weighted accrual: notional at the current mark x rate x elapsed hours.
            // Positive rate: longs pay, shorts receive. Never prorated from before the
            // position existed or before the first funding observation.
            const since = Math.max(lastFundingWall, position.openWall);
            const hoursElapsed = (frame.wall - since) / 3600000;
            const notional = position.quantity * stats.mark;
            const payment = notional * stats.fundingRate * hoursElapsed;
            const signed = position.side === 'long' ? -1 : 1;
            fundingUsd += signed * payment;
            cash += signed * payment;
          }
          lastFundingWall = frame.wall;
        }
      } else if (['subscribed/trade', 'update/trade'].includes(parsed.type)) {
        const result = parseTrades(parsed, market, clock, nonce);
        nonce = result.nonce;
        batch.push(...result.trades);
        if (batch.length > 500) batch.splice(0, batch.length - 500);
      }
    } catch { rejectedFrames++; }
  }
  if (position && lastTop) closeAt(position.side === 'long' ? lastTop.bid : lastTop.ask, position.quantity, lastTop.time, 'end of capture');
  const fundingIneligible = fundingDependent && fundingSamples === 0;
  if (fundingIneligible) warnings.push('Funding-dependent strategy over a capture with ZERO funding samples: marked INELIGIBLE for promotion — missing funding is never treated as zero funding.');

  const wins = closed.filter(t => t.pnl > 0).length;
  const winSum = closed.reduce((s, t) => s + Math.max(t.pnl, 0), 0), lossSum = closed.reduce((s, t) => s + Math.max(-t.pnl, 0), 0);
  if (rejectedFrames) warnings.push(`${rejectedFrames} recorded frames were invalid and skipped, matching live fail-closed handling.`);
  return {
    kind: 'recorded-feed-replay', strategyId, params: input.params, symbol: market.symbol, frames: frames.length,
    trades: closed, equity, netPnl: cash - input.capital, maxDrawdown, winRate: closed.length ? wins / closed.length : 0,
    profitFactor: lossSum ? winSum / lossSum : null, feesUsd, fundingUsd, fundingSamples, fundingIneligible,
    execution: { delayMs: executionDelayMs, depthLevels: maxDepthLevels, worstPriceBps, partials, rejects: 0 },
    warnings,
    config: { capital: input.capital, asset: 'crypto', lookback: 0, stopPct: params.stopPct ?? 0, riskPct: 0, feeBps: input.feeBps, slippageBps: 0 }
  };
}
