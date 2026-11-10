/** Own-capture walk-forward grader (docs/DATA_ENGINE.md): the research lane's SECOND
 *  tier, over the market data THIS machine recorded from Lighter itself. Historical
 *  Binance klines only screen; our own captures are the venue we actually paper-trade,
 *  so a PASS here is real venue evidence (it still never installs the promotion
 *  manifest itself - scripts/research-promote.ts stays the only promotion path).
 *
 *  Bars are quote-derived (market_stats mid_price, order_book fallback) at
 *  --bucket-seconds; volume is 0 by construction, so the zero-volume quality rule does
 *  not apply and volume-aware strategies are meaningless here.
 *
 *  Usage:
 *    bun run scripts/research-own-captures.ts [--market BTC] [--bucket-seconds 60]
 *        [--archive data/archive] [--train-days 2] [--holdout-days 1] [--equity-step 20]
 *        [--capital 10000] [--fee-bps 2] [--notional 1000] [--alpha 0.05] [--reps 2000]
 */
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { replayKlines } from '../src/backtest-klines';
import { builtinStrategies } from '../src/strategies/builtin';
import { StrategyRegistry } from '../src/strategies/registry';
import { configId } from '../src/promotion';
import { splitByBars, splitWalkForward, walkForwardVerdict } from '../src/walkforward';
import { captureBars, marketIdFor, toKlines, type CaptureObject } from '../src/own-captures';

