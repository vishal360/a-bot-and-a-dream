import { test, expect } from 'bun:test';
import { FleetManager, type FleetFeed, type FleetPaper } from '../src/fleet';
import { DecisionJournal } from '../src/journal';
import { FeedHealthGuard, feedPolicyDefaults } from '../src/feed-health';
import { StrategyRegistry } from '../src/strategies/registry';
import { Store } from '../src/store';

const marketMeta = { symbol: 'BTC', market_id: 0, supported_price_decimals: 2, supported_size_decimals: 4, min_base_amount: 0.001, min_quote_amount: 10 };
const day = '2026-10-27';

function harness(equity: number) {
  const store = new Store(':memory:');
  store.db.exec('CREATE TABLE IF NOT EXISTS fills (account TEXT NOT NULL, id TEXT NOT NULL, time TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(account,id))');
  const submitted: any[] = [];
  let currentEquity = equity;
  const paper: FleetPaper = {
    status: () => ({ markets: [marketMeta], halted: false, risk: { maxOrderNotional: 40000, maxGrossNotional: 90000, dailyLoss: 1000 },
      analytics: { equity: currentEquity, realized: 0, positions: [], trades: [], bots: [] } }) as any,
    botOrder: async (body: any) => { submitted.push(body); return { id: body.id, status: 'filled', filled: body.quantity, price: 101 }; },
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
  registry.register({ id: 'always-open', name: 'Always open', description: 'stub', params: [],
    evaluate: () => ({ action: 'open', side: 'buy', rationale: 'stub open' }) });
  const guard = new FeedHealthGuard(store, { ...feedPolicyDefaults, healthyResumeMs: 1000, fractionWindowMs: 60000 });
  let mono = 0, wall = Date.parse('2026-10-27T10:00:00Z');
  const fleet = new FleetManager(store, paper, feed, journal, registry, guard, {}, { mono: () => mono, wall: () => wall });
  const advance = (ms: number) => { mono += ms; wall += ms; };
  const setEquity = (v: number) => { currentEquity = v; };
  return { store, fleet, journal, submitted, advance, setEquity, paper };
}

test('the total-equity loss brake blocks new entries on UNREALIZED losses and survives reboots', async () => {
  const h = harness(10000);
  h.fleet.create({ slug: 'alpha', strategyId: 'always-open', symbol: 'BTC', maxNotionalPerOrder: 500 });
  h.fleet.setEquityBrake(1); // 1% of UTC-day reference equity
  h.store.set('fleetEnabled', true);
  h.fleet.startBot({ id: 'fleet-alpha' });
  h.advance(2000); // guard healthy-dwell: the first samples must be healthy to reach entries
  await h.fleet.tick(); // day reference captured at 10000; brake not tripped
  // Equity craters 2% UNREALIZED (no closed trades â€” the old closing-leg stop would miss this).
  h.setEquity(9800);
  h.advance(60000);
  await h.fleet.tick();
  console.log('DBG1 status:', JSON.stringify(h.fleet.status().equityBrake));
  console.log('DBG1 skips:', JSON.stringify(h.journal.list({ botId: 'fleet-alpha', limit: 10 }).filter(e => e.decision === 'skip').map(x => x.rationale.slice(0, 60))));
  const skips = h.journal.list({ botId: 'fleet-alpha', limit: 10 }).filter(e => e.decision === 'skip');
  expect(skips.some(e => e.rationale.includes('equity loss brake'))).toBe(true);
  const audits = h.store.db.query("SELECT * FROM audit WHERE action = 'FLEET_EQUITY_BRAKE'").all() as any[];
  expect(audits.length).toBe(1);
  const st = h.fleet.status() as any;
  expect(st.equityBrake.tripped).toBe(true);
  expect(st.equityBrake.dropPct).toBeCloseTo(2, 5);
  // A reboot clears the session latch but NOT the day reference: loss capacity is not reset.
  expect(h.store.get(`equityDayRef:${day}`)).toBe(10000);
});

test('setEquityBrake validates the range; 0 disables and entries continue', async () => {
  const h = harness(10000);
  expect(() => h.fleet.setEquityBrake(0.05)).toThrow('0.1..50');
  expect(() => h.fleet.setEquityBrake(60)).toThrow('0.1..50');
  expect(h.fleet.setEquityBrake(1.5).pct).toBe(1.5);
  expect(h.fleet.setEquityBrake(0).pct).toBe(0); // disabled BEFORE the entries test
  h.store.set('fleetEnabled', true);
  h.fleet.create({ slug: 'alpha', strategyId: 'always-open', symbol: 'BTC' });
  h.fleet.startBot({ id: 'fleet-alpha' });
  h.advance(2000);
  await h.fleet.tick(); // guard dwell tick: the recovery clock needs a first healthy sample
  h.setEquity(8000); // deep loss with the brake DISABLED: entries continue (explicit operator choice)
  h.advance(60000);
  await h.fleet.tick();
  console.log('DBG2 skips:', JSON.stringify(h.journal.list({ botId: 'fleet-alpha', limit: 10 }).filter(e => e.decision === 'skip').map(x => x.rationale.slice(0, 70))));
  console.log('DBG2 entries:', JSON.stringify(h.journal.list({ botId: 'fleet-alpha', limit: 10 }).map(x => x.decision)));
  console.log('DBG2 brake:', JSON.stringify(h.fleet.status().equityBrake));
  expect(h.submitted.length).toBeGreaterThanOrEqual(1);
});
