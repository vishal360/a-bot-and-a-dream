import { lstatSync } from 'node:fs';
import { resolve } from 'node:path';

// Include the observer's local runtime dependencies and the dependency lock, not git HEAD alone.
export const acceptanceSourceFiles = Object.freeze([
  'package.json', 'bun.lock', 'scripts/accept-lighter.ts', 'scripts/lighter-acceptance-clock.ts',
  'scripts/lighter-acceptance-evidence.ts', 'scripts/lighter-acceptance-observation.ts', 'scripts/lighter-acceptance-progress.ts',
  'src/lighter.ts', 'src/lighter-stream.ts', 'src/lighter-book.ts', 'src/lighter-stats.ts',
  'src/lighter-trades.ts', 'src/lighter-evidence.ts', 'src/lighter-acceptance.ts', 'src/paper-math.ts', 'src/store.ts', 'src/domain.ts',
]);
export type EvidenceHash = { file: string; bytes: number; sha256: string };
export const sha256 = (bytes: string | Uint8Array) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');

export async function hashAcceptanceSources(root: string): Promise<EvidenceHash[]> {
  return Promise.all(acceptanceSourceFiles.map(async file => {
    const bytes = new Uint8Array(await Bun.file(resolve(root, file)).arrayBuffer());
    return { file, bytes: bytes.byteLength, sha256: sha256(bytes) };
  }));
}

/** Only ordinary, bounded JSON files within this evidence directory may be inspected. */
export async function readEvidenceFile(directory: string, file: string) {
  if (typeof file !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(file)) throw new Error('Unsafe evidence filename');
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('Evidence directory must be an ordinary directory');
  const path = resolve(directory, file), stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error('Evidence must be a bounded ordinary JSON file');
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  if (bytes.byteLength > 16 * 1024 * 1024) throw new Error('Evidence byte limit exceeded');
  return { bytes, record: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), hash: { file, bytes: bytes.byteLength, sha256: sha256(bytes) } };
}

export async function hashEvidenceFile(directory: string, file: string): Promise<EvidenceHash> {
  return (await readEvidenceFile(directory, file)).hash;
}