import type { Strategy } from './types';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ID = /^[a-z0-9-]{2,60}$/;

/** Immutable in-process registry. One file per strategy, registered once at startup.
 *  The hash freezes the exact evaluate function + parameter spec as the artifact identity
 *  recorded in the decision journal; it changes whenever strategy code changes. */
export class StrategyRegistry {
  private strategies = new Map<string, Strategy>();
  register(strategy: Strategy) {
    if (!ID.test(strategy.id)) throw new Error(`Invalid strategy id: ${strategy.id}`);
    if (this.strategies.has(strategy.id)) throw new Error(`Duplicate strategy id: ${strategy.id}`);
    if (!strategy.name || !strategy.description || !Array.isArray(strategy.params)) throw new Error(`Invalid strategy metadata: ${strategy.id}`);
    for (const p of strategy.params) {
      if (!p.key || !/^[a-z][a-zA-Z0-9]{0,30}$/.test(p.key) || !Number.isFinite(p.min) || !Number.isFinite(p.max) || p.min >= p.max ||
          !Number.isFinite(p.default) || p.default < p.min || p.default > p.max) throw new Error(`Invalid parameter spec on ${strategy.id}.${p.key}`);
    }
    if (typeof strategy.evaluate !== 'function') throw new Error(`Strategy ${strategy.id} has no evaluate`);
    this.strategies.set(strategy.id, strategy);
  }
  get(id: string): Strategy {
    if (!ID.test(id)) throw new Error('Invalid strategy id');
    const strategy = this.strategies.get(id);
    if (!strategy) throw new Error(`Unknown strategy: ${id}. Registered: ${[...this.strategies.keys()].join(', ') || 'none'}`);
    return strategy;
  }
  has(id: string) { return ID.test(id) && this.strategies.has(id); }
  list() { return [...this.strategies.values()].map(s => ({ id: s.id, name: s.name, description: s.description, params: s.params, researchOnly: s.researchOnly === true, hash: artifactHash(s) })); }
}

export function artifactHash(strategy: Strategy) {
  const sources = (strategy.artifactSources ?? []).map(file => {
    if (!/^src\/strategies\/[A-Za-z0-9_-]+\.ts$/.test(file)) throw new Error('Invalid strategy artifact source');
    const bytes = readFileSync(resolve(import.meta.dir, '..', '..', file));
    return { file, sha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex') };
  });
  return new Bun.CryptoHasher('sha256').update(JSON.stringify({ id: strategy.id, name: strategy.name, description: strategy.description, params: strategy.params, researchOnly: strategy.researchOnly === true, fundingDependent: strategy.fundingDependent === true, artifactSources: sources, evaluate: String(strategy.evaluate) })).digest('hex');
}
