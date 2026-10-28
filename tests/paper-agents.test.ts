import { test, expect } from 'bun:test';
import { Store } from '../src/store';
import { Operations } from '../src/operations';
import { ExecutionRisk } from '../src/execution-risk';
import { Paper } from '../src/paper';
import { paperAnalytics } from '../src/paper-ledger';
import type { Fill } from '../src/ledger';

const settledFill = (id: string, botId: string, side: 'buy' | 'sell', quantity: number, quote: string, fee: string, effect: 'open' | 'reduce', time = '2026-01-02T12:00:00Z'): Fill => ({
  id, account: 'paper-mainnet', botId, symbol: 'BTC-USD', side, quantity, price: Number(quote) / 1e6 / quantity,
  fee: Number(fee) / 1e6, multiplier: 1, time, source: 'paper', reason: 'test',
  settlement: { version: 2, effect, quantityAtoms: String(Math.round(quantity * 1e8)), quoteMicros: quote, feeMicros: fee, leverage: 1 },
});

test('ledger accepts agent bot ids: closed legs attribute to the closer, fees to the filling agent', () => {
  const fills = [
    settledFill('f1', 'agent-research-1', 'buy', .01, '1000000', '100', 'open'),
    settledFill('f2', 'agent-research-1', 'sell', .005, '520000', '60', 'reduce'),
    settledFill('f3', 'agent-shadow-2', 'sell', .005, '510000', '60', 'reduce', '2026-01-03T09:00:00Z'),
  ];
  const a = paperAnalytics(fills, [], 1000, new Date('2026-01-03T12:00:00Z'));
  expect(a.agents.map(r => r.botId)).toEqual(['agent-research-1', 'agent-shadow-2']);
  expect(a.bots).toEqual([]);
  const research = a.agents.find(r => r.botId === 'agent-research-1')!;
  const shadow = a.agents.find(r => r.botId === 'agent-shadow-2')!;
  // f2 closes half the long opened by f1: +20000 micros price pnl, -50 closing fees, -60 fill fee.
  expect(research.realized).toBeCloseTo(0.01989, 10);
  expect(research.fees).toBeCloseTo(0.00016, 10);
  expect(research.trades).toBe(1); expect(research.winRate).toBe(1); expect(research.fills).toBe(2);
  // f3 closes the remainder (closer attribution): +10000 price pnl, -50 closing fees, -60 fill fee.
  expect(shadow.realized).toBeCloseTo(0.00989, 10);
  expect(shadow.fees).toBeCloseTo(0.00006, 10);
  expect(shadow.trades).toBe(1); expect(shadow.fills).toBe(1); expect(shadow.volume).toBeCloseTo(0.51, 10);
  expect(() => paperAnalytics([settledFill('f1', 'agentBad', 'buy', .01, '1000000', '100', 'open')], [], 1000)).toThrow('Unsupported paper inventory');
  expect(() => paperAnalytics([settledFill('f1', 'agent-ab', 'buy', .01, '1000000', '100', 'open')], [], 1000)).toThrow('Unsupported paper inventory');
});

const mock = (async (url: any) => Response.json(String(url).includes('orderBookDetails')
  ? { code: 200, order_book_details: [{ symbol: 'BTC', status: 'active', market_id: 1, supported_size_decimals: 5, supported_price_decimals: 2, min_base_amount: '.00001', min_quote_amount: '0' }] }
  : { code: 200, bids: [{ price: '100', remaining_base_amount: '2' }], asks: [{ price: '101', remaining_base_amount: '.01' }] })) as typeof fetch;

test('agent orders fail closed without latch/allocation, respect the envelope, and reductions never need the latch', async () => {
  const s = new Store(':memory:');
  new Operations(s, {} as any); new ExecutionRisk(s);
  const p = new Paper(s, mock); s.set('allocationPct', 10); s.set('paperSession', { ...s.get('paperSession'), latencyMs: 0 });
  try {
    p.configure({ enabled: true });
    const latch = await p.agentOrder({ id: 'agent-00000001', side: 'buy', quantity: .005, agentId: 'agent-research-1', reason: 'test' });
    expect(latch.status).toBe('rejected'); expect(latch.error).toContain('Agent automation is not enabled');
    await Bun.sleep(1001);
    s.set('agentEnabled', true);
    const zero = await p.agentOrder({ id: 'agent-00000002', side: 'buy', quantity: .005, agentId: 'agent-research-1', reason: 'test' });
    expect(zero.status).toBe('rejected'); expect(zero.error).toContain('agent allocation is 0%');
    await Bun.sleep(1001);
    s.set('agentAllocationPct', 1);
    const ok = await p.agentOrder({ id: 'agent-00000003', side: 'buy', quantity: .01, agentId: 'agent-research-1', reason: 'test' });
    expect(ok.status).toBe('filled'); expect(ok.price).toBeCloseTo(101);
    const summary = p.summary();
    expect(summary.agents.map(r => r.botId)).toEqual(['agent-research-1']);
    expect(summary.agents[0].fills).toBe(1);
    await Bun.sleep(1001);
    // Envelope: agent open notional (~$1.01) + a ~$101.5 order exceeds 1% of $10,000 equity ($100).
    const tooBig = await p.agentOrder({ id: 'agent-00000004', side: 'buy', quantity: 1, agentId: 'agent-research-2', reason: 'test' });
    expect(tooBig.status).toBe('rejected'); expect(tooBig.error).toContain('agent exposure would exceed');
    await Bun.sleep(1001);
    s.set('agentEnabled', false);
    const openAfterOff = await p.agentOrder({ id: 'agent-00000005', side: 'buy', quantity: .001, agentId: 'agent-research-1', reason: 'test' });
    expect(openAfterOff.error).toContain('Agent automation is not enabled');
    await Bun.sleep(1001);
    const close = await p.agentOrder({ id: 'agent-00000006', side: 'sell', quantity: .01, agentId: 'agent-research-1', reason: 'test' });
    expect(close.status).toBe('filled');
    expect(p.summary().positions).toHaveLength(0);
    expect(p.summary().agents[0].fills).toBe(2);
    await Bun.sleep(1001);
    await expect(p.agentOrder({ id: 'agent-00000007', side: 'buy', quantity: .001, agentId: 'BAD', reason: 'x' })).rejects.toThrow('Valid agent ID');
  } finally { s.db.close(); }
}, 30000);

test('real executor admits a fleet bot open (regression: a stale clause blocked every non-manual open)', async () => {
  const s = new Store(':memory:');
  new Operations(s, {} as any); new ExecutionRisk(s);
  const p = new Paper(s, mock); s.set('allocationPct', 10); s.set('paperSession', { ...s.get('paperSession'), latencyMs: 0 });
  try {
    p.configure({ enabled: true }); s.set('fleetEnabled', true);
    const open = await p.botOrder({ id: 'bot-00000001', symbol: 'BTC', side: 'buy', quantity: .01, leverage: 1, botId: 'fleet-regress', reason: 'test' });
    expect(open.status).toBe('filled'); expect(open.price).toBeCloseTo(101);
    expect(p.summary().bots.map(r => r.botId)).toEqual(['fleet-regress']);
  } finally { s.db.close(); }
});
