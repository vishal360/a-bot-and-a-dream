import type { Strategy } from './types';
import { midPrice, windowSlice, mean, stdev, highest, lowest } from './types';

const MIN_SAMPLES = 30;

/** Channel breakout on one-second mid samples. Long when mid breaks above the prior
 *  channel high, short below the prior channel low. Exits: protective stop, take
 *  profit, or an opposite channel break. Direction only; the runner sizes everything. */
export const breakoutV1: Strategy = {
  id: 'breakout-v1',
  name: 'Channel breakout (1s mids)',
  description: 'Enters when price breaks the prior channel of 1s mid samples; exits on stop, target or opposite break. IOC market orders only.',
  params: [
    { key: 'lookbackSeconds', label: 'Channel lookback (seconds)', min: 60, max: 3600, default: 900, integer: true },
    { key: 'stopPct', label: 'Protective stop (fraction)', min: 0.002, max: 0.05, default: 0.006 },
    { key: 'takeProfitPct', label: 'Take profit (fraction)', min: 0.002, max: 0.2, default: 0.012 }
  ],
  evaluate(ctx) {
    const mid = midPrice(ctx.book);
    if (mid === null) return { action: 'hold', rationale: 'No validated book' };
    const channel = windowSlice(ctx, ctx.params.lookbackSeconds).map(s => s.mid);
    if (channel.length < MIN_SAMPLES) return { action: 'hold', rationale: `Warming up: ${channel.length}/${MIN_SAMPLES} samples` };
    // The live sample must not be part of its own breakout channel.
    const prior = channel.slice(0, -1), high = highest(prior)!, low = lowest(prior)!;
    const p = ctx.position;
    if (p) {
      const long = p.quantity > 0;
      const stop = long ? mid <= p.average * (1 - ctx.params.stopPct) : mid >= p.average * (1 + ctx.params.stopPct);
      if (stop) return { action: 'close', fraction: 1, rationale: `Protective stop at ${mid.toFixed(2)} vs entry ${p.average.toFixed(2)}` };
      const target = long ? mid >= p.average * (1 + ctx.params.takeProfitPct) : mid <= p.average * (1 - ctx.params.takeProfitPct);
      if (target) return { action: 'close', fraction: 1, rationale: `Take profit at ${mid.toFixed(2)} vs entry ${p.average.toFixed(2)}` };
      const channelExit = long ? mid < low : mid > high;
      if (channelExit) return { action: 'close', fraction: 1, rationale: `Opposite channel break: mid ${mid.toFixed(2)} vs band [${low.toFixed(2)}, ${high.toFixed(2)}]` };
      return { action: 'hold', rationale: `Inside band [${low.toFixed(2)}, ${high.toFixed(2)}]` };
    }
    if (mid > high) return { action: 'open', side: 'buy', rationale: `Breakout: mid ${mid.toFixed(2)} above channel high ${high.toFixed(2)}` };
    if (mid < low) return { action: 'open', side: 'sell', rationale: `Breakdown: mid ${mid.toFixed(2)} below channel low ${low.toFixed(2)}` };
    return { action: 'hold', rationale: `Inside band [${low.toFixed(2)}, ${high.toFixed(2)}]` };
  }
};

/** Z-score mean reversion on one-second mid samples. Fades moves beyond entryZ toward
 *  the rolling mean; exits when z normalizes to exitZ or the protective stop hits. */
