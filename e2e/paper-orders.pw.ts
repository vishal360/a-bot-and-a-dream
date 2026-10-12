import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('pending reservations push to the browser and local cancellation wins without a fill', async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-cancel-browser-'));
  cpSync(resolve('dist'), join(dir, 'dist'), { recursive: true });
  const port = 32000 + Math.floor(Math.random() * 10000), base = `http://127.0.0.1:${port}`;
  const child = spawn('bun', ['--preload', resolve('e2e/market-preload.ts'), resolve('src/server.ts')], { cwd: dir,
    env: { ...process.env, PORT: String(port), PAPER_FIXTURE_LATENCY_MS: '2000' }, stdio: 'ignore' });
  const post = (path: string, body: unknown) => page.request.post(base + '/api/' + path, { headers: { Origin: base }, data: body });
  const snapshot = async () => (await page.request.get(base + '/api/paper/session')).json();
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await expect.poll(async () => { try { return (await fetch(base + '/api/health')).status; } catch { return 0; } }).toBe(200);
    await page.goto(base);
    await expect(page.getByText('Mainnet validated WebSocket', { exact: true })).toBeVisible();
    expect((await post('risk/allocation', { allocationPct: 50 })).ok()).toBe(true);
    expect((await post('paper/session', { enabled: true })).ok()).toBe(true);
    await expect(page.getByRole('button', { name: 'Buy BTC · market IOC', exact: true })).toBeEnabled();
    const submitted = page.waitForResponse(r => r.url().endsWith('/api/paper/mainnet-order') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Buy BTC · market IOC', exact: true }).click();
    const cancel = page.getByRole('button', { name: 'Cancel pending IOC', exact: true });
    await expect(cancel).toBeVisible();
    const pending = await snapshot();
    expect(pending.orderManagement.reservations).toHaveLength(1);
    expect(Number(pending.orderManagement.chargeMicros)).toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: 'Buy BTC · market IOC', exact: true })).toBeDisabled();
    await cancel.click();
    const result = await (await submitted).json();
    expect(result.status).toBe('canceled');
    const after = await snapshot();
    expect(after.analytics.fillCount).toBe(0); expect(after.analytics.accounting.cashMicros).toBe('10000000000');
    expect(after.orderManagement.reservations).toHaveLength(0); expect(after.orderManagement.pending).toBe(false);
    expect((await (await post('paper/cancel', { id: result.id })).json()).status).toBe('canceled');
    expect((await (await post('paper/mainnet-order', { id: result.id, symbol: result.symbol, side: result.side, quantity: result.quantity })).json()).status).toBe('canceled');
    await expect(cancel).toHaveCount(0); expect(errors).toEqual([]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      child.kill();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const stopped = await Promise.race([exited.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 3000); })]);
        if (!stopped) { child.kill('SIGKILL'); await exited; }
      } finally { clearTimeout(timer); }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});