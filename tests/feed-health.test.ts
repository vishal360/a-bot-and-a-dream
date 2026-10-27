import { test, expect } from 'bun:test';
import { FeedHealthGuard, feedPolicyDefaults } from '../src/feed-health';
import { Store } from '../src/store';

const market = { symbol: 'BTC', market_id: 0 };
const status = (overrides: any = {}) => ({
  state: 'streaming', epoch: 'epoch-1',
  counts: { disconnects: 0, gaps: 0, stale: 0, invalid: 0, recordingFailures: 0 },
  books: [{ market, status: 'healthy' }], stats: [{ marketId: 0, stats: { mark: 100 } }], ...overrides
});
const BASE_WALL = Date.parse('2026-10-27T00:00:00Z');
const policy = { ...feedPolicyDefaults, healthyResumeMs: 5000, fractionWindowMs: 60000 };

test('a streaming healthy feed passes after the recovery dwell', () => {
  const guard = new FeedHealthGuard(new Store(':memory:'), policy);
  guard.sample(status(), 1000, Date.now());
  expect(guard.verdict(2000).allowed).toBe(false);
  expect(guard.verdict(2000).state).toBe('degraded');
  expect(guard.verdict(7000).allowed).toBe(true);
  expect(guard.status().state).toBe('healthy');
});

test('any non-streaming/stale/missing-stats condition fails closed with a reason', () => {
  for (const broken of [
    status({ state: 'reconnecting' }), status({ books: [] }),
    status({ books: [{ market, status: 'stale' }] }), status({ stats: [] }),
    status({ books: [{ market, status: 'healthy' }], stats: [{ marketId: 0, stats: null }] })
  ]) {
    const guard = new FeedHealthGuard(new Store(':memory:'), policy);
    guard.sample(status(), 0, Date.now());
    guard.sample(broken, 6000, Date.now() + 6000);
    const verdict = guard.verdict(6000);
    expect(verdict.allowed).toBe(false);
    expect(verdict.state).toBe('unhealthy');
    expect(verdict.reason).toBeTruthy();
  }
});

test('counter regression latches integrity failure until restart, even after recovery', () => {
  const guard = new FeedHealthGuard(new Store(':memory:'), policy);
  guard.sample(status({ counts: { disconnects: 10, gaps: 2, stale: 1, invalid: 0, recordingFailures: 0 } }), 0, Date.now());
  guard.sample(status({ counts: { disconnects: 9, gaps: 0, stale: 0, invalid: 0, recordingFailures: 0 } }), 1000, Date.now() + 1000);
  expect(guard.status().integrityFailed).toBe(true);
  guard.sample(status(), 2000, Date.now() + 2000);
  expect(guard.verdict(99000).allowed).toBe(false);
  expect(guard.verdict(99000).reason).toContain('integrity');
});

test('episodes record duration and flag over-policy unhealthy intervals', () => {
  const guard = new FeedHealthGuard(new Store(':memory:'), { ...policy, maxUnhealthyIntervalMs: 30000 });
  guard.sample(status(), 0, BASE_WALL);
  guard.sample(status({ state: 'reconnecting' }), 1000, BASE_WALL + 1000);
  guard.sample(status({ state: 'reconnecting' }), 45000, BASE_WALL + 45000);
  guard.sample(status(), 46000, BASE_WALL + 46000);
  const episodes = guard.status().episodes;
  expect(episodes).toHaveLength(3);
  expect(episodes[0]).toMatchObject({ healthy: true, overPolicy: false });
  expect(episodes[1]).toMatchObject({ healthy: false, overPolicy: true });
  expect(episodes[1].end).toBeTruthy();
  expect(episodes[2]).toMatchObject({ healthy: true, end: null });
});

test('rolling healthy fraction blocks verdicts after a degraded window', () => {
  const guard = new FeedHealthGuard(new Store(':memory:'), { ...policy, healthyResumeMs: 1000, minimumHealthyFraction: 0.99 });
  guard.sample(status(), 0, BASE_WALL);
  guard.sample(status({ state: 'reconnecting' }), 1000, BASE_WALL + 1000);
  guard.sample(status(), 2000, BASE_WALL + 2000);
  expect(guard.healthyFraction()!.fraction).toBeCloseTo(0.5, 5);
  guard.sample(status(), 61000, BASE_WALL + 61000);
  expect(guard.healthyStreakMs(61000)).toBeGreaterThan(1000); // dwell passed
  expect(guard.verdict(61000).allowed).toBe(false); // but the window fraction still blocks
});

test('clock regression and malformed inputs throw', () => {
  const guard = new FeedHealthGuard(new Store(':memory:'), policy);
  guard.sample(status(), 5000, Date.now());
  expect(() => guard.sample(status(), 4000, Date.now())).toThrow('regression');
  expect(() => guard.sample(status(), -1, Date.now())).toThrow('clock');
  expect(() => new FeedHealthGuard(new Store(':memory:'), { staleMs: 10 })).toThrow('Invalid feed health policy');
});

test('persist writes a bounded summary and never restores verdicts', () => {
  const store = new Store(':memory:'), guard = new FeedHealthGuard(store, policy);
  guard.sample(status(), 0, BASE_WALL);
  guard.persist();
  const saved = JSON.parse((store.db.query('SELECT payload FROM feed_health_summary WHERE id=1').get() as any).payload);
  expect(saved.status.state).toBe('healthy');
  const fresh = new FeedHealthGuard(store, policy);
  expect(fresh.status().state).toBe('unhealthy');
});