export const meanReversionV1: Strategy = {
  id: 'mean-reversion-v1',
  name: 'Mean reversion (1s mids)',
  description: 'Shorts stretched-high mids and buys stretched-low mids against the rolling mean; exits on z-score normalization or stop.',
  params: [
    { key: 'windowSeconds', label: 'Statistics window (seconds)', min: 60, max: 3600, default: 600, integer: true },
    { key: 'entryZ', label: 'Entry z-score', min: 1.5, max: 6, default: 2.5 },
    { key: 'exitZ', label: 'Exit z-score', min: 0.1, max: 1.5, default: 0.5 },
    { key: 'stopPct', label: 'Protective stop (fraction)', min: 0.002, max: 0.05, default: 0.008 }
  ],
  evaluate(ctx) {
    const mid = midPrice(ctx.book);
    if (mid === null) return { action: 'hold', rationale: 'No validated book' };
    const values = windowSlice(ctx, ctx.params.windowSeconds).map(s => s.mid);
    if (values.length < MIN_SAMPLES) return { action: 'hold', rationale: `Warming up: ${values.length}/${MIN_SAMPLES} samples` };
    const m = mean(values)!, sd = stdev(values);
    if (!sd || sd <= 0) return { action: 'hold', rationale: 'Degenerate window variance' };
    const z = (mid - m) / sd, p = ctx.position;
    if (p) {
      const long = p.quantity > 0;
      const stop = long ? mid <= p.average * (1 - ctx.params.stopPct) : mid >= p.average * (1 + ctx.params.stopPct);
      if (stop) return { action: 'close', fraction: 1, rationale: `Protective stop at ${mid.toFixed(2)} vs entry ${p.average.toFixed(2)}` };
      if (long && z >= -ctx.params.exitZ) return { action: 'close', fraction: 1, rationale: `Long reverted: z ${z.toFixed(2)} ≥ -${ctx.params.exitZ}` };
      if (!long && z <= ctx.params.exitZ) return { action: 'close', fraction: 1, rationale: `Short reverted: z ${z.toFixed(2)} ≤ ${ctx.params.exitZ}` };
      return { action: 'hold', rationale: `Holding; z ${z.toFixed(2)}` };
    }
    if (z >= ctx.params.entryZ) return { action: 'open', side: 'sell', rationale: `Stretched high: z ${z.toFixed(2)} ≥ ${ctx.params.entryZ}` };
    if (z <= -ctx.params.entryZ) return { action: 'open', side: 'buy', rationale: `Stretched low: z ${z.toFixed(2)} ≤ -${ctx.params.entryZ}` };
    return { action: 'hold', rationale: `z ${z.toFixed(2)} within ±${ctx.params.entryZ}` };
  }
};

/** Funding-rate carry on perpetuals. When funding is beyond the entry threshold, hold
 *  the direction that collects funding; exit when funding normalizes or the stop hits.
 *  Funding semantics remain unverified against venue settlement; sizing stays conservative. */
export const fundingCarryV1: Strategy = {
  id: 'funding-carry-v1',
  name: 'Funding carry (perp)',
  description: 'Holds the funding-collecting side while funding exceeds the entry threshold; exits on normalization or stop. Unverified venue funding semantics.',
  params: [
    { key: 'entryFundingPct', label: 'Entry funding (%, hourly)', min: 0.0005, max: 0.5, default: 0.005 },
    { key: 'exitFundingPct', label: 'Exit funding (%, hourly)', min: 0.0001, max: 0.25, default: 0.0015 },
    { key: 'stopPct', label: 'Protective stop (fraction)', min: 0.005, max: 0.2, default: 0.03 }
  ],
  evaluate(ctx) {
    const mid = midPrice(ctx.book);
    if (mid === null) return { action: 'hold', rationale: 'No validated book' };
    const funding = ctx.stats?.fundingRate;
    if (funding === null || funding === undefined || !Number.isFinite(funding)) return { action: 'hold', rationale: 'No fresh funding rate' };
    const p = ctx.position;
    if (p) {
      const long = p.quantity > 0;
      const stop = long ? mid <= p.average * (1 - ctx.params.stopPct) : mid >= p.average * (1 + ctx.params.stopPct);
      if (stop) return { action: 'close', fraction: 1, rationale: `Protective stop at ${mid.toFixed(2)} vs entry ${p.average.toFixed(2)}` };
      const collect = long ? funding < 0 : funding > 0;
      if (!collect && Math.abs(funding) < ctx.params.exitFundingPct) return { action: 'close', fraction: 1, rationale: `Funding normalized: ${funding}%` };
      return { action: 'hold', rationale: `Carrying ${long ? 'long' : 'short'}; funding ${funding}%` };
    }
    if (funding >= ctx.params.entryFundingPct) return { action: 'open', side: 'sell', rationale: `Funding ${funding}% ≥ ${ctx.params.entryFundingPct}%: shorts collect` };
    if (funding <= -ctx.params.entryFundingPct) return { action: 'open', side: 'buy', rationale: `Funding ${funding}% ≤ -${ctx.params.entryFundingPct}%: longs collect` };
    return { action: 'hold', rationale: `Funding ${funding}% within ±${ctx.params.entryFundingPct}%` };
  }
};

export const builtinStrategies: Strategy[] = [breakoutV1, meanReversionV1, fundingCarryV1];
