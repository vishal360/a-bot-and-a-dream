import { test, expect } from 'bun:test';
import { Store } from '../src/store';
import { DecisionJournal } from '../src/journal';
import { evaluatePromotion, loadGateStats, recordGateOutcome } from '../src/agent-promotion';

const gradeInto = (j: DecisionJournal, day: string, grade: string) => j.record({
  time: `${day}T12:00:00Z`, botId: 'agent-ensemble', strategyId: 'agent-llm', symbol: 'BTC',
  decision: 'agent-outcome', rationale: 'x',
  inputs: { markAt: 100, markAtExpiry: grade === 'correct' ? 101 : 99, direction: 'long', confidence: 0.8, grade },
});

test('gate memory seeds once from the journal window, then accumulates independently', () => {
  const s = new Store(':memory:'), j = new DecisionJournal(s);
  gradeInto(j, '2026-11-05', 'correct'); gradeInto(j, '2026-11-05', 'wrong'); gradeInto(j, '2026-11-06', 'correct');
  const first = evaluatePromotion(j, undefined, s); // seeds lifetime + rolling from journal
  expect(first.stats.graded).toBe(3);
  expect(first.stats.correct).toBe(2);
  expect(first.stats.distinctDays).toBe(2);
  const seeded = s.get('agentGateStats') as any;
  // Signed moves: correct(+1), wrong(-1), correct(+1) -> sum +1
  expect(seeded.lifetime).toEqual({ graded: 3, correct: 2, days: 2, sumMovePct: 1, firstDay: '2026-11-05', lastDay: '2026-11-06' });
  // New outcomes via recordGateOutcome extend the lifetime without re-seeding.
  recordGateOutcome(s, '2026-11-07', true, 1.5);
  const after = evaluatePromotion(j, undefined, s);
  expect(after.stats.graded).toBe(4);
  expect(after.stats.correct).toBe(3);
  expect(after.stats.distinctDays).toBe(3);
  expect(after.stats.meanSignedMovePct).toBeCloseTo(0.625, 10);
  // Idempotent: evaluation never double-counts.
  expect(evaluatePromotion(j, undefined, s).stats.graded).toBe(4);
});

test('gate memory survives full journal rolloff AND its own 90-day rolling prune', () => {
  const s = new Store(':memory:'), j = new DecisionJournal(s);
  gradeInto(j, '2026-11-05', 'correct'); gradeInto(j, '2026-11-06', 'wrong');
  evaluatePromotion(j, undefined, s); // seed
  // Simulate the bounded journal rolling everything out.
  s.db.run('DELETE FROM decision_journal');
  // 100 further days arrive via direct recording: the rolling window prunes to 90,
  // but the LIFETIME accumulator keeps every graded outcome and every distinct day.
  for (let i = 0; i < 100; i++) {
    const day = new Date(Date.parse('2027-01-01T00:00:00Z') + i * 86400000).toISOString().slice(0, 10);
    recordGateOutcome(s, day, i % 2 === 0, 0.25);
  }
  const stats = evaluatePromotion(j, undefined, s).stats;
  expect(stats.graded).toBe(102);        // 2 seeded + 100 recorded: nothing lost
  expect(stats.distinctDays).toBe(102);  // lifetime distinct days, not the 90-day window
  expect(stats.window.first).toBe('2026-11-05'); // lifetime first day, not the pruned window
  const stored = s.get('agentGateStats') as any;
  expect(Object.keys(stored.byDay)).toHaveLength(90); // rolling window still bounded
});

test('the gate statistics report the fair-coin binomial p-value and the honesty note', () => {
  const s = new Store(':memory:'), j = new DecisionJournal(s);
  for (let i = 0; i < 55; i++) gradeInto(j, '2026-11-05', i < 30 ? 'correct' : 'wrong');
  const evaluation = evaluatePromotion(j, undefined, s);
  expect(evaluation.statistics.binomialPValueUnderFairCoin).toBeGreaterThan(0.1);
  expect(evaluation.statistics.binomialPValueUnderFairCoin).toBeLessThan(0.4); // 30/55 fair-coin: ~0.29
  expect(evaluation.statistics.note).toContain('not live evidence');
  // A perfect record must produce a tiny p-value (the statistic is not decoration).
  const s2 = new Store(':memory:'), j2 = new DecisionJournal(s2);
  for (let i = 0; i < 100; i++) gradeInto(j2, '2026-11-05', 'correct');
  expect(evaluatePromotion(j2, undefined, s2).statistics.binomialPValueUnderFairCoin).toBeLessThan(1e-15);
});
