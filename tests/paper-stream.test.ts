import { test, expect } from 'bun:test';
import { Store } from '../src/store';
import { Operations } from '../src/operations';
import { ExecutionRisk } from '../src/execution-risk';
import { Paper, leverageLimit } from '../src/paper';
import { LighterStream, type StreamSocket } from '../src/lighter-stream';
import { parseStats } from '../src/lighter-stats';
import { paperAnalytics, paperBalance } from '../src/paper-ledger';
import type { Fill } from '../src/ledger';

const market = { symbol: 'BTC', market_id: 1, market_type: 'perp', status: 'active', supported_price_decimals: 2, supported_size_decimals: 5, min_base_amount: '0.00001', min_quote_amount: '0', min_initial_margin_fraction: 500, maintenance_margin_fraction: 300, closeout_margin_fraction: 200 };
const statsFrame = (wall: number, mark = '100') => ({ type: 'update/market_stats', channel: 'market_stats:1', timestamp: wall, market_stats: { market_id: 1, symbol: 'BTC', mark_price: mark, index_price: '99', last_trade_price: '98', funding_rate: '-0.001', current_funding_rate: '0.002', funding_timestamp: wall - 3600000 } });
class Socket {
  readyState = 1; sent: any[] = [];
  onopen: StreamSocket['onopen'] = null; onmessage: StreamSocket['onmessage'] = null; onerror: StreamSocket['onerror'] = null; onclose: StreamSocket['onclose'] = null;
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; }
  open() { this.onopen?.call(this as any, {} as Event); }
  emit(frame: unknown) { this.onmessage?.call(this as any, { data: JSON.stringify(frame) } as MessageEvent); }
}
async function fixture() {
  const store = new Store(':memory:'); new Operations(store, {} as any); new ExecutionRisk(store);
  const clock = { wall: Date.now(), mono: 100 }, sockets: Socket[] = [], requests: string[] = [];
  const stream = new LighterStream(store, { marketStats: true, clock: () => ({ ...clock }), tickMs: 60000, retryMs: 1, random: () => 0, connect: () => { const socket = new Socket(); sockets.push(socket); return socket; } });
  const paper = new Paper(store, (async (url: any) => { requests.push(String(url)); if (!String(url).includes('orderBookDetails')) throw new Error('REST execution forbidden'); return Response.json({ code: 200, order_book_details: [market] }); }) as typeof fetch, stream);
  store.set('allocationPct', 100); store.set('paperSession', { ...store.get('paperSession'), latencyMs: 0 });
  await paper.refreshMetadata(); stream.start(); sockets[0].open(); paper.configure({ enabled: true });
  const book = (nonce = 1, snapshot = true) => ({ type: snapshot ? 'subscribed/order_book' : 'update/order_book', channel: 'order_book:1', timestamp: clock.wall, order_book: { code: 0, nonce, begin_nonce: nonce - 1, bids: snapshot ? [{ price: '100', size: '100' }] : [], asks: snapshot ? [{ price: '101', size: '100' }] : [] } });
  const seed = () => { sockets.at(-1)!.emit(book()); sockets.at(-1)!.emit(statsFrame(clock.wall)); };
  return { store, stream, paper, clock, sockets, requests, book, seed, close: () => { stream.stop(); store.db.close(); } };
}

test('market stats use venue identity, bounded wire economics and millisecond timestamps', () => {
  const clock = { wall: Date.now(), mono: 100 }, frame = statsFrame(clock.wall);
  expect(parseStats(frame, market, clock, 5000)).toMatchObject({ mark: 100, index: 99, last: 98, fundingRate: -.001, fundingTimestamp: clock.wall - 3600000 });
  expect(() => parseStats({ ...frame, timestamp: clock.wall + 2209 }, market, clock, 5000)).toThrow('publication age -2209ms');
  for (const mutation of [
    { channel: 'market_stats:2' }, { timestamp: clock.wall - 5001 }, { timestamp: clock.wall + 2001 },
    { market_stats: { ...frame.market_stats, symbol: 'ETH' } }, { market_stats: { ...frame.market_stats, market_id: 2 } },
    { market_stats: { ...frame.market_stats, mark_price: 100 } }, { market_stats: { ...frame.market_stats, mark_price: '0' } },
    { market_stats: { ...frame.market_stats, index_price: 'NaN' } }, { market_stats: { ...frame.market_stats, funding_rate: '101' } },
    { market_stats: { ...frame.market_stats, mark_price: '100.000000001' } },
    { market_stats: { ...frame.market_stats, funding_timestamp: clock.wall + 2001 } },
  ]) expect(() => parseStats({ ...frame, ...mutation }, market, clock, 5000)).toThrow();
});