const root = resolve(import.meta.dir, '..');
const args = process.argv.slice(2);
const arg = (name: string): string | null => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : null;
};
const num = (name: string, fallback: number): number => {
  const raw = arg(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Invalid --${name}: ${raw}`);
  return value;
};

const registry = new StrategyRegistry();
for (const strategy of builtinStrategies) registry.register(strategy);

const archiveRoot = resolve(arg('archive') ?? 'data/archive');
const driveRoot = resolve(arg('drive-archive') ?? 'G:/My Drive/ABAD-archive');
const market = arg('market') ?? 'BTC';
const bucketMs = Math.trunc(num('bucket-seconds', 60)) * 1000;
const trainDays = Math.trunc(num('train-days', 2));
const holdoutDays = Math.trunc(num('holdout-days', 1));
const equityStep = Math.trunc(num('equity-step', 20));
const capital = num('capital', 10000);
const feeBps = Math.trunc(num('fee-bps', 2));
const notional = num('notional', Math.min(1000, capital - 1));
const alpha = num('alpha', 0.05);
const reps = Math.trunc(num('reps', 2000));
// Optional contiguous day window + bars-mode split for gappy quote-derived corpora.
const fromDay = arg('from');
const toDay = arg('to');
const trainBarsArg = arg('train-bars');
if (!existsSync(archiveRoot) && !existsSync(driveRoot)) throw new Error(`neither archive root exists: ${archiveRoot} | ${driveRoot}`);

// Both evidence roots, local first: completed UTC days are MOVED to the Drive mirror
// hourly, so a whole-day corpus lives on Drive while the freshest partial day is local.
// Days present in both are read from local only (the mirror never diverges; belt and braces).
const roots = [archiveRoot, ...(existsSync(driveRoot) ? [driveRoot] : [])];
const seenDays = new Set<string>();
const dayFolders: { root: string; day: string }[] = [];
for (const rootDir of roots) {
  if (!existsSync(rootDir)) continue;
  for (const d of readdirSync(rootDir, { withFileTypes: true })) {
    if (!d.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(d.name) || seenDays.has(d.name)) continue;
    seenDays.add(d.name);
    dayFolders.push({ root: rootDir, day: d.name });
  }
}
dayFolders.sort((a, b) => a.day.localeCompare(b.day));
{
  const windowed = dayFolders.filter(f => (!fromDay || f.day >= fromDay) && (!toDay || f.day <= toDay));
  if (!windowed.length) throw new Error(`no day folders in the requested window ${fromDay ?? '(start)'}..${toDay ?? '(end)'}`);
  dayFolders.length = 0;
  dayFolders.push(...windowed);
}
if (!dayFolders.length) throw new Error('no UTC day folders in either archive root yet');
const driveDays = dayFolders.filter(f => f.root === driveRoot).length;

// Merge every capture of every day into one bar map; later captures (rolling r1/r2)
// refresh open/high/low/close of buckets they re-sample. Volume stays 0 by construction.
const bars = new Map<number, { openTime: number; open: number; high: number; low: number; close: number; volume: number; closeTime: number; samples: number }>();
let capturesRead = 0, capturesUsed = 0, midSamples = 0;
const perDayCounts = new Map<string, number>();
for (const { root: rootDir, day } of dayFolders) {
  let parseFailures = 0;
  // Cloud filters (Google Drive) can return PARTIAL listings on a cold enumeration:
  // list until the count stops growing (max 8 rounds) before reading.
  let files: string[] = [];
  for (let round = 0; round < 8; round++) {
    const listed = readdirSync(join(rootDir, day)).filter(f => f.endsWith('.json')).sort();
    if (listed.length === files.length) break;
    files = listed;
    await new Promise(r => setTimeout(r, 250));
  }
  for (const file of files) {
    let capture: CaptureObject;
    try { capture = JSON.parse(readFileSync(join(rootDir, day, file), 'utf8')); capturesRead++; } catch (error) { parseFailures++; if (parseFailures <= 3) console.log('  unreadable:', file, (error as Error).message.slice(0, 80)); continue; }
    const marketId = marketIdFor(capture, market);
    if (marketId === null) continue;
    capturesUsed++;
    captureBars(capture, marketId, bucketMs, bars);
    const dayKey = new Date(capture.manifest?.startedMs ?? 0).toISOString().slice(0, 10);
    console.log(`  ${day}: ${files.length} capture file(s), ${capturesRead} parsed, ${capturesUsed} with ${market}`);
    perDayCounts.set(day, (perDayCounts.get(day) ?? 0) + 1);
    void dayKey;
  }
}
for (const bar of bars.values()) midSamples += bar.samples;
const klines = toKlines(bars);

// Coverage accounting (review P0-07): raw quote counts create an illusion of depth.
// Report the EFFECTIVE sample: hours of sampled minutes vs the span the corpus covers.
const barTimes = klines.map(k => k.openTime);
const spanHours = barTimes.length > 1 ? (barTimes[barTimes.length - 1] - barTimes[0]) / 3600000 : 0;
const barsHours = Number((klines.length * (bucketMs / 3600000)).toFixed(2));
const coveragePct = spanHours > 0 ? Number((barsHours / spanHours * 100).toFixed(1)) : null;

const verdictsDir = join(root, 'research', 'verdicts');
mkdirSync(verdictsDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const insufficient = (reason: string): never => {
  const report = {
    generatedAt: new Date().toISOString(), kind: 'own-captures-walkforward', market, bucketSeconds: bucketMs / 1000,
    archive: { localRoot: archiveRoot, driveRoot, dayFolders: dayFolders.length, driveDays, capturesRead, capturesUsed, midSamples, bars: klines.length, barsHours, spanHours: Number(spanHours.toFixed(2)), coveragePct },
    verdict: { verified: [], rejected: [], overall: 'INSUFFICIENT' }, reason, canPromote: false,
    note: 'Not enough own-capture history yet. Keep recording; rerun as days accumulate.',
  };
  const path = join(verdictsDir, `${stamp}-own-captures.json`);
  writeFileSync(path, JSON.stringify(report, null, 1) + '\n');
  console.log(`INSUFFICIENT: ${reason}`);
  console.log(`report: ${path}`);
  process.exit(1);
};

if (capturesUsed === 0) insufficient(`no captures contain market ${market}`);
if (klines.length < 300) insufficient(`only ${klines.length} ${bucketMs / 1000}s bar(s) across ${dayFolders.length} day(s); need at least 300 (roughly train+holdout+runway)`);
console.log(`own captures: ${capturesUsed} capture(s) with ${market} -> ${klines.length} x ${bucketMs / 1000}s bars, ${midSamples} mid samples, ${dayFolders.length} day folder(s) (${driveDays} from the Drive mirror)`);

let train: typeof klines = [], holdout: typeof klines = [];
let splitMode: 'days' | 'bars' = 'days';
try {
  if (trainBarsArg !== null) {
    // Bars-mode split for gappy quote-derived corpora: day counts assume near-contiguous
    // coverage, which recorded reality often lacks. Contiguous time order is preserved.
    splitMode = 'bars';
    ({ train, holdout } = splitByBars(klines, Math.trunc(Number(trainBarsArg))));
  } else {
    ({ train, holdout } = splitWalkForward(klines, trainDays, holdoutDays));
  }
} catch (error) {
  // Not enough contiguous coverage for the requested split is an honest INSUFFICIENT,
  // not a crash: the corpus needs more recording days (or denser buckets).
  insufficient(`walk-forward split refused: ${(error as Error).message}. Keep recording and rerun as days accumulate.`);
}
const candidates = builtinStrategies.map(strategy => ({ strategyId: strategy.id, params: {} as Record<string, number> }));
const runLane = (series: typeof klines) => candidates.map(candidate => {
  const result = replayKlines({ registry, strategyId: candidate.strategyId, params: candidate.params,
    klines: series, symbol: market, capital, feeBps, notionalPerOrderUsd: notional, source: `own-captures ${market}` });
  return { candidate, id: configId(candidate.strategyId, candidate.params), result };
});
console.log(`split: train ${train.length} bars, holdout ${holdout.length} bars`);

const trainResults = runLane(train);
const trainEquities = trainResults.map(result => result.result.equity.filter((_, i) => i % equityStep === 0));
const minSampled = Math.min(...trainEquities.map(e => e.length));
if (minSampled < 102) insufficient(`train equity sampled at --equity-step ${equityStep} yields only ${minSampled} points; lower the step or record more days`);

const inputPath = join(verdictsDir, `${stamp}-own-captures-train-input.json`);
const trainVerdictPath = join(verdictsDir, `${stamp}-own-captures-train-verdict.json`);
writeFileSync(inputPath, JSON.stringify({ source: `own-captures ${market} | train ${trainDays}d`, configs: trainResults.map((result, i) => ({ id: result.id, equity: trainEquities[i] })) }), { encoding: 'utf8' });

const isWindows = process.platform === 'win32';
const pythonPath = join(root, 'research', '.venv', ...(isWindows ? ['Scripts', 'python.exe'] : ['bin', 'python']));
const spaPath = join(root, 'research', 'spa_verify.py');
if (!existsSync(pythonPath)) throw new Error('research/.venv is missing; create it and install research/requirements.txt first');
const run = Bun.spawnSync([pythonPath, spaPath, '--input', inputPath, '--output', trainVerdictPath, '--reps', String(reps), '--alpha', String(alpha)], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
if (!existsSync(trainVerdictPath)) throw new Error(`Verifier did not produce a verdict (exit ${run.exitCode}): ${run.stderr.toString().slice(0, 500)}`);
const trainVerdict = JSON.parse(readFileSync(trainVerdictPath, 'utf8'));
const trainSurvivors: string[] = trainVerdict.verdict === 'PASS' ? trainVerdict.stepm_survivors : [];

const holdoutResults = runLane(holdout);
const verdict = walkForwardVerdict({ candidates: candidates.map(c => configId(c.strategyId, c.params)),
  trainSurvivors, holdout: holdoutResults.map(result => ({ id: result.id, netPnl: result.result.netPnl })) });

const report = {
  generatedAt: new Date().toISOString(), kind: 'own-captures-walkforward', market, bucketSeconds: bucketMs / 1000,
  archive: { localRoot: archiveRoot, driveRoot, dayFolders: dayFolders.length, driveDays, capturesRead, capturesUsed, midSamples, bars: klines.length, barsHours, spanHours: Number(spanHours.toFixed(2)), coveragePct },
  split: { mode: splitMode, trainDays, holdoutDays, trainBars: train.length, holdoutBars: holdout.length, from: fromDay ?? null, to: toDay ?? null },
  screen: { alpha, reps, equityStep, trainSpaPvalue: trainVerdict.spa_pvalue, trainSurvivors, trainVerdict: trainVerdict.verdict },
  holdout: holdoutResults.map(result => ({ id: result.id, strategyId: result.candidate.strategyId, netPnl: result.result.netPnl, trades: result.result.trades.length, maxDrawdown: result.result.maxDrawdown })),
  verdict,
  canPromote: false,
  note: 'A PASS here is REAL venue evidence (our own Lighter captures) but never installs research/promotions.json itself; run scripts/research-promote.ts over the holdout captures to promote.',
};
const reportPath = join(verdictsDir, `${stamp}-own-captures.json`);
writeFileSync(reportPath, JSON.stringify(report, null, 1) + '\n');
console.log(JSON.stringify({ report: reportPath, trainVerdict: trainVerdict.verdict, trainSpaPvalue: trainVerdict.spa_pvalue, ...verdict }, null, 2));
process.exit(verdict.verified.length ? 0 : 1);
