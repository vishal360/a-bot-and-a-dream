import type { StrategyRegistry } from './strategies/registry';
import { validateParams, type StrategyContext, type StrategyProposal } from './strategies/types';

/** One candle from a public venue REST API (default: Binance spot klines). */
export type Kline = {
  openTime: number; open: number; high: number; low: number; close: number; volume: number; closeTime: number;
};

export type KlineReplayResult = {
  kind: 'historical-klines-replay';
  strategyId: string; params: Record<string, number>; symbol: string; candles: number; source: string;
  trades: { entryTime: string; exitTime: string; side: 'long' | 'short'; entry: number; exit: number; quantity: number; pnl: number; reason: string }[];
  equity: number[]; netPnl: number; maxDrawdown: number; winRate: number; profitFactor: number | null;
  feesUsd: number; warnings: string[];
  config: { capital: number; feeBps: number; spreadBps: number; notionalPerOrderUsd: number; source: string; executionModel: 'taker' | 'maker-conservative'; limitTtlCandles: number };
};

/** Historical-screen lane (docs/HISTORY_BACKFILL.md): replays a strategy over public
 *  klines with the SAME no-look-ahead contract as the Lighter capture replay — a proposal
 *  evaluated on candle i executes at candle i+1's open — but with an honestly weaker
 *  market model: a synthetic two-quote book around each close, next-open fills, modeled
 *  fees only, no depth walk, no funding cash flows, and a DIFFERENT VENUE than the one we
 *  trade. Historical verdicts screen candidates; only Lighter-capture verdicts can ever
 *  promote a strategy (research/promotions.json is Lighter-only by design).
 *
 *  Performance note: the 1s-mid window buffer is bounded and SHARED across evaluations
 *  (not copied per candle) so long histories stay O(n); strategies must treat the context
 *  as read-only, which every built-in does. */
