// Sequential build/browser checks avoid races over dist and Playwright reports.
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const commands = [
  ['typecheck', [process.execPath, 'run', 'typecheck']],
  ['tests', [process.execPath, 'test']],
  ['build', [process.execPath, 'run', 'build']],
  ['browser', [process.execPath, 'node_modules/@playwright/test/cli.js', 'test']],
  ['smoke', [process.execPath, 'run', 'scripts/verify.ts']],
  ['whitespace', ['git', 'diff', '--check']],
] as const;
const results: { name: string; exit: number }[] = [];
for (const [name, command] of commands) {
  const child = Bun.spawn([...command], { cwd: root, stdout: 'pipe', stderr: 'pipe', timeout: 180000 });
  const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  await Bun.write(new URL(`../evidence-${name}.log`, import.meta.url), `${out}\n${err}\nEXIT=${exit}\n`);
  results.push({ name, exit });
  await Bun.write(new URL('../evidence-verification.log', import.meta.url), JSON.stringify({ time: new Date().toISOString(), results }, null, 2));
  if (exit !== 0 && ['typecheck', 'tests', 'build'].includes(name)) break;
}
process.exitCode = results.some(r => r.exit !== 0) ? 1 : 0;
export {};