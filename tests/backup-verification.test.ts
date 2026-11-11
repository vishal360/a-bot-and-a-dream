import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { assertSafePath, copyAndVerify, createManifest, restoreCheck, verifyBackup, verifiedIndependentCopy, writeManifest } from '../src/backup-verification';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'abad-verify-'));
  const file = join(root, 'evidence.sqlite');
  const db = new Database(file); db.run('CREATE TABLE evidence(value TEXT)'); db.run("INSERT INTO evidence VALUES ('durable')"); db.close();
  writeManifest(file, createManifest(file, 'sqlite'));
  return { root, file, clean: () => rmSync(root, { recursive: true, force: true }) };
}
test('manifest records SHA256 bytes integrity and unimplemented encryption; offline restore to new target', () => {
  const f = fixture();
  try {
    const m = verifyBackup(f.file);
    expect(m.sha256).toMatch(/^[a-f0-9]{64}$/); expect(m.bytes).toBe(readFileSync(f.file).length); expect(m.integrity).toBe('ok'); expect(m.encryption).toBe('not-implemented');
    const target = join(f.root, 'restore');
    const result = restoreCheck(f.file, target);
    expect(result.ok).toBe(true); expect(result.remoteVerified).toBe(false);
    const db = new Database(result.restored, { readonly: true });
    expect(db.query('SELECT value FROM evidence').get()).toEqual({ value: 'durable' }); db.close();
    expect(() => restoreCheck(f.file, target)).toThrow('new unique');
    expect(existsSync(f.file)).toBe(true);
  } finally { f.clean(); }
});
test('restore rejects corrupt hash and incorrect byte counts before creating target', () => {
  const f = fixture();
  try {
    const m = verifyBackup(f.file);
    writeFileSync(`${f.file}.manifest.json`, JSON.stringify({ ...m, sha256: '0'.repeat(64) }));
    expect(() => restoreCheck(f.file, join(f.root, 'bad'))).toThrow('SHA256/bytes');
    expect(existsSync(join(f.root, 'bad'))).toBe(false);
    writeFileSync(`${f.file}.manifest.json`, JSON.stringify({ ...m, bytes: m.bytes + 1 }));
    expect(() => verifyBackup(f.file)).toThrow('SHA256/bytes');
  } finally { f.clean(); }
});
test('integrity_check independently rejects non-SQLite bytes even with valid SHA256', () => {
  const f = fixture();
  try { writeFileSync(f.file, 'corruption'); expect(() => createManifest(f.file, 'sqlite')).toThrow(); }
  finally { f.clean(); }
});
test('copy checksum mismatch never removes local source and mounted metadata is not receipt authority', () => {
  const f = fixture();
  try {
    const m = verifyBackup(f.file);
    expect(() => copyAndVerify(f.file, join(f.root, 'copy.sqlite'), { ...m, sha256: '0'.repeat(64) })).toThrow('readback');
    expect(verifyBackup(f.file)).toEqual(m); expect(existsSync(join(f.root, 'copy.sqlite'))).toBe(false);
    writeFileSync(`${f.file}.remote-receipt.json`, JSON.stringify({ ...m, independent: true, readbackVerified: true }));
    expect(verifiedIndependentCopy(f.file, m)).toBeNull();
    expect(verifiedIndependentCopy(f.file, m, () => ({ provider: 'test', objectId: 'test', bytes: m.bytes + 1, sha256: m.sha256, independent: true, readbackVerified: true }))).toBeNull();
  } finally { f.clean(); }
});
test('independent verification cannot authorize pruning if local bytes change during callback', () => {
  const f = fixture();
  try {
    const m = verifyBackup(f.file);
    const receipt = verifiedIndependentCopy(f.file, m, () => {
      writeFileSync(f.file, 'changed while remote readback ran');
      return { provider: 'fixture', objectId: 'remote/object', sha256: m.sha256, bytes: m.bytes, readbackVerified: true, independent: true };
    });
    expect(receipt).toBeNull();
    expect(existsSync(f.file)).toBe(true);
  } finally { f.clean(); }
});

test('traversal and symlink roots/descendants are refused without touching external files', () => {
  const f = fixture();
  try {
    expect(() => assertSafePath(join(f.root, '..', 'outside'), f.root)).toThrow('escapes');
    const actual = join(f.root, 'actual'); mkdirSync(actual);
    const link = join(f.root, 'link'); symlinkSync(actual, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => assertSafePath(join(link, 'new-file'))).toThrow('symlink');
    expect(() => restoreCheck(f.file, join(link, 'restore'))).toThrow('symlink');
  } finally { f.clean(); }
});
