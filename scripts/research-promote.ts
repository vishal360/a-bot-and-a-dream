/** Research lane v2 promotion pipeline (docs/FLEET.md, "Research promotion gate").
 *
 *  Replays candidate strategy configurations over ONE exported capture (same market,
 *  same frames, no look-ahead), exports the equity curves, runs the SPA/StepM
 *  verifier (research/spa_verify.py) and - only on a PASS verdict - installs
 *  research/promotions.json, the manifest the fleet's promotion gate enforces.
 *  A FAIL verdict is archived under research/verdicts/ (git-ignored) and installs
 *  nothing: no verdict, no promotion.
 *
 *  Usage:
 *    bun run scripts/research-promote.ts --capture <exported-capture.json> --market SYMBOL
 *        [--configs <configs.json>] [--capital 10000] [--fee-bps 2] [--leverage 1]
 *        [--notional 1000] [--alpha 0.05] [--reps 2000]
 *    bun run scripts/research-promote.ts --check
 *
 *  --configs is a JSON array of { "strategyId": "...", "params": {...} } (at least 2
 *  entries; the default is the three built-ins at their default params). */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { replayCapture, type ReplayCapture } from '../src/lighter-evidence';
import { framesFromCapture, replayStrategy } from '../src/backtest-replay';
import { builtinStrategies } from '../src/strategies/builtin';
import { StrategyRegistry, artifactHash } from '../src/strategies/registry';
import { validateParams } from '../src/strategies/types';
import { configId, loadPromotionGate, sha256File, type PromotionManifest } from '../src/promotion';

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
const results = candidates.map(candidate => ({
  candidate,
  id: configId(candidate.strategyId, candidate.params),
  resolvedParams: validateParams(registry.get(candidate.strategyId), candidate.params),
  replay: replayStrategy({ registry, strategyId: candidate.strategyId, params: candidate.params, market, frames,
    staleMs: capture.manifest.staleMs, marketStats: capture.manifest.marketStats,
    capital, feeBps, leverage, notionalPerOrderUsd }),
}));
const lengths = results.map(result => result.replay.equity.length);
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
  configs: results.map(result => ({ id: result.id, equity: result.replay.equity })),
}), { encoding: 'utf8' });

const isWindows = process.platform === 'win32';
const pythonPath = join(root, 'research', '.venv', ...(isWindows ? ['Scripts', 'python.exe'] : ['bin', 'python']));
const spaPath = join(root, 'research', 'spa_verify.py');
if (!existsSync(pythonPath)) {
  throw new Error('research/.venv is missing; create it and install research/requirements.txt first');
}
const reps = Math.trunc(num('reps', 2000));
const alpha = num('alpha', 0.05);
const run = Bun.spawnSync([pythonPath, spaPath, '--input', inputPath, '--output', verdictPath,
  '--reps', String(reps), '--alpha', String(alpha)], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
if (!existsSync(verdictPath)) {
  throw new Error(`Verifier did not produce a verdict (exit ${run.exitCode}): ${run.stderr.toString().slice(0, 500)}`);
}
const verdict = JSON.parse(readFileSync(verdictPath, 'utf8'));
const verdictSha256 = new Bun.CryptoHasher('sha256').update(readFileSync(verdictPath)).digest('hex');

// 5. Only a PASS installs the manifest; a FAIL is evidence, not promotion.
if (verdict.verdict !== 'PASS') {
  console.log(JSON.stringify({ installed: false, verdict: verdict.verdict, reasons: verdict.reasons, verdictFile: verdictPath }, null, 2));
  process.exit(1);
}
const byId = new Map(results.map(result => [result.id, result]));
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
  version: 1,
  generatedAt: verdict.generatedAt,
  capture: { sha256: capture.sha256, market: marketSymbol, frames: frames.length },
  alpha: verdict.alpha,
  reps: verdict.reps,
  samples: verdict.samples,
  verifierSha256: sha256File(spaPath),
  verdictSha256,
  entries,
};
const manifestPath = join(root, 'research', 'promotions.json');
const tmpPath = `${manifestPath}.tmp`;
writeFileSync(tmpPath, `${JSON.stringify(manifest, null, 1)}\n`, { encoding: 'utf8' });
renameSync(tmpPath, manifestPath);
console.log(JSON.stringify({ installed: true, manifest: manifestPath, promoted: entries.map(entry => entry.strategyId), spaPvalue: verdict.spa_pvalue, samples: verdict.samples, verdictFile: verdictPath }, null, 2));
