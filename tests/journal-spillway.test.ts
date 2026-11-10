import { test, expect } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store';
import { DecisionJournal } from '../src/journal';

const entry = (i: number) => ({ time: '2026-11-07T12:00:00Z', botId: 'agent-gemini-flow', strategyId: 'agent-llm', symbol: 'BTC', decision: 'agent-proposal' as const, rationale: `e${i}` });

test('evicted journal rows spill append-only into the archive before leaving the ring', () => {
  const dir = join(tmpdir(), `abad-spill-${Math.random().toString(36).slice(2, 8)}`);
  const s = new Store(':memory:'), journal = new DecisionJournal(s, 100, dir);
  try {
    for (let i = 0; i < 120; i++) journal.record(entry(i));
    // 20 rows left the 100-row ring: they must ALL be in the archive, in order.
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const lines = readFileSync(join(dir, files[0]), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(lines).toHaveLength(20);
    expect(lines[0].rationale).toBe('e0');
    expect(lines[19].rationale).toBe('e19');
    // The ring itself holds the newest 100.
    expect(journal.list({ limit: 1000 }).map(r => r.rationale)).not.toContain('e0');
    expect(journal.archiveStatus().failures).toBe(0);
  } finally {
    for (const f of readdirSync(dir)) existsSync(join(dir, f)); // files cleaned by tmpdir semantics
  }
});

test('a spill failure never breaks recording (fail-safe, counted, surfaced)', () => {
  const dir = join(tmpdir(), `abad-spill-fail-${Math.random().toString(36).slice(2, 8)}`);
  const s = new Store(':memory:'), journal = new DecisionJournal(s, 100, dir);
  try {
    // Occupy the archive path with a FILE so mkdir/append fail.
    require('node:fs').writeFileSync(dir, 'not a directory');
    for (let i = 0; i < 120; i++) journal.record(entry(i));
    expect(journal.archiveStatus().failures).toBeGreaterThan(0);
    expect(journal.archiveStatus().lastError).toBeTruthy();
    // Recording itself is unaffected: the ring is full and correct.
    expect(journal.list({ limit: 1000 })).toHaveLength(100);
  } finally { require('node:fs').rmSync(dir, { force: true }); }
});

test('archiveDir: null disables the spillway (bounded ring only)', () => {
  const s = new Store(':memory:'), journal = new DecisionJournal(s, 100, null);
  for (let i = 0; i < 110; i++) journal.record(entry(i));
  expect(journal.archiveStatus().dir).toBeNull();
  expect(journal.list({ limit: 1000 })).toHaveLength(100);
});
