import { test, expect } from 'bun:test';
import { Store } from '../src/store';
import { DecisionJournal } from '../src/journal';
import { AgentPromotion, UNLOCK_PHRASE, evaluatePromotion, loadGateStats, recordGateOutcome } from '../src/agent-promotion';

const gradeInto = (j: DecisionJournal, day: string, grade: string) => j.record({
  time: `${day}T12:00:00Z`, botId: 'agent-ensemble', strategyId: 'agent-llm', symbol: 'BTC',
  decision: 'agent-outcome', rationale: 'x',
  inputs: { markAt: 100, markAtExpiry: grade === 'correct' ? 101 : 99, direction: 'long', confidence: 0.8, grade },
});

test('gate memory seeds once from durable history, then accumulates independently', () => {
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
  // Re-open from persisted state and grade a day long since evicted from display.
  const restartedJournal = new DecisionJournal(s);
  recordGateOutcome(s, '2026-11-05', false, -1);
  recordGateOutcome(s, '2026-11-05', true, 1);
  const revisited = loadGateStats(s, restartedJournal);
  expect(revisited.graded).toBe(104);
  expect(revisited.distinctDays).toBe(102);
  expect(Object.keys((s.get('agentGateStats') as any).byDay)).toHaveLength(90);
});

test('legacy byDay counts outweigh the surviving journal and migrate without invented moves', () => {
  for (const recordFirst of [false, true]) {
    const s = new Store(':memory:'), j = new DecisionJournal(s);
    gradeInto(j, '2026-11-05', 'wrong');
    s.set('agentGateStats', { byDay: {
      '2026-11-01': { graded: 1200, correct: 800 },
      '2026-11-02': { graded: 100, correct: 80 },
      '2026-11-03': { graded: 100, correct: 80 },
    } });
    if (recordFirst) recordGateOutcome(s, '2026-11-04', true, 3);
    const stats = loadGateStats(s, j);
    expect(stats.graded).toBe(1400 + Number(recordFirst));
    expect(stats.correct).toBe(960 + Number(recordFirst));
    expect(stats.distinctDays).toBe(3 + Number(recordFirst));
    expect(stats.meanSignedMovePct).toBeNull();
    expect(evaluatePromotion(j, undefined, s).eligible).toBe(true);
    recordGateOutcome(s, '2026-11-05', true, 4);
    expect(loadGateStats(s, j).meanSignedMovePct).toBeNull();
  }
});

test('old lifetime migration conservatively avoids recounting unidentifiable pruned days', () => {
  const s = new Store(':memory:'), j = new DecisionJournal(s);
  s.set('agentGateStats', { lifetime: { graded: 100, correct: 60, days: 100, sumMovePct: 5,
    firstDay: '2026-01-01', lastDay: '2026-04-10' }, byDay: { '2026-04-10': { graded: 1, correct: 1 } } });
  recordGateOutcome(s, '2026-01-02', true, 1);
  recordGateOutcome(s, '2026-01-02', true, 1);
  expect(loadGateStats(s, j).distinctDays).toBe(100);
  recordGateOutcome(s, '2026-04-11', true, 1);
  expect(loadGateStats(s, j).distinctDays).toBe(101);
});

test('absent memory seeds every durable history page even after ring eviction', () => {
  const s = new Store(':memory:'), j = new DecisionJournal(s, 100, null);
  for (let i = 0; i < 1105; i++) gradeInto(j, '2026-11-05', 'correct');
  expect(j.list({ limit: 1000 })).toHaveLength(100);
  expect(loadGateStats(s, j).graded).toBe(1105);
  expect(loadGateStats(s, j).meanSignedMovePct).toBe(1);
});

test('missing move evidence stays unknown rather than becoming a zero move', () => {
  const s = new Store(':memory:'), j = new DecisionJournal(s);
  recordGateOutcome(s, '2026-11-05', true);
  recordGateOutcome(s, '2026-11-06', true, 2);
  expect(loadGateStats(s, j).meanSignedMovePct).toBeNull();
});

test('malformed stored stats fail closed, are not reseeded and cannot unlock paper', () => {
  const life = { graded: 100, correct: 60, days: 3, sumMovePct: 1, firstDay: '2026-11-01', lastDay: '2026-11-03' };
  const byDay = { '2026-11-01': { graded: 30, correct: 20 }, '2026-11-02': { graded: 30, correct: 20 }, '2026-11-03': { graded: 40, correct: 20 } };
  const malformed = [null, [], {}, { byDay: null }, { byDay: { '2026-11-01': { graded: '100', correct: 100 } } },
    ...[{ graded: '100' }, { graded: -1 }, { graded: 100.5 }, { graded: Number.MAX_SAFE_INTEGER + 1 },
      { correct: 101 }, { days: 101 }, { days: '3' }, { sumMovePct: '100' }, { firstDay: '2026-02-30' }]
      .map(change => ({ lifetime: { ...life, ...change }, byDay })),
    { lifetime: life, byDay, seenDays: ['2026-11-01'] },
    { lifetime: life, byDay, seenDays: ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-03'] },
  ];
  for (const raw of malformed) {
    const s = new Store(':memory:'), j = new DecisionJournal(s);
    s.set('agentGateStats', raw);
    gradeInto(j, '2026-11-05', 'correct');
    const result = evaluatePromotion(j, undefined, s);
    expect(result.eligible).toBe(false);
    expect(result.shortfalls.join(' ')).toContain('malformed');
    expect(result.statistics.meanSignedMovePct).toBeNull();
    expect(s.get('agentGateStats')).toEqual(raw);
    expect(() => recordGateOutcome(s, '2026-11-06', true, 1)).toThrow();
    expect(() => new AgentPromotion(s, j).unlock({ confirm: UNLOCK_PHRASE })).toThrow('Promotion gate refuses');
    expect(s.get('agentExecEnabled')).not.toBe(true);
  }
});

test('non-JSON stored evidence also blocks eligibility without replacement', () => {
  const s = new Store(':memory:'), j = new DecisionJournal(s);
  s.db.query('INSERT INTO state VALUES (?,?)').run('agentGateStats', '{broken');
  const evaluation = evaluatePromotion(j, undefined, s);
  expect(evaluation.eligible).toBe(false);
  expect(evaluation.shortfalls.join(' ')).toContain('malformed');
  expect(() => recordGateOutcome(s, '2026-11-06', true, 1)).toThrow();
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
