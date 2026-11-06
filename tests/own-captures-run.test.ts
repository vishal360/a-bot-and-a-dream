import { test, expect } from 'bun:test';

test('the own-capture grader reports INSUFFICIENT honestly on a thin archive (no verifier needed)', async () => {
  const { mkdirSync, writeFileSync, readdirSync, unlinkSync, existsSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { execSync } = await import('node:child_process');
  const root = join(tmpdir(), `abad-owncaps-${Math.random().toString(36).slice(2, 8)}`);
  const archive = join(root, 'archive');
  const T0 = Date.parse('2026-11-01T00:00:00Z');
  const dayDir = join(archive, '2026-11-01');
  mkdirSync(dayDir, { recursive: true });
  // Only 5 bars: far below the 300-bar honesty floor.
  const frames = Array.from({ length: 5 }, (_, m) => ({ clock: { wall: T0 + m * 60000 }, raw: JSON.stringify({ channel: 'market_stats:1', market_stats: { mid_price: '100' } }) }));
  writeFileSync(join(dayDir, '1793-thin.json'), JSON.stringify({ manifest: { markets: [{ symbol: 'BTC', market_id: 1 }], startedMs: T0 }, frames }));
  const verdicts = join(process.cwd(), 'research', 'verdicts');
  const before = existsSync(verdicts) ? readdirSync(verdicts).filter(f => f.includes('own-captures')).length : 0;
  let exit = 0, stdout = '';
  try {
    stdout = execSync('bun run scripts/research-own-captures.ts --archive ' + JSON.stringify(archive) + ' --market BTC --from 2026-11-01 --to 2026-11-01', { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e: any) { exit = e.status ?? 1; stdout = String(e.stdout ?? ''); }
  try {
    expect(exit).toBe(1);
    expect(stdout).toContain('INSUFFICIENT');
    expect(stdout).toContain('5');
    // Exactly one new verdict artifact landed (the INSUFFICIENT report).
    const after = readdirSync(verdicts).filter(f => f.includes('own-captures'));
    expect(after).toHaveLength(before + 1);
    const report = JSON.parse(await import('node:fs').then(fs => fs.readFileSync(join(verdicts, after.find(f => !f.includes('train')) ?? after[0]), 'utf8')));
    expect(report.verdict.overall).toBe('INSUFFICIENT');
    expect(report.canPromote).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    if (existsSync(verdicts)) for (const f of readdirSync(verdicts).filter(f => f.includes('own-captures'))) { try { unlinkSync(join(verdicts, f)); } catch { /* may be held */ } }
  }
});
