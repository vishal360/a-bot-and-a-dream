import { test, expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { AcceptanceProgress } from '../scripts/lighter-acceptance-progress';

const context = { startedAt: '2026-10-13T00:00:00.000Z', pid: 123, requestedSeconds: 86400, symbols: ['BTC', 'ETH'] };
const details = { phase: 'starting' as const, observationElapsedMs: 0, warmupMs: 0, state: 'stopped', healthy: false, counts: { accepted: 0, recordingFailures: 0 } };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dream-acceptance-progress-'));
  return { dir, progress: new AcceptanceProgress(pathToFileURL(`${dir}/`), context),
    run: () => Bun.file(join(dir, 'run.json')).json(), close: () => rmSync(dir, { recursive: true, force: true }) };
}

test('startup and observation heartbeats explicitly remain unaccepted', async () => {
  const f = fixture();
  try {
    await f.progress.update(details);
    expect(await f.run()).toMatchObject({ ...context, ...details, complete: false, samplePassed: false, sustainedFeedAccepted: false,
      automationAuthorized: false, executionEnabled: false });
    await f.progress.update({ ...details, phase: 'observing', observationElapsedMs: 120000, warmupMs: 100, state: 'streaming', healthy: true,
      counts: { accepted: 2000, recordingFailures: 0 } });
    const run = await f.run();
    expect(run.observationElapsedMs).toBe(120000); expect(run.counts.accepted).toBe(2000);
    expect(Number.isFinite(Date.parse(run.updatedAt))).toBe(true);
    expect(run.complete).toBe(false); expect(run.sustainedFeedAccepted).toBe(false);
    expect(run.note).toContain('final report is required');
    expect(existsSync(join(f.dir, 'report.json'))).toBe(false);
    expect(existsSync(join(f.dir, 'run.json.tmp'))).toBe(false);
  } finally { f.close(); }
});

test('successful and failed samples publish a report before completed telemetry, never authority', async () => {
  for (const passed of [true, false]) {
    const f = fixture();
    try {
      await f.progress.update({ ...details, phase: 'finalizing' });
      const failures = passed ? [] : ['Requested observation duration not completed'];
      await f.progress.finish({ samplePassed: passed, sustainedFeedAccepted: false, failures, automationAuthorized: true, executionEnabled: true });
      expect(await Bun.file(join(f.dir, 'report.json')).json()).toMatchObject({ samplePassed: passed, sustainedFeedAccepted: false,
        failures, automationAuthorized: false, executionEnabled: false });
      expect(await f.run()).toMatchObject({ complete: true, phase: 'completed', reportFile: 'report.json', samplePassed: passed,
        sustainedFeedAccepted: false, failures, automationAuthorized: false, executionEnabled: false });
      expect(existsSync(join(f.dir, 'report.json.tmp'))).toBe(false);
      const reportHash = new Bun.CryptoHasher('sha256').update(await Bun.file(join(f.dir, 'report.json')).arrayBuffer()).digest('hex');
      expect((await f.run()).reportSha256).toBe(reportHash);
      expect(await Bun.file(join(f.dir, 'report.json')).json()).toMatchObject(context);
    } finally { f.close(); }
  }
});

test('report publication failure cannot mark acceptance completed', async () => {
  const f = fixture();
  try {
    await f.progress.update(details);
    mkdirSync(join(f.dir, 'report.json'));
    let failed = false;
    try { await f.progress.finish({ samplePassed: true, sustainedFeedAccepted: true, failures: [] }); } catch { failed = true; }
    expect(failed).toBe(true);
    expect(await f.run()).toMatchObject({ complete: false, phase: 'failed', samplePassed: false, sustainedFeedAccepted: false,
      automationAuthorized: false, executionEnabled: false });
    expect((await f.run()).error.length).toBeGreaterThan(0);
  } finally { f.close(); }
});

test('heartbeat publication failure preserves prior readable telemetry and propagates', async () => {
  const f = fixture();
  try {
    await f.progress.update(details);
    const before = await f.run();
    mkdirSync(join(f.dir, 'run.json.tmp'));
    let failed = false;
    try { await f.progress.update({ ...details, phase: 'observing', healthy: true }); } catch { failed = true; }
    expect(failed).toBe(true); expect(await f.run()).toEqual(before);
  } finally { f.close(); }
});

test('completion heartbeat failure leaves the durable report but never a completed heartbeat', async () => {
  const f = fixture();
  try {
    await f.progress.update(details);
    mkdirSync(join(f.dir, 'run.json.tmp'));
    let failed = false;
    try { await f.progress.finish({ samplePassed: true, sustainedFeedAccepted: false, failures: [] }); } catch { failed = true; }
    expect(failed).toBe(true);
    expect(await Bun.file(join(f.dir, 'report.json')).json()).toMatchObject({ samplePassed: true, sustainedFeedAccepted: false,
      automationAuthorized: false, executionEnabled: false });
    expect((await f.run()).complete).toBe(false);
  } finally { f.close(); }
});

test('explicit finalization failure is unaccepted, with PID and duration retained', async () => {
  const f = fixture();
  try {
    await f.progress.update({ ...details, phase: 'finalizing', observationElapsedMs: 60000 });
    await f.progress.fail('Replay export failed');
    expect(await f.run()).toMatchObject({ complete: false, phase: 'failed', error: 'Replay export failed', pid: context.pid,
      observationElapsedMs: 60000, samplePassed: false, sustainedFeedAccepted: false, automationAuthorized: false, executionEnabled: false });
    expect(existsSync(join(f.dir, 'report.json'))).toBe(false);
  } finally { f.close(); }
});