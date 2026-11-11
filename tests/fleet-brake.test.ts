import { test, expect } from 'bun:test';
import { FleetManager, type FleetFeed, type FleetPaper } from '../src/fleet';
import { DecisionJournal } from '../src/journal';
import { FeedHealthGuard, feedPolicyDefaults } from '../src/feed-health';
import { StrategyRegistry } from '../src/strategies/registry';
import { Store } from '../src/store';
import type { PromotionGate } from '../src/promotion';
import type { StrategyProposal } from '../src/strategies/types';

const marketMeta = { symbol: 'BTC', market_id: 0, supported_price_decimals: 2, supported_size_decimals: 4, min_base_amount: 0.001, min_quote_amount: 10 };
const day = '2026-10-27';

function harness(equity: number, options: { positions?: any[]; trades?: any[]; promotion?: PromotionGate; proposal?: StrategyProposal } = {}) {
  const store = new Store(':memory:');
  store.db.exec('CREATE TABLE IF NOT EXISTS fills (account TEXT NOT NULL, id TEXT NOT NULL, time TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(account,id))');
  const submitted: any[] = [];
  let currentEquity = equity;
  const paper: FleetPaper = {
    status: () => ({ markets: [marketMeta], halted: false, risk: { maxOrderNotional: 40000, maxGrossNotional: 90000, dailyLoss: 1000 },
      analytics: { equity: currentEquity, realized: 0, positions: options.positions ?? [], trades: options.trades ?? [], bots: [] } }) as any,
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
    evaluate: () => options.proposal ?? ({ action: 'open', side: 'buy', rationale: 'stub open' }) });
  registry.register({ id: 'always-close', name: 'Always close', description: 'stub', params: [],
    evaluate: () => ({ action: 'close', fraction: 1, rationale: 'stub close' }) });
  const guard = new FeedHealthGuard(store, { ...feedPolicyDefaults, healthyResumeMs: 1000, fractionWindowMs: 60000 });
  let mono = 0, wall = Date.parse('2026-10-27T10:00:00Z');
  const fleet = new FleetManager(store, paper, feed, journal, registry, guard, {}, { mono: () => mono, wall: () => wall }, options.promotion ?? null);
  const advance = (ms: number) => { mono += ms; wall += ms; };
  const setEquity = (v: number) => { currentEquity = v; };
  return { store, fleet, journal, submitted, advance, setEquity, paper, feed, registry, guard, clock: { mono: () => mono, wall: () => wall } };
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
  const skips = h.journal.list({ botId: 'fleet-alpha', limit: 10 }).filter(e => e.decision === 'skip');
  expect(skips.some(e => e.rationale.includes('equity loss brake'))).toBe(true);
  const audits = h.store.db.query("SELECT * FROM audit WHERE action = 'FLEET_EQUITY_BRAKE'").all() as any[];
  expect(audits.length).toBe(1);
  const st = h.fleet.status() as any;
  expect(st.equityBrake.tripped).toBe(true);
  expect(st.equityBrake.dropPct).toBeCloseTo(2, 5);
  // A reboot clears the session latch but NOT the day reference: loss capacity is not reset.
  expect(h.store.get(`equityDayRef:${day}`)).toBe(10000);
  const restarted = new FleetManager(h.store, h.paper, h.feed, h.journal, h.registry, h.guard, {}, h.clock);
  expect(restarted.status().enabled).toBe(false);
  expect(restarted.status().bots[0].status).toBe('paused');
  expect(restarted.status().equityBrake.tripped).toBe(true);
  await restarted.tick();
  expect(h.submitted).toHaveLength(0);
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
  expect(h.submitted.length).toBeGreaterThanOrEqual(1);
});

const held = (quantity: number) => ({ symbol: 'BTC-USD', quantity, average: 100, leverage: 1, unrealized: -200 });
function trip(h: ReturnType<typeof harness>) {
  h.fleet.setEquityBrake(1);
  h.store.set(`equityDayRef:${day}`, 10000);
  h.setEquity(9800);
}
function run(h: ReturnType<typeof harness>, slug: string, strategyId = 'always-close') {
  h.fleet.create({ slug, strategyId, symbol: 'BTC' });
  h.fleet.startBot({ id: `fleet-${slug}` });
  h.fleet.enable({ confirm: 'ENABLE PAPER AUTOMATION' });
}

test('tripped equity brake denies opens but permits verified long and short reductions', async () => {
  for (const quantity of [0.5, -0.5]) {
    const h = harness(9800, { positions: [held(quantity)] });
    // The blocked opener must not prevent a later closing bot from being evaluated.
    run(h, 'entry', 'always-open');
    run(h, 'exit');
    trip(h);
    await h.fleet.tick(); // feed guard is still recovering, reductions remain allowed
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0]).toMatchObject({ botId: 'fleet-exit', side: quantity > 0 ? 'sell' : 'buy', quantity: 0.5 });
    expect(h.fleet.status().equityBrake.tripped).toBe(true);
    expect(h.journal.list({ botId: 'fleet-entry' }).some(e => e.rationale.includes('equity loss brake'))).toBe(true);
  }
});

