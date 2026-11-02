import { test, expect } from 'bun:test';
import { Store } from '../src/store';
import { DecisionJournal } from '../src/journal';
import { AgentRuntime, DEFAULT_AGENTS } from '../src/agent-runtime';
import { AgentPromotion, PROMOTION_THRESHOLDS, evaluatePromotion, UNLOCK_PHRASE } from '../src/agent-promotion';

let clock = Date.parse('2026-11-01T12:00:00Z');
const now = () => clock;
const tickClock = (ms: number) => { clock += ms; };

const context = (mark = 100, equity: number | null = 10000) => [
  { symbol: 'BTC', mark, fundingRate: 0.01, equity, time: new Date(now()).toISOString() },
];

const harness = (gemini: (agentIndex: number) => any, options: Record<string, unknown> = {}) => {
  const s = new Store(':memory:');
  const journal = new DecisionJournal(s);
  let call = 0;
  const fakeFetch = (async (url: any, init: any) => {
    const index = call++ % 3;
    const payload = gemini(index);
    if (payload instanceof Error) throw payload;
    if (init?.body) prompts.push(String(JSON.parse(init.body).contents[0].parts[0].text));
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] });
  }) as typeof fetch;
  const prompts: string[] = [];
  const runtime = new AgentRuntime(s, journal, () => context(), fakeFetch, { now, intervalMs: 60000, ...options });
  return { s, journal, runtime, prompts, close: () => s.db.close() };
};

const contract = (direction: any = 'long', confidence = 0.8) => ({
  direction, confidence, horizonSeconds: 900, rationale: 'test edge',
});

const gradeEnsembleOutcome = (journal: DecisionJournal, grade: string, day: string) => {
  journal.record({
    time: `${day}T12:00:00.000Z`, botId: 'agent-ensemble', strategyId: 'agent-llm', symbol: 'BTC',
    decision: 'agent-outcome', rationale: 'graded',
    inputs: { markAt: 100, markAtExpiry: 101, direction: 'long', confidence: 0.8, agents: 'agent-ensemble', grade },
  });
};

test('the promotion gate fails closed on an empty or weak record', () => {
  const s = new Store(':memory:'), journal = new DecisionJournal(s);
  const evaluation = evaluatePromotion(journal);
  expect(evaluation.eligible).toBe(false);
  expect(evaluation.shortfalls).toHaveLength(3);
  expect(evaluation.stats.graded).toBe(0);
  expect(evaluation.stats.hitRate).toBeNull();
  // 54 correct of 100 over 3 days: hit rate below the 55% floor.
  for (let i = 0; i < 54; i++) gradeEnsembleOutcome(journal, 'correct', '2026-11-01');
  for (let i = 0; i < 46; i++) gradeEnsembleOutcome(journal, 'wrong', i < 23 ? '2026-11-01' : i < 46 ? '2026-11-02' : '2026-11-03');
  const weak = evaluatePromotion(journal);
  expect(weak.eligible).toBe(false);
  expect(weak.shortfalls.some(f => f.includes('hit rate'))).toBe(true);
  s.db.close();
});

test('an eligible record (>=100 graded, >=55%, >=3 days) passes the gate', () => {
  const s = new Store(':memory:'), journal = new DecisionJournal(s);
  for (let i = 0; i < 60; i++) gradeEnsembleOutcome(journal, 'correct', i < 20 ? '2026-11-01' : i < 40 ? '2026-11-02' : '2026-11-03');
  for (let i = 0; i < 40; i++) gradeEnsembleOutcome(journal, 'wrong', i < 14 ? '2026-11-01' : i < 27 ? '2026-11-02' : '2026-11-03');
  const evaluation = evaluatePromotion(journal);
  expect(evaluation.eligible).toBe(true);
  expect(evaluation.stats.hitRate).toBeCloseTo(0.6, 10);
  expect(evaluation.stats.distinctDays).toBe(3);
  // Flat outcomes count in the denominator and never as correct.
  gradeEnsembleOutcome(journal, 'flat', '2026-11-03');
  expect(evaluatePromotion(journal).stats.hitRate).toBeCloseTo(60 / 101, 10);
  s.db.close();
});

test('unlock requires the exact phrase and an eligible record; allocation is clamped to policy', () => {
  const s = new Store(':memory:'), journal = new DecisionJournal(s);
  const promotion = new AgentPromotion(s, journal);
  expect(() => promotion.unlock({ confirm: 'yes' })).toThrow(UNLOCK_PHRASE);
  expect(() => promotion.unlock({ confirm: UNLOCK_PHRASE })).toThrow(/does not meet the thresholds/);
  for (let i = 0; i < 60; i++) gradeEnsembleOutcome(journal, 'correct', i < 20 ? '2026-11-01' : i < 40 ? '2026-11-02' : '2026-11-03');
  for (let i = 0; i < 40; i++) gradeEnsembleOutcome(journal, 'wrong', i < 14 ? '2026-11-01' : i < 27 ? '2026-11-02' : '2026-11-03');
  expect(() => promotion.unlock({ confirm: UNLOCK_PHRASE, allocationPct: 5 })).toThrow(/between 1 and 2/);
  const status = promotion.unlock({ confirm: UNLOCK_PHRASE });
  expect(status.unlocked).toBe(true);
  expect(status.allocationPct).toBe(2);
  expect(s.get('agentExecEnabled')).toBe(true);
  expect(s.get('agentAllocationPct')).toBe(2);
  // A smaller allocation is allowed; larger is not.
  promotion.lock();
  expect(promotion.unlock({ confirm: UNLOCK_PHRASE, allocationPct: 1 }).allocationPct).toBe(1);
  promotion.lock();
  expect(promotion.status().unlocked).toBe(false);
  s.db.close();
});