test('display retains validated quotes through disconnects but never restores execution authority', async () => {
  const f = await fixture();
  try {
    f.seed();
    const quotes = { bid: 100, ask: 101, mark: 100, index: 99, last: 98, fundingRate: -.001, estimatedFundingRate: .002 };
    expect(f.paper.status().feed).toMatchObject({ ...quotes, displayOnly: false });
    f.sockets[0].onclose?.call(f.sockets[0] as any, {} as CloseEvent);
    expect(f.stream.read(1)).toBeNull();
    expect(f.paper.status().feed).toMatchObject({ ...quotes, status: 'disconnected', displayOnly: true, reason: 'WebSocket disconnected' });
    expect(f.paper.currentMarks().filter(m => m.account === 'paper-mainnet')).toEqual([]);
    expect((await f.paper.order({ id: 'display-cache-no-fill', side: 'buy', quantity: 1 })).status).toBe('rejected');
    f.clock.mono += 2; f.stream.tick(); f.sockets.at(-1)!.open();
    f.sockets.at(-1)!.emit(f.book());
    expect(f.paper.status().feed.displayOnly).toBe(true);
    f.sockets.at(-1)!.emit(statsFrame(f.clock.wall, '102'));
    expect(f.paper.status().feed).toMatchObject({ mark: 102, displayOnly: false });
    // Same ID with changed symbol must not inherit another market's cached prices.
    f.stream.watch([{ ...market, symbol: 'ETH' }]);
    expect(f.stream.display(1).bid).toBeUndefined();
  } finally { f.close(); }
});

test('stream alone authorizes fills and venue mark valuation; stats and depth are both required', async () => {
  const f = await fixture();
  try {
    expect(f.sockets[0].sent).toEqual([{ type: 'subscribe', channel: 'order_book/1' }, { type: 'subscribe', channel: 'market_stats/1' }]);
    f.sockets[0].emit(f.book()); expect(f.stream.status().healthy).toBe(false);
    expect((await f.paper.order({ id: 'without-stats-01', side: 'buy', quantity: 1 })).status).toBe('rejected');
    await Bun.sleep(1001); f.sockets[0].emit(statsFrame(f.clock.wall));
    f.store.set('marks', [{ account: 'paper-mainnet', symbol: 'BTC-USD', price: 999, time: new Date().toISOString(), source: 'old REST' }]);
    f.paper.setLeverage({ leverage: 2 });
    const result = await f.paper.order({ id: 'stream-entry-01', side: 'buy', quantity: 1 });
    expect(result).toMatchObject({ status: 'filled', price: 101, leverage: 2 });
    expect(f.paper.summary()).toMatchObject({ marginUsed: 50.5, cash: 9949.4798, equity: 9998.9798 });
    expect(f.paper.summary().positions[0].mark).toBe(100);
    expect(new Operations(f.store, {} as any).snapshot(f.paper.currentMarks()).accounts.find(a => a.account === 'paper-mainnet')!.analytics.equity).toBe(f.paper.summary().equity);
    expect(f.paper.status().feed).toMatchObject({ mark: 100, index: 99, last: 98, fundingRate: -.001 });
    expect(f.paper.status().fills[0].reason).toContain('validated WebSocket');
    expect(f.requests).toHaveLength(1);
    expect(() => f.paper.setLeverage({ leverage: 3 })).toThrow('Close');
    expect(() => f.paper.setLeverage({ leverage: 21 })).toThrow('whole number');
    f.clock.mono += 5001; f.clock.wall += 5001;
    expect(f.paper.summary().equity).toBeNull(); expect(f.paper.summary().positions[0].mark).toBeNull();
    await Bun.sleep(1001);
    expect((await f.paper.order({ id: 'stale-exit-01', side: 'sell', quantity: 1 })).status).toBe('rejected');
    expect(f.paper.summary().fillCount).toBe(1); expect(f.requests).toHaveLength(1);
  } finally { f.close(); }
}, 10000);

test('invalid/regressing stats, stale stats watchdog and recording faults invalidate paper authority', async () => {
  for (const mode of ['regressing', 'identity', 'stale', 'recording']) {
    const f = await fixture();
    try {
      f.seed(); expect(f.stream.status().healthy).toBe(true);
      if (mode === 'regressing') f.sockets[0].emit(statsFrame(f.clock.wall - 1));
      if (mode === 'identity') f.sockets[0].emit({ ...statsFrame(f.clock.wall), channel: 'market_stats:2' });
      if (mode === 'stale') { f.clock.mono += 5001; f.clock.wall += 5001; f.sockets[0].emit(f.book(2, false)); f.stream.tick(); }
      if (mode === 'recording') { f.store.db.exec('DROP TABLE lighter_feed_journal'); f.sockets[0].emit(statsFrame(f.clock.wall)); }
      expect(f.stream.read(1)).toBeNull(); expect(f.paper.status().feed.status).toBe('disconnected');
      expect((await f.paper.order({ id: `invalid-${mode}-01`, side: 'buy', quantity: 1 })).status).toBe('rejected');
    } finally { f.close(); }
  }
});

