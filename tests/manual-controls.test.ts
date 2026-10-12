import { test, expect } from 'bun:test';
import { Store } from '../src/store';
import { Operations } from '../src/operations';
import { ExecutionRisk } from '../src/execution-risk';
import { Paper } from '../src/paper';
import { paperAnalytics, paperBalance } from '../src/paper-ledger';
import type { Fill } from '../src/ledger';

function fixture() {
  const s = new Store(':memory:'); new Operations(s, {} as any); new ExecutionRisk(s);
  const prices = { btc: 100, eth: 20 };
  const liquidity = { btc: 100, eth: 100 };
  const request = (async (url: any) => {
    if (String(url).includes('orderBookDetails')) return Response.json({ code: 200, order_book_details: [
      { symbol: 'BTC', status: 'active', market_id: 1, supported_size_decimals: 5, supported_price_decimals: 2, min_base_amount: '.00001', min_quote_amount: '0' },
      { symbol: 'ETH', status: 'active', market_id: 2, supported_size_decimals: 4, supported_price_decimals: 2, min_base_amount: '.0001', min_quote_amount: '0' },
      { symbol: 'OLD', status: 'inactive', market_id: 3 },
    ] });
    const isEth = String(url).includes('market_id=2'), bid = isEth ? prices.eth : prices.btc;
    return Response.json({ code: 200, bids: [{ price: String(bid), remaining_base_amount: String(isEth ? liquidity.eth : liquidity.btc) }], asks: [{ price: String(bid + 0.1), remaining_base_amount: '100' }] });
  }) as typeof fetch;
  const p = new Paper(s, request);
  s.set('allocationPct', 100); s.set('paperSession', { ...s.get('paperSession'), latencyMs: 0 }); p.configure({ enabled: true });
  return { s, p, prices, liquidity, request };
}

test('multi-market cash and cost basis remain isolated; asset quantities are never pooled', () => {
  const fill = (symbol: string, side: 'buy' | 'sell', quantity: number, price: number, id: string): Fill => ({ id, account: 'paper-mainnet', botId: 'orion', symbol, side, quantity, price, fee: 0, multiplier: 1, time: '2026-01-01T00:00:00Z', source: 'paper', reason: 'test' });
  const fills = [fill('BTC-USD', 'buy', 1, 100, 'btc-entry'), fill('ETH-USD', 'buy', 2, 20, 'eth-entry'), fill('ETH-USD', 'sell', 1, 25, 'eth-exit')];
  const b = paperBalance(fills, 1000);
  expect(b.cash).toBe(885000000n); expect(b.basis).toBe(120000000n);
  expect(b.inventory.get('BTC-USD')?.quantity).toBe(100000000n);
  expect(b.inventory.get('ETH-USD')?.quantity).toBe(100000000n);
  expect(b.trades[0].pnl).toBe(5); expect(b.trades[0].symbol).toBe('ETH-USD');
  const a = paperAnalytics(fills, [
    { account: 'paper-mainnet', symbol: 'BTC-USD', price: 110, time: '2026-01-01T00:00:00Z', source: 'test' },
    { account: 'paper-mainnet', symbol: 'ETH-USD', price: 21, time: '2026-01-01T00:00:00Z', source: 'test' },
  ], 1000, new Date('2026-01-01T00:00:01Z'));
  expect(a.equity).toBe(1016); expect(a.unrealized).toBe(11); expect(a.positions).toHaveLength(2);
  expect(a.positions.map(p => p.openNetPnl)).toEqual([10, 1]);
  expect(a.averageBuy).toBeNull();
  expect(() => paperBalance([...fills, fill('ETH-USD', 'sell', 2, 25, 'oversell')], 1000)).toThrow('oversell');
  expect(paperAnalytics(fills, [], 1000).equity).toBeNull();
});

test('selectable markets and IOC limits validate price precision, cap fills and deduplicate by market', async () => {
  const { s, p } = fixture();
  try {
    await p.select({ symbol: 'ETH' });
    expect(p.status().symbol).toBe('ETH'); expect(p.status().markets).toHaveLength(2);
    const order = { id: 'eth-limit-cancel', symbol: 'ETH', type: 'limit', side: 'buy', quantity: 1, limitPrice: 20 };
    expect((await p.order(order)).status).toBe('canceled'); expect(p.summary().fillCount).toBe(0);
    expect((await p.order(order)).status).toBe('canceled');
    await expect(p.order({ ...order, symbol: 'BTC' })).rejects.toThrow('Conflicting');
    await Bun.sleep(1001);
    const filled = await p.order({ ...order, id: 'eth-limit-filled', limitPrice: 20.1 });
    expect(filled.status).toBe('filled'); expect(filled.price).toBeLessThanOrEqual(20.1);
    expect(p.summary().positions[0].symbol).toBe('ETH-USD');
    await expect(p.select({ symbol: 'OLD' })).rejects.toThrow('metadata');
    expect(p.status().symbol).toBe('ETH');
    await Bun.sleep(1001);
    expect((await p.order({ ...order, id: 'bad-price-tick', limitPrice: 20.111 })).error).toContain('precision');
  } finally { s.db.close(); }
}, 10000);

