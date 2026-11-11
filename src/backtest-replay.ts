import { LighterBook, type StreamMarket, type BookClock } from './lighter-book';
import { dollars, floorDiv, fundingPayment } from './paper-ledger';
import { units } from './paper-math';
import { validateFundingHistory, type FundingHistoryInput, type FundingCoverage } from './replay-funding';
import { parseStats } from './lighter-stats';
import { parseTrades, type PublicTrade } from './lighter-trades';
import type { ReplayCapture } from './lighter-evidence';
import type { StrategyRegistry } from './strategies/registry';
import { validateParams, midPrice, type StrategyContext, type StrategyProposal } from './strategies/types';

export type ReplayFrame = { wall: number; mono: number; raw: string };
export type ReplayTrade = { entryTime: string; exitTime: string; side: 'long' | 'short'; entry: number; exit: number; quantity: number; pnl: number; reason: string; fundingUsd: number };
export const REPLAY_SIMULATOR_VERSION = 'replay-v4-explicit-hourly-funding';
export type ReplayResult = {
  kind: 'recorded-feed-replay'; strategyId: string; params: Record<string, number>; symbol: string; frames: number;
  trades: ReplayTrade[]; equity: number[]; netPnl: number; maxDrawdown: number; winRate: number; profitFactor: number | null;
  feesUsd: number; fundingUsd: number; fundingSamples: number; fundingIneligible: boolean;
  fundingCoverage: FundingCoverage;
  fundingEvents: { timestamp: number; time: string; positionAtoms: string; paymentMicros: string; valuePerUnit: string; direction: 'long' | 'short' }[];
  equityTimeline: { time: string; value: number; kind: 'frame' | 'funding' }[];
  execution: { delayMs: number; depthLevels: number; worstPriceBps: number; partials: number; rejects: number };
  warnings: string[]; config: { capital: number; asset: 'crypto'; lookback: number; stopPct: number; riskPct: number; feeBps: number; slippageBps: number };
};

export function framesFromCapture(capture: ReplayCapture): ReplayFrame[] {
  return capture.frames.map(f => ({ wall: f.clock.wall, mono: f.clock.mono, raw: f.raw }));
}

const MAX_FRAMES = 2000;

