import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test.skipIf(process.platform !== 'win32')('Windows launcher starts/stops only its isolated fixture and detects a foreign listener', () => {
  const root = mkdtempSync(join(tmpdir(), 'abad-launcher-'));
  const script = join(root, 'scripts', 'dashboard-control.ps1');
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'src')); mkdirSync(join(root, 'node_modules'));
  copyFileSync(resolve('scripts/dashboard-control.ps1'), script);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { build: 'bun run build.ts' } }));
  writeFileSync(join(root, 'build.ts'), "import {mkdirSync,writeFileSync} from 'node:fs'; mkdirSync('dist',{recursive:true});writeFileSync('dist/index.html','fixture');");
  writeFileSync(join(root, 'src', 'server.ts'), "Bun.serve({hostname:'127.0.0.1',port:Number(process.env.PORT),fetch:()=>Response.json({status:'ok',liveTrading:false})});");
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('foreign') });
  const port = probe.port!;
  const run = (action: string) => Bun.spawnSync(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', action, '-Port', String(port), '-NoBrowser'], { stdout: 'pipe', stderr: 'pipe', timeout: 60000 });
  try {
    const refused = run('Start'); expect(refused.exitCode).not.toBe(0); expect(refused.stderr.toString()).toContain('already occupied');
    expect(run('Stop').exitCode).toBe(0); expect(probe.port).toBe(port);
    probe.stop(true);
    const started = run('Start'); expect(started.exitCode, started.stderr.toString()).toBe(0);
    const statePath = join(root, 'data', 'dashboard-launcher', 'owner.json');
    expect(existsSync(statePath)).toBe(true);
    const first = JSON.parse(readFileSync(statePath, 'utf8').replace(/^\uFEFF/, ''));
    expect(run('Start').exitCode).toBe(0);
    expect(JSON.parse(readFileSync(statePath, 'utf8').replace(/^\uFEFF/, '')).processId).toBe(first.processId);
    expect(run('Status').stdout.toString()).toContain('Managed dashboard PID');
    expect(run('Stop').exitCode).toBe(0); expect(existsSync(statePath)).toBe(false);
    expect(run('Stop').exitCode).toBe(0);
  } finally {
    probe.stop(true);
    run('Stop');
    // Exact unique fixture directory returned by mkdtempSync above.
    rmSync(root, { recursive: true, force: true });
  }
}, 120000);
