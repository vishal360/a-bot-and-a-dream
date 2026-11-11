import type { ParamSpec, Strategy, StrategyContext, StrategyProposal } from './types';
import { validateParams } from './types';

/** Research artifact identity includes this file AND its parameter/type contract. */
export type ResearchStrategy = Strategy & { researchOnly: true; artifactSources: string[] };
export const RESEARCH_VERSION = 'completed-minute-v1';
export type ResearchBar = { time: number; open: number; high: number; low: number; close: number };
const MINUTE = 60_000;
const hold = (rationale: string): StrategyProposal => ({ action: 'hold', rationale });
const average = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const high = (bars: ResearchBar[]) => Math.max(...bars.map(b => b.high));
const low = (bars: ResearchBar[]) => Math.min(...bars.map(b => b.low));

/** No exchange OHLC/volume assumptions: these are OHLC of observed one-second mids.
 * Reject malformed/future/unordered input rather than silently repairing chronology.
 * A usable minute spans >=50 seconds with no gap >5 seconds, including its edges.
 * Only the contiguous suffix ending at the immediately previous minute is returned.
 */
export function completedResearchBars(ctx: StrategyContext): { bars: ResearchBar[]; error?: string } {
  const now = Date.parse(ctx.now), current = Math.floor(now / MINUTE) * MINUTE;
  if (!Number.isFinite(now) || ctx.window.length > 3600) return { bars: [], error: 'Invalid clock or window exceeds 3600 samples' };
  const buckets = new Map<number, { time: number; mid: number }[]>();
  let previous = -Infinity;
  for (const sample of ctx.window) {
    const time = Date.parse(sample.time);
    if (!Number.isFinite(time) || time > now || time <= previous || !Number.isFinite(sample.mid) || sample.mid <= 0)
      return { bars: [], error: 'Invalid, future or unordered context sample' };
    previous = time;
    if (time < now - 3_600_000 || time >= current) continue;
    const minute = Math.floor(time / MINUTE) * MINUTE;
    const bucket = buckets.get(minute) ?? [];
    bucket.push({ time, mid: sample.mid }); buckets.set(minute, bucket);
  }
  const bars: ResearchBar[] = [];
  for (let minute = current - MINUTE; minute >= now - 3_600_000; minute -= MINUTE) {
    const samples = buckets.get(minute);
    if (!samples?.length) break;
    const first = samples[0], last = samples[samples.length - 1];
    if (first.time - minute > 5000 || minute + MINUTE - last.time > 5000 || last.time - first.time < 50_000
      || samples.some((s, i) => i > 0 && s.time - samples[i - 1].time > 5000)) break;
    const mids = samples.map(s => s.mid);
    bars.push({ time: minute, open: first.mid, high: Math.max(...mids), low: Math.min(...mids), close: last.mid });
  }
  return { bars: bars.reverse() };
}

