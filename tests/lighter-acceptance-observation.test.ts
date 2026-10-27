import { test, expect } from 'bun:test';
import { LighterAcceptance } from '../src/lighter-acceptance';
import { observeAcceptance } from '../scripts/lighter-acceptance-observation';

const capture = { id: 'fixture', snapshotRooted: true, statsCovered: true, frames: 3, stateSha256: 'a'.repeat(64), error: null };
const markets = [{ marketId: 1, tradesObserved: true }];
function fixture(options: { sampleWorkMs?: number; heartbeatWorkMs?: number[]; earlyWakeups?: number } = {}) {
  const acceptance = new LighterAcceptance(), times: number[] = [], starts: number[] = [], delays: number[] = [];
  let now = 123.25, samples = 0, heartbeats = 0;
  const observer = {
    now: () => now,
    sample: () => {
      const mono = now;
      acceptance.sample({ wall: 1800000000000 + Math.floor(mono), mono, healthy: true, recordingFailures: 0,
        accepted: ++samples, tradeFrames: samples, disconnects: 0 });
      times.push(mono);
      now += options.sampleWorkMs ?? 0;
      return mono;
    },
    sleep: async (ms: number) => {
      delays.push(ms);
      now += delays.length <= (options.earlyWakeups ?? 0) ? ms / 2 : ms;
    },
    progress: async (start: number) => { starts.push(start); now += options.heartbeatWorkMs?.[heartbeats++] ?? 0; },
  };
  return { observer, times, starts, delays, report: (duration: number) => acceptance.report(duration, [capture], markets) };
}

test('observation duration is measured from actual first and final samples, not sample work', async () => {
  const f = fixture({ sampleWorkMs: 0.4 });
  await observeAcceptance(60000, f.observer);
  expect(f.starts).toEqual([f.times[0]]);
  expect(f.times.at(-1)! - f.times[0]).toBeGreaterThanOrEqual(60000);
  expect(f.report(60000)).toMatchObject({ samplePassed: true, sustainedFeedAccepted: false, automationAuthorized: false, executionEnabled: false });
});

test('a periodic heartbeat crossing the deadline still requires a final recorded sample', async () => {
  const f = fixture({ heartbeatWorkMs: [0, 20] });
  await observeAcceptance(60005, f.observer);
  expect(f.starts).toEqual([f.times[0], f.times[0]]);
  expect(f.times.at(-2)! - f.times[0]).toBe(60000);
  expect(f.times.at(-1)! - f.times[0]).toBe(60021);
  expect(f.report(60005).samplePassed).toBe(true);
});

test('startup heartbeat cannot consume the duration without a second sample', async () => {
  const f = fixture({ heartbeatWorkMs: [1500] });
  await observeAcceptance(1000, f.observer);
  expect(f.times).toHaveLength(2);
  expect(f.report(1000)).toMatchObject({ elapsedMs: 1501, samplePassed: true, sustainedFeedAccepted: false });
});

test('slow heartbeat I/O remains an unhealthy sampling gap, never fabricated health', async () => {
  const f = fixture({ heartbeatWorkMs: [0, 3000] });
  await observeAcceptance(60005, f.observer);
  const report = f.report(60005);
  expect(report.elapsedMs).toBeGreaterThanOrEqual(60005);
  expect(report.maximumSampleGapMs).toBe(3001);
  expect(report.failures).toContain('Observer sampling gap exceeded policy');
  expect(report.samplePassed).toBe(false); expect(report.sustainedFeedAccepted).toBe(false);
});

test('early timer wakeups cannot shorten recorded observation duration', async () => {
  const f = fixture({ earlyWakeups: 4 });
  await observeAcceptance(1000, f.observer);
  expect(f.times.length).toBeGreaterThan(2);
  expect(f.times.at(-1)! - f.times[0]).toBeGreaterThanOrEqual(1000);
  expect(f.delays.every(ms => ms >= 1 && ms <= 1000)).toBe(true);
  expect(f.report(1000).samplePassed).toBe(true);
});

test('sample, sleep and heartbeat failures propagate without fabricating completion', async () => {
  for (const operation of ['sample', 'sleep', 'progress'] as const) {
    const f = fixture();
    const fail = () => { throw new Error(`${operation} failed`); };
    const observer = { ...f.observer, [operation]: fail };
    await expect(observeAcceptance(1000, observer)).rejects.toThrow(`${operation} failed`);
    expect(f.report(1000).samplePassed).toBe(false);
  }
});

test('invalid duration bounds are rejected before any observation or heartbeat', async () => {
  for (const duration of [0, 999, 1000.5, NaN, Infinity, 86400001]) {
    const f = fixture();
    await expect(observeAcceptance(duration, f.observer)).rejects.toThrow('Invalid observation duration');
    expect(f.times).toHaveLength(0); expect(f.starts).toHaveLength(0);
  }
});