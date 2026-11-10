import { lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { sha256 } from '../../scripts/lighter-acceptance-evidence';

/** Local validation provenance only; no clock certification or readiness writes. */
export const validationHelpers = Object.freeze([
  'data/resumption/acceptance-hardening-check.ts', 'data/resumption/acceptance-hardening-state.ts',
  'data/resumption/acceptance-hardening-package.ts', 'data/resumption/acceptance-hardening-helpers.test.ts',
]);

export async function readValidationSource(root: string, file: string) {
  const rootFiles = ['.dockerignore', '.gitignore', 'Dockerfile', 'README.md', 'bun.lock', 'index.html',
    'package.json', 'tsconfig.json', 'playwright.config.ts', 'vite.config.ts', 'uptill.txt', 'AGENTS.md'];
  if (typeof file !== 'string' || file.split('/').some(part => !part || part === '.' || part === '..') ||
      (!rootFiles.includes(file) && !validationHelpers.includes(file) &&
       !/^(?:src|scripts|tests|e2e|docs|\.github\/workflows)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|css|md|ps1|yml|yaml)$/.test(file)))
    throw new Error(`Non-source path refused: ${file}`);
  let path = root;
  for (const part of file.split('/')) {
    path = resolve(path, part);
    if (lstatSync(path).isSymbolicLink()) throw new Error(`Linked source path refused: ${file}`);
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error(`Source must be a bounded ordinary file: ${file}`);
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  if (bytes.byteLength > 4 * 1024 * 1024) throw new Error(`Source byte limit exceeded: ${file}`);
  return bytes;
}

/** Only fixture reports/logs and closed fixture artifacts, never arbitrary operational paths. */
export async function readValidationArtifact(directory: string, file: string) {
  if (typeof file !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*\.(?:json|log|sqlite)$/.test(file) ||
      file.split('/').some(part => part === '.' || part === '..')) throw new Error(`Unsafe validation artifact: ${file}`);
  let path = directory;
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error('Linked validation directory refused');
  for (const part of file.split('/')) {
    path = resolve(path, part);
    if (lstatSync(path).isSymbolicLink()) throw new Error(`Linked validation artifact refused: ${file}`);
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error(`Unbounded validation artifact: ${file}`);
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  if (bytes.byteLength > 16 * 1024 * 1024) throw new Error(`Artifact byte limit exceeded: ${file}`);
  return bytes;
}

export async function captureValidationState(root: string) {
  const files = Bun.spawnSync(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root });
  const head = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root });
  if (files.exitCode !== 0 || head.exitCode !== 0) throw new Error('Cannot determine validation source state');
  const paths = [...new Set([...files.stdout.toString('utf8').split('\0').filter(Boolean), ...validationHelpers])].sort();
  const sources = await Promise.all(paths.map(async file => {
    const bytes = await readValidationSource(root, file);
    return { file, bytes: bytes.byteLength, sha256: sha256(bytes) };
  }));
  const gitHead = head.stdout.toString('utf8').trim();
  return { gitHead, fingerprint: sha256(JSON.stringify({ gitHead, sources })), sources };
}

export function validateStageResult(stage: string, result: any, state: Awaited<ReturnType<typeof captureValidationState>>) {
  const expectedExit = ['legacy', 'failedShort'].includes(stage) ? 1 : stage === 'preflight' ? result?.exitCode : 0;
  if (!result || result.complete !== true || result.sourcesStable !== true || result.exitCode !== expectedExit ||
      result.childExitCode !== expectedExit || ![0, 1].includes(expectedExit) ||
      !Number.isFinite(Date.parse(result.startedAt)) || !Number.isFinite(Date.parse(result.endedAt)) ||
      Date.parse(result.endedAt) < Date.parse(result.startedAt) ||
      result.sourceState?.fingerprint !== state.fingerprint || result.finalSourceFingerprint !== state.fingerprint ||
      JSON.stringify(result.sourceState) !== JSON.stringify(state))
    throw new Error(`Unvalidated, failed or source-mismatched stage: ${stage}`);
}