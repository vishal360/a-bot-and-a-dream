import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store';
import { ExecutionRisk, type ReconciledRisk } from '../src/execution-risk';
const now = Date.parse('2026-01-02T12:00:00Z');
const snapshot: ReconciledRisk = { generation: 'testnet:1229:4:rotation1', day: '2026-01-02', observedAt: now, equity: 1000000000, usedMargin: 0, grossNotional: 0, startEquity: 1000000000, netCashFlow: 0 };
const intent = { id: 'one', generation: snapshot.generation, margin: 300000000, notional: 6000000000 };
test('terminal release requires fresh matching evidence, rolls back failures and prevents ID reuse', () => {
  const s = new Store(':memory:'), r = new ExecutionRisk(s);
  try {
    s.set('allocationPct', 100); r.reconcile(snapshot, now); r.reserve(intent, now);
    expect(() => r.settle(intent.id, 'wrong', 'filled', snapshot, now)).toThrow();
    expect(() => r.settle(intent.id, intent.generation, 'filled', { ...snapshot, startEquity: 1 }, now)).toThrow();
    expect(() => r.settle(intent.id, intent.generation, 'filled', snapshot, now)).toThrow('advance');
    expect(r.pending()).toHaveLength(1);
    const post = { ...snapshot, observedAt: now + 1, usedMargin: intent.margin, grossNotional: intent.notional };
    r.settle(intent.id, intent.generation, 'filled', post, now + 1);
    expect(r.pending()).toHaveLength(0);
    r.settle(intent.id, intent.generation, 'filled', post, now + 1);
    expect(() => r.settle(intent.id, intent.generation, 'canceled', post, now + 1)).toThrow('Conflicting');
    expect(() => r.reserve(intent, now + 1)).toThrow('Terminal');
    expect(() => r.settle('unknown', intent.generation, 'filled', post, now + 1)).toThrow('Matching');
  } finally { s.db.close(); }
});
test('risk defaults closed; shared reservations are atomic, bounded and idempotent', () => {
  const s = new Store(':memory:'), r = new ExecutionRisk(s);
  try {
    expect(() => r.reserve(intent, now)).toThrow('reconciliation');
    r.reconcile(snapshot, now);
    expect(() => r.reserve(intent, now)).toThrow('allocation');
    s.set('allocationPct', 50);
    expect(r.reserve(intent, now)).toEqual(intent);
    expect(r.reserve(intent, now)).toEqual(intent);
    expect(r.pending()).toHaveLength(1);
    expect(() => r.reserve({ ...intent, margin: 1 }, now)).toThrow();
    expect(() => r.reserve({ ...intent, id: 'two' }, now)).toThrow('allocation');
    expect(r.pending()).toHaveLength(1);
    expect(() => r.reserve({ ...intent, id: 'two', notional: intent.margin * 20 + 1 }, now)).toThrow('leverage');
    expect(() => r.reserve({ ...intent, id: 'two' }, now + 30001)).toThrow('reconciliation');
    expect(() => r.reserve({ ...intent, id: 'two', generation: 'other' }, now)).toThrow('reconciliation');
    r.reconcile({ ...snapshot, generation: 'other' }, now);
    expect(() => r.reserve({ ...intent, id: 'two', generation: 'other' }, now)).toThrow('prior connection');
    expect(new ExecutionRisk(s).status().pendingCount).toBe(1);
    expect(r.status().reconciliation).toBe('required');
  } finally { s.db.close(); }
});
test('cash flows do not create false losses and daily loss halt survives reset and rollover', () => {
  const s = new Store(':memory:'), r = new ExecutionRisk(s);
  try {
    s.set('allocationPct', 100);
    r.reconcile({ ...snapshot, equity: 900000000, netCashFlow: -100000000 }, now);
    expect(r.status().lossHalted).toBe(false);
    r.reconcile({ ...snapshot, equity: 940000000, observedAt: now + 1 }, now + 1);
    expect(r.status().lossHalted).toBe(true);
    expect(() => r.reserve(intent, now)).toThrow('halt');
    s.reset(); new ExecutionRisk(s);
    r.reconcile({ ...snapshot, day: '2026-01-03', observedAt: now + 86400000 }, now + 86400000);
    expect(r.status().lossHalted).toBe(true);
    expect(() => r.reconcile({ ...snapshot, equity: NaN }, now)).toThrow();
    expect(() => r.reconcile({ ...snapshot, observedAt: now + 1 }, now)).toThrow();
    expect(() => r.reconcile({ ...snapshot, startEquity: 0 }, now)).toThrow();
  } finally { s.db.close(); }
});
test('disk reopen retains reservations, immutable baseline and loss halt but invalidates equity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-risk-')), path = join(dir, 'risk.sqlite');
  let s = new Store(path);
  try {
    let r = new ExecutionRisk(s); s.set('allocationPct', 100);
    r.reconcile(snapshot, now); r.reserve(intent, now);
    expect(() => r.reconcile({ ...snapshot, observedAt: now + 1, startEquity: snapshot.startEquity + 1 }, now + 1)).toThrow('baseline');
    r.reconcile({ ...snapshot, observedAt: now + 1, equity: 940000000 }, now + 1);
    expect(() => r.reconcile(snapshot, now + 1)).toThrow('Out-of-order');
    s.db.close(); s = new Store(path); r = new ExecutionRisk(s);
    expect(r.pending()).toEqual([intent]); expect(r.status().lossHalted).toBe(true);
    expect(r.status().reconciliation).toBe('required');
    expect(() => r.reconcile(snapshot, now + 1)).toThrow('Out-of-order');
    expect(() => r.reconcile({ ...snapshot, startEquity: snapshot.startEquity + 1 }, now)).toThrow('baseline');
    expect(() => r.reserve({ ...intent, id: 'new' }, now)).toThrow('halt');
    s.reset(); expect(r.status().lossHalted).toBe(true);
  } finally { s.db.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('two database connections share budget and rejection does not insert a reservation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-risk-shared-')), path = join(dir, 'risk.sqlite');
  const a = new Store(path), b = new Store(path);
  try {
    const first = new ExecutionRisk(a), second = new ExecutionRisk(b);
    a.set('allocationPct', 50); first.reconcile(snapshot, now);
    first.reserve(intent, now);
    expect(() => second.reserve({ ...intent, id: 'second' }, now)).toThrow('allocation');
    expect(first.pending()).toEqual(second.pending()); expect(second.pending()).toHaveLength(1);
    second.invalidate(); expect(() => first.reserve({ ...intent, id: 'second' }, now)).toThrow('reconciliation');
  } finally { a.db.close(); b.db.close(); rmSync(dir, { recursive: true, force: true }); }
});