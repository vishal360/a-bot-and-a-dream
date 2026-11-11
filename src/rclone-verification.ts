import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, rmSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { IndependentCopyVerifier } from './backup-verification';

/** Opt-in independent remote upload AND downloaded readback. Not enabled by default.
 * A remote configured as a local filesystem cannot establish independent durability;
 * operator must provision an actual remote backend. This verifies bytes now, not future
 * provider availability, encryption, account ownership or retention guarantees.
 */
export function rcloneReadbackVerifier(options: { remote: string; executable?: string; timeoutMs?: number }): IndependentCopyVerifier {
  if (!/^[A-Za-z0-9_-]+:[A-Za-z0-9/_-]+$/.test(options.remote) || options.remote.includes('..')) throw new Error('Explicit rclone remote:path required');
  const executable = options.executable ?? 'rclone';
  if (!executable || executable.startsWith('-')) throw new Error('Invalid rclone executable');
  const timeoutMs = options.timeoutMs ?? 120000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw new Error('Invalid remote verification timeout');
  return (file, manifest) => {
    const remoteName = options.remote.split(':')[0] + ':';
    const listing = spawnSync(executable, ['listremotes', '--json'], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
    if (listing.error || listing.status !== 0 || listing.stdout.length > 1024 * 1024) throw new Error('Cannot verify configured remote backend');
    const entries = JSON.parse(listing.stdout);
    const configured = Array.isArray(entries) ? entries.find((entry: any) => (entry.name === remoteName || entry.name === remoteName.slice(0, -1))) : null;
    if (!configured || !['drive', 's3', 'b2', 'azureblob', 'google cloud storage'].includes(configured.type)) throw new Error('Independent verification requires a direct cloud backend, not local/alias/mounted storage');
    const source = resolve(file);
    if (lstatSync(source).isSymbolicLink() || !lstatSync(source).isFile()) throw new Error('Remote source must be an ordinary file');
    // Content-addressed object prevents replacing a different snapshot on name collision.
    const objectId = `${options.remote}/${manifest.sha256}`;
    const directory = mkdtempSync(join(tmpdir(), 'abad-remote-readback-'));
    const downloaded = join(directory, 'object');
    const run = (args: string[]) => {
      const result = spawnSync(executable, [...args, '--retries', '1', '--low-level-retries', '1', '--contimeout', '15s'],
        { stdio: 'inherit', timeout: timeoutMs, windowsHide: true });
      if (result.error || result.status !== 0) throw new Error('Remote upload/readback failed; local evidence must be retained');
    };
    try {
      run(['copyto', source, objectId, '--immutable']);
      run(['copyto', objectId, downloaded]);
      if (statSync(downloaded).size !== manifest.bytes) throw new Error('Remote readback length mismatch');
      const sha256 = new Bun.CryptoHasher('sha256').update(readFileSync(downloaded)).digest('hex');
      if (sha256 !== manifest.sha256) throw new Error('Remote readback checksum mismatch');
      return { provider: 'rclone-readback-operator-configured', objectId, sha256, bytes: manifest.bytes, readbackVerified: true, independent: true };
    } finally {
      // Exact directory is returned by mkdtempSync above; never a remote or operator path.
      const checked = resolve(directory);
      if (checked.startsWith(resolve(tmpdir()) + '\\') || checked.startsWith(resolve(tmpdir()) + '/')) rmSync(checked, { recursive: true, force: true });
    }
  };
}
