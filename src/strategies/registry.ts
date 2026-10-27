import type { Strategy } from './types';

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
  list() { return [...this.strategies.values()].map(s => ({ id: s.id, name: s.name, description: s.description, params: s.params, hash: artifactHash(s) })); }
}

export function artifactHash(strategy: Strategy) {
  return new Bun.CryptoHasher('sha256').update(JSON.stringify({ id: strategy.id, name: strategy.name, description: strategy.description, params: strategy.params, evaluate: String(strategy.evaluate) })).digest('hex');
}
