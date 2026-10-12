import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('manual paper workflow persists, rejects unsafe orders and reduces while halted', async ({ page }, testInfo) => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-browser-'));
  cpSync(resolve('dist'), join(dir, 'dist'), { recursive: true });
  const port = 32000 + Math.floor(Math.random() * 10000), base = `http://127.0.0.1:${port}`;
  let child: ChildProcess | undefined;
  let logs = '';
  const start = async () => {
    child = spawn('bun', ['--preload', resolve('e2e/market-preload.ts'), resolve('src/server.ts')], { cwd: dir, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', d => { logs += String(d); }); child.stderr?.on('data', d => { logs += String(d); });
    await expect.poll(async () => { try { return (await fetch(base + '/api/health')).status; } catch { return 0; } }).toBe(200);
  };
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const process = child;
    const exited = new Promise<void>(r => process.once('exit', () => r()));
    const wait = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([exited.then(() => true), new Promise<boolean>(r => { timer = setTimeout(() => r(false), 3000); })]); }
      finally { clearTimeout(timer); }
    };
    process.kill();
    if (!await wait()) { process.kill('SIGKILL'); if (!await wait()) throw new Error('Test server did not exit; preserving temporary directory'); }
  };
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const snapshot = async () => (await page.request.get(base + '/api/paper/session')).json();
  const waitOrder = async (action: () => Promise<void>) => { const response = page.waitForResponse(r => r.url().endsWith('/api/paper/mainnet-order') && r.request().method() === 'POST'); await action(); return (await response).json(); };
  try {
    await start(); await page.goto(base);
    const feed = await (await page.request.get(base + '/api/feeds/lighter')).json();
    expect(feed.mode).toBe('read-only public feed / paper authority'); expect(feed.executionSource).toBe('validated WebSocket / paper only');
    expect(feed.executionEnabled).toBe(false); expect(feed.agentsEnabled).toBe(false);
    await expect(page.getByRole('heading', { name: /BTC \/ USD/ })).toBeVisible();
    await expect(page.getByText('Mainnet validated WebSocket', { exact: true })).toBeVisible();
    await page.getByLabel('Paper leverage', { exact: true }).selectOption('2');
    await page.getByRole('button', { name: 'Save paper leverage', exact: true }).click();
    await expect(page.getByRole('heading', { name: /BTC \/ USD/ })).toContainText('2×');
    // A backend change arrives through SSE, with no account polling/reload.
    const sessionReads: string[] = [];
    const track = (request: any) => { if (request.method() === 'GET' && request.url().endsWith('/api/paper/session')) sessionReads.push(request.url()); };
    page.on('request', track);
    expect((await page.request.post(base + '/api/paper/leverage', { headers: { Origin: base }, data: { symbol: 'BTC', leverage: 3 } })).ok()).toBe(true);
    await expect(page.getByRole('heading', { name: /BTC \/ USD/ })).toContainText('3×');
    expect(sessionReads).toHaveLength(0); page.off('request', track);
    expect((await page.request.post(base + '/api/paper/leverage', { headers: { Origin: base }, data: { symbol: 'BTC', leverage: 1 } })).ok()).toBe(true);
    await expect(page.getByRole('heading', { name: /BTC \/ USD/ })).toContainText('1×');
    await expect(page.getByRole('button', { name: 'Buy BTC · market IOC', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Enable manual paper', exact: true }).click();
    const rejected = await waitOrder(() => page.getByRole('button', { name: 'Buy BTC · market IOC', exact: true }).click());
    expect(rejected.status).toBe('rejected'); await expect(page.getByRole('alert')).toContainText('risk limit');
    await page.getByLabel('Paper allocation (%)').fill('50');
    await page.getByRole('button', { name: 'Save paper allocation', exact: true }).click();
    await expect(page.getByText('Paper allocation · 50% saved')).toBeVisible();
    await page.getByLabel('BTC quantity').fill('0.003');
    await page.waitForTimeout(1100);
    const buy = await waitOrder(() => page.getByRole('button', { name: 'Buy BTC · market IOC', exact: true }).click());
    expect(buy.status).toBe('partial-canceled'); expect(buy.filled).toBeCloseTo(.002); expect(buy.price).toBeCloseTo(50015);
    await expect(page.getByText(/BTC held: 0.002/)).toBeVisible();
    await expect(page.getByLabel('Paper leverage', { exact: true })).toBeDisabled();
    await expect(page.getByRole('img', { name: 'BTC price chart' })).toBeVisible();
    await expect(page.locator('.terminal-stat').filter({ hasText: 'Avg buy · latest 100 fills' })).toContainText('$50,015.00');
    await expect(page.locator('.terminal-stat').filter({ hasText: 'Open position P&L' })).toContainText('-$0.05');
    await page.getByLabel('Stop loss (USD)', { exact: true }).fill('49000');
    await page.getByLabel('Take profit (USD)', { exact: true }).fill('51000');
    await page.getByRole('button', { name: 'Save position protection', exact: true }).click();
    await expect.poll(async () => (await snapshot()).protections.BTC?.stopLoss).toBe(49000);
    await page.getByRole('button', { name: 'Reduce 50%', exact: true }).click();
    await expect(page.getByLabel('BTC quantity', { exact: true })).toHaveValue('0.001');
    await page.getByRole('tab', { name: 'Fills', exact: true }).click();
    await expect(page.getByRole('cell', { name: 'BUY', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Realized equity', exact: true }).click();
    await expect(page.getByRole('img', { name: 'Realized equity chart' })).toBeVisible();
    const before = await snapshot(); expect(before.analytics.realized).toBeCloseTo(-.020006); expect(before.analytics.unrealized).toBeCloseTo(-.03);
    await page.reload(); await expect(page.getByText(/BTC held: 0.002/)).toBeVisible();
    await stop(); await start();
    // EventSource reconnects by itself: restart-paused state arrives without reload.
    await expect(page.getByRole('button', { name: 'Enable manual paper', exact: true })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Mainnet validated WebSocket', { exact: true })).toBeVisible();
    await page.reload();
    expect((await snapshot()).protections.BTC.takeProfit).toBe(51000);
    await expect(page.getByRole('button', { name: 'Enable manual paper', exact: true })).toBeVisible();
    await expect(page.getByText(/BTC held: 0.002/)).toBeVisible();
    page.once('dialog', d => d.accept()); await page.getByRole('button', { name: /EMERGENCY HALT/ }).click();
    await expect(page.getByText(/EMERGENCY HALT LATCHED/)).toBeVisible();
    const close = await waitOrder(() => page.getByRole('button', { name: 'Close BTC position · market IOC', exact: true }).click());
    expect(close.status).toBe('filled');
    await expect(page.getByText(/BTC held: 0 ·/)).toBeVisible();
    const after = await snapshot(); expect(after.analytics.positions).toHaveLength(0); expect(after.analytics.realized).toBeCloseTo(-.070006); expect(after.analytics.equity).toBeCloseTo(9999.929994);
    expect(after.protections.BTC).toBeUndefined();
    await expect(page.locator('.terminal-stat').filter({ hasText: 'Avg sell · latest 100 fills' })).toContainText('$50,000.00');
    await page.getByRole('tab', { name: 'Closed trades', exact: true }).click();
    await expect(page.getByRole('cell', { name: '-$0.07', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Statistics', exact: true }).click();
    await expect(page.getByText('Closed exit legs', { exact: true })).toBeVisible();
    // Same real backend, a second market and a non-marketable limit never invent a fill.
    expect((await page.request.post(base + '/api/reset', { headers: { Origin: base }, data: { confirm: 'RESET' } })).ok()).toBe(true);
    await page.getByLabel('Trading market', { exact: true }).selectOption('ETH');
    await expect(page.getByRole('heading', { name: /ETH \/ USD/ })).toBeVisible();
    await page.getByRole('button', { name: 'Enable manual paper', exact: true }).click();
    await page.getByLabel('Order type', { exact: true }).selectOption('limit');
    await page.getByLabel('Limit price (USD)', { exact: true }).fill('1999');
    await page.getByLabel('ETH quantity', { exact: true }).fill('0.01');
    await page.waitForTimeout(1100); // Existing one-second IOC throttle also spans market switches.
    const limit = await waitOrder(() => page.getByRole('button', { name: 'Buy ETH · limit IOC', exact: true }).click());
    expect(limit, JSON.stringify(limit)).toMatchObject({ status: 'canceled', symbol: 'ETH' }); expect((await snapshot()).analytics.fillCount).toBe(2);
    await page.getByLabel('Order type', { exact: true }).selectOption('market');
    await page.waitForTimeout(1100);
    const ethBuy = await waitOrder(() => page.getByRole('button', { name: 'Buy ETH · market IOC', exact: true }).click());
    expect(ethBuy.status).toBe('filled');
    await expect(page.getByText(/ETH held: 0.01/)).toBeVisible();
    await expect(page.getByRole('cell', { name: 'ETH-USD', exact: true })).toBeVisible();
    await page.waitForTimeout(1100);
    const ethClose = await waitOrder(() => page.getByRole('button', { name: 'Close ETH position · market IOC', exact: true }).click());
    expect(ethClose.status).toBe('filled');
    await expect(page.getByText(/ETH held: 0 ·/)).toBeVisible();
    // Signed inventory: selling flat reserves margin rather than crediting proceeds.
    await page.waitForTimeout(1100);
    const short = await waitOrder(() => page.getByRole('button', { name: 'Sell ETH · market IOC', exact: true }).click());
    expect(short).toMatchObject({ status: 'filled', side: 'sell', effect: 'open' });
    await expect(page.getByText(/ETH held: -0.01/)).toBeVisible();
    await expect(page.getByText('SHORT', { exact: true })).toBeVisible();
    expect((await snapshot()).analytics.positions[0].side).toBe('short');
    await page.getByLabel('Stop loss (USD)', { exact: true }).fill('2100');
    await page.getByLabel('Take profit (USD)', { exact: true }).fill('1900');
    await page.getByRole('button', { name: 'Save position protection', exact: true }).click();
    await expect.poll(async () => (await snapshot()).protections.ETH?.stopLoss).toBe(2100);
    page.once('dialog', d => d.accept()); await page.getByRole('button', { name: /EMERGENCY HALT/ }).click();
    await page.waitForTimeout(1100);
    const cover = await waitOrder(() => page.getByRole('button', { name: 'Close ETH position · market IOC', exact: true }).click());
    expect(cover).toMatchObject({ status: 'filled', side: 'buy', effect: 'reduce' });
    await expect(page.getByText(/ETH held: 0 ·/)).toBeVisible();
    expect((await snapshot()).protections.ETH).toBeUndefined();
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('paper-workflow.png'), fullPage: true });
  } finally { await stop(); await testInfo.attach('server-log', { body: logs, contentType: 'text/plain' }); rmSync(dir, { recursive: true, force: true }); }
});