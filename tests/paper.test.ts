import { test, expect } from 'bun:test';
import { Store } from '../src/store';
import { Operations } from '../src/operations';
import { ExecutionRisk } from '../src/execution-risk';
import { Paper, parseDepth } from '../src/paper';

test('depth parser rejects invalid/crossed books and sorts executable sides', () => {
  expect(() => parseDepth({ code: 200, bids: [], asks: [] })).toThrow();
  expect(() => parseDepth({ code: 200, bids: [{ price: '101', remaining_base_amount: '1' }], asks: [{ price: '100', remaining_base_amount: '1' }] })).toThrow('Crossed');
  expect(() => parseDepth({ code: 200, bids: [{ price: 'NaN', remaining_base_amount: '1' }], asks: [{ price: '100', remaining_base_amount: '1' }] })).toThrow();
  expect(parseDepth({ code: 200, bids: [{ price: '99', remaining_base_amount: '.1' }, { price: '99', remaining_base_amount: '.2' }], asks: [{ price: '100', remaining_base_amount: '1' }] }).bids).toEqual([{ price: 99, quantity: .3 }]);
});

test('risk money rejects unsupported precision and unknown fields before persisting', () => {
  const s = new Store(':memory:'), ops = new Operations(s, {} as any);
  try {
    const before = s.get('risk');
    expect(() => ops.risk({ dailyLoss: 1.0000001 })).toThrow('precision');
    expect(() => ops.risk({ executionEnabled: true })).toThrow('Unknown');
    expect(s.get('risk')).toEqual(before);
    expect((s.db.query('PRAGMA synchronous').get() as any).synchronous).toBe(2);
    ops.risk({ dailyLoss: 1.000001 }); expect(s.get('risk').dailyLoss).toBe(1.000001);
  } finally { s.db.close(); }
});

test('paper IOC persists depth-based partial fills, deduplicates and permits halted reduction', async () => {
  const s = new Store(':memory:');
  new Operations(s, {} as any); new ExecutionRisk(s);
  const mock = (async (url: any) => Response.json(String(url).includes('orderBookDetails') ? { code: 200, order_book_details: [{ symbol: 'BTC', status: 'active', market_id: 1, supported_size_decimals: 5, supported_price_decimals: 2, min_base_amount: '.00001', min_quote_amount: '0' }] } : { code: 200, bids: [{ price: '100', remaining_base_amount: '2' }], asks: [{ price: '101', remaining_base_amount: '.01' }, { price: '101.2', remaining_base_amount: '.01' }] })) as typeof fetch;
  const p = new Paper(s, mock); s.set('allocationPct', 10); s.set('paperSession', { ...s.get('paperSession'), latencyMs: 0 });
  try {
    p.configure({ enabled: true });
    const result = await p.order({ id: 'order-0001', side: 'buy', quantity: .03 });
    expect(result.status).toBe('partial-canceled'); expect(result.filled).toBeCloseTo(.02); expect(result.price).toBeCloseTo(101.1);
    expect(p.summary().positions[0].quantity).toBeCloseTo(.02);
    expect(p.summary().accounting.cashMicros).toBe('9997977595');
    expect(p.summary().accounting.quantityAtoms).toBe('2000000');
    expect((await p.order({ id: 'order-0001', side: 'buy', quantity: .03 })).filled).toBeCloseTo(.02);
    expect(p.summary().fillCount).toBe(1);
    expect((s.db.query('SELECT COUNT(*) AS n FROM paper_observations').get() as any).n).toBe(1);
    expect(() => new Operations(s, {} as any).resetStats('ARCHIVE AND RESET')).toThrow('session ledger');
    s.halt(); await Bun.sleep(1001);
    const close = await p.order({ id: 'order-0002', side: 'sell', quantity: .02 });
    expect(close.status).toBe('filled'); expect(p.summary().positions).toHaveLength(0); expect(p.summary().realized).toBeLessThan(0);
    await Bun.sleep(1001);
    expect((await p.order({ id: 'order-0003', side: 'buy', quantity: .01 })).status).toBe('rejected');
    const restarted = new Paper(s, mock); expect(restarted.status().enabled).toBe(false); expect(restarted.summary().fillCount).toBe(2);
    expect(restarted.summary().accounting.quantityAtoms).toBe('0');
    expect(restarted.summary().accounting.basisMicros).toBe('0');
    expect(restarted.summary().accounting.cashMicros).toBe('9999977195');
    expect(new Operations(s, {} as any).snapshot().accounts.find(a => a.account === 'paper-mainnet')!.analytics).toEqual(restarted.summary());
    s.db.exec('DELETE FROM paper_liquidity'); s.set('paperLiquidityVersion', null);
    const upgraded = new Paper(s, mock);
    expect((s.db.query('SELECT COUNT(*) AS n FROM paper_liquidity').get() as any).n).toBe(3);
    expect(s.get('paperLiquidityUnreconciled')).toBeNull();
    s.set('halted', false); upgraded.configure({ enabled: true });
    const reused = await upgraded.order({ id: 'reuse-depth-0001', side: 'buy', quantity: .01 });
    expect(reused.status).toBe('rejected'); expect(reused.error).toContain('unused REST liquidity');
    expect(restarted.summary().fillCount).toBe(2);
  } finally { s.db.close(); }
});

