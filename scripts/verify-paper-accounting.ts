import { resolve } from 'node:path';

// Offline regression runner: fixture-backed tests only, no mainnet orders or agents.
const commands = [
  ['typecheck', ['bun', 'run', 'typecheck']],
  ['unit', ['bun', 'test']],
  ['build', ['bun', 'run', 'build']],
  ['browser', ['bun', 'node_modules/@playwright/test/cli.js', 'test']],
] as const;
const startedAt = new Date().toISOString();
const results: { name: string; exitCode: number; stdout: string; stderr: string; startedAt: string; endedAt: string }[] = [];
await Bun.write('resume-verified-results.json', JSON.stringify({ complete: false, startedAt, results }, null, 2));
for (const [name, command] of commands) {
  const stdout = resolve(`resume-verified-${name}-out.log`), stderr = resolve(`resume-verified-${name}-err.log`);
  // Bun.file spawn sinks can leave a previous longer log's tail; truncate explicitly.
  await Promise.all([Bun.write(stdout, ''), Bun.write(stderr, '')]);
  const commandStartedAt = new Date().toISOString();
  const child = Bun.spawn([...command], { cwd: resolve('.'), stdout: Bun.file(stdout), stderr: Bun.file(stderr), env: { ...process.env, CI: '1' } });
  const exitCode = await child.exited;
  results.push({ name, exitCode, stdout, stderr, startedAt: commandStartedAt, endedAt: new Date().toISOString() });
  await Bun.write('resume-verified-results.json', JSON.stringify({ complete: false, startedAt, results }, null, 2));
}
await Bun.write('resume-verified-results.json', JSON.stringify({ complete: true, startedAt, endedAt: new Date().toISOString(), results }, null, 2));
process.exitCode = results.some(r => r.exitCode !== 0) ? 1 : 0;