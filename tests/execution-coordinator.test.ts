import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionCoordinator, type AccountBinding, type ExecutionIntent, type SendRequest, type TrustedAccountSnapshot, type VerifiedExecutionEvidence, type VenueSigningAdapter } from '../src/execution-coordinator';
const binding: AccountBinding = { environment: 'fixture', accountId: 'account', apiKeyId: 'key', chainId: 'fixture-chain', generation: 'g1' };
const limits = { maxNotional: 1000, maxTotalNotional: 2000, maxPendingOrders: 3, snapshotMaxAgeMs: 1000, leaseTtlMs: 100 };
const intent = (clientId = 'one', patch: Partial<ExecutionIntent> = {}): ExecutionIntent => ({ clientId, symbol: 'BTC', side: 'buy', quantity: 5, worstPrice: 10, margin: 20, reduceOnly: false, ...patch });
const snapshot = (patch: Partial<TrustedAccountSnapshot> = {}): TrustedAccountSnapshot => ({ ...binding, verified: true, sequence: 1, observedAt: 10000, nextNonce: 40, equity: 1000, available: 800, grossNotional: 100, positions: { BTC: 10 }, ...patch });
class FakeAdapter implements VenueSigningAdapter {
  calls: SendRequest[] = [];
  handler: (r: SendRequest) => Promise<{ accepted: true; transactionId: string }> = async r => ({ accepted: true, transactionId: `tx-${r.order.clientId}` });
  async send(r: SendRequest) { r.assertCurrentLease(); this.calls.push(r); return this.handler(r); }
}
const closers: (() => void)[] = [];
afterEach(() => { for (const close of closers.splice(0).reverse()) close(); });
function setup(patch: Partial<typeof limits> = {}, file?: string) {
  let now = 10000; const adapter = new FakeAdapter();
  const c = new ExecutionCoordinator(file ?? ':memory:', binding, { ...limits, ...patch }, adapter, () => now);
  closers.push(() => c.close()); c.reconcileAccount(snapshot()); c.authorizeSession(binding);
  return { c, adapter, time: (n: number) => { now = n; } };
}
function disk() { const dir = mkdtempSync(join(tmpdir(), 'coordinator-')); closers.push(() => rmSync(dir, { recursive: true, force: true })); return join(dir, 'oms.sqlite'); }
const evidence = (patch: Partial<VerifiedExecutionEvidence> = {}): VerifiedExecutionEvidence => ({ ...binding, verified: true, evidenceId: 'ev1', clientId: 'one', nonce: 40, venueOrderId: 'venue-one', kind: 'filled', transactionId: 'tx-one', orderEvidenceId: 'venue-proof', observedAt: 10001, fills: [{ fillId: 'fill1', quantity: 5 }], ...patch });

test('durable preparation precedes network, immutable IDs; acceptance is not filled and duplicate submit never resends', async () => {
  const { c, adapter } = setup();
  c.prepare(intent()); expect(adapter.calls).toHaveLength(0);
  expect(c.prepare(intent()).state).toBe('prepared');
  expect(() => c.prepare(intent('one', { quantity: 4 }))).toThrow('fingerprint');
  adapter.handler = async r => {
    expect(c.get('one')?.state).toBe('submitting'); expect(c.get('one')?.nonce).toBe(40);
    expect((await c.submit('one')).state).toBe('submitting');
    return { accepted: true, transactionId: 'tx-one' };
  };
  expect((await c.submit('one')).state).toBe('acknowledged');
  expect(c.get('one')?.filledQuantity).toBe(0); expect(c.get('one')?.venueOrderId).toBeUndefined(); expect(c.get('one')?.transactionId).toBe('tx-one'); expect(c.status().reservedMargin).toBe(20);
  await c.submit('one'); expect(adapter.calls).toHaveLength(1);
  expect(c.status().alerts[0]).toContain('NATIVE_PROTECTION_GAP');
});

test('ambiguous timeout is unknown; reservation held; no resend or new open; reduceOnly still bounded', async () => {
  const { c, adapter } = setup(); c.prepare(intent());
  adapter.handler = async () => { throw new Error('timeout after write'); };
  expect((await c.submit('one')).state).toBe('unknown');
  expect(c.status().reservedMargin).toBe(20); await c.submit('one'); expect(adapter.calls).toHaveLength(1);
  expect(() => c.prepare(intent('two'))).toThrow('unknown');
  expect(c.prepare(intent('reduce', { reduceOnly: true, side: 'sell', quantity: 2 })).state).toBe('prepared');
  expect(() => c.cancelPrepared('one')).toThrow('prove');
});

