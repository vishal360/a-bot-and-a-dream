import type { Kline } from './backtest-klines';

export type QualityProblem = { kind: 'gap' | 'duplicate' | 'zero-volume-run'; detail: string };

export type DayQuality = {
  day: string;
  candles: number;
  intervalMs: number;
  verdict: 'ok' | 'degraded' | 'bad';
  totalGapMs: number;
  problems: QualityProblem[];
};

export type QualityOptions = {
  /** A single gap longer than this makes the day unusable ('bad'). Default 1 hour. */
  longGapMs?: number;
  /** Cumulative gap time above this degrades the day. Default 5 minutes. */
  maxTotalGapMs?: number;
  /** A zero-volume run at least this long degrades the day. Default 5 minutes. */
  zeroVolumeRunMs?: number;
};

/** Backfill quality gates (docs/HISTORY_BACKFILL.md): a downloaded day is only as
 *  good as its worst hole. Duplicate timestamps are instantly fatal (they poison
 *  uniform-spacing assumptions), any gap over longGapMs is fatal, cumulative gaps
 *  and long zero-volume runs degrade the day. The walk-forward grader refuses
 *  'bad' days outright (fail-closed) and records degraded ones in its report. */
export function assessDayQuality(klines: Kline[], day: string, options: QualityOptions = {}): DayQuality {
  const longGapMs = options.longGapMs ?? 3600 * 1000;
  const maxTotalGapMs = options.maxTotalGapMs ?? 5 * 60 * 1000;
  const zeroVolumeRunMs = options.zeroVolumeRunMs ?? 5 * 60 * 1000;
  if (!Array.isArray(klines)) throw new Error('assessDayQuality needs a kline array');
  const problems: QualityProblem[] = [];
  const push = (kind: QualityProblem['kind'], detail: string) => {
    if (problems.length < 50) problems.push({ kind, detail });
  };

  let intervalMs = Number.POSITIVE_INFINITY;
  for (let i = 1; i < klines.length; i++) {
    const diff = klines[i].openTime - klines[i - 1].openTime;
    if (diff > 0 && diff < intervalMs) intervalMs = diff;
  }
  if (!Number.isFinite(intervalMs)) intervalMs = 0;

  let totalGapMs = 0, fatal = false, degraded = false;
  for (let i = 1; i < klines.length && !fatal; i++) {
    const diff = klines[i].openTime - klines[i - 1].openTime;
    if (diff === 0) {
      fatal = true;
      push('duplicate', `duplicate openTime ${new Date(klines[i].openTime).toISOString()}`);
    } else if (intervalMs > 0 && diff > intervalMs * 1.5) {
      totalGapMs += diff - intervalMs;
      if (diff - intervalMs > longGapMs) {
        fatal = true;
        push('gap', `${Math.round(diff / 60000)} min hole from ${new Date(klines[i - 1].openTime).toISOString()} to ${new Date(klines[i].openTime).toISOString()}`);
      }
    }
  }
  if (!fatal && totalGapMs > maxTotalGapMs) {
    degraded = true;
    push('gap', `cumulative gap time ${(totalGapMs / 60000).toFixed(1)} min exceeds the ${(maxTotalGapMs / 60000).toFixed(0)} min budget`);
  }

  // Zero-volume runs: exchanges stop, maintenance windows, dead hours. A short run is
  // normal; a long one means the replay would trade into fabricated liquidity.
  let runStart = -1;
  const closeRun = (endIndex: number) => {
    if (runStart < 0) return;
    const runMs = klines[endIndex].openTime - klines[runStart].openTime + intervalMs;
    if (runMs >= zeroVolumeRunMs) {
      if (runMs >= longGapMs) { fatal = true; }
      else degraded = true;
      push('zero-volume-run', `${Math.round(runMs / 60000)} min of zero volume starting ${new Date(klines[runStart].openTime).toISOString()}`);
    }
    runStart = -1;
  };
  for (let i = 0; i < klines.length; i++) {
    if (klines[i].volume === 0) { if (runStart < 0) runStart = i; }
    else closeRun(i);
  }
  closeRun(klines.length - 1);

  return {
    day, candles: klines.length, intervalMs,
    verdict: fatal ? 'bad' : degraded ? 'degraded' : 'ok',
    totalGapMs, problems,
  };
}