test('paper fails closed on zero allocation and data failure', async () => {
  const s = new Store(':memory:'); new Operations(s, {} as any); new ExecutionRisk(s);
  const p = new Paper(s, (async () => { throw new Error('offline'); }) as unknown as typeof fetch);
  try {
    p.configure({ enabled: true });
    expect((await p.order({ id: 'offline-0001', side: 'buy', quantity: .001 })).status).toBe('rejected');
    expect(p.summary().fillCount).toBe(0); expect(p.status().feed.status).toBe('disconnected');
    expect(() => p.configure({ enabled: 'true' })).toThrow();
  } finally { s.db.close(); }
});

test('paper rejects zero allocation without fabricating fills', async () => {
  const s = new Store(':memory:'); new Operations(s, {} as any); new ExecutionRisk(s);
  const mock = (async (url: any) => Response.json(String(url).includes('orderBookDetails') ? { code: 200, order_book_details: [{ symbol: 'BTC', status: 'active', market_id: 1, supported_size_decimals: 5, supported_price_decimals: 2, min_base_amount: '.00001', min_quote_amount: '0' }] } : { code: 200, bids: [{ price: '100', remaining_base_amount: '1' }], asks: [{ price: '101', remaining_base_amount: '1' }] })) as typeof fetch;
  const p = new Paper(s, mock);
  try { p.configure({ enabled: true }); const result = await p.order({ id: 'zero-allocation', side: 'buy', quantity: .001 }); expect(result.status).toBe('rejected'); expect(result.error).toContain('risk limit'); expect(p.summary().fillCount).toBe(0); }
  finally { s.db.close(); }
});

test('paper risk rejects depth cost exceeding the order limit even when best quote fits', async () => {
  const s = new Store(':memory:'); new Operations(s, {} as any); new ExecutionRisk(s);
  const mock = (async (url: any) => Response.json(String(url).includes('orderBookDetails')
    ? { code: 200, order_book_details: [{ symbol: 'BTC', status: 'active', market_id: 1, supported_size_decimals: 5, supported_price_decimals: 2, min_base_amount: '.00001', min_quote_amount: '0' }] }
    : { code: 200, bids: [{ price: '99', remaining_base_amount: '1' }], asks: [{ price: '100', remaining_base_amount: '.001' }, { price: '100.5', remaining_base_amount: '1' }] })) as typeof fetch;
  const p = new Paper(s, mock);
  try {
    s.set('allocationPct', 50); s.set('risk', { ...s.get('risk'), maxOrderNotional: 1 });
    s.set('paperSession', { ...s.get('paperSession'), latencyMs: 0 }); p.configure({ enabled: true });
    const result = await p.order({ id: 'depth-risk-0001', side: 'buy', quantity: .01 });
    expect(result.status).toBe('rejected'); expect(result.error).toContain('risk limit'); expect(p.summary().fillCount).toBe(0);
  } finally { s.db.close(); }
});

