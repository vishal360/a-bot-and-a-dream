import { readdirSync } from 'node:fs';
import { validateParams, type Strategy } from './strategies/types';

export type SweepAttempt = { strategyId: string; params: Record<string, number> };

/** Parse a grid spec of the form "lookback=20,50,100;stopPct=0.005,0.01" into
 *  {lookback: [20,50,100], stopPct: [0.005,0.01]}. Keys must match [A-Za-z_][A-Za-z0-9_]*,
 *  every value must be a finite number. Empty segments and malformed pairs throw. */
export function parseGrid(spec: string): Record<string, number[]> {
  if (typeof spec !== 'string' || !spec.trim()) throw new Error('Empty grid spec');
  const out: Record<string, number[]> = {};
  for (const segment of spec.split(';')) {
    if (!segment.trim()) continue;
    const eq = segment.indexOf('=');
    if (eq <= 0) throw new Error(`Invalid grid segment "${segment}" (expected key=v1,v2,...)`);
    const key = segment.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid grid key "${key}"`);
    if (out[key]) throw new Error(`Duplicate grid key "${key}"`);
    const values = segment.slice(eq + 1).split(',').map(v => {
      const n = Number(v.trim());
      if (!Number.isFinite(n)) throw new Error(`Invalid grid value "${v.trim()}" for key "${key}"`);
      return n;
    });
    if (!values.length) throw new Error(`Grid key "${key}" has no values`);
    out[key] = values;
  }
  if (!Object.keys(out).length) throw new Error('Grid spec produced no parameters');
  return out;
}

/** Cartesian product of the grid, in key order, validated against the strategy's
 *  parameter spec. Every produced attempt is a config the sweep REALLY tried —
 *  this file is what `research-walkforward --attempts` consumes so the SPA input
 *  counts every chance taken, not just the survivors. */
export function buildAttempts(strategy: Strategy, grid: Record<string, number[]>): SweepAttempt[] {
  const keys = Object.keys(grid);
  const unknown = keys.filter(k => !strategy.params.some(p => p.key === k));
  if (unknown.length) throw new Error(`Grid keys not in ${strategy.id} params: ${unknown.join(', ')}`);
  const attempts: SweepAttempt[] = [];
  const walk = (index: number, params: Record<string, number>) => {
    if (index === keys.length) {
      validateParams(strategy, params); // range/integrality violations fail the sweep honestly
      attempts.push({ strategyId: strategy.id, params: { ...params } });
      return;
    }
    for (const value of grid[keys[index]]) walk(index + 1, { ...params, [keys[index]]: value });
  };
  walk(0, {});
  if (!attempts.length) throw new Error('Grid produced zero attempts');
  return attempts;
}

/** Load the builtin registry lazily so callers (and the CLI) share one construction. */
export function builtinRegistry() {
  // Imported lazily to keep this module cheap to unit-test in isolation.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { builtinStrategies } = require('./strategies/builtin') as typeof import('./strategies/builtin');
  const { StrategyRegistry } = require('./strategies/registry') as typeof import('./strategies/registry');
  const registry = new StrategyRegistry();
  for (const strategy of builtinStrategies) registry.register(strategy);
  return registry;
}

export function attemptsToJsonl(attempts: SweepAttempt[]): string {
  return attempts.map(a => JSON.stringify(a)).join('\n') + '\n';
}

export function countAttempts(dir: string): number {
  return readdirSync(dir).filter(f => f.endsWith('.jsonl')).length;
}
