import { test, expect } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { LighterAcceptance, acceptanceCriteria, type AcceptanceSample } from '../src/lighter-acceptance';

const capture = { id: 'fixture', snapshotRooted: true, statsCovered: true, frames: 3, stateSha256: 'a'.repeat(64), error: null };
const markets = [{ marketId: 1, tradesObserved: true }];
const s = (mono: number, more: Partial<AcceptanceSample> = {}): AcceptanceSample => ({ wall: 1800000000000 + mono, mono, healthy: true, accepted: mono + 1, tradeFrames: mono + 1, recordingFailures: 0, disconnects: 0, ...more });
function sample(ms = 60000) { const a = new LighterAcceptance(); for (let n = 0; n <= ms; n += 1000) a.sample(s(n)); return a; }

test('short successful samples can never certify sustained testing or authorize orders', () => {
  const report = sample().report(60000, [capture], markets);
  expect(report.samplePassed).toBe(true); expect(report.sustainedFeedAccepted).toBe(false);
  expect(report.automationAuthorized).toBe(false); expect(report.strategyValidated).toBe(false);
  expect(report.executionEnabled).toBe(false); expect(report.tradeContinuity).toBe('unproven');
});
test('only a full healthy 24-hour observation meets the fixed feed criterion', () => {
  const report = sample(acceptanceCriteria.sustainedMs).report(acceptanceCriteria.sustainedMs, [capture], markets);
  expect(report.sustainedFeedAccepted).toBe(true); expect(report.automationAuthorized).toBe(false);
});
test('late sampling, clock drift and counter regression cannot be counted as healthy', () => {
  for (const bad of [s(60000), s(1000, { wall: s(1000).wall + 2001 }), s(1000, { accepted: 0 }), s(0)]) {
    const a = new LighterAcceptance(); a.sample(s(100)); a.sample(bad);
    expect(a.report(1000, [capture], markets).samplePassed).toBe(false);
  }
});
test('disconnects between healthy samples conservatively mark the interval unhealthy', () => {
  const a = new LighterAcceptance();
  a.sample(s(0)); a.sample(s(1000, { disconnects: 1 }));
  a.sample(s(2000, { disconnects: 1 }));
  const report = a.report(2000, [capture], markets);
  expect(report.healthyMs).toBe(1000); expect(report.unhealthyMs).toBe(1000);
  expect(report.longestUnhealthyMs).toBe(1000); expect(report.samplePassed).toBe(false);
  expect(report.failures).toContain('Insufficient observed healthy time');
});
test('disconnect counter regression latches integrity failure and malformed counts are rejected', () => {
  const a = new LighterAcceptance();
  a.sample(s(0, { disconnects: 1 })); a.sample(s(1000)); a.sample(s(2000));
  expect(a.report(2000, [capture], markets).failures).toContain('Clock/counter integrity failed');
  for (const disconnects of [-1, 0.5, NaN, Infinity, undefined]) {
    expect(() => a.sample(s(3000, { disconnects }))).toThrow('Invalid acceptance sample');
  }
});
test('recording failures, incomplete replay and missing per-market trades fail acceptance', () => {
  const a = sample(); a.sample(s(61000, { recordingFailures: 1 }));
  expect(a.report(60000, [capture], markets).failures).toContain('Durable recording failure observed');
  for (const captures of [[], [{ ...capture, snapshotRooted: false }], [{ ...capture, statsCovered: false }], [{ ...capture, error: 'checksum' }]]) expect(sample().report(60000, captures, markets).samplePassed).toBe(false);
  expect(sample().report(60000, [capture], [{ marketId: 1, tradesObserved: false }]).samplePassed).toBe(false);
  expect(sample().report(60000, [capture], markets, 'Disconnected').samplePassed).toBe(false);
  expect(sample().report(61000, [capture], markets).samplePassed).toBe(false);
});
test('unhealthy intervals and invalid inputs fail closed', () => {
  const a = new LighterAcceptance();
  for (let n = 0; n <= 60000; n += 1000) a.sample(s(n, { healthy: n > 31000 }));
  const report = a.report(60000, [capture], markets);
  expect(report.longestUnhealthyMs).toBe(32000); expect(report.samplePassed).toBe(false);
  expect(() => a.sample(s(NaN))).toThrow();
  expect(() => a.report(86400001, [], markets)).toThrow();
});
test('report market identities must be unique nonnegative integers with explicit trade coverage', () => {
  const a = sample();
  for (const invalid of [[], [markets[0], markets[0]], [{ marketId: -1, tradesObserved: true }],
    [{ marketId: 0.5, tradesObserved: true }], [{ marketId: NaN, tradesObserved: true }],
    [{ marketId: 1, tradesObserved: undefined as unknown as boolean }]]) {
    expect(() => a.report(60000, [capture], invalid)).toThrow('Invalid acceptance report bounds');
  }
});
test('acceptance CLI help and argument errors are offline and have no order adapter', async () => {
  const path = fileURLToPath(new URL('../scripts/accept-lighter.ts', import.meta.url));
  for (const [args, code] of [[['--help'], 0], [['--seconds', '0'], 1], [['--symbols', 'BTC,BTC'], 1], [['--live'], 1]] as const) {
    const child = Bun.spawn([process.execPath, path, ...args], { stdout: 'pipe', stderr: 'pipe' });
    await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(await child.exited).toBe(code);
  }
});