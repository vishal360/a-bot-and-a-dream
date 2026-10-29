import { test, expect } from 'bun:test';
import { Store } from '../src/store';
import { DecisionJournal } from '../src/journal';
import { AgentRuntime, DEFAULT_AGENTS, extractProposalJson } from '../src/agent-runtime';
import { buildProposal, proposalExpired, validateProposalFields, validateStoredProposal } from '../src/agent-contract';
import { ensembleDirection } from '../src/agent-ensemble';

let clock = Date.parse('2026-10-30T12:00:00Z');
const now = () => clock;
const tickClock = (ms: number) => { clock += ms; };

const context = (mark = 100) => [{ symbol: 'BTC', mark, fundingRate: 0.01, equity: 10000, time: new Date(now()).toISOString() }];
const harness = (gemini: (agentIndex: number) => any, options: Record<string, unknown> = {}) => {
  const s = new Store(':memory:');
  const journal = new DecisionJournal(s);
  let call = 0;
  const fakeFetch = (async (url: any) => {
    const index = call++ % 3;
    const payload = gemini(index);
    if (payload instanceof Error) throw payload;
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] });
  }) as typeof fetch;
  const runtime = new AgentRuntime(s, journal, () => context(), fakeFetch, { now, intervalMs: 60000, ...options });
  return { s, journal, runtime, close: () => s.db.close() };
};

const contract = () => ({
  direction: 'long' as const, confidence: 0.8, horizonSeconds: 900, rationale: 'test edge',
});

test('proposal contracts fail closed and own their own expiry', () => {
  expect(validateProposalFields(contract())).toEqual({ direction: 'long', confidence: 0.8, horizonSeconds: 900, rationale: 'test edge' });
  expect(() => validateProposalFields({ ...contract(), direction: 'up' })).toThrow('direction');
  expect(() => validateProposalFields({ ...contract(), confidence: 1.5 })).toThrow('confidence');
  expect(() => validateProposalFields({ ...contract(), horizonSeconds: 10 })).toThrow('horizonSeconds');
  expect(() => validateProposalFields({ ...contract(), rationale: '' })).toThrow('rationale');
  const p = buildProposal(contract(), { id: 'prop-00000001', agentId: 'agent-gemini-momentum', symbol: 'BTC' }, now());
  expect(p.expiresAt).toBe(new Date(now() + 900000).toISOString()); // derived, not model-supplied
  expect(proposalExpired(p, now() + 900000)).toBe(true);
  expect(proposalExpired(p, now() + 899999)).toBe(false);
  expect(() => buildProposal(contract(), { id: 'prop-00000001', agentId: 'BAD', symbol: 'BTC' }, now())).toThrow('agent id');
  expect(() => validateStoredProposal({ ...p, version: 2 })).toThrow('version');
  expect(validateStoredProposal(p).symbol).toBe('BTC');
});

test('ensemble: 2-of-3 agreement passes, flats and disagreements starve the quorum', () => {
  const mk = (agentId: string, direction: any, confidence: number) => buildProposal({ direction, confidence, horizonSeconds: 900, rationale: 'r' }, { id: `prop-${agentId}-xxxx`, agentId, symbol: 'BTC' }, now());
  const three = [mk('agent-aaa', 'long', 0.9), mk('agent-bbb', 'long', 0.6), mk('agent-ccc', 'short', 0.7)];
  const result = ensembleDirection(three);
  expect(result!.direction).toBe('long');
  expect(result!.confidence).toBeCloseTo(0.75, 10);
  expect(result!.agreeing).toEqual(['agent-aaa', 'agent-bbb']);
  expect(result!.dissenting).toEqual(['agent-ccc']);
  expect(ensembleDirection([mk('agent-aaa', 'long', 0.9), mk('agent-bbb', 'short', 0.6), mk('agent-ccc', 'flat', 0.5)])).toBeNull();
  expect(ensembleDirection([mk('agent-aaa', 'flat', 0.9), mk('agent-bbb', 'flat', 0.6), mk('agent-ccc', 'long', 0.7)])).toBeNull();
});