/** Deterministic strategy replay over validated recorded Lighter frames.
 *
 *  Execution model (v4, causal arrival-time + depth):
 *  - Proposals are evaluated on book frame i (the decision) and CANNOT fill before
 *    decisionMono + executionDelayMs — the monotonic simulated order-arrival time (default
 *    300 ms, the published Standard-tier taker latency). Fills happen on the first
 *    book frame at or after arrival.
 * - Fills walk the requested depth levels, consume displayed size, and accept
 *    partial fills (IOC remainder cancelled). A worst-acceptable-price guard in bps
 *    clips levels beyond the guard, also producing partials.
 *  - Explicit complete public hourly history drives discrete funding before same-time fills.
 *    Recorded stats remain strategy signals only; missing history means unknown funding.
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
  fundingHistory?: FundingHistoryInput;
}): ReplayResult {
  const { registry, strategyId, market, frames, staleMs, marketStats } = input;
  const minBaseAmount = Number((market as any).min_base_amount ?? 0);
  const strategy = registry.get(strategyId);
  const params = validateParams(strategy, input.params ?? {});
  const fundingDependent = strategy.fundingDependent === true;
  const executionDelayMs = input.executionDelayMs ?? 300;
  const maxDepthLevels = input.maxDepthLevels ?? 5;
  const worstPriceBps = input.worstPriceBps ?? 10;
  if (!Number.isInteger(maxDepthLevels) || maxDepthLevels < 1 || maxDepthLevels > 5000) throw new Error('Invalid maxDepthLevels (1..5000)');
  if (!Number.isInteger(executionDelayMs) || executionDelayMs < 0 || executionDelayMs > 60000) throw new Error('Invalid executionDelayMs (0..60000)');
  if (!Number.isInteger(worstPriceBps) || worstPriceBps < 0 || worstPriceBps > 1000) throw new Error('Invalid worstPriceBps (0..1000)');
  if (!Number.isFinite(input.capital) || input.capital < 100 || input.capital > 1e8) throw new Error('Invalid replay capital');
  if (!Number.isInteger(input.feeBps) || input.feeBps < 0 || input.feeBps > 100) throw new Error('Invalid replay feeBps');
  if (!Number.isInteger(input.leverage) || input.leverage < 1 || input.leverage > 20) throw new Error('Invalid replay leverage');
  if (!Number.isFinite(input.notionalPerOrderUsd) || input.notionalPerOrderUsd < 10 || input.notionalPerOrderUsd > input.capital) throw new Error('Invalid notionalPerOrderUsd');
  if (!Array.isArray(frames) || !frames.length || frames.length > MAX_FRAMES) throw new Error(`Replay needs 1–${MAX_FRAMES} recorded frames`);
  for (const f of frames) if (typeof f?.raw !== 'string' || !f.raw.length || f.raw.length > 524288 || !Number.isFinite(f.wall) || !Number.isFinite(f.mono) || f.mono < 0) throw new Error('Invalid replay frame');

  for (let i = 1; i < frames.length; i++) if (frames[i].wall < frames[i - 1].wall || frames[i].mono < frames[i - 1].mono) throw new Error('Replay frames must be in receive order');
  const funding = validateFundingHistory(input.fundingHistory, market, frames[0].wall / 1000, frames.at(-1)!.wall / 1000);
  const fundingEvents: ReplayResult['fundingEvents'] = [], equityTimeline: ReplayResult['equityTimeline'] = [];
  let fundingCursor = 0, fundingMicros = 0n;
  const book = new LighterBook(market, staleMs);
  const batch: PublicTrade[] = [];
  let lastWall = -Infinity, lastMono = -Infinity, nonce: number | undefined;
  let position: { quantity: number; basis: number; side: 'long' | 'short'; entryTime: string; entryFees: number; fundingMicros: bigint } | null = null;
  let cash = input.capital, peak = cash, maxDrawdown = 0, feesUsd = 0, fundingUsd = 0, rejectedFrames = 0, partials = 0, rejects = 0;
  const closed: ReplayTrade[] = [], equity: number[] = [], window: { time: string; mid: number }[] = [];
  type PendingOrder = { proposal: Exclude<StrategyProposal, { action: 'hold' }>; decisionMono: number; reference: number; quantity: number };
  let pending: PendingOrder | null = null;
  const sizeScale = 10 ** market.supported_size_decimals;
  const roundSize = (quantity: number) => Math.floor(Number((quantity * sizeScale).toFixed(8))) / sizeScale;
  // Counterfactual consumption persists until the recording explicitly updates a level.
  const consumed = { buy: new Map<number, number>(), sell: new Map<number, number>() };
  let consumptionNonce: number | null = null;
  let stats: { mark: number; index: number; fundingRate: number | null; last: number | null } | null = null;
  let fundingSamples = 0;
  let lastTop: { bid: number; ask: number; time: string } | null = null;
  const warnings = [
    'Recorded public-data replay on a bounded capture prefix; not a venue-certified or execution-realistic result.',
    `Arrival-time execution: fills no earlier than decision + ${executionDelayMs} ms (simulated order arrival), depth-walked up to ${maxDepthLevels} level(s) with size consumption, partial IOC fills, and a ${worstPriceBps} bps worst-price guard. Recorded depth is public: the counterfactual book after your own orders is unknowable.`,
    'Funding uses explicit hourly public-history events and exact 8-decimal atoms/micro-dollar model accounting, before same-time fills. No history means unknown funding excluded as zero cash, not evidence of zero. Complete history establishes model coverage only: no independent venue corroboration, onchain finality, venue validation or live approval is asserted.',
    'No account risk limits, halts or liquidation modeling; strategies see only this capture window.',
    'In-sample replay: no walk-forward, holdout or statistical validation.'
  ];

  const context = (view: { bids: { price: number; quantity: number }[]; asks: { price: number; quantity: number }[] }, time: string): StrategyContext => ({
    symbol: market.symbol, book: { ...view, time }, stats: stats ? { ...stats } : null, trades: batch.slice(-100),
    window: window.slice(), params,
    position: position ? { quantity: (position.side === 'long' ? 1 : -1) * position.quantity, average: position.basis / Math.abs(position.quantity), leverage: input.leverage, unrealized: null } : null,
    equityUsd: currentEquity(), now: time
  });
  const currentEquity = () => {
    // Keep cumulative funding in integer micros until reporting, avoiding repeated float cash drift.
    let value = cash + fundingUsd;
    if (position && lastTop) {
      const mid = (lastTop.bid + lastTop.ask) / 2, signed = position.side === 'long' ? 1 : -1;
      value += signed * (mid - position.basis / position.quantity) * position.quantity;
    }
    return value;
  };
  const markEquity = (time: string, kind: 'frame' | 'funding' = 'frame') => {
    const value = currentEquity();
    equity.push(value);
    peak = Math.max(peak, value);
    maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - value) / peak : 0);
    equityTimeline.push({ time, value, kind });
  };
  const closeAt = (price: number, quantity: number, time: string, reason: string) => {
    if (!position || quantity <= 0) return;
    const signed = position.side === 'long' ? 1 : -1, avg = position.basis / position.quantity;
    const fee = price * quantity * input.feeBps / 10000;
    const entryFee = position.entryFees * quantity / position.quantity;
    const heldAtoms = units(position.quantity.toFixed(8), 8), closeAtoms = units(quantity.toFixed(8), 8);
    const closingFunding = closeAtoms === heldAtoms ? position.fundingMicros : floorDiv(position.fundingMicros * closeAtoms, heldAtoms);
    position.fundingMicros -= closingFunding;
    feesUsd += fee;
    cash += signed * (price - avg) * quantity - fee;
    closed.push({ entryTime: position.entryTime, exitTime: time, side: position.side, entry: avg, exit: price, quantity, pnl: signed * (price - avg) * quantity - fee - entryFee + dollars(closingFunding), fundingUsd: dollars(closingFunding), reason });
    position.basis = avg * Number((position.quantity - quantity).toFixed(8));
    position.entryFees -= entryFee;
    position.quantity = Number((position.quantity - quantity).toFixed(8));
    if (position.quantity <= 0) position = null;
  };
  /** Arrival-time depth-walk IOC fill: consume displayed size level by level within the
   *  worst-price guard; returns the filled quantity and average price (0 = reject). */
  const walkFill = (side: 'buy' | 'sell', view: { bids: { price: number; quantity: number }[]; asks: { price: number; quantity: number }[] }, quantity: number, reference: number): { quantity: number; price: number } => {
    const levels = side === 'buy' ? view.asks.slice(0, maxDepthLevels) : view.bids.slice(0, maxDepthLevels);
    if (!levels.length) return { quantity: 0, price: 0 };
    const guard = reference * (1 + (side === 'buy' ? 1 : -1) * worstPriceBps / 10000);
    let remaining = quantity, filledQty = 0, cost = 0;
    const takes: { price: number; quantity: number }[] = [];
    for (const level of levels) {
      const priced = side === 'buy' ? level.price <= guard : level.price >= guard;
      if (!priced) break;
      const take = roundSize(Math.min(Math.max(0, level.quantity - (consumed[side].get(level.price) ?? 0)), remaining));
      if (take <= 0) continue;
      takes.push({ price: level.price, quantity: take });
      cost += take * level.price;
      filledQty += take;
      remaining = Number((remaining - take).toFixed(10));
      if (remaining <= 0) break;
    }
    if (filledQty <= 0 || filledQty < minBaseAmount) return { quantity: 0, price: 0 };
    for (const take of takes) consumed[side].set(take.price, (consumed[side].get(take.price) ?? 0) + take.quantity);
    const price = cost / filledQty;
    if (filledQty < quantity) partials++;
    return { quantity: filledQty, price };
  };

  // Merge history into receive-time replay. Even hours without frames settle, using the
  // last causal book mark and inventory held immediately before the boundary.
  const settleThrough = (wall: number) => {
    while (fundingCursor < funding.rows.length && funding.rows[fundingCursor].timestamp * 1000 <= wall) {
      const row = funding.rows[fundingCursor++];
      const held = position ? units(position.quantity.toFixed(8), 8) * (position.side === 'long' ? 1n : -1n) : 0n;
      const payment = fundingPayment(held, row.value, row.direction);
      fundingMicros += payment;
      fundingUsd = dollars(fundingMicros);
      if (position) position.fundingMicros += payment;
      fundingSamples++;
      const time = new Date(row.timestamp * 1000).toISOString();
      fundingEvents.push({ timestamp: row.timestamp, time, positionAtoms: held.toString(), paymentMicros: payment.toString(), valuePerUnit: row.value, direction: row.direction });
      markEquity(time, 'funding');
    }
  };

  for (const frame of frames) {
    if (frame.wall < lastWall || frame.mono < lastMono) throw new Error('Replay frames must be in receive order');
    lastWall = frame.wall; lastMono = frame.mono;
    settleThrough(frame.wall);
    const clock: BookClock = { wall: frame.wall, mono: frame.mono };
    let parsed: any;
    try { parsed = JSON.parse(frame.raw); } catch { throw new Error('Invalid recorded frame JSON'); }
    const match = /^(order_book|market_stats|trade):(\d+)$/.exec(parsed?.channel ?? ''), channelId = match ? Number(match[2]) : -1;
    if (channelId !== market.market_id) continue;
    const time = new Date(frame.wall).toISOString();
    try {
      if (['subscribed/order_book', 'update/order_book'].includes(parsed.type)) {
        if (lastTop && frame.wall - Date.parse(lastTop.time) > staleMs) {
          if (pending) { pending = null; rejects++; }
          window.length = 0;
          warnings.push('Recorded book gap exceeded freshness budget: pending order cancelled and feature warmup reset; existing position remains exposed.');
        }
        book.apply(parsed, clock);
        if (parsed.type === 'subscribed/order_book') { consumed.buy.clear(); consumed.sell.clear(); }
        // Repeated same-nonce messages carry no new liquidity.
        if (parsed.order_book.nonce !== consumptionNonce) {
          for (const row of parsed.order_book.asks) consumed.buy.delete(Number(row.price));
          for (const row of parsed.order_book.bids) consumed.sell.delete(Number(row.price));
        }
        consumptionNonce = parsed.order_book.nonce;
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
        // A queued IOC is immutable: later signals cannot reset its arrival clock,
        // requested size or decision-price guard. Even zero delay needs a later frame.
        if (pending && frame.mono >= pending.decisionMono + executionDelayMs) {
          const order: PendingOrder = pending; pending = null;
          const proposal: PendingOrder['proposal'] = order.proposal;
          if (proposal.action === 'close' && position) {
            const fill = walkFill(position.side === 'long' ? 'sell' : 'buy', view, Math.min(order.quantity, position.quantity), order.reference);
            if (fill.quantity > 0 && fill.quantity >= minBaseAmount) closeAt(fill.price, fill.quantity, time, proposal.rationale.slice(0, 120));
            else rejects++;
          } else if (proposal.action === 'open' && !position) {
            const fill = walkFill(proposal.side, view, order.quantity, order.reference);
            if (fill.quantity > 0 && fill.quantity >= minBaseAmount) {
              const fee = fill.price * fill.quantity * input.feeBps / 10000;
              feesUsd += fee; cash -= fee;
              position = { quantity: fill.quantity, basis: fill.price * fill.quantity, side: proposal.side === 'buy' ? 'long' : 'short', entryTime: time, entryFees: fee, fundingMicros: 0n };
            } else rejects++;
          } else rejects++;
        }
        if (!pending) {
          try {
            const proposal = strategy.evaluate(context(view, time));
            if (proposal.action === 'open' || proposal.action === 'close') {
              const valid = typeof proposal.rationale === 'string' && (proposal.action === 'open'
                ? !position && (proposal.side === 'buy' || proposal.side === 'sell')
                : !!position && Number.isFinite(proposal.fraction) && proposal.fraction > 0 && proposal.fraction <= 1);
              if (!valid) rejects++;
              else {
                const side: 'buy' | 'sell' = proposal.action === 'open' ? proposal.side : position!.side === 'long' ? 'sell' : 'buy';
                const reference: number = side === 'buy' ? view.asks[0].price : view.bids[0].price;
                const quantity = roundSize(proposal.action === 'open' ? input.notionalPerOrderUsd / reference : position!.quantity * proposal.fraction);
                if (quantity <= 0 || quantity < minBaseAmount) rejects++;
                else pending = { proposal, decisionMono: frame.mono, reference, quantity };
              }
            }
          } catch { rejects++; }
        }
        markEquity(time);
      } else if (marketStats && ['subscribed/market_stats', 'update/market_stats'].includes(parsed.type)) {
        stats = parseStats(parsed, market, clock, staleMs);
        // Current/next rate is a strategy signal, never settlement cash.
        markEquity(time);
      } else if (['subscribed/trade', 'update/trade'].includes(parsed.type)) {
        const result = parseTrades(parsed, market, clock, nonce);
        nonce = result.nonce;
        batch.push(...result.trades);
        if (batch.length > 500) batch.splice(0, batch.length - 500);
      }
    } catch {
      rejectedFrames++;
      // A feed discontinuity invalidates orders decided on the pre-fault state.
      if (pending) { pending = null; rejects++; }
    }
  }
  if (pending) { rejects++; warnings.push('One pending IOC was cancelled at the end of the capture before an eligible fill.'); }
  if (position) warnings.push('End-of-capture position remains open: final equity/net PnL include midpoint-marked unrealized PnL, not a synthetic liquidation; exit fees and executable liquidation depth are unknown.');
  const fundingIneligible = fundingDependent;
  if (fundingIneligible) warnings.push('Funding-dependent strategy marked INELIGIBLE for promotion regardless of sample count: complete public history establishes simulator economics only, not independent venue corroboration or live approval.');

  const wins = closed.filter(t => t.pnl > 0).length;
  const winSum = closed.reduce((s, t) => s + Math.max(t.pnl, 0), 0), lossSum = closed.reduce((s, t) => s + Math.max(-t.pnl, 0), 0);
  if (rejectedFrames) warnings.push(`${rejectedFrames} recorded frames were invalid and skipped, matching live fail-closed handling.`);
  return {
    kind: 'recorded-feed-replay', strategyId, params: input.params, symbol: market.symbol, frames: frames.length,
    trades: closed, equity, netPnl: currentEquity() - input.capital, maxDrawdown, winRate: closed.length ? wins / closed.length : 0,
    profitFactor: lossSum ? winSum / lossSum : null, feesUsd, fundingUsd, fundingSamples, fundingIneligible, fundingCoverage: funding.coverage, fundingEvents, equityTimeline,
    execution: { delayMs: executionDelayMs, depthLevels: maxDepthLevels, worstPriceBps, partials, rejects },
    warnings,
    config: { capital: input.capital, asset: 'crypto', lookback: 0, stopPct: params.stopPct ?? 0, riskPct: 0, feeBps: input.feeBps, slippageBps: 0 }
  };
}
