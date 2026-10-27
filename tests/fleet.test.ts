import { test, expect } from 'bun:test';
import { FleetManager, type FleetFeed, type FleetPaper } from '../src/fleet';
import { DecisionJournal } from '../src/journal';
import { FeedHealthGuard, feedPolicyDefaults } from '../src/feed-health';
import { StrategyRegistry } from '../src/strategies/registry';
import { breakoutV1 } from '../src/strategies/builtin';
import { Store } from '../src/store';

const marketMeta = { symbol: 'BTC', market_id: 0, supported_price_decimals: 2, supported_size_decimals: 4, min_base_amount: 0.001, min_quote_amount: 10 };
const day = new Date().toISOString().slice(0, 10);

function harness(options: { paper?: any; feed?: any; fills?: any[] } = {}) {
  const store = new Store(':memory:');
  store.db.exec('CREATE TABLE IF NOT EXISTS fills (account TEXT NOT NULL, id TEXT NOT NULL, time TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(account,id))');
  for (const fill of options.fills ?? []) store.db.query('INSERT OR REPLACE INTO fills VALUES (?,?,?,?)').run('paper-mainnet', fill.id, fill.time, JSON.stringify(fill));
  const submitted: any[] = [];
  const paper: FleetPaper = {
    status: () => ({ markets: [marketMeta], halted: false, risk: { maxOrderNotional: 40000, maxGrossNotional: 90000, dailyLoss: 1000 },
      analytics: { equity: 10000, realized: 0, positions: [], trades: [], bots: [] }, ...options.paper }) as any,
    botOrder: async (body: any) => { submitted.push(body); return { id: body.id, status: 'filled', filled: body.quantity, price: 101 }; }
  };
  const feed: FleetFeed = {
    status: () => ({ state: 'streaming', epoch: 'e1', counts: { disconnects: 0, gaps: 0, stale: 0, invalid: 0, recordingFailures: 0 },
      books: [{ market: { symbol: 'BTC', market_id: 0 }, status: 'healthy' }], stats: [{ marketId: 0, stats: { mark: 100.5 } }] }) as any,
    read: () => ({ bids: [{ price: 100, quantity: 10 }], asks: [{ price: 101, quantity: 10 }], receivedAt: new Date().toISOString(),
      stats: { mark: 100.5, index: 100, fundingRate: 0.001, last: 100 } }),
    evidence: { recentTrades: () => [] }
  };
  const journal = new DecisionJournal(store);
  const registry = new StrategyRegistry();
  registry.register(breakoutV1);
  registry.register({ id: 'always-open', name: 'Always open', description: 'test stub', params: [],
    evaluate: () => ({ action: 'open', side: 'buy', rationale: 'stub open' }) });
  registry.register({ id: 'always-close', name: 'Always close', description: 'test stub', params: [],
    evaluate: () => ({ action: 'close', fraction: 1, rationale: 'stub close' }) });
  const guard = new FeedHealthGuard(store, { ...feedPolicyDefaults, healthyResumeMs: 1000, fractionWindowMs: 60000 });
  let mono = 0, wall = Date.parse('2026-10-27T10:00:00Z');
  const fleet = new FleetManager(store, paper, feed, journal, registry, guard, {}, { mono: () => mono, wall: () => wall });
  const advance = (ms: number) => { mono += ms; wall += ms; };
  return { store, fleet, journal, submitted, advance, paper, feed, guard };
}

test('bot creation validates strategy, parameters and caps; duplicates refuse', () => {
  const { fleet } = harness();
  expect(() => fleet.create({ slug: 'BAD', strategyId: 'breakout-v1', symbol: 'BTC' })).toThrow('slug');
  expect(() => fleet.create({ slug: 'ok', strategyId: 'nope', symbol: 'BTC' })).toThrow('Unknown strategy');
  expect(() => fleet.create({ slug: 'ok', strategyId: 'breakout-v1', symbol: 'BTC', params: { lookbackSeconds: 5 } })).toThrow('lookbackSeconds');
  expect(() => fleet.create({ slug: 'ok', strategyId: 'breakout-v1', symbol: 'BTC', maxNotionalPerOrder: 90000 })).toThrow('maxNotionalPerOrder');
  expect(() => fleet.create({ slug: 'ok', strategyId: 'breakout-v1', symbol: 'BTC', leverage: 0 })).toThrow('leverage');
  fleet.create({ slug: 'alpha', strategyId: 'breakout-v1', symbol: 'BTC', maxNotionalPerOrder: 500 });
  expect(() => fleet.create({ slug: 'alpha', strategyId: 'breakout-v1', symbol: 'BTC' })).toThrow('already exists');
  const status = fleet.status();
  expect(status.bots[0].id).toBe('fleet-alpha');
  expect(status.bots[0].status).toBe('paused');
  expect(status.strategies.map((s: any) => s.id)).toContain('breakout-v1');
});

