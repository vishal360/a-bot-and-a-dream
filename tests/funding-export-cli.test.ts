import { test, expect } from 'bun:test';
import { resolve } from 'node:path';
const script = resolve('scripts/fetch-replay-funding.ts');
test('public funding exporter help and invalid arguments are offline and bounded', () => {
  const run = (args: string[]) => Bun.spawnSync([process.execPath, script, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const help = run(['--help']);
  expect(help.exitCode).toBe(0);
  expect(help.stdout.toString()).toContain('Public mainnet funding history only');
  expect(run(['--auth', 'secret']).exitCode).not.toBe(0);
  expect(run(['--market-id', '-1', '--symbol', 'BTC', '--from', '0', '--to', '1', '--out', 'unused.json']).exitCode).not.toBe(0);
  expect(run(['--market-id', '0', '--symbol', 'BTC', '--from', '0', '--to', '999999999', '--out', 'unused.json']).exitCode).not.toBe(0);
});
