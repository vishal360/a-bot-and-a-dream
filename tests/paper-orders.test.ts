import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store';
import { Operations } from '../src/operations';
import { ExecutionRisk } from '../src/execution-risk';
import { Paper } from '../src/paper';

function fixture(path = ':memory:') {
  const store = new Store(path); new Operations(store, {} as any); new ExecutionRisk(store);
  const state = { bid: 100, ask: 101, asks: 100, bids: 100, broken: false };
  const request = (async (url: any) => {
    if (state.broken) throw new Error('Disconnected market data');
    return Response.json(String(url).includes('orderBookDetails')
      ? { code: 200, order_book_details: [{ symbol: 'BTC', status: 'active', market_id: 1, supported_size_decimals: 5, supported_price_decimals: 2, min_base_amount: '.00001', min_quote_amount: '0', min_initial_margin_fraction: 500 }] }
      : { code: 200, bids: [{ price: String(state.bid), remaining_base_amount: String(state.bids) }], asks: [{ price: String(state.ask), remaining_base_amount: String(state.asks) }] });
  }) as typeof fetch;
  const paper = new Paper(store, request);
  store.set('allocationPct', 100); store.set('paperSession', { ...store.get('paperSession'), latencyMs: 60 }); paper.configure({ enabled: true });
  return { store, paper, state, request };
}
async function reserved(paper: Paper) {
  for (let i = 0; i < 100; i++) { if (paper.status().orderManagement.reservations.length) return; await Bun.sleep(2); }
  throw new Error('Order never reserved');
}
const entry = (id: string, extra = {}) => ({ id, side: 'buy', quantity: 1, ...extra });

test('durable reservation covers the entire request; duplicate reads never reserve or execute twice', async () => {
  const f = fixture();
  try {
    f.state.asks = .5;
    const intent = entry('reserved-partial-01'), execution = f.paper.order(intent);
    await reserved(f.paper);
    const pending = f.paper.status().orderManagement;
    expect(pending.chargeMicros).toBe('101530302'); expect(pending.notionalMicros).toBe('101510000');
    expect((await f.paper.order(intent)).status).toBe('pending');
    expect(f.paper.status().orderManagement.reservations).toHaveLength(1);
    await expect(f.paper.order({ ...intent, quantity: 2 })).rejects.toThrow('Conflicting');
    await expect(f.paper.order({ ...intent, leverage: 1 })).rejects.toThrow('Conflicting');
    await expect(f.paper.order(entry('second-pending-01'))).rejects.toThrow('busy');
    expect((await execution).status).toBe('partial-canceled');
    expect(f.paper.summary().accounting.cashMicros).toBe('9949489900');
    expect(f.paper.status().orderManagement.chargeMicros).toBe('0');
    expect((await f.paper.order(intent)).status).toBe('partial-canceled'); expect(f.paper.summary().fillCount).toBe(1);
    const restart = new Paper(f.store, f.request);
    expect(restart.status().orderManagement.recovery.status).toBe('reconciled');
    expect((await restart.order(intent)).status).toBe('partial-canceled');
  } finally { f.store.db.close(); }
});

test('local cancellation wins during latency and is idempotent before and after settlement', async () => {
  const f = fixture();
  try {
    const intent = entry('cancel-latency-01'), execution = f.paper.order(intent);
    await reserved(f.paper);
    expect(f.paper.cancel({ id: intent.id }).status).toBe('canceled');
    expect(f.paper.cancel({ id: intent.id }).status).toBe('canceled');
    expect((await execution).status).toBe('canceled'); expect(f.paper.summary().fillCount).toBe(0);
    expect(f.paper.status().orderManagement.reservations).toHaveLength(0);
    expect((await f.paper.order(intent)).status).toBe('canceled');
    expect((f.store.db.query('SELECT COUNT(*) AS n FROM paper_liquidity').get() as any).n).toBe(0);
    expect(() => f.paper.cancel({ id: 'unknown-order-01' })).toThrow('Unknown');
  } finally { f.store.db.close(); }
});

