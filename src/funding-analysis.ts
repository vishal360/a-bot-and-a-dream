export type FundingSample = { t: number; rate: number; fundingTimestamp?: number | null };

export type FundingCadence = {
  samples: number;
  distinctRates: number;
  /** Number of observed funding-rate TRANSITIONS (rate value changes). */
  changes: number;
  /** Intervals between consecutive authoritative funding timestamps, when present. */
  timestampIntervalsMs: number[];
  medianIntervalMs: number | null;
  inferredCadenceHours: number | null;
  /** true = derived from venue funding_timestamp fields; false = inferred from rate changes. */
  authoritative: boolean;
};

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Funding-cadence analysis (docs/HISTORY_BACKFILL.md, funding-semantics): funding-carry
 *  research is only as honest as our model of WHEN funding accrues. Lighter captures
 *  carry market_stats frames with funding_rate AND funding_timestamp — the timestamp
 *  stream is authoritative (the venue's own schedule), so distinct sorted timestamps
 *  give the cadence directly. Without timestamps we fall back to inferring from rate
 *  VALUE changes, which is weaker (a rate can hold equal across periods) and is marked
 *  as non-authoritative. */
export function inferFundingCadence(samples: FundingSample[]): FundingCadence {
  if (!Array.isArray(samples)) throw new Error('inferFundingCadence needs a sample array');
  const valid = samples.filter(s => Number.isFinite(s.t) && Number.isFinite(s.rate));
  const distinctRates = new Set(valid.map(s => s.rate)).size;
  let changes = 0;
  for (let i = 1; i < valid.length; i++) if (valid[i].rate !== valid[i - 1].rate) changes++;

  const stamps = [...new Set(valid.map(s => s.fundingTimestamp).filter((t): t is number => typeof t === 'number' && Number.isFinite(t)))].sort((a, b) => a - b);
  const timestampIntervalsMs: number[] = [];
  for (let i = 1; i < stamps.length; i++) {
    const diff = stamps[i] - stamps[i - 1];
    if (diff > 0) timestampIntervalsMs.push(diff);
  }
  const medianIntervalMs = median(timestampIntervalsMs);
  if (stamps.length >= 2 && medianIntervalMs !== null) {
    return {
      samples: valid.length, distinctRates, changes, timestampIntervalsMs,
      medianIntervalMs, inferredCadenceHours: medianIntervalMs / 3600000, authoritative: true,
    };
  }
  // Fallback: intervals between rate CHANGES (upper bound on the true cadence).
  const changeTimes: number[] = [];
  for (let i = 1; i < valid.length; i++) if (valid[i].rate !== valid[i - 1].rate) changeTimes.push(valid[i].t);
  const intervals: number[] = [];
  for (let i = 1; i < changeTimes.length; i++) if (changeTimes[i] - changeTimes[i - 1] > 0) intervals.push(changeTimes[i] - changeTimes[i - 1]);
  const fallbackMedian = median(intervals);
  return {
    samples: valid.length, distinctRates, changes, timestampIntervalsMs: [],
    medianIntervalMs: fallbackMedian, inferredCadenceHours: fallbackMedian === null ? null : fallbackMedian / 3600000,
    authoritative: false,
  };
}
