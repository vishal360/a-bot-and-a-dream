import { test, expect } from 'bun:test';
import { Store } from '../src/store';
import { DecisionJournal } from '../src/journal';
import { TelegramAlerter } from '../src/alerts';

const harness = (options: Record<string, unknown> = {}) => {
  const s = new Store(':memory:');
  const journal = new DecisionJournal(s);
  const sent: { url: string; body: any }[] = [];
  const fakeFetch = (async (url: any, init: any) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response('{"ok":true}', { status: 200 });
  }) as typeof fetch;
  const alerter = new TelegramAlerter(s, journal, fakeFetch, { intervalMs: 60000, ...options });
  const record = (kind: string, botId: string, rationale = 'event') =>
    journal.record({ time: new Date().toISOString(), botId, strategyId: 'agent-llm', symbol: 'BTC', decision: kind as any, rationale });
  return { s, journal, alerter, sent, record, close: () => s.db.close() };
};

const withEnv = async (run: () => Promise<void>) => {
  const savedToken = process.env.TELEGRAM_BOT_TOKEN, savedChat = process.env.TELEGRAM_CHAT_ID;
  process.env.TELEGRAM_BOT_TOKEN = '123456:ABCDEF-test-token';
  process.env.TELEGRAM_CHAT_ID = '99999999';
  try { await run(); } finally {
    if (savedToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = savedToken;
    if (savedChat === undefined) delete process.env.TELEGRAM_CHAT_ID; else process.env.TELEGRAM_CHAT_ID = savedChat;
  }
};

test('alerting is fail-closed without configuration: nothing is sent, nothing crashes', async () => {
  await withEnv(async () => {
    delete process.env.TELEGRAM_BOT_TOKEN; delete process.env.TELEGRAM_CHAT_ID;
    const { journal, alerter, sent, record, close } = harness();
    try {
      record('agent-outcome', 'agent-gemini-flow', 'graded');
      const result = await alerter.tick();
      expect(result.skipped).toBe('not configured');
      expect(sent).toHaveLength(0);
      expect(alerter.status().configured).toBe(false);
    } finally { close(); }
  });
});

test('the cursor sends each matching event once and skips the noise', async () => {
  await withEnv(async () => {
    const { journal, alerter, sent, record, close } = harness();
    try {
      record('agent-outcome', 'agent-gemini-flow', 'direction correct');                              // allowlisted
      record('skip', 'agent-ensemble', 'ensemble: no 2-of-3 agreement on a direction');               // noise
      record('skip', 'agent-ensemble', 'daily model request cap reached (500/500)');                  // cap wall: sent
      record('agent-reject', 'agent-gemini-momentum', 'model HTTP 503');                              // streak 1 < 5
      const result = await alerter.tick();
      expect(result.sent).toBe(2);
      expect(sent).toHaveLength(2);
      expect(sent[0].body.text).toContain('direction correct');
      expect(sent[1].body.text).toContain('cap reached');
      expect((await alerter.tick()).sent).toBe(0); // cursor advanced: no replay
    } finally { close(); }
  });
});

test('a persona rejecting repeatedly raises one dark-persona alert, reset by a success', async () => {
  await withEnv(async () => {
    const { alerter, sent, record, close } = harness();
    try {
      for (let i = 0; i < 5; i++) record('agent-reject', 'agent-gemini-momentum', 'model HTTP 503');
      await alerter.tick();
      expect(sent.filter(s => s.body.text.includes('may be dark'))).toHaveLength(1);
      record('agent-proposal', 'agent-gemini-momentum', 'recovered'); // success resets the streak
      await alerter.tick();
      expect(sent.filter(s => s.body.text.includes('may be dark'))).toHaveLength(1); // no repeat
    } finally { close(); }
  });
});

test('the test endpoint sends regardless of the cursor', async () => {
  await withEnv(async () => {
    const { alerter, sent, close } = harness();
    try {
      expect((await alerter.test()).ok).toBe(true);
      expect(sent).toHaveLength(1);
    } finally { close(); }
  });
});

test('journal cursor helpers: lastId and listSinceId are exact and bounded', () => {
  const s = new Store(':memory:'), journal = new DecisionJournal(s);
  expect(journal.lastId()).toBe(0);
  const entry = (i: number) => ({ time: new Date().toISOString(), botId: 'agent-gemini-flow', strategyId: 'agent-llm', symbol: 'BTC', decision: 'agent-proposal' as const, rationale: `e${i}` });
  journal.record(entry(1)); journal.record(entry(2)); journal.record(entry(3));
  expect(journal.lastId()).toBe(3);
  expect(journal.listSinceId(0, 10).map(r => r.rationale)).toEqual(['e1', 'e2', 'e3']);
  expect(journal.listSinceId(1, 10).map(r => r.rationale)).toEqual(['e2', 'e3']);
  expect(journal.listSinceId(1, 1).map(r => r.rationale)).toEqual(['e2']);
  expect(() => journal.listSinceId(-1, 10)).toThrow('cursor');
  expect(() => journal.listSinceId(0, 0)).toThrow('limit');
});