export function replayKlines(input: {
  registry: StrategyRegistry; strategyId: string; params: Record<string, number>;
  klines: Kline[]; funding?: { time: number; rate: number }[]; symbol: string;
  capital: number; feeBps: number; spreadBps?: number; notionalPerOrderUsd: number; source: string;
  executionModel?: 'taker' | 'maker-conservative';
  limitTtlCandles?: number;
}): KlineReplayResult {
  const { registry, strategyId, klines, funding, symbol } = input;
  const strategy = registry.get(strategyId);
  const params = validateParams(strategy, input.params ?? {});
  const spreadBps = input.spreadBps ?? 2;
  if (!Number.isFinite(input.capital) || input.capital < 100 || input.capital > 1e8) throw new Error('Invalid replay capital');
  if (!Number.isInteger(input.feeBps) || input.feeBps < 0 || input.feeBps > 100) throw new Error('Invalid replay feeBps');
  if (!Number.isFinite(spreadBps) || spreadBps < 0 || spreadBps > 100) throw new Error('Invalid replay spreadBps');
  if (!Number.isFinite(input.notionalPerOrderUsd) || input.notionalPerOrderUsd < 10 || input.notionalPerOrderUsd > input.capital) throw new Error('Invalid notionalPerOrderUsd');
  if (input.limitTtlCandles !== undefined && (!Number.isInteger(input.limitTtlCandles) || input.limitTtlCandles < 1 || input.limitTtlCandles > 100)) throw new Error('Invalid limitTtlCandles');
  const maker = input.executionModel === 'maker-conservative';
  const ttl = Math.max(1, Math.trunc(input.limitTtlCandles ?? 5));
  if (!Array.isArray(klines) || klines.length < 2) throw new Error('Kline replay needs at least 2 candles');
  let lastOpen = -Infinity;
  for (const k of klines) {
    if (!Number.isSafeInteger(k.openTime) || k.openTime <= lastOpen) throw new Error('Klines must be ascending by openTime');
    if (![k.open, k.high, k.low, k.close].every(v => typeof v === 'number' && Number.isFinite(v) && v > 0) ||
        typeof k.volume !== 'number' || !Number.isFinite(k.volume) || k.volume < 0) throw new Error('Invalid kline');
    lastOpen = k.openTime;
  }
  const warnings = [
    `Historical screen on ${input.source} klines for ${symbol}; this is a DIFFERENT venue than Lighter and can never promote a strategy.`,
    'Synthetic two-quote book at each candle close; fills at the next candle open with modeled fees only: no depth walk, queue position, partial liquidity or funding cash flows.',
    'Funding (when provided) is venue funding history mapped as a signal only, with its native cadence — it is not Lighter hourly funding.',
    'No account risk limits, halts or liquidation modeling; the window buffer is shared (read-only context) for linear-time replay.',
  ];
  if (maker) {
    warnings.push(`Maker-conservative fills: limits are placed at the DECISION candle's close and fill only when a LATER candle trades strictly THROUGH the level - touch-equal prices do NOT fill, queue position is never assumed, and fees stay at the taker rate (maker rebates are not credited). Unfilled limits cancel after ${ttl} candle(s); a stale closing limit falls back to a taker exit rather than holding forever.`);
  }

  let position: { quantity: number; basis: number; side: 'long' | 'short'; entryTime: string } | null = null;
  let cash = input.capital, peak = cash, maxDrawdown = 0, feesUsd = 0;
  const closed: KlineReplayResult['trades'] = [], equity: number[] = [];
  let pending: StrategyProposal | null = null;
  let fundingIndex = 0;
  const window: { time: string; mid: number }[] = [];
  // Maker-conservative state: at most one resting limit, placed at the decision candle's
  // close, active from the NEXT candle, cancelled after ttl candles (a stale closing
  // limit exits via taker instead of becoming an unbounded hold).
  type RestingLimit = { action: 'open' | 'close'; side: 'buy' | 'sell'; limitPrice: number; fraction?: number; reason: string; placedAtIndex: number; expiresAtIndex: number };
  let pendingLimit: RestingLimit | null = null;
  let expiredLimits = 0;

  for (let i = 0; i < klines.length; i++) {
    const k = klines[i];
    const time = new Date(k.closeTime).toISOString();

    // Maker-conservative: a resting limit fills only when THIS candle trades strictly
    // THROUGH its level (entry: buy fills on low < limit, short on high > limit; exit:
    // the exit side is the opposite of the position side). Limits placed at the decision
    // candle's close are live from the next candle; expired closes fall back to taker.
    if (maker && pendingLimit && i > pendingLimit.placedAtIndex) {
      const limit: RestingLimit = pendingLimit;
      const through = limit.action === 'open'
        ? (limit.side === 'buy' ? k.low < limit.limitPrice : k.high > limit.limitPrice)
        : (limit.side === 'sell' ? k.high > limit.limitPrice : k.low < limit.limitPrice);
      if (i > limit.expiresAtIndex) {
        pendingLimit = null;
        expiredLimits++;
        if (limit.action === 'close' && position) {
          // A stale exit must not become an unbounded hold: taker exit now, honestly priced.
          const signed = position.side === 'long' ? 1 : -1;
          const fee = k.open * position.quantity * input.feeBps / 10000;
          feesUsd += fee;
          cash += signed * (k.open - position.basis / position.quantity) * position.quantity - fee;
          closed.push({ entryTime: position.entryTime, exitTime: time, side: position.side,
            entry: position.basis / position.quantity, exit: k.open, quantity: position.quantity,
            pnl: signed * (k.open - position.basis / position.quantity) * position.quantity - fee, reason: 'limit expired: taker exit' });
          position = null;
        }
      } else if (through) {
        pendingLimit = null;
        const price = limit.limitPrice;
        if (limit.action === 'close' && position) {
          const fraction = limit.fraction ?? 1;
          const quantity = position.quantity * fraction;
          if (quantity > 0) {
            const signed = position.side === 'long' ? 1 : -1;
            const fee = price * quantity * input.feeBps / 10000;
            feesUsd += fee;
            cash += signed * (price - position.basis / position.quantity) * quantity - fee;
            closed.push({ entryTime: position.entryTime, exitTime: time, side: position.side,
              entry: position.basis / position.quantity, exit: price, quantity,
              pnl: signed * (price - position.basis / position.quantity) * quantity - fee, reason: limit.reason.slice(0, 120) });
            position.quantity = Number((position.quantity - quantity).toFixed(8));
            if (position.quantity <= 0) position = null;
          }
        } else if (limit.action === 'open' && !position) {
          const quantity = input.notionalPerOrderUsd / price;
          const fee = price * quantity * input.feeBps / 10000;
          feesUsd += fee;
          cash -= fee;
          position = { quantity, basis: price * quantity, side: limit.side === 'buy' ? 'long' : 'short', entryTime: time };
        }
      }
    } else if (!maker && pending && i > 0) {
      const proposal = pending;
      pending = null;
      if (proposal.action === 'close' && position) {
        const fraction = proposal.fraction;
        if (Number.isFinite(fraction) && fraction > 0 && fraction <= 1) {
          const quantity = position.quantity * fraction;
          if (quantity > 0) {
            const signed = position.side === 'long' ? 1 : -1;
            const fee = k.open * quantity * input.feeBps / 10000;
            feesUsd += fee;
            cash += signed * (k.open - position.basis / position.quantity) * quantity - fee;
            closed.push({ entryTime: position.entryTime, exitTime: time, side: position.side,
              entry: position.basis / position.quantity, exit: k.open, quantity,
              pnl: signed * (k.open - position.basis / position.quantity) * quantity - fee, reason: proposal.rationale.slice(0, 120) });
            position.quantity = Number((position.quantity - quantity).toFixed(8));
            if (position.quantity <= 0) position = null;
          }
        }
      } else if (proposal.action === 'open' && !position) {
        const price = proposal.side === 'buy' ? k.open * (1 + spreadBps / 20000) : k.open * (1 - spreadBps / 20000);
        const quantity = input.notionalPerOrderUsd / price;
        const fee = price * quantity * input.feeBps / 10000;
        feesUsd += fee;
        cash -= fee;
        position = { quantity, basis: price * quantity, side: proposal.side === 'buy' ? 'long' : 'short', entryTime: time };
      }
    }

    // Context is built on the candle CLOSE; the proposal it produces runs at the next open.
    while (funding && fundingIndex < funding.length && funding[fundingIndex].time <= k.openTime) fundingIndex++;
    const fundingRate = funding && fundingIndex > 0 ? funding[fundingIndex - 1].rate : null;
    const half = k.close * spreadBps / 20000;
    const book = { bids: [{ price: k.close - half, quantity: 1e6 }], asks: [{ price: k.close + half, quantity: 1e6 }], time };
    const lastSample = window[window.length - 1];
    if (!lastSample || k.closeTime - Date.parse(lastSample.time) >= 1000) window.push({ time, mid: k.close });
    if (window.length > 4000) window.splice(0, window.length - 3700);
    const ctx: StrategyContext = {
      symbol, book, stats: { mark: k.close, index: k.close, fundingRate, last: k.close },
      trades: [], window, params,
      position: position ? { quantity: position.quantity, average: position.basis / position.quantity, leverage: 1, unrealized: null } : null,
      equityUsd: equity[equity.length - 1] ?? input.capital, now: time,
    };
    try { pending = strategy.evaluate(ctx); } catch { pending = null; }
    // Maker mode: convert the decision made at THIS candle's close into a resting limit
    // (live from the next candle). While a limit rests, new decisions are dropped - the
    // first decision owns the slot, exactly like one real working order.
    if (maker && pending && !pendingLimit) {
      const proposal = pending;
      pending = null;
      const opens = proposal.action === 'open' && !position;
      const closes = proposal.action === 'close' && !!position;
      if (opens || closes) {
        pendingLimit = {
          action: proposal.action === 'open' ? 'open' : 'close',
          side: proposal.action === 'open' ? proposal.side : (position!.side === 'long' ? 'sell' : 'buy'),
          limitPrice: k.close,
          fraction: proposal.action === 'close' ? proposal.fraction : undefined,
          reason: proposal.rationale,
          placedAtIndex: i, expiresAtIndex: i + ttl,
        };
      }
    }

    let value = cash;
    if (position) {
      const signed = position.side === 'long' ? 1 : -1;
      value += signed * (k.close - position.basis / position.quantity) * position.quantity;
    }
    equity.push(value);
    peak = Math.max(peak, value);
    maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - value) / peak : 0);
  }
  if (position) {
    const k = klines[klines.length - 1];
    const signed = position.side === 'long' ? 1 : -1;
    const fee = k.close * position.quantity * input.feeBps / 10000;
    feesUsd += fee;
    cash += signed * (k.close - position.basis / position.quantity) * position.quantity - fee;
    closed.push({ entryTime: position.entryTime, exitTime: new Date(k.closeTime).toISOString(), side: position.side,
      entry: position.basis / position.quantity, exit: k.close, quantity: position.quantity,
      pnl: signed * (k.close - position.basis / position.quantity) * position.quantity - fee, reason: 'end of history' });
  }

  if (maker && expiredLimits) warnings.push(`${expiredLimits} limit order(s) expired unfilled and were cancelled (stale closing limits fell back to a taker exit) - maker fills are NOT guaranteed, and this replay says so numerically.`);
  const wins = closed.filter(t => t.pnl > 0).length;
  const winSum = closed.reduce((s, t) => s + Math.max(t.pnl, 0), 0), lossSum = closed.reduce((s, t) => s + Math.max(-t.pnl, 0), 0);
  return {
    kind: 'historical-klines-replay', strategyId, params, symbol, candles: klines.length, source: input.source,
    trades: closed, equity, netPnl: cash - input.capital, maxDrawdown, winRate: closed.length ? wins / closed.length : 0,
    profitFactor: lossSum ? winSum / lossSum : null, feesUsd, warnings,
    config: { capital: input.capital, feeBps: input.feeBps, spreadBps, notionalPerOrderUsd: input.notionalPerOrderUsd, source: input.source, executionModel: maker ? 'maker-conservative' : 'taker', limitTtlCandles: ttl },
  };
}
