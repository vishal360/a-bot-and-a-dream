import { test, expect } from 'bun:test';
import { PromotionGate, canonicalParams, configId, manifestErrors, type PromotionManifest } from '../src/promotion';
import { FleetManager, type FleetFeed, type FleetPaper } from '../src/fleet';
import { DecisionJournal } from '../src/journal';
import { FeedHealthGuard, feedPolicyDefaults } from '../src/feed-health';
import { StrategyRegistry, artifactHash } from '../src/strategies/registry';
import { breakoutV1 } from '../src/strategies/builtin';
import { Store } from '../src/store';
import type { Strategy } from '../src/strategies/types';

const VERIFIER = 'a'.repeat(64);

function stubStrategy(overrides: Partial<Strategy> = {}): Strategy {
  return { id: 'always-open', name: 'Always open', description: 'test stub',
    params: [{ key: 'threshold', label: 'Threshold', min: 0, max: 1, default: 0.5 }],
    evaluate: () => ({ action: 'open', side: 'buy', rationale: 'stub open' }), ...overrides };
}

/** The pipeline promotes validated (resolved) params; mirror that here. */
function resolvedDefaults(strategy: Strategy): Record<string, number> {
  const resolved: Record<string, number> = {};
  for (const spec of strategy.params) resolved[spec.key] = spec.default;
  return resolved;
}

function manifestFor(strategy: Strategy, overrides: any = {}): PromotionManifest {
  return {
    version: 1, generatedAt: '2026-10-28T00:00:00.000Z',
    capture: { sha256: 'b'.repeat(64), market: 'BTC', frames: 1500 },
    alpha: 0.05, reps: 2000, samples: 1200,
    verifierSha256: VERIFIER, verdictSha256: 'c'.repeat(64),
    entries: [{ strategyId: strategy.id, params: resolvedDefaults(strategy), artifactHash: artifactHash(strategy), spaPvalue: 0.01 }],
    ...overrides,
  };
}

test('canonical params and config ids are order-stable and reject junk', () => {
  expect(canonicalParams({ b: 1, a: 2 })).toBe(canonicalParams({ a: 2, b: 1 }));
  expect(() => canonicalParams({ a: Number.NaN })).toThrow();
  expect(configId('breakout-v1', {})).toBe(configId('breakout-v1', {}));
  expect(configId('breakout-v1', {})).not.toBe(configId('breakout-v1', { stopPct: 0.006 }));
  expect(() => configId('BAD ID', {})).toThrow();
});

test('manifest validation fails closed on every corrupted field', () => {
  const strategy = stubStrategy();
  expect(manifestErrors(manifestFor(strategy))).toEqual([]);
  expect(manifestErrors({ ...manifestFor(strategy), version: 2 }).join(' ')).toContain('version');
  expect(manifestErrors({ ...manifestFor(strategy), alpha: 1.5 }).join(' ')).toContain('alpha');
  expect(manifestErrors({ ...manifestFor(strategy), entries: [] }).join(' ')).toContain('entries');
  expect(manifestErrors({ ...manifestFor(strategy), verifierSha256: 'zz' }).join(' ')).toContain('verifierSha256');
  const aboveAlpha = manifestFor(strategy, { entries: [{ strategyId: strategy.id, params: {}, artifactHash: artifactHash(strategy), spaPvalue: 0.5 }] });
  expect(manifestErrors(aboveAlpha).join(' ')).toContain('alpha');
  const nonFinite = manifestFor(strategy);
  (nonFinite.entries[0] as any).params = { stopPct: Number.NaN };
  expect(manifestErrors(nonFinite).join(' ')).toContain('params');
  const duplicated = manifestFor(strategy, { entries: [manifestFor(strategy).entries[0], manifestFor(strategy).entries[0]] });
  expect(manifestErrors(duplicated).join(' ')).toContain('duplicates');
});

test('gate modes: unverified allows, strict allows only exact promoted configs, refusing allows nothing', () => {
  const strategy = stubStrategy();
  const other = stubStrategy({ id: 'other-open', name: 'Other', description: 'stub', evaluate: () => ({ action: 'hold', rationale: 'x' }) });
  expect(PromotionGate.unverified().allows(strategy, {})).toBe(true);

  const strict = PromotionGate.install(manifestFor(strategy), VERIFIER);
  expect(strict.mode).toBe('strict');
  expect(strict.allows(strategy, { threshold: 0.5 })).toBe(true);
  expect(strict.allows(strategy, {})).toBe(false);                    // params differ from the verdict
  expect(strict.allows(strategy, { threshold: 0.9 })).toBe(false);
  expect(strict.allows(other, { threshold: 0.5 })).toBe(false);       // different strategy
  const edited = stubStrategy({ description: 'the code changed' });
  expect(strict.allows(edited, { threshold: 0.5 })).toBe(false);      // artifact hash changed

  const drifted = PromotionGate.install(manifestFor(strategy), 'f'.repeat(64));
  expect(drifted.mode).toBe('refusing');
  expect(drifted.allows(strategy, {})).toBe(false);

  const broken = PromotionGate.install({ version: 9 }, VERIFIER);
  expect(broken.mode).toBe('refusing');
  expect(broken.describe().reasons?.length).toBeGreaterThan(0);
});

// Fleet integration ---------------------------------------------------------------

const marketMeta = { symbol: 'BTC', market_id: 0, supported_price_decimals: 2, supported_size_decimals: 4, min_base_amount: 0.001, min_quote_amount: 10 };

