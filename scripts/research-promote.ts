/** Single-capture research SCREEN (legacy command name; never promotes).
 *
 *  Replays candidates over ONE capture and archives a SPA/StepM screen. Even PASS
 *  is in-sample evidence, not untouched independent holdout or production-like
 *  research approval. This command NEVER writes research/promotions.json; existing
 *  PAPER allowlists are left untouched. No manifest remains explicitly unverified
 *  PAPER experimentation, not an implicit research approval.
 *
 *  Usage:
 *    bun run scripts/research-promote.ts --capture <exported-capture.json> --market SYMBOL
 *        [--configs <configs.json>] [--capital 10000] [--fee-bps 2] [--leverage 1]
 *        [--notional 1000] [--alpha 0.05] [--reps 2000]
 *    bun run scripts/research-promote.ts --check
 *
 *  --configs is a JSON array of { "strategyId": "...", "params": {...} } (at least 2
 *  entries; the default is the three built-ins at their default params). */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { replayCapture, type ReplayCapture } from '../src/lighter-evidence';
import { REPLAY_SIMULATOR_VERSION, framesFromCapture, replayStrategy } from '../src/backtest-replay';
import { builtinStrategies } from '../src/strategies/builtin';
import { researchStrategies } from '../src/strategies/research';
import type { ReplayFundingHistory } from '../src/replay-funding';
import { StrategyRegistry, artifactHash } from '../src/strategies/registry';
import { validateParams } from '../src/strategies/types';
import { configId, loadPromotionGate, sha256File, manifestErrors, type PromotionManifest } from '../src/promotion';

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

if (args.includes('--check')) {
  const gate = loadPromotionGate(join(root, 'research', 'promotions.json'), join(root, 'research', 'spa_verify.py'));
  console.log(JSON.stringify(gate.describe(), null, 2));
  process.exit(gate.mode === 'refusing' ? 1 : 0);
}

const capturePath = arg('capture');
const marketSymbol = arg('market');
if (!capturePath || !marketSymbol) {
  throw new Error('Usage: bun run scripts/research-promote.ts --capture <exported-capture.json> --market SYMBOL (or --check)');
}
const captureFile = resolve(capturePath);
if (Bun.file(captureFile).size > 16 * 1024 * 1024) throw new Error('Capture export exceeds the 16 MiB replay bound');

// 1. Load and tamper-check the capture: replayCapture verifies the embedded sha256,
//    frame order, sizes and market manifest before anything is scored.
const capture = await Bun.file(captureFile).json() as ReplayCapture;
replayCapture(capture);
const market = capture.manifest.markets.find((m: any) => m.symbol === marketSymbol);
if (!market) {
  throw new Error(`Capture does not include market ${marketSymbol}; it has: ${capture.manifest.markets.map((m: any) => m.symbol).join(', ')}`);
}
const frames = framesFromCapture(capture);
const fundingPath = arg('funding');
let fundingHistory: ReplayFundingHistory | undefined;
if (fundingPath) {
  const file = Bun.file(resolve(fundingPath));
  if (file.size > 2 * 1024 * 1024) throw new Error('Funding evidence exceeds 2MiB');
  fundingHistory = await file.json(); // replay validates identity, digest, coverage and finality-policy bounds
}

// 2. Candidate configurations. Defaults cover every built-in at its default params.
type Candidate = { strategyId: string; params: Record<string, number> };
let candidates: Candidate[] = builtinStrategies.map(strategy => ({ strategyId: strategy.id, params: {} }));
const configsPath = arg('configs');
if (configsPath) {
  const raw = await Bun.file(resolve(configsPath)).json();
  if (!Array.isArray(raw) || raw.length < 2) throw new Error('--configs must be a JSON array of at least 2 entries');
  candidates = raw.map((entry: any) => {
    if (!entry || typeof entry.strategyId !== 'string') throw new Error('Every config needs a strategyId');
    if (entry.params !== undefined && (typeof entry.params !== 'object' || entry.params === null)) throw new Error('Config params must be an object');
    return { strategyId: entry.strategyId, params: entry.params ?? {} } as Candidate;
  });
}
if (candidates.length < 2) throw new Error('The SPA gate needs at least 2 configurations to correct for multiplicity');
const ids = candidates.map(candidate => configId(candidate.strategyId, candidate.params));
if (new Set(ids).size !== ids.length) throw new Error('Duplicate configurations (same strategy and params)');