test('leverage stays bounded by venue and app caps; gross and shared margin limits still apply', async () => {
  expect(leverageLimit({ min_initial_margin_fraction: 1000 })).toBe(10);
  expect(leverageLimit({ min_initial_margin_fraction: 100 })).toBe(20);
  for (const fraction of [undefined, 0, '500', -1]) expect(leverageLimit({ min_initial_margin_fraction: fraction })).toBe(1);
  const f = await fixture();
  try {
    f.seed(); f.paper.setLeverage({ leverage: 20 }); f.store.set('allocationPct', 1);
    expect((await f.paper.order({ id: 'margin-budget-01', side: 'buy', quantity: 20 })).error).toContain('allocation');
    await Bun.sleep(1001); f.store.set('allocationPct', 100); f.store.set('risk', { ...f.store.get('risk'), maxOrderNotional: 100 });
    expect((await f.paper.order({ id: 'gross-order-01', side: 'buy', quantity: 1 })).error).toContain('per-order');
    await Bun.sleep(1001); f.store.set('risk', { ...f.store.get('risk'), maxOrderNotional: 1000, maxGrossNotional: 100 });
    expect((await f.paper.order({ id: 'gross-account-01', side: 'buy', quantity: 1 })).error).toContain('account cap');
    expect(f.paper.summary().fillCount).toBe(0);
  } finally { f.close(); }
}, 10000);

test('leveraged partial exits release proportional margin, not leveraged P&L; insolvency is visible', () => {
  const fill = (id: string, side: 'buy' | 'sell', quantity: number, quote: number, time: string): Fill => ({ id, account: 'paper-mainnet', botId: 'orion', symbol: 'BTC-USD', multiplier: 1, side, quantity, price: quote / quantity, fee: 0, time, source: 'paper', reason: 'test', settlement: { version: 1, quantityAtoms: String(quantity * 1e8), quoteMicros: String(quote * 1e6), feeMicros: '0', leverage: 10 } });
  const fills = [fill('entry', 'buy', 2, 200, '2026-01-01T00:00:00Z'), fill('partial', 'sell', 1, 110, '2026-01-01T00:00:01Z')];
  const b = paperBalance(fills, 100);
  expect(b.cash).toBe(100000000n); expect(b.inventory.get('BTC-USD')!.margin).toBe(10000000n); expect(b.realized).toBe(10000000n);
  expect(paperAnalytics(fills, [{ account: 'paper-mainnet', symbol: 'BTC-USD', price: 110, time: '2026-01-01T00:00:01Z', source: 'test' }], 100, new Date('2026-01-01T00:00:02Z')).equity).toBe(120);
  const insolvent = paperBalance([fills[0], fill('gap-close', 'sell', 2, 2, '2026-01-01T00:00:02Z')], 100);
  expect(insolvent.cash).toBe(-98000000n);
  expect(() => paperBalance([fill('unfunded', 'buy', 2, 200, '2026-01-01T00:00:00Z')], 1)).toThrow('negative cash');
});

test('stream mark triggers protection but reduction walks depth while halted', async () => {
  const f = await fixture();
  try {
    f.seed(); f.paper.setLeverage({ leverage: 2 });
    expect((await f.paper.order({ id: 'stop-entry-stream', side: 'buy', quantity: 1 })).status).toBe('filled');
    f.paper.protect({ symbol: 'BTC', stopLoss: 95 }); f.store.halt(); await Bun.sleep(1001);
    f.sockets[0].emit(statsFrame(f.clock.wall, '90')); await f.paper.monitor();
    expect(f.paper.summary().positions).toHaveLength(0); expect(f.paper.orders()[0].price).toBe(100);
    expect(f.paper.status().protections.BTC).toBeUndefined();
  } finally { f.close(); }
});

test('freshness is rechecked after modeled delay and fresh books cannot revive stale stats', async () => {
  const f = await fixture();
  try {
    f.seed(); f.store.set('paperSession', { ...f.store.get('paperSession'), latencyMs: 20 });
    const order = f.paper.order({ id: 'delay-stale-stream', side: 'buy', quantity: 1 });
    f.clock.wall += 5001; f.clock.mono += 5001;
    expect((await order).status).toBe('rejected'); expect(f.paper.summary().fillCount).toBe(0);
    // Recover with a new snapshot, then keep the book fresh while stats expire.
    f.stream.tick(); f.clock.mono += 2; f.stream.tick(); f.sockets.at(-1)!.open(); f.seed();
    f.clock.wall += 4000; f.clock.mono += 4000; f.sockets.at(-1)!.emit(f.book(2, false));
    f.clock.wall += 1001; f.clock.mono += 1001; f.sockets.at(-1)!.emit(f.book(3, false));
    expect(f.stream.read(1)?.stats).toBeNull(); expect(f.stream.status().healthy).toBe(false);
    f.stream.tick(); expect(f.stream.read(1)).toBeNull(); expect(f.stream.status().error).toContain('Stale market stats');
  } finally { f.close(); }
});

