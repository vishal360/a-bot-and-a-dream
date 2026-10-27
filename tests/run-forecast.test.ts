import { test, expect } from 'bun:test';
import { forecastRun, poissonCdf, formatDuration, type Heartbeat } from '../src/run-forecast';

const now = Date.parse('2026-10-26T12:00:00.000Z');
const hb = (over: Partial<Heartbeat> = {}, counts: Partial<Heartbeat['counts']> = {}): Heartbeat => ({
  startedAt: '2026-10-26T08:00:00.000Z', pid: 1, requestedSeconds: 86400, phase: 'observing', observationElapsedMs: 4 * 3600_000,
  state: 'streaming', healthy: true, updatedAt: new Date(now - 30_000).toISOString(), complete: false, samplePassed: false,
  sustainedFeedAccepted: false,
  counts: { connections: 1, disconnects: 0, gaps: 0, stale: 0, invalid: 0, frames: 10, accepted: 10, tradeFrames: 1, recordingFailures: 0, ...counts },
  ...over,
});

test('poisson cdf matches known values and stays finite for large lambda', () => {
  expect(poissonCdf(0, 1)).toBeCloseTo(Math.exp(-1), 10);
  expect(poissonCdf(2, 1)).toBeCloseTo(Math.exp(-1) * 2.5, 10);
  expect(poissonCdf(-1, 3)).toBe(0);
  expect(poissonCdf(5, 0)).toBe(1);
  expect(poissonCdf(200, 200)).toBeGreaterThan(0.5);
  expect(poissonCdf(200, 200)).toBeLessThan(0.55);
  expect(() => poissonCdf(1, Number.NaN)).toThrow();
});

test('a calm run is on track with a high probability', () => {
  const f = forecastRun(hb({}, { disconnects: 4 }), now);
  expect(f.status).toBe('ON TRACK');
  expect(f.maxDisconnects).toBe(216);
  expect(f.feedProbability).toBeGreaterThan(0.99);
  expect(f.remainingMs).toBe(20 * 3600_000);
});

test('the 208-disconnects-in-6.4h churn pattern is forecast as near-certain failure', () => {
  const f = forecastRun(hb({ observationElapsedMs: 23_029_000 }, { disconnects: 208 }), now);
  expect(f.status).toBe('AT RISK');
  expect(f.feedProbability).toBeLessThan(0.01);
  expect(f.projectedDisconnects).toBeGreaterThan(600);
});

test('exceeding the disconnect budget, recording failures and stale heartbeats are hard zeros', () => {
  expect(forecastRun(hb({}, { disconnects: 300 }), now).feedProbability).toBe(0);
  expect(forecastRun(hb({}, { recordingFailures: 1 }), now).status).toBe('FAILED');
  const stalled = forecastRun(hb({ updatedAt: new Date(now - 10 * 60_000).toISOString() }), now);
  expect(stalled.status).toBe('STALLED'); expect(stalled.feedProbability).toBe(0);
});

test('completed runs report the real outcome', () => {
  expect(forecastRun(hb({ complete: true, samplePassed: true, observationElapsedMs: 86_400_000 }), now)).toMatchObject({ status: 'PASSED', feedProbability: 1, remainingMs: 0 });
  expect(forecastRun(hb({ complete: true, samplePassed: false }), now)).toMatchObject({ status: 'FAILED', feedProbability: 0 });
});

test('duration formatting', () => {
  expect(formatDuration(3_723_000)).toBe('1h 02m 03s');
  expect(formatDuration(-5)).toBe('0h 00m 00s');
});
