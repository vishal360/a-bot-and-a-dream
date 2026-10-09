import { resolve, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
const check = Bun.spawn([process.execPath, 'run', 'check'], { stdout: 'pipe', stderr: 'pipe' });
const [stdout, stderr, code] = await Promise.all([new Response(check.stdout).text(), new Response(check.stderr).text(), check.exited]);
await Bun.write('validation.log', stdout + stderr + `\nCHECK_EXIT=${code}\n`);
if (code !== 0) throw new Error('Validation failed; inspect validation.log');
const dir = mkdtempSync(join(tmpdir(), 'dream-static-'));
const port = 28500 + Math.floor(Math.random() * 1000);
// Static paths resolve from the real project; isolate data by copying only built assets.
const { cpSync } = await import('node:fs'); cpSync('dist', join(dir, 'dist'), { recursive: true });
const proc = Bun.spawn([process.execPath, resolve('src/server.ts')], { cwd: dir, env: { ...process.env, PORT: String(port) }, stdout: 'ignore', stderr: 'pipe' });
try {
  const base = `http://127.0.0.1:${port}`; let html = '';
  for (let i = 0; i < 100; i++) { try { const r = await fetch(base); if (r.ok) { html = await r.text(); break; } } catch {} await Bun.sleep(50); }
  if (!html.includes('A Bot and a Dream')) throw new Error('Production HTML not served');
  for (const path of [...html.matchAll(/(?:src|href)="(\/assets\/[^" ]+)"/g)].map(m => m[1])) {
    const r = await fetch(base + path); if (!r.ok || !(await r.text()).length) throw new Error(`Missing asset ${path}`);
  }
  const health = await (await fetch(base + '/api/health')).json();
  if (health.liveTrading !== false || health.brokerConnected !== false) throw new Error('Unsafe health flags');
  await Bun.write('validation.log', await Bun.file('validation.log').text() + 'PRODUCTION_HTTP_SMOKE=PASS\n');
  console.log('PASS: typecheck, 11 tests, production build, static assets and HTTP health. See validation.log.');
} finally { proc.kill(); await proc.exited; rmSync(dir, { recursive: true, force: true }); }
export {};