function harness(promotion: PromotionGate | null, options: { paper?: any } = {}) {
  const store = new Store(':memory:');
  store.db.exec('CREATE TABLE IF NOT EXISTS fills (account TEXT NOT NULL, id TEXT NOT NULL, time TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(account,id))');
  const submitted: any[] = [];
  const paper: FleetPaper = {
    status: () => ({ markets: [marketMeta], halted: false, risk: { maxOrderNotional: 40000, maxGrossNotional: 90000, dailyLoss: 1000 },
      analytics: { equity: 10000, realized: 0, positions: [], trades: [], bots: [] }, ...options.paper }) as any,
    botOrder: async (body: any) => { submitted.push(body); return { id: body.id, status: 'filled', filled: body.quantity, price: 101 }; },
  };
  const feed: FleetFeed = {
    status: () => ({ state: 'streaming', epoch: 'e1', counts: { disconnects: 0, gaps: 0, stale: 0, invalid: 0, recordingFailures: 0 },
      books: [{ market: { symbol: 'BTC', market_id: 0 }, status: 'healthy' }], stats: [{ marketId: 0, stats: { mark: 100.5 } }] }) as any,
    read: () => ({ bids: [{ price: 100, quantity: 10 }], asks: [{ price: 101, quantity: 10 }], receivedAt: new Date().toISOString(),
      stats: { mark: 100.5, index: 100, fundingRate: 0.001, last: 100 } }),
    evidence: { recentTrades: () => [] },
  };
  const journal = new DecisionJournal(store);
  const registry = new StrategyRegistry();
  registry.register(breakoutV1);
  registry.register(stubStrategy());
  const guard = new FeedHealthGuard(store, { ...feedPolicyDefaults, healthyResumeMs: 1000, fractionWindowMs: 60000 });
  let mono = 0, wall = Date.parse('2026-10-27T10:00:00Z');
  const fleet = new FleetManager(store, paper, feed, journal, registry, guard, {}, { mono: () => mono, wall: () => wall }, promotion);
  const advance = (ms: number) => { mono += ms; wall += ms; };
  return { store, fleet, journal, submitted, advance, paper, feed };
}

test('no gate installed: fleet behaves exactly as before and labels itself unverified', () => {
  const { fleet } = harness(null);
  fleet.create({ slug: 'plain', strategyId: 'breakout-v1', symbol: 'BTC' });
  expect(fleet.status().promotion.mode).toBe('unverified');
});

test('strict gate: only the promoted config can be created', async () => {
  const promoted = stubStrategy();
  const { fleet, submitted, advance } = harness(PromotionGate.install(manifestFor(promoted), VERIFIER));
  fleet.create({ slug: 'promoted', strategyId: 'always-open', symbol: 'BTC' }); // {} resolves to the promoted defaults
  expect(() => fleet.create({ slug: 'blocked', strategyId: 'breakout-v1', symbol: 'BTC' })).toThrow('not promoted');
  expect(() => fleet.create({ slug: 'tweaked', strategyId: 'always-open', symbol: 'BTC', params: { threshold: 0.9 } })).toThrow('not promoted');
  fleet.startBot({ id: 'fleet-promoted' });
  fleet.enable({ confirm: 'ENABLE PAPER AUTOMATION' });
  advance(1000); await fleet.tick(); // guard dwell
  advance(1000); await fleet.tick();
  expect(submitted).toHaveLength(1);
  expect(fleet.status().promotion.mode).toBe('strict');
});

test('a manifest installed after bots exist refuses them at tick with a journaled skip', async () => {
  const promoted = stubStrategy();
  const { store, fleet, submitted, advance, paper, feed } = harness(null);
  fleet.create({ slug: 'legacy', strategyId: 'breakout-v1', symbol: 'BTC' });
  fleet.startBot({ id: 'fleet-legacy' });
  fleet.enable({ confirm: 'ENABLE PAPER AUTOMATION' });
  expect(submitted).toHaveLength(0); // pre-manifest tick below only warms windows

  // A restart with the manifest now installed reloads the same bot under the strict gate.
  const strictJournal = new DecisionJournal(store);
  const registry = new StrategyRegistry();
  registry.register(breakoutV1);
  registry.register(promoted);
  const strict = new FleetManager(store, paper, feed, strictJournal, registry, new FeedHealthGuard(store), {}, undefined, PromotionGate.install(manifestFor(promoted), VERIFIER));
  strict.startBot({ id: 'fleet-legacy' });
  strict.enable({ confirm: 'ENABLE PAPER AUTOMATION' });
  advance(1000); await strict.tick(); // guard dwell
  advance(1000); await strict.tick();
  advance(1000); await strict.tick();
  expect(submitted).toHaveLength(0);
  const skips = strictJournal.list({ botId: 'fleet-legacy', limit: 20 }).filter((entry: any) => entry.decision === 'skip');
  expect(skips.some((entry: any) => entry.rationale.includes('not promoted by the research gate'))).toBe(true);
});

test('update cannot smuggle a non-promoted config into an existing bot', () => {
  const promoted = stubStrategy();
  const { fleet } = harness(PromotionGate.install(manifestFor(promoted), VERIFIER));
  fleet.create({ slug: 'ok', strategyId: 'always-open', symbol: 'BTC' });
  expect(() => fleet.update({ id: 'fleet-ok', strategyId: 'breakout-v1', params: {} })).toThrow('not promoted');
  expect(() => fleet.update({ id: 'fleet-ok', params: { threshold: 0.9 } })).toThrow('not promoted');
  fleet.update({ id: 'fleet-ok', name: 'Renamed only' });
  expect(fleet.status().bots[0].name).toBe('Renamed only');
});