test('partial and cumulative fills dedup across evidence; release only verified terminal with advancing snapshot', async () => {
  const { c, time } = setup(); c.prepare(intent()); await c.submit('one'); time(10001);
  const s2 = snapshot({ sequence: 2, observedAt: 10001, grossNotional: 120, available: 780 });
  const part = evidence({ kind: 'partial', fills: [{ fillId: 'f1', quantity: 2 }] });
  expect(c.reconcileOrder(part, s2).state).toBe('partial');
  expect(c.status().reservedMargin).toBe(20);
  expect(c.reconcileOrder(part, s2).filledQuantity).toBe(2);
  expect(() => c.reconcileOrder(evidence(), snapshot())).toThrow();
  const done = evidence({ evidenceId: 'ev2', fills: [{ fillId: 'f1', quantity: 2 }, { fillId: 'f2', quantity: 3 }] });
  const s3 = { ...s2, sequence: 3 };
  expect(c.reconcileOrder(done, s3).state).toBe('filled'); expect(c.status().reservedMargin).toBe(0);
  expect(c.reconcileOrder(done, s3).filledQuantity).toBe(5);
  expect(() => c.reconcileOrder(evidence({ evidenceId: 'contradict', kind: 'canceled', fills: done.fills }), { ...s3, sequence: 4 })).toThrow('Contradictory');
  expect(c.get('one')?.conflict).toBeTruthy(); expect(c.status().authorized).toBe(false);
  c.authorizeSession(binding); expect(() => c.prepare(intent('new-after-conflict'))).toThrow('conflicting');
});

test('contradictory oversized, duplicate, reused or regressing fills fail closed without releasing', async () => {
  for (const fills of [[{ fillId: 'x', quantity: 6 }], [{ fillId: 'x', quantity: 2 }, { fillId: 'x', quantity: 3 }]]) {
    const { c, time } = setup(); c.prepare(intent()); await c.submit('one'); time(10001);
    expect(() => c.reconcileOrder(evidence({ fills }), snapshot({ sequence: 2, observedAt: 10001 }))).toThrow();
    expect(c.status().reservedMargin).toBe(20); expect(c.get('one')?.conflict).toBeTruthy();
  }
});

test('restart clears authorization, recovers submitting as unknown, never resends, cancels provably local preparation', async () => {
  const file = disk(); const a = setup({}, file); a.c.prepare(intent()); a.c.prepare(intent('local'));
  let finish!: (r: { accepted: true; transactionId: string }) => void;
  a.adapter.handler = () => new Promise(resolve => { finish = resolve; });
  const sending = a.c.submit('one');
  const bAdapter = new FakeAdapter(); const b = new ExecutionCoordinator(file, binding, limits, bAdapter, () => 10000); closers.push(() => b.close());
  expect(b.status().authorized).toBe(false); expect(b.get('one')?.state).toBe('unknown');
  expect((await b.submit('one')).state).toBe('unknown'); expect(bAdapter.calls).toHaveLength(0);
  await expect(b.submit('local')).rejects.toThrow('locally canceled');
  expect(b.cancelPrepared('local').state).toBe('canceled');
  finish({ accepted: true, transactionId: 'tx-one' }); await sending;
  expect(a.c.get('one')?.state).toBe('unknown');
  expect(() => b.prepare(intent('blocked'))).toThrow('reconciliation');
});

test('durable per-key lease serializes, expires with fencing and rejects delayed stale acceptance', async () => {
  const { c, adapter, time } = setup(); c.prepare(intent()); c.prepare(intent('two'));
  let finish!: (r: { accepted: true; transactionId: string }) => void;
  adapter.handler = () => new Promise(resolve => { finish = resolve; }); const first = c.submit('one');
  await expect(c.submit('two')).rejects.toThrow('lease busy');
  time(10101); expect((await c.submit('two')).state).toBe('prepared');
  expect(c.get('one')?.state).toBe('unknown'); expect(() => adapter.calls[0].assertCurrentLease()).toThrow('Stale');
  finish({ accepted: true, transactionId: 'tx-one' }); await first;
  expect(c.get('one')?.state).toBe('unknown'); expect(adapter.calls).toHaveLength(1);
  await expect(c.submit('two')).rejects.toThrow('unknown');
});

test('nonce high water persists across restart, snapshot nonce rollback cannot reuse nonce', async () => {
  const file = disk(); const a = setup({}, file); a.c.prepare(intent()); await a.c.submit('one');
  const b = setup({}, file); b.c.prepare(intent('two')); await b.c.submit('two');
  expect(b.c.get('two')?.nonce).toBe(41); expect(b.adapter.calls).toHaveLength(1);
});

