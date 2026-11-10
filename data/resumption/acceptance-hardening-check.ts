import { resolve } from 'node:path';
import { copyFileSync, existsSync, mkdirSync, rmdirSync } from 'node:fs';
import { captureValidationState, validationHelpers } from './acceptance-hardening-state';
import { sha256 } from '../../scripts/lighter-acceptance-evidence';

const root = resolve(import.meta.dir, '../..');
const commands: Record<string, string[]> = {
  typecheck: [process.execPath, 'run', 'typecheck'],
  helperTypecheck: [process.execPath, 'node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--skipLibCheck',
    '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--esModuleInterop', '--types', 'bun', ...validationHelpers],
  helperTests: [process.execPath, 'test', './data/resumption/acceptance-hardening-helpers.test.ts'],
  targeted: [process.execPath, 'test', './tests/lighter-acceptance-clock.test.ts', './tests/lighter-acceptance-inspection.test.ts', './tests/lighter-acceptance-progress.test.ts', './tests/lighter-acceptance-observation.test.ts', './tests/lighter-acceptance.test.ts', './tests/lighter-feed-drills.test.ts', './tests/lighter-foundation-gate.test.ts'],
  unit: [process.execPath, 'run', 'test'], build: [process.execPath, 'run', 'build'],
  browser: [process.execPath, 'node_modules/@playwright/test/cli.js', 'test'],
  drills: [process.execPath, 'run', 'scripts/drill-lighter-feed.ts'],
  preflight: [process.execPath, 'run', 'scripts/lighter-acceptance-clock.ts'],
  short: [process.execPath, 'run', 'scripts/accept-lighter.ts', '--seconds', '60', '--symbols', 'BTC,ETH'],
  legacy: [process.execPath, 'run', 'scripts/inspect-lighter-acceptance.ts', 'a8923e7b-c22a-42a8-9cfd-98789e28f7db'],
  failedShort: [process.execPath, 'run', 'scripts/inspect-lighter-acceptance.ts', '4b7bb361-1c97-41f2-bfcc-46893bf47c44'],
  whitespace: ['git', 'diff', '--check'],
};
const name = process.argv[2];
if (!Object.hasOwn(commands, name) || process.argv.length !== 3) throw new Error('One known validation stage required');
const directory = resolve(import.meta.dir, 'acceptance-hardening'); mkdirSync(directory, { recursive: true });
const lock = resolve(directory, `${name}.lock`);
mkdirSync(lock); // Exclusive ownership; a stale lock needs review, not automatic takeover.
try {
const sourceState = await captureValidationState(root);
const previous = resolve(directory, 'attempts', `previous-${name}-${crypto.randomUUID()}`);
mkdirSync(previous, { recursive: true });
for (const suffix of ['out.log', 'err.log', 'result.json']) {
  const file = `${name}-${suffix}`, path = resolve(directory, file);
  if (existsSync(path)) copyFileSync(path, resolve(previous, file));
}
const stdout = resolve(directory, `${name}-out.log`), stderr = resolve(directory, `${name}-err.log`), result = resolve(directory, `${name}-result.json`);
await Promise.all([Bun.write(stdout, ''), Bun.write(stderr, '')]);
const startedAt = new Date().toISOString();
const child = Bun.spawn(commands[name], { cwd: root, stdout: Bun.file(stdout), stderr: Bun.file(stderr), env: { ...process.env, CI: '1' }, timeout: 300000 });
await Bun.write(result, JSON.stringify({ complete: false, startedAt, pid: process.pid, childPid: child.pid, command: commands[name], sourceState }, null, 2));
const childExitCode = await child.exited;
const finalSourceState = await captureValidationState(root);
const sourcesStable = sourceState.fingerprint === finalSourceState.fingerprint;
const exitCode = sourcesStable ? childExitCode : 1;
const logs = await Promise.all([stdout, stderr].map(async path => {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  return { bytes: bytes.byteLength, sha256: sha256(bytes) };
}));
await Bun.write(result, JSON.stringify({ complete: true, startedAt, endedAt: new Date().toISOString(), pid: process.pid, childPid: child.pid,
  command: commands[name], exitCode, childExitCode, stdout, stderr, logHashes: { stdout: logs[0], stderr: logs[1] },
  sourcesStable, sourceState, finalSourceFingerprint: finalSourceState.fingerprint }, null, 2));
process.exitCode = exitCode;
} finally { rmdirSync(lock); }