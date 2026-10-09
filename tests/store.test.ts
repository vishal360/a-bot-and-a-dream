import { test, expect } from 'bun:test';
import { Store } from '../src/store';
import { backtest, defaultConfig, syntheticBars } from '../src/domain';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('fleet includes futures and crypto; unknown controls fail closed', () => {
  const s = new Store(':memory:');
  expect(s.get('bots').map((b: any) => b.asset)).toEqual(['futures', 'crypto']);
  expect(() => s.command('unknown', 'start')).toThrow(); expect(() => s.command('atlas', 'live')).toThrow(); s.db.close();
});
test('halt survives reopen and reset never resumes automatically', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-test-')), path = join(dir, 'state.sqlite');
  try {
    let s = new Store(path); s.command('atlas', 'start'); s.halt(); s.db.close();
    s = new Store(path); expect(s.get('halted')).toBe(true); expect(() => s.command('orion', 'start')).toThrow();
    expect(s.get('bots').every((b: any) => b.status === 'halted')).toBe(true);
    s.reset(); expect(s.get('bots').every((b: any) => b.status === 'paused')).toBe(true); s.command('orion', 'start'); expect(s.get('bots')[1].status).toBe('running'); s.db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('registration is immutable, idempotent and always paper-only', () => {
  const s = new Store(':memory:'); const r = backtest(syntheticBars('crypto'), { ...defaultConfig, asset: 'crypto' }, 'synthetic');
  const id = s.saveRun(r), hash = s.promote(id); expect(hash).toHaveLength(64); expect(s.promote(id)).toBe(hash);
  expect(s.snapshot().strategies).toHaveLength(1); expect((s.snapshot().strategies[0] as any).status).toBe('paper-only / unvalidated');
  expect(() => s.promote('missing')).toThrow(); expect(s.get('bots').every((b: any) => b.status === 'paused')).toBe(true); s.db.close();
});