test('shadow runtime: disabled by default, enable phrase required, valid proposals journaled + ensembled', async () => {
  const { s, journal, runtime, close } = harness(() => contract());
  try {
    expect((await runtime.tick()).reason).toContain('disabled');
    expect(() => runtime.enable({ confirm: 'yes' })).toThrow('ENABLE AGENT SHADOW');
    runtime.enable({ confirm: 'ENABLE AGENT SHADOW' });
    const result = await runtime.tick();
    expect(result.ran).toBe(true);
    expect(result.proposals).toBe(3);
    expect(result.shadowsOpened).toBe(1); // 3/3 agree on long
    const decisions = journal.list({ botId: 'agent-ensemble', limit: 10 }).map((r: any) => r.decision);
    expect(decisions).toContain('agent-proposal');
    expect(s.get('agentShadowPending')).toHaveLength(1);
    expect(runtime.status().requests.used).toBe(3);
    expect(runtime.status().enabled).toBe(true);
  } finally { close(); }
});

test('malformed model output is journaled as a rejection, never guessed into a proposal', async () => {
  const { journal, runtime, close } = harness((i) => i === 0 ? 'not json at all' : contract());
  try {
    runtime.enable({ confirm: 'ENABLE AGENT SHADOW' });
    const result = await runtime.tick();
    expect(result.rejections).toBe(1);
    expect(result.proposals).toBe(2);
    const rejects = journal.list({ botId: DEFAULT_AGENTS[0].agentId, limit: 5 });
    expect(rejects.some((r: any) => r.decision === 'agent-reject' && r.rationale.includes('rejected'))).toBe(true);
  } finally { close(); }
});

test('shadows expire into journaled outcomes graded against the real mark', async () => {
  let mark = 100;
  const { journal, runtime, close } = harness(() => contract(), { });
  (runtime as any).context = () => context(mark);
  try {
    runtime.enable({ confirm: 'ENABLE AGENT SHADOW' });
    await runtime.tick(); // opens a long shadow with markAt = 100, expires in 900s
    tickClock(901000); mark = 103; // horizon passed; price went up: long was correct
    const result = await runtime.tick();
    expect(result.shadowsClosed).toBe(1);
    const outcomes = journal.list({ botId: 'agent-ensemble', limit: 10 }).filter((r: any) => r.decision === 'agent-outcome');
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].rationale).toContain('direction correct');
  } finally { close(); }
});

test('daily request cap stops model calls and is journaled exactly once', async () => {
  const { journal, runtime, close } = harness(() => contract(), { dailyRequestCap: 3 });
  try {
    runtime.enable({ confirm: 'ENABLE AGENT SHADOW' });
    await runtime.tick(); // uses exactly 3 requests
    const used = runtime.status().requests.used;
    expect(used).toBe(3);
    await runtime.tick();
    expect(runtime.status().requests.used).toBe(3); // no further calls
    const caps = journal.list({ botId: 'agent-ensemble', limit: 10 }).filter((r: any) => r.rationale?.includes('cap reached'));
    expect(caps).toHaveLength(1); // journaled once, not per tick
  } finally { close(); }
});

test('missing API key degrades to idle agents', async () => {
  const s = new Store(':memory:');
  const journal = new DecisionJournal(s);
  const runtime = new AgentRuntime(s, journal, () => context(), (async () => { throw new Error('should not be called'); }) as unknown as typeof fetch, { now });
  try {
    runtime.enable({ confirm: 'ENABLE AGENT SHADOW' });
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const result = await runtime.tick();
      expect(result.reason).toContain('GEMINI_API_KEY missing');
    } finally { if (saved !== undefined) process.env.GEMINI_API_KEY = saved; }
  } finally { s.db.close(); }
});

test('extractProposalJson strips fences and fails closed on junk', () => {
  const good = extractProposalJson('```json\n{"direction":"short","confidence":0.4,"horizonSeconds":600,"rationale":"ok"}\n```');
  expect(good.direction).toBe('short');
  expect(() => extractProposalJson('I think the market will go up')).toThrow('no JSON');
  expect(() => extractProposalJson('{"direction":"sideways"}')).toThrow('direction');
});