test('disconnect, price gap and kill switch during latency reject atomically and release the reservation', async () => {
  for (const failure of ['disconnect', 'gap', 'halt', 'allocation']) {
    const f = fixture();
    try {
      const execution = f.paper.order(entry(`latency-${failure}-01`)); await reserved(f.paper);
      if (failure === 'disconnect') f.state.broken = true;
      if (failure === 'gap') { f.state.ask = 110; f.state.bid = 109; }
      if (failure === 'halt') f.store.halt();
      if (failure === 'allocation') f.store.set('allocationPct', 0);
      const result = await execution;
      expect(result.status).toBe('rejected');
      if (failure === 'gap') expect(result.error).toContain('reservation exceeded');
      expect(f.paper.summary().fillCount).toBe(0); expect(f.paper.status().orderManagement.reservations).toHaveLength(0);
      expect((f.store.db.query('SELECT COUNT(*) AS n FROM paper_liquidity').get() as any).n).toBe(0);
    } finally { f.store.db.close(); }
  }
});

test('nonmarketable limit cancels with no fill and releases its budget', async () => {
  const f = fixture();
  try {
    const execution = f.paper.order(entry('limit-no-cross-01', { type: 'limit', limitPrice: 100 }));
    await reserved(f.paper); expect((await execution).status).toBe('canceled');
    expect(f.paper.status().orderManagement.reservations).toHaveLength(0); expect(f.paper.summary().fillCount).toBe(0);
  } finally { f.store.db.close(); }
});

test('restart fences a suspended worker; interrupted orders release budget and never replay', async () => {
  const f = fixture();
  try {
    const intent = entry('restart-latency-01'), execution = f.paper.order(intent); await reserved(f.paper);
    const restart = new Paper(f.store, f.request);
    expect(restart.status().enabled).toBe(false); expect(restart.status().orderManagement.reservations).toHaveLength(0);
    restart.configure({ enabled: true });
    expect((await execution).error).toContain('restart'); expect(restart.summary().fillCount).toBe(0);
    expect((await restart.order(intent)).status).toBe('rejected');
    await Bun.sleep(1001);
    expect((await f.paper.order(entry('stale-worker-01'))).status).toBe('rejected');
  } finally { f.store.db.close(); }
});

