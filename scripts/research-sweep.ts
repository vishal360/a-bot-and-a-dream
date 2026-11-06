/** Sweep-attempts generator (docs/HISTORY_BACKFILL.md): parameter sweeps are where
 *  multiplicity cheating sneaks in — try 50 combos and the best one looks great by
 *  luck. This tool turns a grid spec into the EXHAUSTIVE attempts file that
 *  `research-walkforward --attempts` consumes, so the SPA input counts every
 *  configuration the sweep really tried. Attempts are transient inputs and live in
 *  git-ignored data/sweeps; the verdicts they produce land in research/verdicts.
 *
 *  Usage:
 *    bun run scripts/research-sweep.ts --strategy breakout-v1 \
 *        --grid "lookback=20,50,100;stopPct=0.005,0.01" [--out data/sweeps/breakout.jsonl]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseGrid, buildAttempts, attemptsToJsonl, builtinRegistry } from '../src/sweep-grid';

const root = resolve(import.meta.dir, '..');
const args = process.argv.slice(2);
const arg = (name: string): string | null => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : null;
};

const strategyId = arg('strategy');
const gridSpec = arg('grid');
const outPath = resolve(arg('out') ?? join(root, 'data', 'sweeps', `${strategyId ?? 'sweep'}-attempts.jsonl`));
if (!strategyId) throw new Error('--strategy is required');
if (!gridSpec) throw new Error('--grid is required (e.g. "lookback=20,50,100;stopPct=0.005,0.01")');

const registry = builtinRegistry();
const strategy = registry.get(strategyId);
const attempts = buildAttempts(strategy, parseGrid(gridSpec));

mkdirSync(join(outPath, '..'), { recursive: true });
writeFileSync(outPath, attemptsToJsonl(attempts));
console.log(`wrote ${attempts.length} attempt(s) for ${strategyId} -> ${outPath}`);
console.log(`grade the sweep honestly: bun run scripts/research-walkforward.ts --attempts ${outPath} --history <history-dir>`);
