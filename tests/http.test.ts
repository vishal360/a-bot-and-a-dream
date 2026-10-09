import { test, expect } from 'bun:test';
import { defaultConfig } from '../src/domain';
test('HTTP boundary, backtest, promotion and durable halt workflow', async () => {
  // Isolated working directory keeps integration state away from operator data.
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os'); const { join, resolve } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'dream-http-'));
  const port = 18000 + Math.floor(Math.random() * 10000), base = `http://127.0.0.1:${port}`;
  const proc = Bun.spawn([process.execPath, resolve('src/server.ts')], { cwd: dir, env: { ...process.env, PORT: String(port) }, stdout: 'ignore', stderr: 'pipe' });
  const post = (path: string, body: unknown, origin = base) => fetch(base + '/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) { try { ready = (await fetch(base + '/api/health')).ok; } catch {} if (ready) break; await Bun.sleep(50); }
    expect(ready).toBe(true);
    expect((await (await fetch(base + '/api/health')).json()).liveTrading).toBe(false);
    expect((await post('halt', {}, 'https://attacker.example')).status).toBe(403);
    expect((await post('command', { id: 'atlas', action: 'start' })).status).toBe(200);
    expect((await post('halt', {})).status).toBe(200);
    expect((await post('command', { id: 'atlas', action: 'start' })).status).toBe(400);
    expect((await post('reset', { confirm: 'wrong' })).status).toBe(400);
    expect((await post('reset', { confirm: 'RESET' })).status).toBe(200);
    const run = await (await post('backtest', { config: { ...defaultConfig, asset: 'crypto' } })).json();
    expect(run.result.source).toBe('synthetic'); expect((await post('promote', { id: run.id })).status).toBe(200);
    const state = await (await fetch(base + '/api/state')).json(); expect(state.strategies.length).toBe(1); expect(state.bots.every((b: any) => b.status === 'paused')).toBe(true);
    expect((await post('backtest', { config: { ...defaultConfig, riskPct: .5 } })).status).toBe(400);
  } finally { proc.kill(); await proc.exited; rmSync(dir, { recursive: true, force: true }); }
}, 20000);