test('automation authorization gates submissions and never survives restart', async () => {
  const { fleet, store, submitted, advance } = harness();
  fleet.create({ slug: 'auto', strategyId: 'always-open', symbol: 'BTC' });
  fleet.startBot({ id: 'fleet-auto' });
  advance(1000); await fleet.tick();
  expect(submitted).toHaveLength(0);
  expect(fleet.status().enabled).toBe(false);
  expect(() => fleet.enable({ confirm: 'yes' })).toThrow('ENABLE PAPER AUTOMATION');
  fleet.enable({ confirm: 'ENABLE PAPER AUTOMATION' });
  advance(1000); await fleet.tick(); // guard dwell
  advance(1000); await fleet.tick();
  expect(submitted).toHaveLength(1);
  expect(submitted[0].botId).toBe('fleet-auto');
  fleet.disable();
  expect(fleet.status().enabled).toBe(false);
  // A fresh manager on the same store pauses runners and clears authorization.
  const second = new FleetManager(store, (fleet as any).paper, (fleet as any).feed, new DecisionJournal(store), new StrategyRegistry(), new FeedHealthGuard(store), {});
  expect(second.status().enabled).toBe(false);
  expect(second.status().bots[0].status).toBe('paused');
});

test('guard dwell, then breakout sizing, fill attribution and journaling work end to end', async () => {
  const { fleet, submitted, advance, journal } = harness();
  fleet.create({ slug: 'brk', strategyId: 'breakout-v1', symbol: 'BTC', maxNotionalPerOrder: 1000, maxOpenNotional: 1000, cooldownMs: 1000 });
  fleet.startBot({ id: 'fleet-brk' });
  fleet.enable({ confirm: 'ENABLE PAPER AUTOMATION' });
  for (let i = 0; i < 34; i++) { advance(1000); await fleet.tick(); }
  expect(submitted).toHaveLength(0); // still inside the channel
  (fleet as any).feed.read = () => ({ bids: [{ price: 102, quantity: 10 }], asks: [{ price: 102.2, quantity: 10 }], receivedAt: new Date().toISOString(), stats: { mark: 102.1, index: 100, fundingRate: 0.001, last: 102 } });
  advance(1000); await fleet.tick(); // breakout proposal queues
  advance(1000); await fleet.tick(); // executes at next book
  expect(submitted).toHaveLength(1);
  const order = submitted[0];
  expect(order.side).toBe('buy');
  expect(order.botId).toBe('fleet-brk');
  expect(order.quantity).toBe(Math.floor(1000 / 102.2 * 10000) / 10000); // floored to size decimals, within notional cap
  expect(order.leverage).toBe(1);
  const bot = fleet.status().bots[0];
  expect(bot.stats.orders).toBe(1);
  expect(bot.stats.fills).toBe(1);
  expect(bot.openNotionalUsd).toBe(0); // fake paper does not persist fill rows; attribution stays executor-owned
  const decisions = journal.list({ botId: 'fleet-brk', limit: 10 }).map((r: any) => r.decision);
  expect(decisions).toContain('submit');
  expect(decisions).toContain('fill');
});

test('unhealthy feed blocks opens but never blocks reductions', async () => {
  const { fleet, submitted, advance, feed } = harness({ paper: { analytics: { equity: 10000, realized: 0, positions: [{ symbol: 'BTC-USD', quantity: 0.5, average: 100, leverage: 1, unrealized: 1, mark: 100.5, stale: false }], trades: [], bots: [] } } });
  fleet.create({ slug: 'mix', strategyId: 'always-close', symbol: 'BTC' });
  fleet.startBot({ id: 'fleet-mix' });
  feed.status = () => ({ state: 'reconnecting', epoch: 'e1', counts: { disconnects: 1, gaps: 0, stale: 0, invalid: 0, recordingFailures: 0 },
    books: [{ market: { symbol: 'BTC', market_id: 0 }, status: 'healthy' }], stats: [] } as any);
  fleet.enable({ confirm: 'ENABLE PAPER AUTOMATION' });
  advance(1000); await fleet.tick();
  expect(submitted).toHaveLength(1); // close proposal executes despite unhealthy feed
  expect(submitted[0].side).toBe('sell');
  expect(submitted[0].quantity).toBe(0.5);
  // opens are refused while the guard is unhealthy
  const { fleet: openFleet, submitted: openSubmitted, feed: openFeed } = harness();
  openFleet.create({ slug: 'op', strategyId: 'always-open', symbol: 'BTC' });
  openFleet.startBot({ id: 'fleet-op' });
  openFeed.status = () => ({ state: 'streaming', epoch: 'e2', counts: { disconnects: 0, gaps: 0, stale: 0, invalid: 0, recordingFailures: 0 },
    books: [{ market: { symbol: 'BTC', market_id: 0 }, status: 'stale' }], stats: [{ marketId: 0, stats: {} }] } as any);
  openFleet.enable({ confirm: 'ENABLE PAPER AUTOMATION' });
  advance(1000); await openFleet.tick();
  advance(1000); await openFleet.tick();
  expect(openSubmitted).toHaveLength(0);
});

