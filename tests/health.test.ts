import { test, expect } from 'bun:test';
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store';
import { DecisionJournal } from '../src/journal';
import { HealthMonitor } from '../src/health';

const T0 = Date.parse('2026-11-02T12:00:00Z');
let seq = 0;
const work = () => {
  const dir = join(tmpdir(), `abad-health-${++seq}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const harness = (options: Record<string, unknown> = {}) => {
  const s = new Store(':memory:');
  const journal = new DecisionJournal(s);
  const root = work();
  let now = T0;
  const monitor = new HealthMonitor(s, journal, {
    intervalMs: 60000,
    archiveRoot: root,
    mirrorLogPath: join(root, 'mirror.log'),
    driveRoot: join(root, 'drive'), // absent unless a test creates it
    cooldownMs: 6 * 3600 * 1000,
    feedStatus: () => ({ state: 'streaming' }),
    now: () => now,
    ...options,
  });
  return { s, journal, monitor, root, setNow: (ms: number) => { now = ms; }, close: () => s.db.close() };
};

test('retention pressure becomes a durable health alert rather than silent evidence deletion', async () => {
  let blocked = true;
  const { monitor, journal, close } = harness({ durabilityStatus: () => ({ archive: { retentionBlocked: blocked }, backup: { diskPressure: false } }) });
  try {
    const first = await monitor.tick();
    expect(first.find(x => x.check === 'durability-retention')?.state).toBe('alert');
    expect(journal.historySinceId(0, 100).some(x => x.decision === 'health-alert' && x.rationale.includes('Sole-copy'))).toBe(true);
    blocked = false;
    expect((await monitor.tick()).find(x => x.check === 'durability-retention')?.state).toBe('ok');
  } finally { close(); }
});

const alertsIn = (journal: DecisionJournal) => journal.list({ limit: 100 }).filter(e => e.decision === 'health-alert');

test('capture-stall: streaming + stale newest capture alerts; fresh capture and non-streaming feeds stay quiet', async () => {
  const { monitor, root, close } = harness();
  try {
    const dayDir = join(root, '2026-11-02');
    mkdirSync(dayDir, { recursive: true });
    const capture = join(dayDir, '1793-capture.json');
    writeFileSync(capture, '{}');
    utimesSync(capture, new Date(T0 - 60 * 60000), new Date(T0 - 60 * 60000)); // 60 min old

    // Streaming feed + stale capture: alert.
    let results = await monitor.tick(true);
    expect(results.find(r => r.check === 'capture-stall')!.state).toBe('alert');

    // Fresh capture (30s old): ok.
    utimesSync(capture, new Date(T0 - 30000), new Date(T0 - 30000));
    results = await monitor.tick(true);
    const stall = results.find(r => r.check === 'capture-stall')!;
    expect(stall.state).toBe('ok');
    expect(stall.detail).toContain('30s old');
  } finally { close(); }

  // Non-streaming feed + ancient capture: no stall (the check only applies while streaming).
  const halted = harness({ feedStatus: () => ({ state: 'halted' }) });
  try {
    const results = await halted.monitor.tick(true);
    expect(results.find(r => r.check === 'capture-stall')!.state).toBe('ok');
  } finally { halted.close(); }
});

test('capture-stall: streaming with no capture folder for today alerts', async () => {
  const { monitor, close } = harness();
  try {
    const results = await monitor.tick(true);
    const stall = results.find(r => r.check === 'capture-stall')!;
    expect(stall.state).toBe('alert');
    expect(stall.detail).toContain('no capture folder');
  } finally { close(); }
});

test('cooldown: a continuing problem journals once per window; later windows warn again', async () => {
  const { journal, monitor, setNow, close } = harness();
  try {
    // Streaming feed + no captures at all: capture-stall and mirror issues may alert; at least one does.
    await monitor.tick(true);
    const afterFirst = alertsIn(journal).length;
    expect(afterFirst).toBeGreaterThanOrEqual(1);
    // Five minutes later the cooldown still holds: nothing new.
    setNow(T0 + 5 * 60000);
    await monitor.tick();
    expect(alertsIn(journal).length).toBe(afterFirst);
    // Seven hours later the window has passed: it warns again.
    setNow(T0 + 7 * 3600 * 1000);
    await monitor.tick();
    expect(alertsIn(journal).length).toBeGreaterThan(afterFirst);
    // And every alert carries the health-alert kind the Telegram alerter allowlists.
    expect(alertsIn(journal).every(e => e.decision === 'health-alert')).toBe(true);
  } finally { close(); }
});

test('mirror-stale: parses the last completed cycle; alerts only past the staleness limit', async () => {
  const { monitor, root, close } = harness({ mirrorStaleMs: 2 * 3600 * 1000 });
  try {
    mkdirSync(join(root, 'drive'), { recursive: true }); // Drive root present: the check is active
    writeFileSync(join(root, 'mirror.log'), [
      '2026-11-02T11:30:00.000+00:00 moved 2026-11-01 -> somewhere',
      '2026-11-02T11:30:00.123+00:00 mirror cycle done',
      'noise line without a timestamp',
      '',
    ].join('\n'));
    let results = await monitor.tick(true);
    const mirror = results.find(r => r.check === 'mirror-stale')!;
    expect(mirror.state).toBe('ok');
    expect(mirror.detail).toContain('30 min ago');

    // Rewind the completion to 3h ago: stale against the 2h limit.
    writeFileSync(join(root, 'mirror.log'), '2026-11-02T09:00:00.123+00:00 mirror cycle done\n');
    results = await monitor.tick(true);
    expect(results.find(r => r.check === 'mirror-stale')!.state).toBe('alert');
  } finally { close(); }
});

test('missing mirror log while the Drive root exists is itself an alert', async () => {
  const { monitor, root, journal, close } = harness();
  try {
    mkdirSync(join(root, 'drive'), { recursive: true });
    const results = await monitor.tick(true);
    expect(results.find(r => r.check === 'mirror-stale')!.state).toBe('alert');
    expect(alertsIn(journal).some(e => e.rationale.includes('mirror'))).toBe(true);
  } finally { close(); }
});

test('disk-free: never throws, reports ok or an honest unavailable', async () => {
  const { monitor, close } = harness({ diskFreeFloorBytes: 1 });
  try {
    const results = await monitor.tick(true);
    const disk = results.find(r => r.check === 'disk-free')!;
    expect(['ok', 'unavailable']).toContain(disk.state);
  } finally { close(); }
});

test('status(): the last result per check is inspectable', async () => {
  const { monitor, close } = harness();
  try {
    await monitor.tick(true);
    const status = monitor.status();
    expect(status.checks.map(c => c.check).sort()).toEqual(['capture-stall', 'disk-free', 'mirror-stale']);
  } finally { close(); }
});