test('pending claim is shared across matcher instances and recovery scans beyond display limit', async () => {
  const s = new Store(':memory:'); new Operations(s, {} as any); new ExecutionRisk(s);
  let release!: () => void;
  const gate = new Promise<void>(resolve => release = resolve);
  const mock = (async (url: any) => {
    await gate;
    return Response.json(String(url).includes('orderBookDetails')
      ? { code: 200, order_book_details: [{ symbol: 'BTC', status: 'active', market_id: 1, supported_size_decimals: 5, supported_price_decimals: 2, min_base_amount: '.00001', min_quote_amount: '0' }] }
      : { code: 200, bids: [{ price: '100', remaining_base_amount: '1' }], asks: [{ price: '101', remaining_base_amount: '1' }] });
  }) as typeof fetch;
  const a = new Paper(s, mock), b = new Paper(s, mock);
  try {
    s.set('allocationPct', 100); s.set('paperSession', { ...s.get('paperSession'), latencyMs: 0 }); a.configure({ enabled: true });
    const first = a.order({ id: 'concurrent-first', side: 'buy', quantity: .001 });
    const second = await b.order({ id: 'concurrent-second', side: 'buy', quantity: .001 });
    expect(second.status).toBe('rejected'); expect(second.error).toContain('pending order');
    release(); expect((await first).status).toBe('filled'); expect(a.summary().fillCount).toBe(1);
    for (let i = 0; i < 125; i++) s.db.query('INSERT INTO paper_orders VALUES (?,?)').run(`recovery-${i}`, JSON.stringify({ id: `recovery-${i}`, status: 'pending' }));
    new Paper(s, mock);
    expect((s.db.query("SELECT COUNT(*) AS n FROM paper_orders WHERE json_extract(payload,'$.status')='pending'").get() as any).n).toBe(0);
    expect(a.status().enabled).toBe(false);
  } finally { release(); s.db.close(); }
});

test('observation retention is bounded while preserving fill evidence and immutable integer baseline', async () => {
  const s = new Store(':memory:'); new Operations(s, {} as any); new ExecutionRisk(s);
  const mock = (async (url: any) => Response.json(String(url).includes('orderBookDetails')
    ? { code: 200, order_book_details: [{ symbol: 'BTC', status: 'active', market_id: 1, supported_size_decimals: 5, supported_price_decimals: 2, min_base_amount: '.00001', min_quote_amount: '0' }] }
    : { code: 200, bids: [{ price: '100', remaining_base_amount: '1' }], asks: [{ price: '101', remaining_base_amount: '1' }] })) as typeof fetch;
  const p = new Paper(s, mock);
  try {
    s.db.query('INSERT INTO paper_observations VALUES (?,?)').run('evidence', '{}');
    s.db.query('INSERT INTO paper_orders VALUES (?,?)').run('evidence-order', JSON.stringify({ id: 'evidence-order', status: 'filled', filled: 1, observationId: 'evidence' }));
    for (let i = 0; i < 1100; i++) s.db.query('INSERT INTO paper_observations VALUES (?,?)').run(`old-${i}`, '{}');
    await p.observe();
    expect((s.db.query('SELECT COUNT(*) AS n FROM paper_observations').get() as any).n).toBe(1001);
    expect(s.db.query('SELECT id FROM paper_observations WHERE id=?').get('evidence')).not.toBeNull();
    const key = `paperBaselineMicros:${new Date().toISOString().slice(0, 10)}`;
    expect(s.get(key)).toBe('10000000000'); await p.observe(); expect(s.get(key)).toBe('10000000000');
  } finally { s.db.close(); }
});

test('fill fees latch realized daily loss atomically without waiting for the next observation', async () => {
  const s = new Store(':memory:'); new Operations(s, {} as any); new ExecutionRisk(s);
  const mock = (async (url: any) => Response.json(String(url).includes('orderBookDetails')
    ? { code: 200, order_book_details: [{ symbol: 'BTC', status: 'active', market_id: 1, supported_size_decimals: 5, supported_price_decimals: 2, min_base_amount: '.00001', min_quote_amount: '0' }] }
    : { code: 200, bids: [{ price: '100', remaining_base_amount: '1' }], asks: [{ price: '101', remaining_base_amount: '1' }] })) as typeof fetch;
  const p = new Paper(s, mock);
  try {
    s.set('allocationPct', 100); s.set('risk', { ...s.get('risk'), dailyLoss: .00002 });
    s.set('paperSession', { ...s.get('paperSession'), latencyMs: 0 }); p.configure({ enabled: true });
    expect((await p.order({ id: 'fee-loss-boundary', side: 'buy', quantity: .001 })).status).toBe('filled');
    expect(s.get('paperLossHalt')).toBe(true);
    expect(() => p.configure({ enabled: true })).toThrow('halt');
    s.reset(); expect(s.get('paperLossHalt')).toBe(true);
  } finally { s.db.close(); }
});