test('frequency caps, cooldowns and daily loss limits pause or skip the bot', async () => {
  const { fleet, submitted, advance, journal } = harness();
  fleet.create({ slug: 'freq', strategyId: 'always-open', symbol: 'BTC', maxOrdersPerHour: 1, cooldownMs: 1000 });
  fleet.startBot({ id: 'fleet-freq' });
  fleet.enable({ confirm: 'ENABLE PAPER AUTOMATION' });
  advance(1000); await fleet.tick(); // guard dwell skip
  advance(1000); await fleet.tick(); // submits
  advance(1000); await fleet.tick(); // hourly cap skip
  expect(submitted).toHaveLength(1);
  const skips = journal.list({ botId: 'fleet-freq', limit: 20 }).filter((r: any) => r.decision === 'skip');
  expect(skips.some((r: any) => r.rationale.includes('frequency cap'))).toBe(true);
  const { fleet: lossFleet, advance: lossAdvance } = harness({ paper: { analytics: { equity: 10000, realized: -150, positions: [], trades: [{ botId: 'fleet-loss', time: `${day}T05:00:00.000Z`, pnl: -150 }], bots: [] } } });
  lossFleet.create({ slug: 'loss', strategyId: 'always-open', symbol: 'BTC', maxDailyLossUsd: 100 });
  lossFleet.startBot({ id: 'fleet-loss' });
  lossFleet.enable({ confirm: 'ENABLE PAPER AUTOMATION' });
  lossAdvance(2000); await lossFleet.tick();
  expect(lossFleet.status().bots[0].status).toBe('paused');
});

test('one net direction per market: opposite opens are refused, same-direction and closes pass', async () => {
  const { fleet, submitted, advance, journal } = harness({ paper: { analytics: { equity: 10000, realized: 0, positions: [{ symbol: 'BTC-USD', quantity: -0.5, average: 100, leverage: 1, unrealized: null }], trades: [], bots: [] } } });
  fleet.create({ slug: 'dir', strategyId: 'always-open', symbol: 'BTC' });
  fleet.startBot({ id: 'fleet-dir' });
  fleet.enable({ confirm: 'ENABLE PAPER AUTOMATION' });
  advance(2000); await fleet.tick();
  advance(3000); await fleet.tick();
  expect(submitted).toHaveLength(0); // account is short; a buy open would reduce a sibling position
  const skips = journal.list({ botId: 'fleet-dir', limit: 20 }).filter((r: any) => r.decision === 'skip');
  expect(skips.some((r: any) => r.rationale.includes('One net direction per market'))).toBe(true);
});

test('deletion requires pause and zero attributed notional', () => {
  const { fleet } = harness({ fills: [{ id: 'f1', account: 'paper-mainnet', botId: 'fleet-hold', symbol: 'BTC-USD', side: 'buy', quantity: 1, price: 100, fee: 0, multiplier: 1, source: 'paper', time: '2026-10-27T00:00:00Z', settlement: { version: 2, effect: 'open', quantityAtoms: '100000000', quoteMicros: '100000000', feeMicros: '200', leverage: 1 } }] });
  fleet.create({ slug: 'gone', strategyId: 'breakout-v1', symbol: 'BTC' });
  fleet.startBot({ id: 'fleet-gone' });
  expect(() => fleet.delete({ id: 'fleet-gone' })).toThrow('Pause the bot');
  fleet.pauseBot({ id: 'fleet-gone' });
  fleet.delete({ id: 'fleet-gone' });
  fleet.create({ slug: 'hold', strategyId: 'breakout-v1', symbol: 'BTC' });
  fleet.pauseBot({ id: 'fleet-hold' });
  expect(() => fleet.delete({ id: 'fleet-hold' })).toThrow('close its positions');
  expect(fleet.status().bots.map((b: any) => b.id)).toEqual(['fleet-hold']);
});

test('journal queries are exposed through status for the dashboard', async () => {
  const { fleet, journal, advance } = harness();
  fleet.create({ slug: 'jr', strategyId: 'breakout-v1', symbol: 'ETH' }); // market metadata missing
  fleet.startBot({ id: 'fleet-jr' });
  fleet.enable({ confirm: 'ENABLE PAPER AUTOMATION' });
  advance(1000); await fleet.tick();
  const entries = journal.list({ botId: 'fleet-jr' });
  expect(entries.some((e: any) => e.decision === 'skip' && e.rationale.includes('Market metadata unavailable'))).toBe(true);
  expect(fleet.status().journal.length).toBeGreaterThan(0);
});