test('disk reopen reconciles committed fills and interrupted reservations without touching capital', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-orders-')), path = join(dir, 'paper.sqlite');
  let f = fixture(path);
  try {
    const intent = entry('disk-committed-01'); expect((await f.paper.order(intent)).status).toBe('filled');
    const cash = f.paper.summary().accounting.cashMicros;
    f.store.db.query('INSERT INTO paper_orders VALUES (?,?)').run('disk-pending-01', JSON.stringify({ ...intent, id: 'disk-pending-01', status: 'pending' }));
    f.store.db.query('INSERT INTO paper_reservations VALUES (?,?)').run('disk-pending-01', JSON.stringify({ id: 'disk-pending-01', generation: 'old', symbol: 'BTC', side: 'buy', quantityAtoms: '100000000', notionalMicros: '101510000', chargeMicros: '101530302' }));
    f.store.db.close(); f = fixture(path);
    expect(f.paper.status().orderManagement.recovery.status).toBe('reconciled');
    expect(f.paper.status().orderManagement.reservations).toHaveLength(0);
    expect(f.paper.summary().accounting.cashMicros).toBe(cash);
    expect((await f.paper.order(intent)).status).toBe('filled');
    expect((await f.paper.order(entry('disk-pending-01'))).status).toBe('rejected');
  } finally { f.store.db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('pending+fill contradictions and orphan reservations preserve uncertainty across reset', async () => {
  const f = fixture();
  try {
    expect((await f.paper.order(entry('evidence-entry-01'))).status).toBe('filled');
    const order = f.paper.orders()[0];
    f.store.db.query('UPDATE paper_orders SET payload=? WHERE id=?').run(JSON.stringify({ ...order, status: 'pending' }), order.id);
    f.store.db.query('INSERT INTO paper_reservations VALUES (?,?)').run('orphan-reserve-01', JSON.stringify({ id: 'orphan-reserve-01', generation: 'old', symbol: 'BTC', side: 'buy', quantityAtoms: '100', notionalMicros: '100', chargeMicros: '100' }));
    const restart = new Paper(f.store, f.request); restart.configure({ enabled: true });
    expect(restart.status().orderManagement.blocked).toBe(true); expect(restart.status().orderManagement.reservations).toHaveLength(1);
    expect((await restart.order(entry('recovery-blocked-01'))).error).toContain('pending order');
    // A contradictory pending+fill must never be rejected or replayed automatically.
    expect(restart.orders().find(o => o.id === order.id).status).toBe('pending');
    expect(() => restart.cancel({ id: order.id })).toThrow('committed fill');
    f.store.reset(); expect(restart.status().orderManagement.blocked).toBe(true);
  } finally { f.store.db.close(); }
});

test('mismatched terminal evidence blocks buying but permits a ledger-verified halted exit', async () => {
  const f = fixture();
  try {
    expect((await f.paper.order(entry('mismatch-entry-01'))).status).toBe('filled');
    const order = f.paper.orders()[0];
    f.store.db.query('UPDATE paper_orders SET payload=? WHERE id=?').run(JSON.stringify({ ...order, quoteMicros: '1' }), order.id);
    const restart = new Paper(f.store, f.request); restart.configure({ enabled: true });
    expect(restart.status().orderManagement.blocked).toBe(true);
    expect((await restart.order(entry('blocked-buy-0001'))).error).toContain('reconciliation');
    f.store.halt(); await Bun.sleep(1001);
    expect((await restart.order({ id: 'verified-close-01', side: 'sell', quantity: 1 })).status).toBe('filled');
    expect(restart.summary().positions).toHaveLength(0); expect(restart.status().orderManagement.reservations).toHaveLength(0);
  } finally { f.store.db.close(); }
});

test('partial protection exits use the same quantity reservation and retry only the remainder after rejection', async () => {
  const f = fixture();
  try {
    await f.paper.order(entry('shared-stop-entry-01')); f.paper.protect({ symbol: 'BTC', stopLoss: 95 });
    f.state.bid = 90; f.state.ask = 91; f.state.bids = .5; await f.paper.observe(); await Bun.sleep(1001);
    const monitor = f.paper.refreshWatched(); await reserved(f.paper);
    const pending = f.paper.orders()[0]; expect(pending.source).toBe('protection');
    expect(f.paper.status().orderManagement.reservations[0].quantityAtoms).toBe('100000000');
    expect(f.paper.status().orderManagement.chargeMicros).toBe('0'); await monitor;
    expect(f.paper.summary().positions[0].quantity).toBe(.5); expect(f.paper.status().orderManagement.reservations).toHaveLength(0);
    await Bun.sleep(1001); await f.paper.refreshWatched(); // Same consumed liquidity: rejected, trigger remains latched.
    expect(f.paper.orders()[0].status).toBe('rejected'); expect(f.paper.status().protections.BTC.trigger).toBe('stop-loss');
    expect(f.paper.status().orderManagement.reservations).toHaveLength(0);
    f.state.bid = 96; f.state.ask = 97; f.state.bids = 100; await Bun.sleep(1001); await f.paper.refreshWatched();
    expect(f.paper.orders()[0].quantity).toBe(.5); expect(f.paper.summary().positions).toHaveLength(0);
  } finally { f.store.db.close(); }
}, 10000);

test('manual callers cannot spoof agent/protection authority or internal lifecycle fields', async () => {
  const f = fixture();
  try {
    for (const extra of [{ source: 'agent' }, { reason: 'stop-loss' }, { generation: 'fake' }, { phase: 'reserved' }]) {
      await expect(f.paper.order(entry('untrusted-order-01', extra))).rejects.toThrow('Unknown');
    }
    expect(f.paper.orders()).toHaveLength(0);
  } finally { f.store.db.close(); }
});

test('a failed terminal write rolls back fill, liquidity and loss latch before rejecting and releasing', async () => {
  const f = fixture();
  try {
    f.store.set('risk', { ...f.store.get('risk'), dailyLoss: .000001 });
    f.store.db.exec(`CREATE TRIGGER fail_filled_order BEFORE INSERT ON paper_orders
      WHEN json_extract(NEW.payload,'$.status') IN ('filled','partial-canceled')
      BEGIN SELECT RAISE(ABORT,'simulated terminal storage failure'); END`);
    const result = await f.paper.order(entry('rollback-terminal-01'));
    expect(result.status).toBe('rejected'); expect(result.error).toContain('storage failure');
    expect(f.paper.summary().accounting.cashMicros).toBe('10000000000');
    expect(f.paper.summary().fillCount).toBe(0); expect(f.store.get('paperLossHalt')).not.toBe(true);
    expect(f.paper.status().orderManagement.reservations).toHaveLength(0);
    expect((f.store.db.query('SELECT COUNT(*) AS n FROM paper_liquidity').get() as any).n).toBe(0);
    expect((f.store.db.query("SELECT COUNT(*) AS n FROM audit WHERE action='MAINNET_PAPER_FILL'").get() as any).n).toBe(0);
  } finally { f.store.db.close(); }
});

test('cancellation after committed settlement returns the fill without undoing cash or consumption', async () => {
  const f = fixture();
  try {
    const intent = entry('cancel-after-fill-01'); expect((await f.paper.order(intent)).status).toBe('filled');
    const cash = f.paper.summary().accounting.cashMicros;
    expect(f.paper.cancel({ id: intent.id }).status).toBe('filled');
    expect(f.paper.summary().accounting.cashMicros).toBe(cash); expect(f.paper.summary().fillCount).toBe(1);
  } finally { f.store.db.close(); }
});

test('restart detects missing consumption and inconsistent execution legs instead of replenishing liquidity', async () => {
  for (const problem of ['consumption', 'legs', 'observation']) {
    const f = fixture();
    try {
      await f.paper.order(entry(`corrupt-${problem}-01`));
      if (problem === 'consumption') f.store.db.exec('DELETE FROM paper_liquidity');
      if (problem === 'legs') {
        const order = f.paper.orders()[0]; order.executions[0].quantity = .5;
        f.store.db.query('UPDATE paper_orders SET payload=? WHERE id=?').run(JSON.stringify(order), order.id);
      }
      if (problem === 'observation') f.store.db.exec('DELETE FROM paper_observations');
      const restart = new Paper(f.store, f.request);
      expect(restart.status().orderManagement.blocked).toBe(true);
      expect(restart.status().orderManagement.recovery.issues.length).toBeGreaterThan(0);
      restart.configure({ enabled: true });
      expect((await restart.order(entry(`no-reuse-${problem}-01`))).status).toBe('rejected');
      expect(restart.summary().fillCount).toBe(1);
    } finally { f.store.db.close(); }
  }
});

test('inability to persist rejection retains the pending reservation until verified restart recovery', async () => {
  const f = fixture();
  try {
    const execution = f.paper.order(entry('retain-storage-fault-01')); await reserved(f.paper);
    f.store.db.exec(`CREATE TRIGGER fail_any_terminal BEFORE INSERT ON paper_orders
      WHEN json_extract(NEW.payload,'$.status') != 'pending'
      BEGIN SELECT RAISE(ABORT,'terminal storage unavailable'); END`);
    let message = '';
    try { await execution; } catch (e) { message = (e as Error).message; }
    expect(message).toContain('terminal storage unavailable');
    expect(f.paper.summary().fillCount).toBe(0); expect(f.paper.status().orderManagement.reservations).toHaveLength(1);
    expect(f.paper.orders()[0].status).toBe('pending');
    f.store.db.exec('DROP TRIGGER fail_any_terminal');
    const restart = new Paper(f.store, f.request);
    expect(restart.status().orderManagement.reservations).toHaveLength(0);
    expect(restart.orders()[0].status).toBe('rejected'); expect(restart.status().enabled).toBe(false);
  } finally { f.store.db.close(); }
});