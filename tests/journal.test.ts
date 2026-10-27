import { test, expect } from 'bun:test';
import { DecisionJournal } from '../src/journal';
import { Store } from '../src/store';

const entry = (overrides: Partial<any> = {}) => ({
  time: '2026-10-27T10:00:00.000Z', botId: 'fleet-test', strategyId: 'breakout-v1', symbol: 'BTC',
  decision: 'submit' as const, side: 'buy' as const, quantity: 0.01, price: 65000, rationale: 'test', ...overrides
});

test('journal round-trips entries and rejects malformed evidence', () => {
  const store = new Store(':memory:'), journal = new DecisionJournal(store);
  journal.record(entry());
  journal.record(entry({ decision: 'fill', orderId: 'abc-123', riskChecks: [{ check: 'feed-guard', pass: true }], inputs: { mid: 65000 } }));
  const rows = journal.list();
  expect(rows).toHaveLength(2);
  expect(rows[0].decision).toBe('fill');
  expect(rows[0].risk_checks[0].check).toBe('feed-guard');
  expect(rows[0].inputs.mid).toBe(65000);
  expect(journal.list({ botId: 'fleet-test' })).toHaveLength(2);
  expect(journal.list({ botId: 'fleet-other' })).toHaveLength(0);
  for (const bad of [
    entry({ botId: 'BAD' }), entry({ strategyId: '' }), entry({ symbol: 'a b' }), entry({ decision: 'nonsense' as any }),
    entry({ side: 'up' as any }), entry({ quantity: -1 }), entry({ time: 'not-a-time' }),
    entry({ rationale: 'x'.repeat(501) }), entry({ inputs: { big: 'y'.repeat(4200) } as any }),
    entry({ riskChecks: [{ check: 'x', pass: true, detail: 'z'.repeat(8300) }] as any })
  ]) expect(() => journal.record(bad)).toThrow();
});

test('journal prunes to its bound and counts submissions per bot', () => {
  const store = new Store(':memory:'), journal = new DecisionJournal(store, 100);
  for (let i = 0; i < 150; i++) journal.record(entry({ time: new Date(Date.parse('2026-10-27T10:00:00Z') + i * 1000).toISOString(), decision: i % 2 ? 'submit' : 'skip' }));
  const rows = journal.list({ limit: 1000 });
  expect(rows).toHaveLength(100);
  expect(rows[0].time).toBe(new Date(Date.parse('2026-10-27T10:00:00Z') + 149 * 1000).toISOString());
  expect(journal.count('fleet-test', '2026-10-27T00:00:00Z')).toBe(50); // 100 kept rows alternate submit/skip
  expect(() => journal.count('fleet-test', 'garbage')).toThrow();
  expect(() => new DecisionJournal(store, 10)).toThrow('Invalid journal limit');
});
