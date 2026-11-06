import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { Store } from '../src/store';
import { DecisionJournal } from '../src/journal';
import { DbBackup } from '../src/backup';

let seq = 0;
const work = () => {
  const dir = join(tmpdir(), `abad-bk1-${++seq}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const makeSourceDb = (dbPath: string) => {
  const db = new Database(dbPath);
  db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  db.run("INSERT INTO t (v) VALUES ('x')");
  db.close();
};

test('the first snapshot runs minutes after start, not a full interval later', async () => {
  const root = work();
  const dbPath = join(root, 'terminal.sqlite');
  makeSourceDb(dbPath);
  const s = new Store(':memory:'), journal = new DecisionJournal(s);
  const backup = new DbBackup(s, journal, {
    dbPath, localDir: join(root, 'bk'), driveDir: null,
    intervalMs: 60000, firstRunMs: 1100,
  });
  backup.start();
  try {
    await new Promise(r => setTimeout(r, 1700));
    expect(backup.status().successCount).toBe(1);
    expect(existsSync(join(root, 'bk'))).toBe(true);
  } finally { backup.stop(); s.db.close(); }
});

test('stop() cancels the pending first run', async () => {
  const root = work();
  const dbPath = join(root, 'terminal.sqlite');
  makeSourceDb(dbPath);
  const s = new Store(':memory:'), journal = new DecisionJournal(s);
  const backup = new DbBackup(s, journal, { dbPath, localDir: join(root, 'bk'), driveDir: null, intervalMs: 60000, firstRunMs: 1500 });
  backup.start();
  backup.stop();
  await new Promise(r => setTimeout(r, 1900));
  expect(backup.status().successCount).toBe(0);
  s.db.close();
});

test('a 12h boot with zero successful backups raises one health-alert (latched)', () => {
  const s = new Store(':memory:'), journal = new DecisionJournal(s);
  let now = Date.parse('2026-11-07T00:00:00Z');
  const backup = new DbBackup(s, journal, {
    dbPath: join(work(), 'missing.sqlite'), localDir: join(work(), 'bk'), driveDir: null,
    intervalMs: 3600000, noSuccessAlertMs: 12 * 3600000, now: () => now,
  });
  (backup as any).startedAt = now;
  // Before the threshold: silent.
  (backup as any).checkNoSuccess();
  expect(journal.list({ limit: 10 }).some(e => e.decision === 'health-alert')).toBe(false);
  // After 13h: one alert, latched.
  now += 13 * 3600000;
  (backup as any).checkNoSuccess();
  const alerts = journal.list({ limit: 10 }).filter(e => e.decision === 'health-alert' && e.rationale.includes('no successful backup'));
  expect(alerts).toHaveLength(1);
  expect(backup.status().noSuccessAlerted).toBe(true);
  // Still latched afterwards.
  now += 3600000;
  (backup as any).checkNoSuccess();
  expect(journal.list({ limit: 10 }).filter(e => e.decision === 'health-alert')).toHaveLength(1);
  s.db.close();
});

test('configuration validation covers the new knobs', () => {
  const s = new Store(':memory:'), journal = new DecisionJournal(s);
  expect(() => new DbBackup(s, journal, { firstRunMs: 500 })).toThrow('firstRunMs');
  expect(() => new DbBackup(s, journal, { noSuccessAlertMs: 1000 })).toThrow('noSuccessAlertMs');
  s.db.close();
});

test('status() exposes the new fields', () => {
  const s = new Store(':memory:'), journal = new DecisionJournal(s);
  const backup = new DbBackup(s, journal, { localDir: join(work(), 'bk'), driveDir: null, dbPath: join(work(), 'x.sqlite') });
  const st = backup.status();
  expect(st.firstRunMs).toBe(300000);
  expect(st.noSuccessAlertMs).toBe(12 * 3600000);
  expect(st.startedAt).toBeNull();
  s.db.close();
});