test('all market exposure shares allocation and stale held markets block new buys but not reductions', async () => {
  const { s, p } = fixture();
  try {
    expect((await p.order({ id: 'portfolio-btc-buy', side: 'buy', quantity: 1 })).status).toBe('filled');
    s.set('allocationPct', 1); await Bun.sleep(1001);
    const denied = await p.order({ id: 'portfolio-eth-buy', symbol: 'ETH', side: 'buy', quantity: 1 });
    expect(denied.status).toBe('rejected'); expect(denied.error).toContain('allocation');
    s.set('allocationPct', 100);
    s.set('marks', s.get('marks').map((m: any) => ({ ...m, time: new Date(Date.now() - 30000).toISOString() })));
    await Bun.sleep(1001);
    const stale = await p.order({ id: 'portfolio-eth-stale', symbol: 'ETH', side: 'buy', quantity: 1 });
    expect(stale.error).toContain('Fresh BTC-USD');
    s.halt(); await Bun.sleep(1001);
    expect((await p.order({ id: 'portfolio-btc-close', side: 'sell', quantity: 1 })).status).toBe('filled');
    expect(p.summary().positions).toHaveLength(0);
  } finally { s.db.close(); }
}, 10000);

test('stops and targets persist, pause on restart, execute at depth after gaps, and cannot oversell', async () => {
  const { s, p, prices, request } = fixture();
  try {
    await p.order({ id: 'protection-entry', side: 'buy', quantity: 1 });
    expect(() => p.protect({ symbol: 'BTC', stopLoss: 101 })).toThrow('below');
    expect(() => p.protect({ symbol: 'BTC', takeProfit: 99 })).toThrow('above');
    p.protect({ symbol: 'BTC', stopLoss: 95, takeProfit: 110 });
    const restarted = new Paper(s, request);
    expect(restarted.status().protections.BTC.stopLoss).toBe(95);
    prices.btc = 90; await restarted.refreshWatched();
    expect(restarted.summary().positions).toHaveLength(1); // restart is paused
    restarted.configure({ enabled: true }); s.halt();
    await restarted.refreshWatched();
    expect(restarted.summary().positions).toHaveLength(0);
    expect(restarted.orders()[0].price).toBe(90); // never promise execution at the stop
    expect(restarted.status().protections.BTC).toBeUndefined();
    await restarted.refreshWatched(); expect(restarted.summary().fillCount).toBe(2);
    s.reset(); await Bun.sleep(1001); prices.eth = 20;
    expect((await restarted.order({ id: 'target-eth-entry', symbol: 'ETH', side: 'buy', quantity: 1 })).status).toBe('filled');
    restarted.protect({ symbol: 'ETH', takeProfit: 21 }); await Bun.sleep(1001);
    prices.eth = 22; await restarted.refreshWatched();
    expect(restarted.summary().positions).toHaveLength(0);
    expect(restarted.orders()[0].price).toBe(22);
  } finally { s.db.close(); }
}, 10000);

test('missing depth never triggers protection from a cached bid', async () => {
  const { s, p, prices, request } = fixture();
  try {
    await p.order({ id: 'missing-feed-entry', side: 'buy', quantity: 1 });
    p.protect({ symbol: 'BTC', stopLoss: 95 });
    const broken = new Paper(s, (async (_url: any) => { throw new Error('network disconnected'); }) as unknown as typeof fetch);
    broken.configure({ enabled: true }); prices.btc = 90;
    s.set('marks', s.get('marks').map((m: any) => ({ ...m, price: 90 })));
    await broken.refreshWatched();
    expect(broken.summary().fillCount).toBe(1); expect(broken.status().protections.BTC.lastError).toContain('fresh');
    const recovered = new Paper(s, request); recovered.configure({ enabled: true }); await recovered.refreshWatched();
    expect(recovered.summary().positions).toHaveLength(0);
  } finally { s.db.close(); }
});

test('a triggered partial stop stays latched across a rebound and closes only the remainder', async () => {
  const { s, p, prices, liquidity } = fixture();
  try {
    await p.order({ id: 'partial-stop-entry', side: 'buy', quantity: 1 });
    p.protect({ symbol: 'BTC', stopLoss: 95, takeProfit: 110 });
    await Bun.sleep(1001); prices.btc = 90; liquidity.btc = .5;
    await p.refreshWatched();
    expect(p.summary().positions[0].quantity).toBe(.5);
    expect(p.status().protections.BTC.trigger).toBe('stop-loss');
    expect(p.status().protections.BTC.lastError).toContain('Partial');
    await Bun.sleep(1001); prices.btc = 96; liquidity.btc = 100;
    await p.refreshWatched();
    expect(p.summary().positions).toHaveLength(0);
    expect(p.orders()[0].quantity).toBe(.5); expect(p.orders()[0].price).toBe(96);
    expect(p.status().protections.BTC).toBeUndefined();
  } finally { s.db.close(); }
}, 10000);