/** Walk-forward research grader over downloaded history (docs/HISTORY_BACKFILL.md).
 *
 *  Two-tier honesty: candidates are screened on the TRAIN window by the same
 *  multiplicity-corrected SPA/StepM verifier (research/spa_verify.py) used for
 *  promotions, then the survivors face the untouched HOLDOUT window. A config is
 *  "walk-forward-verified" only if it survives BOTH. This script NEVER installs
 *  research/promotions.json — historical data can only screen candidates; promotion
 *  stays Lighter-capture-only by design (scripts/research-promote.ts).
 *
 *  Usage:
 *    bun run scripts/research-walkforward.ts --history data/history/binance-spot-BTCUSDT-1s
 *        [--market BTC] [--train-days 20] [--holdout-days 5] [--configs <json>]
 *        [--alpha 0.05] [--reps 2000] [--equity-step 300] [--capital 10000] [--fee-bps 2] [--notional 1000]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { replayKlines, type Kline } from '../src/backtest-klines';
import { builtinStrategies } from '../src/strategies/builtin';
import { researchStrategies } from '../src/strategies/research';
import { StrategyRegistry } from '../src/strategies/registry';
import { validateParams } from '../src/strategies/types';
import { configId } from '../src/promotion';
import { splitWalkForward, walkForwardVerdict } from '../src/walkforward';
import { assessDayQuality } from '../src/backfill-quality';

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
for (const strategy of [...builtinStrategies, ...researchStrategies]) registry.register(strategy);

const historyDir = resolve(arg('history') ?? 'data/history/binance-spot-BTCUSDT-1s');
const metaPath = join(historyDir, 'meta.json');
if (!existsSync(metaPath)) throw new Error(`Not a history directory (meta.json missing): ${historyDir}`);
const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
const market = arg('market') ?? String(meta.symbol ?? 'BTCUSDT').replace(/USDT$/, '');
const trainDays = Math.trunc(num('train-days', 20));
const holdoutDays = Math.trunc(num('holdout-days', 5));
const alpha = num('alpha', 0.05);
const reps = Math.trunc(num('reps', 2000));
const equityStep = Math.trunc(num('equity-step', 300));
const capital = num('capital', 10000);
const feeBps = Math.trunc(num('fee-bps', 2));
const notional = num('notional', Math.min(1000, capital - 1));

const dayFiles = readdirSync(historyDir).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
if (dayFiles.length < 2) throw new Error('Need at least two day files in the history directory');
const allowBadQuality = args.includes('--allow-bad-quality');
const klines: Kline[] = [];
const qualitySummary: Record<string, { verdict: string; problems: number }> = {};
const badDays: string[] = [];
for (const f of dayFiles) {
  const dayKlines: Kline[] = [];
  for (const line of readFileSync(join(historyDir, f), 'utf8').split(/\r?\n/).filter(Boolean)) dayKlines.push(JSON.parse(line) as Kline);
  // Fail-closed quality gate: every day is RE-ASSESSED from the data itself (a stale or
  // missing quality file cannot sneak a bad day through), and a recorded 'bad' verdict
  // file stands even if the re-assessment would pass (recorded badness is not forgiven).
  const quality = assessDayQuality(dayKlines, f.replace('.jsonl', ''));
  const recordedPath = join(historyDir, 'quality', f.replace('.jsonl', '.json'));
  if (existsSync(recordedPath)) {
    const recorded = JSON.parse(readFileSync(recordedPath, 'utf8'));
    if (recorded.verdict === 'bad') quality.verdict = 'bad';
  }
  qualitySummary[quality.day] = { verdict: quality.verdict, problems: quality.problems.length };
  if (quality.verdict === 'bad') badDays.push(`${quality.day}: ${quality.problems.slice(0, 3).map(p => p.detail).join('; ') || 'verdict bad'}`);
  klines.push(...dayKlines);
}
if (badDays.length && !allowBadQuality) {
  throw new Error(`Refusing to grade: ${badDays.length} day file(s) failed the quality gate (${badDays.slice(0, 2).join(' | ')}). Remove or re-download them, or pass --allow-bad-quality to proceed with the refusals recorded in the report.`);
}
const degradedDays = Object.entries(qualitySummary).filter(([, q]) => q.verdict === 'degraded').map(([d]) => d);
const funding = existsSync(join(historyDir, 'funding.jsonl'))
  ? readFileSync(join(historyDir, 'funding.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as { time: number; rate: number })
  : [];

type Candidate = { strategyId: string; params: Record<string, number> };
let candidates: Candidate[] = builtinStrategies.map(strategy => ({ strategyId: strategy.id, params: {} }));
const configsPath = arg('configs');
if (configsPath) {
  const raw = await Bun.file(resolve(configsPath)).json();
  if (!Array.isArray(raw) || raw.length < 2) throw new Error('--configs must be a JSON array of at least 2 entries');
  candidates = raw.map((entry: any) => {
    if (!entry || typeof entry.strategyId !== 'string') throw new Error('Every config needs a strategyId');
    return { strategyId: entry.strategyId, params: entry.params ?? {} } as Candidate;
  });
}
// Multiplicity accounting (docs/HISTORY_BACKFILL.md): the SPA input must count EVERY
// configuration the sweep tried, not just the interesting survivors. --attempts takes
// a JSONL file of {strategyId, params} lines exported by the sweep tool; that is the
// honest way to grade a sweep. Without it, only the candidates listed here count.
const attemptsFile = arg('attempts');
if (attemptsFile) {
  const lines = readFileSync(resolve(attemptsFile), 'utf8').split(/\r?\n/).filter(Boolean);
  const attempts: Candidate[] = lines.map((line, idx) => {
    const entry = JSON.parse(line);
    if (!entry || typeof entry.strategyId !== 'string') throw new Error(`--attempts line ${idx + 1} needs a strategyId`);
    return { strategyId: entry.strategyId, params: entry.params ?? {} } as Candidate;
  });
  candidates = attempts;
}
if (candidates.length < 2) throw new Error('The SPA screen needs at least 2 configurations to correct for multiplicity');
const ids = candidates.map(candidate => configId(candidate.strategyId, candidate.params));
if (new Set(ids).size !== ids.length) throw new Error('Duplicate configurations (same strategy and params)');

const { train, holdout } = splitWalkForward(klines, trainDays, holdoutDays);
const source = `${meta.source ?? 'unknown'} ${meta.symbol ?? ''} ${meta.interval ?? ''}`.trim();

const executionModel = arg('execution') === 'maker-conservative' ? 'maker-conservative' as const : 'taker' as const;
const runLane = (series: Kline[]) => candidates.map(candidate => {
  const result = replayKlines({ registry, strategyId: candidate.strategyId, params: candidate.params,
    klines: series, funding, symbol: market, capital, feeBps, notionalPerOrderUsd: notional, source, executionModel });
  return { candidate, id: configId(candidate.strategyId, candidate.params),
    resolvedParams: validateParams(registry.get(candidate.strategyId), candidate.params), result };
});

console.log(`history: ${klines.length} candles (${dayFiles[0].slice(0, 10)} .. ${dayFiles[dayFiles.length - 1].slice(0, 10)}), funding events: ${funding.length}`);
console.log(`split: train ${train.length} candles, holdout ${holdout.length} candles (last ${holdoutDays} day(s))`);

const trainResults = runLane(train);
const trainEquities = trainResults.map(result => result.result.equity.filter((_, i) => i % equityStep === 0));
const minSampled = Math.min(...trainEquities.map(e => e.length));
if (minSampled < 102) throw new Error(`Train equity sampled at --equity-step ${equityStep} yields only ${minSampled} points; lower the step or download more days`);

const verdictsDir = join(root, 'research', 'verdicts');
mkdirSync(verdictsDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const inputPath = join(verdictsDir, `${stamp}-walkforward-train-input.json`);
const trainVerdictPath = join(verdictsDir, `${stamp}-walkforward-train-verdict.json`);
writeFileSync(inputPath, JSON.stringify({ source: `${source} | walkforward train ${trainDays}d`,
  configs: trainResults.map((result, i) => ({ id: result.id, equity: trainEquities[i] })) }), { encoding: 'utf8' });

const isWindows = process.platform === 'win32';
const pythonPath = join(root, 'research', '.venv', ...(isWindows ? ['Scripts', 'python.exe'] : ['bin', 'python']));
const spaPath = join(root, 'research', 'spa_verify.py');
if (!existsSync(pythonPath)) throw new Error('research/.venv is missing; create it and install research/requirements.txt first');
const run = Bun.spawnSync([pythonPath, spaPath, '--input', inputPath, '--output', trainVerdictPath,
  '--reps', String(reps), '--alpha', String(alpha)], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
if (!existsSync(trainVerdictPath)) throw new Error(`Verifier did not produce a verdict (exit ${run.exitCode}): ${run.stderr.toString().slice(0, 500)}`);
const trainVerdict = JSON.parse(readFileSync(trainVerdictPath, 'utf8'));
const trainSurvivors: string[] = trainVerdict.verdict === 'PASS' ? trainVerdict.stepm_survivors : [];

const holdoutResults = runLane(holdout);
const holdoutPnl = holdoutResults.map(result => ({ id: result.id, netPnl: result.result.netPnl }));
const verdict = walkForwardVerdict({ candidates: ids, trainSurvivors, holdout: holdoutPnl });

const report = {
  generatedAt: new Date().toISOString(),
  history: { source, symbol: meta.symbol, interval: meta.interval, candles: klines.length, fundingEvents: funding.length },
  split: { trainDays, holdoutDays, trainCandles: train.length, holdoutCandles: holdout.length },
  quality: { refusedDays: badDays.length, allowedBad: allowBadQuality && badDays.length > 0, degradedDays, badDays },
  multiplicity: { candidates: candidates.length, attemptsFile: attemptsFile ?? null, note: 'The SPA screen corrects for exactly these candidates; grade sweeps with --attempts so every tried configuration counts.' },
  execution: { model: executionModel, note: executionModel === 'maker-conservative' ? 'maker-conservative: strict trade-through fills, taker fees, TTL cancel with taker fallback on exits' : 'taker: next-open fills with spread' },
  screen: { alpha, reps, equityStep, trainSpaPvalue: trainVerdict.spa_pvalue, trainSurvivors, trainVerdict: trainVerdict.verdict, trainReasons: trainVerdict.reasons },
  holdout: holdoutResults.map(result => ({ id: result.id, strategyId: result.candidate.strategyId, netPnl: result.result.netPnl, trades: result.result.trades.length, fees: result.result.feesUsd, maxDrawdown: result.result.maxDrawdown })),
  verdict,
  canPromote: false,
  note: 'Historical walk-forward verification NEVER installs research/promotions.json; only Lighter-capture PASS verdicts can promote (scripts/research-promote.ts).',
};
const reportPath = join(verdictsDir, `${stamp}-walkforward.json`);
writeFileSync(reportPath, JSON.stringify(report, null, 1) + '\n');
console.log(JSON.stringify({ report: reportPath, trainVerdict: trainVerdict.verdict, trainSpaPvalue: trainVerdict.spa_pvalue, ...verdict }, null, 2));
process.exit(verdict.verified.length ? 0 : 1);