const common: ParamSpec = [
  { key: 'stopPct', label: 'Protective stop (fraction)', min: 0.001, max: 0.05, default: 0.008 },
  { key: 'takeProfitPct', label: 'Protective target (fraction)', min: 0.002, max: 0.15, default: 0.016 },
  { key: 'maxSpreadPct', label: 'Maximum entry spread (fraction)', min: 0.00001, max: 0.01, default: 0.001 },
  { key: 'minVolPct', label: 'Minimum minute return RMS', min: 0, max: 0.01, default: 0.0001 },
  { key: 'maxVolPct', label: 'Maximum minute return RMS', min: 0.0001, max: 0.05, default: 0.015 }
];
type Features = { ctx: StrategyContext; p: Record<string, number>; bars: ResearchBar[]; mid: number };
function make(id: string, name: string, description: string, specs: ParamSpec,
  required: (p: Record<string, number>) => number, signal: (f: Features) => StrategyProposal): ResearchStrategy {
  const strategy: ResearchStrategy = {
    id, name, description, researchOnly: true,
    artifactSources: ['src/strategies/research.ts', 'src/strategies/types.ts'],
    params: [...common.map(p => ({ ...p })), ...specs],
    evaluate(ctx) {
      const now = Date.parse(ctx.now), bid = ctx.book?.bids[0]?.price, ask = ctx.book?.asks[0]?.price;
      const quoteTime = Date.parse(ctx.book?.time ?? '');
      if (!Number.isFinite(now) || !Number.isFinite(bid) || !Number.isFinite(ask) || !(bid! > 0) || !(ask! >= bid!)
        || !Number.isFinite(quoteTime) || quoteTime > now || now - quoteTime > 10_000)
        return hold('Invalid or stale quote');
      const mid = bid! / 2 + ask! / 2;
      let p: Record<string, number>;
      try { p = validateParams(strategy, ctx.params); } catch { return hold('Invalid strategy parameters'); }
      const position = ctx.position;
      // Protective exits precede ALL history, spread and feature filters. Use liquidation-side quote.
      if (position) {
        if (!Number.isFinite(position.quantity) || position.quantity === 0 || !Number.isFinite(position.average) || position.average <= 0)
          return hold('Invalid position');
        const long = position.quantity > 0, exit = long ? bid! : ask!;
        if (long ? exit <= position.average * (1 - p.stopPct) : exit >= position.average * (1 + p.stopPct))
          return { action: 'close', fraction: 1, rationale: 'Protective stop' };
        if (long ? exit >= position.average * (1 + p.takeProfitPct) : exit <= position.average * (1 - p.takeProfitPct))
          return { action: 'close', fraction: 1, rationale: 'Protective target' };
      }
      if (p.minVolPct > p.maxVolPct) return hold('Invalid volatility bounds');
      const history = completedResearchBars(ctx), needed = required(p);
      if (history.error) return hold(history.error);
      if (history.bars.length < needed) return hold(`Warming up: ${history.bars.length}/${needed} contiguous completed minutes`);
      const bars = history.bars.slice(-needed);
      const returns = bars.slice(1).map((b, i) => (b.close - bars[i].close) / bars[i].close);
      const vol = Math.sqrt(average(returns.map(r => r * r)));
      if (!Number.isFinite(vol) || vol < p.minVolPct || vol > p.maxVolPct) return hold('Minute volatility filter');
      // Open positions are never increased, reversed or martingaled by signal logic.
      if (position) return hold('Holding protected position');
      if ((ask! - bid!) / mid > p.maxSpreadPct) return hold('Entry spread filter');
      return signal({ ctx, p, bars, mid });
    }
  };
  return strategy;
}
const lookback = (defaultValue: number): ParamSpec => [
  { key: 'lookbackMinutes', label: 'Completed-minute lookback', min: 5, max: 45, default: defaultValue, integer: true }
];
export const channelTrendResearchV1 = make(
  'research-channel-trend-v1', 'Research: volatility-filtered minute channel',
  'Completed-minute close breaks the previous minute-mid channel; bounded minute-return volatility filter.',
  [...lookback(20), { key: 'breakoutBufferPct', label: 'Breakout buffer (fraction)', min: 0, max: 0.01, default: 0.0002 }],
  p => p.lookbackMinutes + 1, ({ p, bars }) => {
    const prior = bars.slice(0, -1), close = bars.at(-1)!.close;
    if (close > high(prior) * (1 + p.breakoutBufferPct)) return { action: 'open', side: 'buy', rationale: 'Completed-minute channel breakout up' };
    if (close < low(prior) * (1 - p.breakoutBufferPct)) return { action: 'open', side: 'sell', rationale: 'Completed-minute channel breakout down' };
    return hold('Inside completed-minute channel');
  });

export const zscoreReversionResearchV1 = make(
  'research-zscore-reversion-v1', 'Research: trend-filtered z-score reversion',
  'Fade a completed close stretched from prior closes only when prior-window endpoint drift is small.',
  [...lookback(20),
    { key: 'entryZ', label: 'Entry z-score', min: 1, max: 5, default: 2 },
    { key: 'maxTrendPct', label: 'Maximum prior endpoint drift (fraction)', min: 0.0001, max: 0.03, default: 0.005 }],
  p => p.lookbackMinutes + 1, ({ p, bars }) => {
    const prior = bars.slice(0, -1).map(b => b.close), mean = average(prior);
    const sd = Math.sqrt(average(prior.map(v => (v - mean) ** 2)));
    if (Math.abs(prior.at(-1)! / prior[0] - 1) > p.maxTrendPct) return hold('Prior trend too strong to fade');
    if (!(sd > mean * 1e-10)) return hold('Degenerate prior variance');
    const z = (bars.at(-1)!.close - mean) / sd;
    if (z <= -p.entryZ) return { action: 'open', side: 'buy', rationale: 'Completed close stretched low in low-drift regime' };
    if (z >= p.entryZ) return { action: 'open', side: 'sell', rationale: 'Completed close stretched high in low-drift regime' };
    return hold('Completed close within z-score entry band');
  });