test('promotion revocation and daily loss deny entries but do not strand existing exposure', async () => {
  let promoted = true;
  const promotion = { allows: () => promoted, describe: () => ({ mode: 'enforce' }) } as unknown as PromotionGate;
  const h = harness(9800, { positions: [held(0.5)], promotion,
    trades: [{ botId: 'fleet-exit', time: `${day}T05:00:00Z`, pnl: -150 }] });
  run(h, 'exit');
  promoted = false;
  trip(h);
  await h.fleet.tick();
  expect(h.submitted).toHaveLength(1);
  expect(h.fleet.status().bots[0].status).toBe('running');
  const submission = h.journal.list({ botId: 'fleet-exit' }).find(e => e.decision === 'submit');
  expect(submission?.risk_checks?.every((c: { pass: boolean }) => c.pass)).toBe(true);

  for (const dailyLoss of [false, true]) {
    promoted = true;
    const entry = harness(10000, { positions: [held(0.5)], promotion,
      trades: dailyLoss ? [{ botId: 'fleet-entry', time: `${day}T05:00:00Z`, pnl: -150 }] : [] });
    run(entry, 'entry', 'always-open');
    promoted = false;
    await entry.fleet.tick();
    entry.advance(2000); await entry.fleet.tick();
    expect(entry.submitted).toHaveLength(0);
    expect(entry.journal.list({ botId: 'fleet-entry' }).some(e => e.rationale.includes(dailyLoss ? 'Daily loss limit' : 'not promoted'))).toBe(true);
  }
});

test('brake never authorizes disabled automation or resumes paused bots', async () => {
  const h = harness(9800, { positions: [held(0.5)] });
  run(h, 'exit');
  trip(h);
  h.fleet.disable();
  await h.fleet.tick();
  expect(h.submitted).toHaveLength(0);
  h.fleet.enable({ confirm: 'ENABLE PAPER AUTOMATION' });
  h.fleet.pauseBot({ id: 'fleet-exit' });
  await h.fleet.tick();
  expect(h.submitted).toHaveLength(0);
  expect(h.fleet.status().bots[0].status).toBe('paused');
});

test('invalid close proposals and absent or invalid positions never throw or submit', async () => {
  for (const positions of [[], [held(0)], [held(NaN)], [held(Infinity)]]) {
    const h = harness(9800, { positions });
    run(h, 'exit'); trip(h);
    await h.fleet.tick();
    expect(h.submitted).toHaveLength(0);
    expect(h.journal.list({ botId: 'fleet-exit' }).some(e => e.rationale.includes('Nothing valid to close'))).toBe(true);
  }
  for (const fraction of [0, -1, 1.1, NaN, Infinity]) {
    const h = harness(9800, { positions: [held(0.5)], proposal: { action: 'close', fraction, rationale: 'invalid' } });
    run(h, 'exit', 'always-open'); trip(h);
    await h.fleet.tick();
    expect(h.submitted).toHaveLength(0);
  }
});

test('equity brake remains latched after recovery and restart until explicitly disabled', async () => {
  const h = harness(9800);
  run(h, 'entry', 'always-open'); trip(h);
  await h.fleet.tick();
  h.setEquity(11000);
  h.advance(2000); await h.fleet.tick();
  expect(h.submitted).toHaveLength(0);
  expect(h.fleet.status().equityBrake.tripped).toBe(true);
  const restarted = new FleetManager(h.store, h.paper, h.feed, h.journal, h.registry, h.guard, {}, h.clock);
  expect(restarted.status().equityBrake.tripped).toBe(true);
  restarted.startBot({ id: 'fleet-entry' });
  restarted.enable({ confirm: 'ENABLE PAPER AUTOMATION' });
  await restarted.tick();
  expect(h.submitted).toHaveLength(0);
  restarted.setEquityBrake(0);
  h.advance(2000); await restarted.tick();
  expect(h.submitted).toHaveLength(1);
});

test('nonpositive or nonfinite equity fails closed for entries but still allows reductions', async () => {
  for (const equity of [0, -100, NaN, Infinity]) {
    const h = harness(equity, { positions: [held(0.5)] });
    run(h, 'entry', 'always-open'); run(h, 'exit');
    h.fleet.setEquityBrake(1);
    await h.fleet.tick();
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0].botId).toBe('fleet-exit');
    expect(h.fleet.status().equityBrake.tripped).toBe(true);
    expect(h.store.get(`equityDayRef:${day}`)).toBeNull();
    expect(h.store.get(`equityBrakeTripped:${day}`)).toBe(true);
  }
});

test('only one sibling close is submitted per snapshot to avoid reversing a stale net position', async () => {
  const h = harness(9800, { positions: [held(0.5)] });
  run(h, 'first'); run(h, 'second'); trip(h);
  await h.fleet.tick();
  expect(h.submitted).toHaveLength(1);
});
