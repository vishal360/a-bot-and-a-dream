import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('baseline reconciliation restores manual activation and stale quotes survive reconnect', async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-recovery-browser-'));
  cpSync(resolve('dist'), join(dir, 'dist'), { recursive: true });
  const port = 32000 + Math.floor(Math.random() * 10000), base = `http://127.0.0.1:${port}`;
  const child = spawn('bun', ['--preload', resolve('e2e/market-preload.ts'), resolve('src/server.ts')], { cwd: dir,
    env: { ...process.env, PORT: String(port), PAPER_FIXTURE_BASELINE_HALT: '1' }, stdio: 'ignore' });
  const snapshot = async () => (await page.request.get(base + '/api/paper/session')).json();
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  try {
    await expect.poll(async () => { try { return (await fetch(base + '/api/health')).status; } catch { return 0; } }).toBe(200);
    await page.goto(base);
    await expect(page.getByRole('button', { name: 'Reconcile paper baseline', exact: true })).toBeVisible();
    const baseline = (await snapshot()).riskDays.current;
    const activation = page.waitForResponse(r => r.url().endsWith('/api/paper/session') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Enable manual paper', exact: true }).click();
    expect(await (await activation).json()).toMatchObject({ error: 'Paper baseline reconciliation required' });
    page.once('dialog', d => d.accept());
    await page.getByRole('button', { name: 'Reconcile paper baseline', exact: true }).click();
    await expect.poll(async () => (await snapshot()).riskDays.blocked).toBe(false);
    expect((await snapshot()).riskDays.current).toEqual(baseline);
    await page.getByRole('button', { name: 'Enable manual paper', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Buy BTC · market IOC', exact: true })).toBeEnabled();
    const quotes = page.getByLabel('Market quotes', { exact: true });
    const before = await quotes.innerText();
    expect(before).toContain('$50,000.00'); expect(before).toContain('0.001%');
    writeFileSync(join(dir, 'data/fixture-disconnect.flag'), 'disconnect');
    await expect(page.getByText(/Last validated quotes · stale \/ display only/)).toBeVisible();
    expect(await quotes.innerText()).toBe(before);
    await expect(page.getByRole('button', { name: 'Buy BTC · market IOC', exact: true })).toBeDisabled();
    await expect(page.getByText('Mainnet validated WebSocket', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Buy BTC · market IOC', exact: true })).toBeEnabled();
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(r => child.once('exit', () => r())); child.kill();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { if (!await Promise.race([exited.then(() => true), new Promise<boolean>(r => { timer = setTimeout(() => r(false), 3000); })])) { child.kill('SIGKILL'); await exited; } }
      finally { clearTimeout(timer); }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});