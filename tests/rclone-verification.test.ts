import { test, expect } from 'bun:test';
import { rcloneReadbackVerifier } from '../src/rclone-verification';
test('remote verifier rejects local paths and unsafe remotes before spawning', () => {
  for (const remote of ['C:\\backup', '/tmp/backup', 'drive:../escape', 'drive:path;evil', 'drive:'])
    expect(() => rcloneReadbackVerifier({ remote })).toThrow();
  expect(() => rcloneReadbackVerifier({ remote: 'cloud:abad', timeoutMs: 0 })).toThrow();
});
test('remote drill CLI help and invalid args are offline', () => {
  const run = (args: string[]) => Bun.spawnSync([process.execPath, 'scripts/verify-remote-backup.ts', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const help = run(['--help']); expect(help.exitCode).toBe(0); expect(help.stdout.toString()).toContain('No pruning');
  expect(run(['--auth', 'bad']).exitCode).not.toBe(0);
});