test('shorts reserve collateral and restart recovery permits halted buy-to-close protections', async () => {
  const f = await fixture();
  try {
    f.seed(); f.paper.setLeverage({ leverage: 2 });
    expect((await f.paper.order({ id: 'short-stream-open', side: 'sell', quantity: 1 })).status).toBe('filled');
    expect(f.paper.summary()).toMatchObject({ cash: 9949.98, marginUsed: 50, equity: 9999.98 });
    expect(f.paper.summary().positions[0]).toMatchObject({ quantity: -1, side: 'short', average: 100 });
    expect(() => f.paper.protect({ stopLoss: 95 })).toThrow('above');
    f.paper.protect({ stopLoss: 105, takeProfit: 90 });
    const restarted = new Paper(f.store, (async (_url: any) => Response.json({ code: 200, order_book_details: [market] })) as typeof fetch, f.stream);
    expect(restarted.status().orderManagement.recovery.status).toBe('reconciled');
    expect(restarted.status().enabled).toBe(false);
    f.sockets[0].emit(statsFrame(f.clock.wall, '110')); await restarted.monitor();
    expect(restarted.summary().positions[0].quantity).toBe(-1);
    restarted.configure({ enabled: true }); f.store.halt(); await restarted.monitor();
    expect(restarted.summary().positions).toHaveLength(0);
    expect(restarted.orders()[0]).toMatchObject({ side: 'buy', source: 'protection', effect: 'reduce', price: 101 });
    expect(restarted.summary().realized).toBeCloseTo(-1.0402);
  } finally { f.close(); }
});

test('maintenance breach liquidates at observed depth, charges the disclosed surcharge and reconciles on restart', async () => {
  const f = await fixture();
  try {
    f.seed(); f.store.set('risk', { ...f.store.get('risk'), maxOrderNotional: 50000, maxGrossNotional: 50000 });
    f.paper.setLeverage({ leverage: 10 });
    expect((await f.paper.order({ id: 'liquidation-short-open', side: 'sell', quantity: 100 })).status).toBe('filled');
    f.paper.configure({ enabled: false }); f.store.halt(); await Bun.sleep(1001);
    f.sockets[0].emit(statsFrame(f.clock.wall, '198')); await f.paper.monitor();
    expect(f.paper.summary().positions).toHaveLength(0);
    expect(f.paper.orders()[0]).toMatchObject({ source: 'liquidation', side: 'buy', price: 101, status: 'filled' });
    expect(f.paper.summary().liquidationFees).toBe(101);
    // Never execute at the adverse mark; actual visible asks were 101.
    expect(f.paper.summary().equity).toBeCloseTo(9794.98);
    const restarted = new Paper(f.store, (async (_url: any) => Response.json({ code: 200, order_book_details: [market] })) as typeof fetch, f.stream);
    expect(restarted.status().orderManagement.recovery.status).toBe('reconciled');
    expect(restarted.summary().liquidationFees).toBe(101);
  } finally { f.close(); }
});

test('liquidation cannot manufacture depth or refill consumed asks; partial exposure stays visible', async () => {
  const f = await fixture();
  try {
    f.seed(); f.store.set('risk', { ...f.store.get('risk'), maxOrderNotional: 50000, maxGrossNotional: 50000 });
    f.paper.setLeverage({ leverage: 10 });
    expect((await f.paper.order({ id: 'partial-liq-short', side: 'sell', quantity: 100 })).status).toBe('filled');
    // The consumed ledger is authoritative across stream refreshes.
    f.store.db.query('INSERT INTO paper_liquidity VALUES (?,?)').run('1:buy:101', '9900000000');
    f.sockets[0].emit(statsFrame(f.clock.wall, '198')); await Bun.sleep(1001); await f.paper.monitor();
    expect(f.paper.orders()[0]).toMatchObject({ source: 'liquidation', status: 'partial-canceled', filled: 1, canceled: 99 });
    expect(f.paper.summary().positions[0].quantity).toBe(-99);
    await Bun.sleep(1001); await f.paper.monitor();
    expect(f.paper.orders()[0].status).toBe('rejected'); expect(f.paper.summary().positions[0].quantity).toBe(-99);
    f.clock.wall += 5001; f.clock.mono += 5001;
    const before = f.paper.orders().length; await f.paper.monitor();
    expect(f.paper.orders()).toHaveLength(before); expect(f.paper.status().margin.state).toBe('unknown');
  } finally { f.close(); }
});