export const pullbackContinuationResearchV1 = make(
  'research-ma-pullback-v1', 'Research: moving-average pullback continuation',
  'Fast/slow mean alignment, prior-bar touch of fast mean, then completed close breaks the pullback bar.',
  [...lookback(20),
    { key: 'fastMinutes', label: 'Fast mean minutes', min: 2, max: 10, default: 5, integer: true },
    { key: 'pullbackPct', label: 'Fast mean touch tolerance (fraction)', min: 0, max: 0.01, default: 0.001 }],
  p => p.lookbackMinutes + 2, ({ p, bars }) => {
    if (p.fastMinutes >= p.lookbackMinutes) return hold('Fast mean must be shorter than slow mean');
    const prior = bars.slice(0, -1), before = bars.slice(0, -2);
    const fast = average(prior.slice(-p.fastMinutes).map(b => b.close));
    const previousFast = average(before.slice(-p.fastMinutes).map(b => b.close));
    const slow = average(prior.slice(-p.lookbackMinutes).map(b => b.close));
    const pullback = prior.at(-1)!, close = bars.at(-1)!.close;
    if (fast > slow && fast > previousFast && pullback.low <= fast * (1 + p.pullbackPct) && pullback.close >= slow && close > pullback.high)
      return { action: 'open', side: 'buy', rationale: 'Uptrend fast-mean pullback continuation' };
    if (fast < slow && fast < previousFast && pullback.high >= fast * (1 - p.pullbackPct) && pullback.close <= slow && close < pullback.low)
      return { action: 'open', side: 'sell', rationale: 'Downtrend fast-mean pullback continuation' };
    return hold('No aligned moving-average pullback continuation');
  });

export const squeezeExpansionResearchV1 = make(
  'research-squeeze-expansion-v1', 'Research: squeeze / range expansion',
  'Recent observed-mid ranges contract against older baseline; latest completed bar expands out of squeeze channel.',
  [...lookback(20),
    { key: 'squeezeMinutes', label: 'Squeeze minutes', min: 2, max: 8, default: 4, integer: true },
    { key: 'squeezeRatio', label: 'Squeeze / baseline range ratio', min: 0.1, max: 0.9, default: 0.5 },
    { key: 'expansionRatio', label: 'Expansion / squeeze range ratio', min: 1.1, max: 5, default: 2 }],
  p => p.lookbackMinutes + p.squeezeMinutes + 1, ({ p, bars }) => {
    const base = bars.slice(0, p.lookbackMinutes), squeeze = bars.slice(p.lookbackMinutes, -1), latest = bars.at(-1)!;
    const range = (b: ResearchBar) => (b.high - b.low) / b.close;
    const baseRange = average(base.map(range)), squeezeRange = average(squeeze.map(range));
    const previousClose = squeeze.at(-1)!.close;
    const expansion = Math.max(latest.high - latest.low, Math.abs(latest.high - previousClose), Math.abs(latest.low - previousClose)) / previousClose;
    if (!(baseRange > 0) || !(squeezeRange > 0) || squeezeRange > baseRange * p.squeezeRatio || expansion < squeezeRange * p.expansionRatio)
      return hold('No nondegenerate squeeze and range expansion');
    if (latest.close > high(squeeze)) return { action: 'open', side: 'buy', rationale: 'Squeeze range expansion up' };
    if (latest.close < low(squeeze)) return { action: 'open', side: 'sell', rationale: 'Squeeze range expansion down' };
    return hold('Expansion did not close outside squeeze channel');
  });

export const researchStrategies: ResearchStrategy[] = [channelTrendResearchV1, zscoreReversionResearchV1, pullbackContinuationResearchV1, squeezeExpansionResearchV1];
