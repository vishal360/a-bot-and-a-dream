import { test, expect } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { Store } from '../src/store';
import { DecisionJournal } from '../src/journal';
import { DbBackup } from '../src/backup';

let seq = 0;
const work = () => {
  const dir = join(tmpdir(), `abad-backup-${++seq}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const makeSourceDb = (dbPath: string) => {
  const db = new Database(dbPath);
  db.run('CREATE TABLE evidence (id INTEGER PRIMARY KEY, payload TEXT)');
  db.run("INSERT INTO evidence (payload) VALUES ('capture-proof-1')");
  db.close();
};

const harness = (options: Record<string, unknown> = {}) => {
  const s = new Store(':memory:');
  const journal = new DecisionJournal(s);
  const root = work();
  let now = Date.parse('2026-11-02T12:00:00Z');
  const { driveDirName, ...rest } = options as { driveDirName?: string | null };
  const backup = new DbBackup(s, journal, {
    dbPath: join(root, 'terminal.sqlite'),
    localDir: join(root, 'backups'),
    driveDir: driveDirName === null ? null : join(root, driveDirName ?? 'drive-backups'),
    intervalMs: 3600 * 1000,
    now: () => now,
    ...rest,
  });
  return { s, journal, backup, root, bump: (ms: number) => { now += ms; }, dbPath: join(root, 'terminal.sqlite'), close: () => s.db.close() };
};

test('a backup produces a local snapshot, a Drive copy, and leaves the live database untouched', async () => {
  const { backup, journal, dbPath, root, close } = harness();
  try {
    makeSourceDb(dbPath);
    const result = await backup.run();
    expect(result.ok).toBe(true);
    expect(result.file).toBeDefined();
    const localFiles = readdirSync(join(root, 'backups')).filter(f => f.endsWith('.sqlite'));
    expect(localFiles).toHaveLength(1);
    expect(existsSync(join(root, 'drive-backups', localFiles[0]))).toBe(true);
    // The snapshot is a real database containing the evidence.
    const snapshot = new Database(join(root, 'backups', localFiles[0]), { readonly: true });
    const row = snapshot.query('SELECT payload FROM evidence').get() as any;
    expect(row.payload).toBe('capture-proof-1');
    snapshot.close();
    // Quiet success: audited, not journaled.
    expect(backup.status().successCount).toBe(1);
    expect(backup.status().lastRunAt).not.toBeNull();
    expect(journal.list({ limit: 10 }).some(e => e.decision === 'health-alert')).toBe(false);
  } finally { close(); }
});

test('keep-count never deletes sole local evidence without independent verification', async () => {
  const { backup, root, bump, dbPath, close } = harness({ keep: 3 });
  try {
    makeSourceDb(dbPath);
    for (let i = 0; i < 5; i++) {
      const result = await backup.run();
      expect(result.ok).toBe(true);
      bump(3600 * 1000);
    }
    expect(readdirSync(join(root, 'backups')).filter(f => f.endsWith('.sqlite'))).toHaveLength(5);
    expect(readdirSync(join(root, 'drive-backups')).filter(f => f.endsWith('.sqlite'))).toHaveLength(5);
    expect(backup.status().retentionBlocked).toBe(true);
    expect(backup.status().verification.remoteVerified).toBe(false);
  } finally { close(); }
});

test('a missing database fails loudly: journaled health-alert, audited, honest result', async () => {
  const { backup, journal, close } = harness();
  try {
    const result = await backup.run();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('missing');
    const alerts = journal.list({ limit: 10 }).filter(e => e.decision === 'health-alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].rationale).toContain('db-backup');
    expect(backup.status().lastResult!.ok).toBe(false);
  } finally { close(); }
});

test('a corrupt source fails without producing a snapshot', async () => {
  const { backup, dbPath, root, close } = harness();
  try {
    writeFileSync(dbPath, 'this is not a sqlite database at all');
    const result = await backup.run();
    expect(result.ok).toBe(false);
    expect(existsSync(join(root, 'backups')) ? readdirSync(join(root, 'backups')).filter(f => f.endsWith('.sqlite')).length : 0).toBe(0);
  } finally { close(); }
});

test('an unmountable Drive directory is a loud failure: local snapshot kept, alert journaled', async () => {
  const { backup, journal, root, dbPath, close } = harness({ driveDirName: 'no-such-drive/deeper' });
  try {
    makeSourceDb(dbPath);
    // Windows cannot create a directory under a reserved device name prefix in some
    // environments; force the failure by making the target path a FILE instead.
    writeFileSync(join(root, 'no-such-drive'), 'not a directory');
    const result = await backup.run();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Drive copy failed');
    expect(readdirSync(join(root, 'backups')).filter(f => f.endsWith('.sqlite'))).toHaveLength(1); // the local snapshot survived
    expect(journal.list({ limit: 10 }).some(e => e.decision === 'health-alert')).toBe(true);
  } finally { close(); }
});

test('driveDir: null runs local-only by design (no copy attempted, no failure)', async () => {
  const { backup, root, dbPath, journal, close } = harness({ driveDirName: null });
  try {
    makeSourceDb(dbPath);
    const result = await backup.run();
    expect(result.ok).toBe(true);
    expect(backup.status().driveDir).toBeNull();
    expect(readdirSync(join(root, 'backups')).filter(f => f.endsWith('.sqlite'))).toHaveLength(1);
    expect(journal.list({ limit: 10 }).some(e => e.decision === 'health-alert')).toBe(false);
  } finally { close(); }
});

test('constructor rejects nonsense configuration', () => {
  const s = new Store(':memory:'), journal = new DecisionJournal(s);
  expect(() => new DbBackup(s, journal, { keep: 0 })).toThrow('keep');
  expect(() => new DbBackup(s, journal, { intervalMs: 1000 })).toThrow('interval');
  s.db.close();
});
