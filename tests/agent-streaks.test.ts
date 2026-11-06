import { test, expect } from 'bun:test';
import { Store } from '../src/store';
import { DecisionJournal } from '../src/journal';
import { AgentRuntime } from '../src/agent-runtime';

let clock = Date.parse('2026-11-07T12:00:00Z');
const now = () => clock;
const tickClock = (ms: number) => { clock += ms; };
const context = (mark = 100, equity: number | null = 10000) => [{ symbol: 'BTC', mark, fundingRate: 0.01, equity, time: new Date(now()).toISOString() }];

test('reject streaks increment, persist, surface as dark, and reset on success', async () => {
  const s = new Store(':memory:');
  const journal = new DecisionJournal(s);
  // Custom roster so the failing persona's ENTIRE model chain (m-b and m-b2) can be
  // broken by the fake fetch â€” a chain with one healthy model never rejects.
  const agents = [
    { agentId: 'agent-test-a', model: 'm-a', persona: 'a' },
    { agentId: 'agent-test-skeptic', model: 'm-b', fallbackModels: ['m-b2'], persona: 'b' },
    { agentId: 'agent-test-c', model: 'm-c', persona: 'c' },
  ];
  let failSkeptic = true;
  const fakeFetch = (async (url: any) => {
    if (failSkeptic && String(url).includes('m-b')) throw new Error('model HTTP 503');
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ direction: 'flat', confidence: 0.5, horizonSeconds: 900, rationale: 'r' }) }] } }] });
  }) as any;
  const runtime = new AgentRuntime(s, journal, context, fakeFetch, { now, intervalMs: 60000, agents });
  s.set('agentEnabled', true);
  for (let i = 0; i < 5; i++) { await runtime.tick(); tickClock(60000); }
  const skeptic = 'agent-test-skeptic';
  expect((s.get('agentPersonaStreaks') ?? {})[skeptic]).toBe(5);
  expect(runtime.status().darkPersonas[skeptic]).toBe(5);
  // A new runtime on the same store sees the persisted streak (restart survival).
  const runtime2 = new AgentRuntime(s, journal, context, fakeFetch, { now, intervalMs: 60000, agents });
  expect(runtime2.status().darkPersonas[skeptic]).toBe(5);
  // The restart cleared the session latch (by design): re-enable, then recover.
  failSkeptic = false;
  s.set('agentEnabled', true);
  await runtime2.tick();
  expect((s.get('agentPersonaStreaks') ?? {})[skeptic]).toBe(0);
  expect(runtime2.status().darkPersonas[skeptic]).toBeUndefined();
  s.db.close();
});

test('the alerter is not needed for streaks: the runtime tracks them independently', async () => {
  const s = new Store(':memory:');
  const journal = new DecisionJournal(s);
  const agents = [
    { agentId: 'agent-test-a', model: 'm-a', persona: 'a' },
    { agentId: 'agent-test-b', model: 'm-b', fallbackModels: ['m-b2'], persona: 'b' },
    { agentId: 'agent-test-c', model: 'm-c', persona: 'c' },
  ];
  const fakeFetch = (async (url: any) => {
    if (String(url).includes('m-b')) throw new Error('model HTTP 503');
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ direction: 'flat', confidence: 0.5, horizonSeconds: 900, rationale: 'r' }) }] } }] });
  }) as any;
  const runtime = new AgentRuntime(s, journal, context, fakeFetch, { now, intervalMs: 60000, agents });
  s.set('agentEnabled', true);
  await runtime.tick();
  const rejects = journal.list({ limit: 50 }).filter(e => e.decision === 'agent-reject' && e.bot_id === 'agent-test-b');
  expect(rejects).toHaveLength(1);
  expect(rejects[0].rationale).toContain('model HTTP 503');
  s.db.close();
});