test('restart discipline: session-only shadow clears, persisted shadow stays, execution always re-locks', () => {
  const s = new Store(':memory:'), journal = new DecisionJournal(s);
  s.set('agentEnabled', true); s.set('agentShadowPersist', false);
  s.set('agentExecEnabled', true);
  void new AgentRuntime(s, journal, () => context(), (async () => new Response('{}')) as any, { now });
  expect(s.get('agentEnabled')).toBe(false);
  expect(s.get('agentExecEnabled')).toBe(false);
  s.db.close();

  const s2 = new Store(':memory:'), journal2 = new DecisionJournal(s2);
  s2.set('agentEnabled', true); s2.set('agentShadowPersist', true);
  s2.set('agentExecEnabled', true);
  void new AgentRuntime(s2, journal2, () => context(), (async () => new Response('{}')) as any, { now });
  expect(s2.get('agentEnabled')).toBe(true); // the operator opted into persistence
  expect(s2.get('agentExecEnabled')).toBe(false); // execution never persists
  s2.db.close();
});

test('a promoted ensemble places ONE paper order per quorum, sized by the envelope', async () => {
  const executed: any[] = [];
  const { runtime, journal, close } = harness(() => contract('long', 0.8), {
    execute: async (order: any) => { executed.push(order); },
  });
  try {
    const s = (runtime as any).store as Store;
    s.set('agentEnabled', true);
    s.set('agentExecEnabled', true);
    s.set('agentAllocationPct', 2);
    await runtime.tick();
    expect(executed).toHaveLength(1);
    expect(executed[0].side).toBe('buy');
    expect(executed[0].quantity).toBeCloseTo(2, 4); // 2% of 10000 at mark 100
    expect(executed[0].agentId).toBe('agent-ensemble');
    const orders = journal.list({ botId: 'agent-ensemble', limit: 50 }).filter(e => e.decision === 'agent-order');
    expect(orders).toHaveLength(1);
    expect(orders[0].side).toBe('buy');
    // A second tick with the opinion still open does not pyramid.
    tickClock(60000);
    await runtime.tick();
    expect(executed).toHaveLength(1);
  } finally { close(); }
});

test('execution failures journal honestly and never crash the tick', async () => {
  const { runtime, journal, close } = harness(() => contract('short', 0.7), {
    execute: async () => { throw new Error('agent allocation is 0%'); },
  });
  try {
    const s = (runtime as any).store as Store;
    s.set('agentEnabled', true); s.set('agentExecEnabled', true); s.set('agentAllocationPct', 2);
    const result = await runtime.tick();
    expect(result.proposals).toBe(3);
    const rejects = journal.list({ botId: 'agent-ensemble', limit: 50 }).filter(e => e.decision === 'agent-reject');
    expect(rejects.some(e => e.rationale.includes('agent allocation is 0%'))).toBe(true);
  } finally { close(); }
});

test('no executor wired: the gate can unlock but a quorum journals an honest rejection', async () => {
  const { runtime, journal, close } = harness(() => contract('long', 0.9));
  try {
    const s = (runtime as any).store as Store;
    s.set('agentEnabled', true); s.set('agentExecEnabled', true); s.set('agentAllocationPct', 2);
    await runtime.tick();
    const rejects = journal.list({ botId: 'agent-ensemble', limit: 50 }).filter(e => e.decision === 'agent-reject');
    expect(rejects.some(e => e.rationale.includes('no executor'))).toBe(true);
  } finally { close(); }
});

test('journal-as-memory: a persona prompt carries its own graded history', async () => {
  const { runtime, journal, prompts, close } = harness(() => contract('long', 0.8));
  try {
    const persona = DEFAULT_AGENTS[0].agentId;
    journal.record({
      time: new Date(now()).toISOString(), botId: persona, strategyId: 'agent-llm', symbol: 'BTC',
      decision: 'agent-outcome', rationale: 'graded',
      inputs: { markAt: 100, markAtExpiry: 100.5, direction: 'long', confidence: 0.8, grade: 'correct' },
    });
    journal.record({
      time: new Date(now()).toISOString(), botId: persona, strategyId: 'agent-llm', symbol: 'BTC',
      decision: 'agent-outcome', rationale: 'graded',
      inputs: { markAt: 100, markAtExpiry: 99.5, direction: 'short', confidence: 0.7, grade: 'wrong' },
    });
    const s = (runtime as any).store as Store;
    s.set('agentEnabled', true);
    await runtime.tick();
    // The momentum persona (DEFAULT_AGENTS[0]) has graded history; its prompt must carry it.
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain('Your recent graded outcomes');
    expect(prompts[0]).toContain('LONG CORRECT');
    expect(prompts[0]).toContain('SHORT WRONG');
    // Personas without history get no block.
    expect(prompts[1]).not.toContain('Your recent graded outcomes');
    expect(prompts[2]).not.toContain('Your recent graded outcomes');
  } finally { close(); }
});

test('a persona with no history gets no memory block (memory is never invented)', async () => {
  const { runtime, prompts, close } = harness(() => contract('flat', 0.5));
  try {
    const s = (runtime as any).store as Store;
    s.set('agentEnabled', true);
    await runtime.tick();
    expect(prompts.every(p => !p.includes('Your recent graded outcomes'))).toBe(true);
  } finally { close(); }
});

test('thresholds are the operator-approved policy, immutable by accident', () => {
  expect(PROMOTION_THRESHOLDS).toEqual({ minGraded: 100, minHitRate: 0.55, minDays: 3, maxAllocationPct: 2 });
});
