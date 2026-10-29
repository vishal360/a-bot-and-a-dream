import type { Kline } from './backtest-klines';

export type WalkForwardSplit = { train: Kline[]; holdout: Kline[] };

/** Contiguous rolling split: the LAST holdoutDays are the untouched holdout window;
 *  the trainDays before them are the training window. No shuffling — time order is the
 *  whole point of walk-forward evidence. */
export function splitWalkForward(klines: Kline[], trainDays: number, holdoutDays: number): WalkForwardSplit {
  if (!Array.isArray(klines) || klines.length < 2) throw new Error('Walk-forward needs klines');
  if (!Number.isInteger(trainDays) || trainDays < 1 || !Number.isInteger(holdoutDays) || holdoutDays < 1) throw new Error('Walk-forward needs whole positive day counts');
  const stepMs = klines[1].openTime - klines[0].openTime;
  if (!Number.isSafeInteger(stepMs) || stepMs <= 0) throw new Error('Klines must be uniformly spaced');
  const perDay = Math.round(86400000 / stepMs);
  const holdoutCount = holdoutDays * perDay;
  if (klines.length < holdoutCount + perDay) throw new Error(`Not enough history: need more than ${holdoutDays} day(s) plus a train window`);
  const holdoutStart = klines.length - holdoutCount;
  const trainStart = Math.max(0, holdoutStart - trainDays * perDay);
  return { train: klines.slice(trainStart, holdoutStart), holdout: klines.slice(holdoutStart) };
}

export type WalkForwardVerdict = {
  verified: { id: string; holdoutNetPnl: number }[];
  rejected: { id: string; reason: 'train-eliminated' | 'holdout-negative'; holdoutNetPnl?: number }[];
};

/** The two-tier honesty rule (docs/HISTORY_BACKFILL.md): a config is walk-forward-verified
 *  only if it (1) survived the multiplicity-corrected SPA screen on the TRAIN window and
 *  (2) beat holding cash net of fees on the untouched HOLDOUT window. Historical
 *  verification NEVER promotes: research/promotions.json is installable only from
 *  Lighter-capture PASS verdicts (scripts/research-promote.ts). */
export function walkForwardVerdict(input: {
  candidates: string[]; trainSurvivors: string[]; holdout: { id: string; netPnl: number }[];
}): WalkForwardVerdict {
  const holdoutMap = new Map(input.holdout.map(h => [h.id, h.netPnl]));
  const survivors = new Set(input.trainSurvivors);
  const verified: WalkForwardVerdict['verified'] = [], rejected: WalkForwardVerdict['rejected'] = [];
  for (const id of input.candidates) {
    const netPnl = holdoutMap.get(id);
    if (!survivors.has(id) || netPnl === undefined) { rejected.push({ id, reason: 'train-eliminated' }); continue; }
    if (netPnl > 0) verified.push({ id, holdoutNetPnl: netPnl });
    else rejected.push({ id, reason: 'holdout-negative', holdoutNetPnl: netPnl });
  }
  return { verified, rejected };
}