test('risk reservations aggregate atomically against independent conservative notional and equity caps', () => {
  const { c } = setup({ maxNotional: 100, maxTotalNotional: 220 }); c.prepare(intent()); c.prepare(intent('two'));
  expect(() => c.prepare(intent('third'))).toThrow('notional');
  expect(() => c.prepare(intent('big', { quantity: 11 }))).toThrow('notional');
  const low = setup(); low.c.reconcileAccount(snapshot({ sequence: 2, available: 30 }));
  low.c.prepare(intent()); expect(() => low.c.prepare(intent('two'))).toThrow('equity');
  expect(low.c.status().pendingCount).toBe(1);
  const caps = setup({ maxPendingOrders: 1 }); caps.c.prepare(intent()); expect(() => caps.c.prepare(intent('two'))).toThrow('order cap');
});

test('reduceOnly rejects excess position, wrong direction and pending reductions; never flips', () => {
  const { c } = setup();
  expect(() => c.prepare(intent('bad', { reduceOnly: true }))).toThrow('reduceOnly');
  expect(() => c.prepare(intent('bad', { reduceOnly: true, side: 'sell', quantity: 11 }))).toThrow('reduceOnly');
  c.prepare(intent('reduce', { reduceOnly: true, side: 'sell', quantity: 6 }));
  expect(() => c.prepare(intent('reduce2', { reduceOnly: true, side: 'sell', quantity: 5 }))).toThrow('reduceOnly');
  expect(c.prepare(intent('reduce3', { reduceOnly: true, side: 'sell', quantity: 4 })).quantity).toBe(4);
  const breached = setup(); breached.c.reconcileAccount(snapshot({ sequence: 2, grossNotional: 3000, available: 0 }));
  expect(breached.c.prepare(intent('exit', { reduceOnly: true, side: 'sell', margin: 0 })).state).toBe('prepared');
});

test('fresh verified binding/generation/session mandatory; stale prepared risk cannot dispatch', async () => {
  const { c, time } = setup();
  expect(() => c.reconcileAccount(snapshot({ verified: false as true }))).toThrow('Verified');
  expect(() => c.reconcileAccount(snapshot({ chainId: 'wrong' }))).toThrow('binding');
  expect(() => c.reconcileAccount(snapshot({ generation: 'wrong' }))).toThrow('binding');
  expect(() => c.reconcileAccount(snapshot({ observedAt: 10001 }))).toThrow('Stale');
  c.prepare(intent()); c.reconcileAccount(snapshot({ sequence: 2 }));
  await expect(c.submit('one')).rejects.toThrow('original');
  expect(() => c.reconcileAccount(snapshot())).toThrow('rollback');
  time(11001); expect(() => c.prepare(intent('stale'))).toThrow('Stale');
  c.revokeSession(); expect(c.status().authorized).toBe(false);
});

test('MAINNET always refused before DB access regardless of flags/case; missing caps refused', () => {
  for (const environment of ['MAINNET', 'mainnet', 'production', 'TESTNET']) {
    expect(() => new ExecutionCoordinator(':memory:', { ...binding, environment, allowMainnet: true } as unknown as AccountBinding, limits, new FakeAdapter())).toThrow('denied');
  }
  expect(() => new ExecutionCoordinator(':memory:', { ...binding, environment: 'testnet', chainId: '304' }, limits, new FakeAdapter())).toThrow('MAINNET');
  expect(() => new ExecutionCoordinator(':memory:', binding, {} as typeof limits, new FakeAdapter())).toThrow('maxNotional');
});

test('corrupt persisted intent is not trusted and reservation cannot be bypassed', () => {
  const file = disk(); const { c } = setup({}, file); c.prepare(intent());
  const db = new Database(file); const row = db.query('SELECT payload FROM oms_orders WHERE client_id=?').get('one') as { payload: string };
  const o = JSON.parse(row.payload); o.reservedMargin = 0;
  db.query('UPDATE oms_orders SET payload=? WHERE client_id=?').run(JSON.stringify(o), 'one'); db.close();
  expect(() => c.status()).toThrow('Corrupt'); expect(() => c.prepare(intent('two'))).toThrow('Corrupt');
});

test('terminal account snapshot invalidates another key and generation stale baseline before its next open', async () => {
  const file = disk(); const a = setup({}, file);
  const other = { ...binding, apiKeyId: 'key-two', generation: 'g2' }; const ad = new FakeAdapter();
  const b = new ExecutionCoordinator(file, other, limits, ad, () => 10001); closers.push(() => b.close());
  b.reconcileAccount(snapshot({ apiKeyId: other.apiKeyId, generation: other.generation })); b.authorizeSession(other);
  a.c.prepare(intent()); await a.c.submit('one'); a.time(10001);
  a.c.reconcileOrder(evidence(), snapshot({ sequence: 2, observedAt: 10001, grossNotional: 150 }));
  expect(() => b.prepare(intent('other-key-open'))).toThrow('Stale reconciliation');
});
