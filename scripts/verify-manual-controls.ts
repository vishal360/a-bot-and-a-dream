// Durable UTF-8 evidence: shell integration can lose both output and exit status.
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const commands = [
  ['typecheck', [process.execPath, 'run', 'typecheck']],
  ['tests', [process.execPath, 'test']],
  ['build', [process.execPath, 'run', 'build']],
  ['browser', [process.execPath, 'node_modules/@playwright/test/cli.js', 'test']],
  ['smoke', [process.execPath, 'run', 'scripts/verify.ts']],
  ['whitespace', ['git', 'diff', '--check']],
  ['status', ['git', 'status', '--short', '--branch']],
] as const;
let failed = false;
const results: { name: string; exit: number }[] = [];
for (const [name, command] of commands) {
  const p = Bun.spawn([...command], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exit] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  await Bun.write(new URL(`../manual-${name}.log`, import.meta.url), `${stdout}\n${stderr}\nEXIT=${exit}\n`);
  results.push({ name, exit });
  console.log(`${name}: ${exit}`);
  if (exit !== 0) failed = true;
  if (exit !== 0 && ['typecheck', 'tests', 'build'].includes(name)) break;
}
await Bun.write(new URL('../manual-verification.log', import.meta.url), JSON.stringify({ time: new Date().toISOString(), results }, null, 2));
process.exitCode = failed ? 1 : 0;
export {};