// 3. Replay each configuration over the same frames; equity curves must align exactly,
//    because the verifier compares them point by point.
const capital = num('capital', 10000);
const feeBps = Math.trunc(num('fee-bps', 2));
const leverage = Math.trunc(num('leverage', 1));
const notionalPerOrderUsd = num('notional', Math.min(1000, capital - 1));
const executionDelayMs = Math.trunc(num('delay-ms', 300));
const maxDepthLevels = Math.trunc(num('depth', 5));
const worstPriceBps = Math.trunc(num('worst-bps', 10));
const expiresDays = Math.trunc(num('expires-days', 30));
const maxNotionalPerOrderUsd = num('max-notional', notionalPerOrderUsd);
if (expiresDays < 1 || expiresDays > 3650) throw new Error('Invalid --expires-days (1..3650)');
const results = candidates.map(candidate => ({
  candidate,
  id: configId(candidate.strategyId, candidate.params),
  resolvedParams: validateParams(registry.get(candidate.strategyId), candidate.params),
  replay: replayStrategy({ registry, strategyId: candidate.strategyId, params: candidate.params, market, frames,
    staleMs: capture.manifest.staleMs, marketStats: capture.manifest.marketStats,
    capital, feeBps, leverage, notionalPerOrderUsd, executionDelayMs, maxDepthLevels, worstPriceBps, fundingHistory }),
}));
// Funding rates are not settlement cashflows. Funding-dependent strategies remain
// ineligible until the replay has a verified venue settlement model, even with samples.
const ineligible = results.filter(result => result.replay.fundingIneligible);
if (ineligible.length) console.log(JSON.stringify({ fundingIneligible: ineligible.map(result => result.id), reason: 'funding-dependent strategies are not graded without a verified venue settlement model; rate samples alone are insufficient' }));
const gradedResults = results.filter(result => !result.replay.fundingIneligible);
if (gradedResults.length < 2) throw new Error('Fewer than 2 eligible configurations after funding-ineligibility exclusion; funding-dependent strategies require a verified venue settlement model, not merely more rate samples');
const lengths = gradedResults.map(result => result.replay.equity.length);
if (new Set(lengths).size !== 1) {
  throw new Error(`Equity curves misaligned (${results.map(result => `${result.id}: ${result.replay.equity.length}`).join(', ')}); all configs must share one capture and market`);
}
if (lengths[0] < 102) {
  throw new Error(`Only ${lengths[0]} equity observations from this capture; the verifier needs more than 100. Record a longer capture.`);
}

// 4. Export the verifier input and run research/spa_verify.py in the project venv.
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const verdictsDir = join(root, 'research', 'verdicts');
mkdirSync(verdictsDir, { recursive: true });
const inputPath = join(verdictsDir, `${stamp}-input.json`);
const verdictPath = join(verdictsDir, `${stamp}-verdict.json`);
writeFileSync(inputPath, JSON.stringify({
  source: `${basename(captureFile)} | market ${marketSymbol} | ${frames.length} frames`,
  configs: gradedResults.map(result => ({ id: result.id, equity: result.replay.equity })),
}), { encoding: 'utf8' });

