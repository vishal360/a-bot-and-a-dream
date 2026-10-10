import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store';
import { Vault } from '../src/vault';
import { Operations } from '../src/operations';
import { analytics, validateFill, type Fill } from '../src/ledger';
const fill = (id: string, side: 'buy' | 'sell', quantity: number, price: number, fee = 1): Fill => ({ id, side, quantity, price, fee, multiplier: 5, botId: 'atlas', symbol: 'MES', account: 'external', source: 'imported', reason: 'test', time: `2026-01-01T00:00:0${id}.000Z` });
function fixture(run: (o: Operations, s: Store, v: Vault) => void | Promise<void>, request?: typeof fetch) {
  const dir = mkdtempSync(join(tmpdir(), 'dream-ops-')), s = new Store(':memory:'), v = new Vault(join(dir, 'key')), o = new Operations(s, v, request);
  return Promise.resolve().then(() => run(o, s, v)).finally(() => { s.db.close(); rmSync(dir, { recursive: true }); });
}
test('stats reset archives flat history atomically and preserves controls and deduplication', () => fixture((o, s) => {
  o.ingest(fill('1', 'buy', 1, 100));
  expect(() => o.resetStats('wrong')).toThrow();
  expect(() => o.resetStats('ARCHIVE AND RESET')).toThrow('open positions');
  expect(o.archives()).toHaveLength(0); expect(o.fills()).toHaveLength(1);
  o.ingest(fill('2', 'sell', 1, 110)); s.halt();
  const risk = s.get('risk');
  o.saveLighter({ network: 'testnet', accountIndex: 1229, apiKeyIndex: 4, privateKey: 'a'.repeat(80) });
  const archive = o.resetStats('ARCHIVE AND RESET');
  expect(o.archive(archive.id).fills).toHaveLength(2); expect(o.fills()).toHaveLength(0);
  expect(o.snapshot().accounts[0].analytics.realized).toBe(0);
  expect(s.get('halted')).toBe(true); expect(s.get('risk')).toEqual(risk);
  expect(o.lighterConfig()?.accountIndex).toBe(1229);
  expect(JSON.stringify(o.archive(archive.id))).not.toContain('a'.repeat(80));
  expect(o.ingest(fill('1', 'buy', 1, 100))).toBe(false);
  expect(() => o.ingest(fill('1', 'buy', 1, 101))).toThrow('archived duplicate');
}));
test('partial closes allocate fees and preserve unrealized inventory', () => {
  const a = analytics([fill('1', 'buy', 2, 100, 2), fill('2', 'sell', 1, 110)], [{ account: 'external', symbol: 'MES', price: 105, time: new Date().toISOString(), source: 'test' }], 1000, new Date('2026-01-01'));
  expect(a.realized).toBe(47); expect(a.trades[0].pnl).toBe(48); expect(a.unrealized).toBe(25); expect(a.equity).toBe(1072); expect(a.positions[0].quantity).toBe(1); expect(a.bots[0].realized).toBe(47); expect(a.today).toBe(47);
});
test('portfolio allocation defaults closed, validates percentages and survives stats reset', () => fixture((o, s) => {
  expect(o.allocationPolicy().allocationPct).toBe(0);
  for (const allocationPct of [-1, 101, 75.5, '75', null, NaN, Infinity]) expect(() => o.saveAllocation({ allocationPct })).toThrow();
  expect(o.saveAllocation({ allocationPct: 75 })).toEqual({ allocationPct: 75, dailyLossPct: 6, maxLeverage: 20, executionEnabled: false });
  expect(s.get('allocationPct')).toBe(75);
  o.resetStats('ARCHIVE AND RESET'); expect(o.allocationPolicy().allocationPct).toBe(75);
  expect(o.saveAllocation({ allocationPct: 100 }).allocationPct).toBe(100);
  expect(o.saveAllocation({ allocationPct: 0 }).allocationPct).toBe(0);
}));
test('short positions, reversals and flat inventory reconcile', () => {
  const a = analytics([fill('1', 'sell', 2, 100, 2), fill('2', 'buy', 3, 90, 3), fill('3', 'sell', 1, 95)], [], 1000);
  expect(a.realized).toBe(119); expect(a.positions).toHaveLength(0); expect(a.trades.map(t => t.pnl)).toEqual([96, 23]); expect(a.bots[0].realized).toBe(119);
});
test('allocation uses changing entire venue equity and rejects unsafe snapshots', () => fixture((o, s) => {
  o.saveAllocation({ allocationPct: 75 });
  expect(o.allocationPreview().equity).toBeNull();
  o.saveLighter({ network: 'testnet', accountIndex: 1229, apiKeyIndex: 4, privateKey: 'a'.repeat(80) });
  const now = Date.now(), snapshot = { network: 'testnet', accountIndex: 1229, time: new Date(now).toISOString(), totalAssetValue: '2400' };
  s.set('lighterAccount', snapshot);
  expect(o.allocationPreview(now).marginBudget).toBe(1800);
  s.set('lighterAccount', { ...snapshot, totalAssetValue: '3200' });
  expect(o.allocationPreview(now).marginBudget).toBe(2400);
  expect(o.allocationPreview(now + 30001).marginBudget).toBeNull();
  for (const totalAssetValue of [null, '', ' ', 'NaN', 'Infinity', '-1', true, {}, []]) {
    s.set('lighterAccount', { ...snapshot, totalAssetValue }); expect(o.allocationPreview(now).equity).toBeNull();
  }
  s.set('lighterAccount', { ...snapshot, totalAssetValue: '0' }); expect(o.allocationPreview(now).marginBudget).toBe(0);
  s.set('lighterAccount', { ...snapshot, accountIndex: 999 }); expect(o.allocationPreview(now).equity).toBeNull();
  s.set('lighterAccount', { ...snapshot, network: 'mainnet' }); expect(o.allocationPreview(now).equity).toBeNull();
  s.set('lighterAccount', { ...snapshot, time: new Date(now + 1).toISOString() }); expect(o.allocationPreview(now).equity).toBeNull();
  s.set('lighterAccount', snapshot);
  o.saveLighter({ network: 'testnet', accountIndex: 1230, apiKeyIndex: 4, privateKey: 'b'.repeat(80) });
  expect(s.get('lighterAccount')).toBeNull(); expect(o.allocationPreview(now).marginBudget).toBeNull();
}));
test('allocation policy and venue snapshot survive database reopen without becoming execution authority', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-allocation-')), path = join(dir, 'state.sqlite'), vault = new Vault(join(dir, 'key'));
  let store = new Store(path);
  try {
    let operations = new Operations(store, vault);
    operations.saveAllocation({ allocationPct: 65 });
    operations.saveLighter({ network: 'testnet', accountIndex: 1229, apiKeyIndex: 4, privateKey: 'a'.repeat(80) });
    const now = Date.now();
    store.set('lighterAccount', { network: 'testnet', accountIndex: 1229, time: new Date(now).toISOString(), totalAssetValue: '5000' });
    store.db.close(); store = new Store(path); operations = new Operations(store, vault);
    expect(operations.allocationPolicy().allocationPct).toBe(65);
    expect(operations.allocationPreview(now).marginBudget).toBe(3250);
    expect(operations.allocationPreview(now).executionEnabled).toBe(false);
    expect(operations.allocationPreview(now + 30001).equity).toBeNull();
  } finally { store.db.close(); rmSync(dir, { recursive: true }); }
});
test('account read cannot overwrite a connection switched while the request is pending', async () => {
  let resolve!: (response: Response) => void;
  const mock = (() => new Promise<Response>(r => { resolve = r; })) as unknown as typeof fetch;
  await fixture(async (o, s) => {
    o.saveLighter({ network: 'testnet', accountIndex: 1229, apiKeyIndex: 4, privateKey: 'a'.repeat(80) });
    const pending = o.syncLighter();
    o.saveLighter({ network: 'mainnet', accountIndex: 1229, apiKeyIndex: 4, privateKey: 'b'.repeat(80) });
    resolve(Response.json({ code: 200, accounts: [{ account_index: 1229, total_asset_value: '9000' }] }));
    await expect(pending).rejects.toThrow('Connection changed'); expect(s.get('lighterAccount')).toBeNull();
  }, mock);
});
test('missing marks are unknown rather than zero; stale marks flagged', () => {
  const f = [fill('1', 'buy', 1, 100)]; expect(analytics(f, [], 1000).equity).toBeNull();
  expect(analytics(f, [{ account: 'external', symbol: 'MES', price: 110, time: '2026-01-01', source: 'test' }], 1000).staleMarks).toBe(1);
});
test('invalid fills rejected', () => { expect(() => validateFill({ ...fill('1', 'buy', 1, 100), quantity: NaN })).toThrow(); expect(() => validateFill({ ...fill('1', 'buy', 1, 100), time: 'bad' })).toThrow(); });
test('same-timestamp fills preserve execution insertion order rather than random IDs', () => {
  const first = fill('9', 'buy', 1, 100), second = { ...fill('1', 'sell', 1, 110), time: first.time };
  const a = analytics([first, second], [], 1000); expect(a.trades[0].entry).toBe(100); expect(a.trades[0].exit).toBe(110); expect(a.realized).toBe(48);
});
test('vault encryption, redacted snapshots, token revocation and duplicate conflict', () => fixture((o, s, v) => {
  const encrypted = v.encrypt({ apiSecret: 'private-secret' }); expect(encrypted).not.toContain('private-secret'); expect(v.decrypt(encrypted).apiSecret).toBe('private-secret');
  const id = o.saveConnection({ name: 'test', provider: 'alpaca-paper', apiKey: 'key', apiSecret: 'private-secret', botId: 'atlas' }); expect(JSON.stringify(o.snapshot())).not.toContain('private-secret'); expect(JSON.stringify(o.snapshot())).not.toContain('"secret"');
  const token = o.rotateToken(); expect(o.authorized(token)).toBe(true); o.rotateToken(); expect(o.authorized(token)).toBe(false);
  expect(o.ingest(fill('1', 'buy', 1, 100))).toBe(true); expect(o.ingest(fill('1', 'buy', 1, 100))).toBe(false); expect(() => o.ingest(fill('1', 'buy', 1, 101))).toThrow();
  expect(() => o.ingest({ ...fill('2', 'buy', 1, 100), account: 'paper' })).toThrow(); o.removeConnection(id); expect(o.connections()).toHaveLength(0);
}));
test('paper runner fills, risk rejection, halt blocks exposure but permits flatten', () => fixture((o, s) => {
  o.tick(); expect(() => o.paperOrder({ botId: 'atlas', side: 'buy', quantity: 1 })).toThrow(); s.command('atlas', 'start');
  expect(() => o.paperOrder({ botId: 'atlas', side: 'buy', quantity: 2 })).toThrow();
  o.paperOrder({ botId: 'atlas', side: 'buy', quantity: 1 }); s.halt(); expect(() => o.paperOrder({ botId: 'atlas', side: 'buy', quantity: 1 })).toThrow();
  expect(o.flatten('atlas')).toHaveLength(1); expect(o.snapshot().accounts[0].analytics.positions).toHaveLength(0);
  expect(() => o.risk({ capital: 200000 })).toThrow(); s.reset(); expect(s.get('bots')[0].status).toBe('paused');
}));
test('running synthetic bots actually enter and exit recorded trades', () => fixture((o, s) => {
  s.command('atlas', 'start'); s.command('orion', 'start'); for (let i = 0; i < 100; i++) o.tick();
  const a = o.snapshot().accounts[0].analytics; expect(a.fillCount).toBeGreaterThan(4); expect(a.trades.length).toBeGreaterThan(1); expect(a.bots).toHaveLength(2);
}));
test('Alpaca read-only sync imports idempotently and uses fixed provider endpoints', async () => {
  const urls: string[] = [];
  const mock = (async (url: any, options: any) => { urls.push(String(url)); expect(options.method).toBeUndefined(); expect(options.headers['APCA-API-KEY-ID']).toBe('key');
    const path = new URL(String(url)).pathname;
    return Response.json(path === '/v2/account' ? { equity: '10000', cash: '9000', buying_power: '9000', status: 'ACTIVE', currency: 'USD' } : path.endsWith('FILL') ? [{ id: 'fill-1', symbol: 'BTC/USD', side: 'buy', qty: '0.01', price: '100', transaction_time: '2026-01-01T00:00:00.000Z' }] : [{ symbol: 'BTC/USD', qty: '.01', current_price: '101' }]);
  }) as typeof fetch;
  await fixture(async o => { const id = o.saveConnection({ name: 'test', provider: 'alpaca-paper', apiKey: 'key', apiSecret: 'secret', botId: 'orion' }); await o.sync(id); await o.sync(id); expect(o.fills()).toHaveLength(1); expect(o.connections()[0].status).toBe('connected / read-only'); expect(urls.every(u => u.startsWith('https://paper-api.alpaca.markets/'))).toBe(true); }, mock);
});
test('Lighter credentials remain encrypted and public account sync never authenticates a key', async () => {
  const mock = (async (url: any) => { expect(String(url)).toBe('https://testnet.zklighter.elliot.ai/api/v1/account?by=index&value=42'); return Response.json({ code: 200, accounts: [{ account_index: 42, collateral: '100', positions: [] }] }); }) as typeof fetch;
  await fixture(async (o, s) => {
    expect(() => o.saveLighter({ network: 'testnet', accountIndex: null, apiKeyIndex: 2, privateKey: 'a'.repeat(80) })).toThrow();
    o.saveLighter({ network: 'testnet', accountIndex: 42, apiKeyIndex: 2, privateKey: 'a'.repeat(80) });
    expect(JSON.stringify(o.lighterConfig())).not.toContain('a'.repeat(80)); expect(JSON.stringify(s.get('lighterConfig'))).not.toContain('a'.repeat(80));
    expect(o.lighterConfig()?.executionEnabled).toBe(false); expect((await o.syncLighter()).status).toContain('NOT verified');
    o.deleteLighter(); expect(o.lighterConfig()).toBeNull();
  }, mock);
});