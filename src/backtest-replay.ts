import { LighterBook, type StreamMarket, type BookClock } from './lighter-book';
import { parseStats } from './lighter-stats';
import { parseTrades, type PublicTrade } from './lighter-trades';
import type { ReplayCapture } from './lighter-evidence';
import type { StrategyRegistry } from './strategies/registry';
import { validateParams, midPrice, type StrategyContext, type StrategyProposal } from './strategies/types';

export type ReplayFrame = { wall: number; mono: number; raw: string };
export type ReplayTrade = { entryTime: string; exitTime: string; side: 'long' | 'short'; entry: number; exit: number; quantity: number; pnl: number; reason: string };
export type ReplayResult = {
  kind: 'recorded-feed-replay'; strategyId: string; params: Record<string, number>; symbol: string; frames: number;
  trades: ReplayTrade[]; equity: number[]; netPnl: number; maxDrawdown: number; winRate: number; profitFactor: number | null;
  feesUsd: number; warnings: string[]; config: { capital: number; asset: 'crypto'; lookback: number; stopPct: number; riskPct: number; feeBps: number; slippageBps: number };
};

export function framesFromCapture(capture: ReplayCapture): ReplayFrame[] {
  return capture.frames.map(f => ({ wall: f.clock.wall, mono: f.clock.mono, raw: f.raw }));
}

const MAX_FRAMES = 2000;

/** Deterministic strategy replay over validated recorded Lighter frames. Proposals are
 *  evaluated on one book update and executed at the NEXT update's top of book, so no
 *  entry fills on its own signal bar. Top-of-book fills only; recorded captures are bounded
 *  prefixes, so this is evidence replay, not execution-quality proof. */
export function replayStrategy(input: {
  registry: StrategyRegistry;
  strategyId: string; params: Record<string, number>;
  market: StreamMarket;
  frames: ReplayFrame[];
  staleMs: number; marketStats: boolean;
  capital: number; feeBps: number; leverage: number; notionalPerOrderUsd: number;
  captureId?: string | null;
}): ReplayResult {
  const { registry, strategyId, market, frames, staleMs, marketStats } = input;
  // Capture manifests record the streaming watch tuple only; venue minimums apply when metadata is available.
  const minBaseAmount = Number((market as any).min_base_amount ?? 0);
  const strategy = registry.get(strategyId);
  const params = validateParams(strategy, input.params ?? {});
  if (!Number.isFinite(input.capital) || input.capital < 100 || input.capital > 1e8) throw new Error('Invalid replay capital');
  if (!Number.isInteger(input.feeBps) || input.feeBps < 0 || input.feeBps > 100) throw new Error('Invalid replay feeBps');
  if (!Number.isInteger(input.leverage) || input.leverage < 1 || input.leverage > 20) throw new Error('Invalid replay leverage');
  if (!Number.isFinite(input.notionalPerOrderUsd) || input.notionalPerOrderUsd < 10 || input.notionalPerOrderUsd > input.capital) throw new Error('Invalid notionalPerOrderUsd');
  if (!Array.isArray(frames) || !frames.length || frames.length > MAX_FRAMES) throw new Error(`Replay needs 1–${MAX_FRAMES} recorded frames`);
  for (const f of frames) if (typeof f?.raw !== 'string' || !f.raw.length || f.raw.length > 524288 || !Number.isFinite(f.wall) || !Number.isFinite(f.mono) || f.mono < 0) throw new Error('Invalid replay frame');

  const book = new LighterBook(market, staleMs);
  const batch: PublicTrade[] = [];
  let lastWall = -Infinity, lastMono = -Infinity, nonce: number | undefined;
  let position: { quantity: number; basis: number; side: 'long' | 'short'; entryTime: string } | null = null;
  let cash = input.capital, peak = cash, maxDrawdown = 0, feesUsd = 0, rejectedFrames = 0;
  const closed: ReplayTrade[] = [], equity: number[] = [], window: { time: string; mid: number }[] = [];
  let pending: StrategyProposal | null = null;
  let stats: { mark: number; index: number; fundingRate: number | null; last: number | null } | null = null;
  let lastTop: { bid: number; ask: number; time: string } | null = null;
  const warnings = [
    'Recorded public-data replay on a bounded capture prefix; not a venue-certified or execution-realistic result.',
    'Top-of-book market-IOC fills with modeled fees only: no depth walk, partial liquidity, queue position or funding.',
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
        const view = book.view(clock, 1);
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
        // Execute the proposal queued on the previous book update at today's top of book.
        if (pending && !book.view(clock, 1).reason) {
          const proposal = pending; pending = null;
          if (proposal.action === 'close' && position) {
            const fraction = proposal.fraction;
            if (Number.isFinite(fraction) && fraction > 0 && fraction <= 1) {
              const quantity = Math.floor(Math.abs(position.quantity) * fraction * 10 ** market.supported_size_decimals) / 10 ** market.supported_size_decimals;
              if (quantity >= minBaseAmount) closeAt(position.side === 'long' ? lastTop.bid : lastTop.ask, quantity, time, proposal.rationale.slice(0, 120));
            }
          } else if (proposal.action === 'open' && !position) {
            const price = proposal.side === 'buy' ? lastTop.ask : lastTop.bid;
            const quantity = Math.floor(input.notionalPerOrderUsd / price * 10 ** market.supported_size_decimals) / 10 ** market.supported_size_decimals;
            if (quantity >= minBaseAmount) {
              const fee = price * quantity * input.feeBps / 10000;
              feesUsd += fee; cash -= fee;
              position = { quantity, basis: price * quantity, side: proposal.side === 'buy' ? 'long' : 'short', entryTime: time };
            }
          }
        }
        try { pending = strategy.evaluate(context({ bids: view.bids, asks: view.asks }, time)); }
        catch { pending = null; }
        markEquity(time);
      } else if (marketStats && ['subscribed/market_stats', 'update/market_stats'].includes(parsed.type)) {
        stats = parseStats(parsed, market, clock, staleMs);
      } else if (['subscribed/trade', 'update/trade'].includes(parsed.type)) {
        const result = parseTrades(parsed, market, clock, nonce);
        nonce = result.nonce;
        batch.push(...result.trades);
        if (batch.length > 500) batch.splice(0, batch.length - 500);
      }
    } catch { rejectedFrames++; }
  }
  if (position && lastTop) closeAt(position.side === 'long' ? lastTop.bid : lastTop.ask, position.quantity, lastTop.time, 'end of capture');

  const wins = closed.filter(t => t.pnl > 0).length;
  const winSum = closed.reduce((s, t) => s + Math.max(t.pnl, 0), 0), lossSum = closed.reduce((s, t) => s + Math.max(-t.pnl, 0), 0);
  if (rejectedFrames) warnings.push(`${rejectedFrames} recorded frames were invalid and skipped, matching live fail-closed handling.`);
  return {
    kind: 'recorded-feed-replay', strategyId, params: input.params, symbol: market.symbol, frames: frames.length,
    trades: closed, equity, netPnl: cash - input.capital, maxDrawdown, winRate: closed.length ? wins / closed.length : 0,
    profitFactor: lossSum ? winSum / lossSum : null, feesUsd, warnings,
    config: { capital: input.capital, asset: 'crypto', lookback: 0, stopPct: params.stopPct ?? 0, riskPct: 0, feeBps: input.feeBps, slippageBps: 0 }
  };
}