const isWindows = process.platform === 'win32';
const pythonPath = join(root, 'research', '.venv', ...(isWindows ? ['Scripts', 'python.exe'] : ['bin', 'python']));
const spaPath = join(root, 'research', 'spa_verify.py');
if (!existsSync(pythonPath)) {
  throw new Error('research/.venv is missing; create it and install research/requirements.txt first');
}
const reps = Math.trunc(num('reps', 2000));
const alpha = num('alpha', 0.05);
if (reps < 100 || !(alpha > 0 && alpha < 1)) throw new Error('Screen requires --reps >= 100 and 0 < --alpha < 1');
const run = Bun.spawnSync([pythonPath, spaPath, '--input', inputPath, '--output', verdictPath,
  '--reps', String(reps), '--alpha', String(alpha)], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
if (!existsSync(verdictPath)) {
  throw new Error(`Verifier did not produce a verdict (exit ${run.exitCode}): ${run.stderr.toString().slice(0, 500)}`);
}
const verdict = JSON.parse(readFileSync(verdictPath, 'utf8'));
const verdictSha256 = new Bun.CryptoHasher('sha256').update(readFileSync(verdictPath)).digest('hex');

// 5. Validate the screen output, but NEVER convert an in-sample PASS to approval.
if (run.exitCode !== (verdict.verdict === 'PASS' ? 0 : 1)) throw new Error('Verifier exit status disagrees with verdict');
if (verdict.alpha !== alpha || verdict.reps !== reps || verdict.samples !== lengths[0] - 1 ||
    !Array.isArray(verdict.ids) || JSON.stringify(verdict.ids) !== JSON.stringify(gradedResults.map(result => result.id)) ||
    verdict.configs !== gradedResults.length || !Array.isArray(verdict.stepm_survivors) ||
    new Set(verdict.stepm_survivors).size !== verdict.stepm_survivors.length) throw new Error('Verifier output does not match submitted screen');
const screenOnly = { installed: false, canPromote: false, paperOnly: true, researchApproved: false,
  independentHoldout: false, evidenceKind: 'single-capture-spa-screen',
  reason: 'Single-capture SPA is in-sample screening, not independent holdout evidence; no research approval or promotion is installed.' } as const;
if (verdict.verdict !== 'PASS') {
  console.log(JSON.stringify({ ...screenOnly, verdict: verdict.verdict, reasons: verdict.reasons, verdictFile: verdictPath }, null, 2));
  process.exit(1);
}
const byId = new Map(gradedResults.map(result => [result.id, result]));
const entries = (verdict.stepm_survivors as string[]).map(id => {
  const result = byId.get(id);
  if (!result) throw new Error(`Verifier named unknown survivor: ${id}`);
  return {
    strategyId: result.candidate.strategyId,
    params: result.resolvedParams,
    artifactHash: artifactHash(registry.get(result.candidate.strategyId)),
    spaPvalue: verdict.spa_pvalue,
  };
});
if (!entries.length) throw new Error('PASS verdict without StepM survivors; refusing to install an empty manifest');
const manifest: PromotionManifest = {
  version: 2,
  generatedAt: verdict.generatedAt,
  capture: { sha256: capture.sha256, market: marketSymbol, frames: frames.length },
  alpha: verdict.alpha,
  reps: verdict.reps,
  samples: verdict.samples,
  simulatorVersion: REPLAY_SIMULATOR_VERSION,
  expiresAt: new Date(Date.parse(verdict.generatedAt) + expiresDays * 86400000).toISOString(),
  maxNotionalPerOrderUsd: maxNotionalPerOrderUsd,
  verifierSha256: sha256File(spaPath),
  verdictSha256,
  entries,
};
const errors = manifestErrors(manifest);
if (errors.length) throw new Error(`Invalid screen artifact: ${errors.join('; ')}`);
// Archive provenance/envelope as a NON-installable screen, not a promotion manifest.
const screenPath = join(verdictsDir, `${stamp}-screen.json`);
writeFileSync(screenPath, `${JSON.stringify({ ...screenOnly, screen: manifest, verdictFile: verdictPath }, null, 1)}\n`, { encoding: 'utf8' });
console.log(JSON.stringify({ ...screenOnly, screenFile: screenPath, survivors: entries.map(entry => entry.strategyId), spaPvalue: verdict.spa_pvalue, samples: verdict.samples, verdictFile: verdictPath }, null, 2));
process.exit(1); // Successful screening is still a refused promotion request.
