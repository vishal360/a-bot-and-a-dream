import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';

export type IntegrityManifest = { version: 1; kind: 'sqlite' | 'archive'; file: string; sha256: string; bytes: number; createdAt: string; integrity: 'ok'; encryption: 'not-implemented' };
export type IndependentCopyReceipt = { provider: string; objectId: string; sha256: string; bytes: number; readbackVerified: true; independent: true };
/** Trusted operator-injected adapter ONLY. JSON sidecars/user metadata are never authority.
 * Implementations must actually read back an independent copy. No adapter is enabled by default. */
export type IndependentCopyVerifier = (file: string, manifest: IntegrityManifest) => IndependentCopyReceipt | null;

export function assertSafePath(path: string, root?: string): string {
  const full = resolve(path);
  if (root) {
    const rel = relative(resolve(root), full);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('path escapes configured root');
  }
  let cursor = full;
  for (;;) {
    // lstat also detects dangling links; existsSync alone does not.
    try { if (lstatSync(cursor).isSymbolicLink()) throw new Error(`symlink/reparse path refused: ${cursor}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  return full;
}
export function digestFile(file: string) {
  assertSafePath(file);
  const bytes = readFileSync(file);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}
export function sqliteIntegrity(file: string) {
  assertSafePath(file);
  const db = new Database(file, { readonly: true });
  try {
    const rows = db.query('PRAGMA integrity_check').all() as Record<string, unknown>[];
    if (rows.length !== 1 || Object.values(rows[0])[0] !== 'ok') throw new Error('SQLite integrity_check failed');
  } finally { db.close(); }
}
export function atomicWrite(file: string, bytes: string | Buffer) {
  assertSafePath(file); mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { writeFileSync(tmp, bytes, { flag: 'wx' }); renameSync(tmp, file); }
  finally { if (existsSync(tmp)) unlinkSync(tmp); }
}
export function createManifest(file: string, kind: IntegrityManifest['kind']): IntegrityManifest {
  if (kind === 'sqlite') sqliteIntegrity(file);
  return { version: 1, kind, file: basename(file), ...digestFile(file), createdAt: new Date().toISOString(), integrity: 'ok', encryption: 'not-implemented' };
}
export function writeManifest(file: string, manifest: IntegrityManifest) { atomicWrite(`${file}.manifest.json`, JSON.stringify(manifest, null, 2) + '\n'); }
export function verifyBackup(file: string, manifestFile = `${file}.manifest.json`): IntegrityManifest {
  assertSafePath(file); assertSafePath(manifestFile);
  const m = JSON.parse(readFileSync(manifestFile, 'utf8')) as IntegrityManifest;
  if (m.version !== 1 || !['sqlite', 'archive'].includes(m.kind) || m.file !== basename(file) || !/^[a-f0-9]{64}$/.test(m.sha256) || !Number.isSafeInteger(m.bytes) || m.bytes < 0 || m.integrity !== 'ok') throw new Error('invalid integrity manifest');
  const actual = digestFile(file);
  if (actual.sha256 !== m.sha256 || actual.bytes !== m.bytes) throw new Error('manifest SHA256/bytes mismatch');
  if (m.kind === 'sqlite') sqliteIntegrity(file);
  return m;
}
export function verifiedIndependentCopy(file: string, m: IntegrityManifest, verifier?: IndependentCopyVerifier): IndependentCopyReceipt | null {
  const before = digestFile(file);
  if (before.sha256 !== m.sha256 || before.bytes !== m.bytes) return null;
  const r = verifier?.(file, m);
  const after = digestFile(file);
  if (after.sha256 !== m.sha256 || after.bytes !== m.bytes) return null;
  return r && r.independent === true && r.readbackVerified === true && !!r.provider && !!r.objectId && r.sha256 === m.sha256 && r.bytes === m.bytes ? r : null;
}
/** A mounted filesystem copy is read-back checked, but is NOT remote/offsite proof. */
export function copyAndVerify(file: string, target: string, m: IntegrityManifest) {
  assertSafePath(target); mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target)) throw new Error('copy target already exists');
  const tmp = `${target}.${randomUUID()}.tmp`;
  try {
    copyFileSync(file, tmp, constants.COPYFILE_EXCL);
    const readback = digestFile(tmp);
    if (readback.sha256 !== m.sha256 || readback.bytes !== m.bytes) throw new Error('copy readback checksum mismatch');
    if (m.kind === 'sqlite') sqliteIntegrity(tmp);
    renameSync(tmp, target); writeManifest(target, { ...m, file: basename(target) });
  } finally { if (existsSync(tmp)) unlinkSync(tmp); }
}
/** Offline restore drill: destination directory must be NEW. Never overwrites source. */
export function restoreCheck(file: string, targetDirectory: string) {
  const m = verifyBackup(file);
  const target = assertSafePath(targetDirectory);
  if (existsSync(target)) throw new Error('restore target must be a new unique directory');
  mkdirSync(target); // exclusive, including race protection
  const restored = resolve(target, basename(file));
  copyAndVerify(file, restored, m);
  verifyBackup(restored);
  return { ok: true, restored, integrity: 'ok', remoteVerified: false, encryption: 'not-implemented' };
}
