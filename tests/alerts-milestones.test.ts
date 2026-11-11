import { test, expect } from 'bun:test';
import { Store } from '../src/store';
import { DecisionJournal } from '../src/journal';
import { TelegramAlerter, type AlertGateStatus } from '../src/alerts';

const withEnv = async (run: () => Promise<void>) => {
  const savedToken = process.env.TELEGRAM_BOT_TOKEN, savedChat = process.env.TELEGRAM_CHAT_ID;
  process.env.TELEGRAM_BOT_TOKEN = '123456:ABCDEF-test-token';
  process.env.TELEGRAM_CHAT_ID = '99999999';
  try { await run(); } finally {
    if (savedToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = savedToken;
    if (savedChat === undefined) delete process.env.TELEGRAM_CHAT_ID; else process.env.TELEGRAM_CHAT_ID = savedChat;
  }
};

const gate = (graded: number, correct: number, eligible = false): AlertGateStatus => ({
  eligible, unlocked: false,
  stats: { graded, correct, hitRate: graded ? correct / graded : null, distinctDays: 3 },
});

test('gate milestones fire once at n>=100 and once at eligibility, then latch', async () => {
  await withEnv(async () => {
    const s = new Store(':memory:'), journal = new DecisionJournal(s);
    const sent: string[] = [];
    const fakeFetch = (async (_url: any, init: any) => { sent.push(JSON.parse(init.body).text); return new Response('{"ok":true}', { status: 200 }); }) as typeof fetch;
    let status = gate(99, 50);
    const alerter = new TelegramAlerter(s, journal, fakeFetch, {
      intervalMs: 60000,
      partners: { gateStatus: () => status },
    });
    await alerter.tick();
    expect(sent).toHaveLength(0);
    status = gate(101, 56);
    await alerter.tick();
    expect(sent.filter(t => t.includes('reached 101 graded'))).toHaveLength(1);
    expect(sent[0]).toContain('Sample count alone does not establish');
    expect(sent[0]).not.toContain('now statistically reliable');
    await alerter.tick(); // latched: no repeat
    expect(sent).toHaveLength(1);
    status = gate(120, 70, true);
    await alerter.tick();
    expect(sent.filter(t => t.includes('MILESTONE'))).toHaveLength(1);
    expect(s.get('alertMilestone:gate.n100')).toBe(true);
    expect(s.get('alertMilestone:gate.eligible')).toBe(true);
    s.db.close();
  });
});

test('a failed milestone send is retried on the next tick, not latched', async () => {
  await withEnv(async () => {
    const s = new Store(':memory:'), journal = new DecisionJournal(s);
    let failing = true;
    const sent: string[] = [];
    const fakeFetch = (async (_url: any, init: any) => {
      if (failing) return new Response('boom', { status: 500 });
      sent.push(JSON.parse(init.body).text);
      return new Response('{"ok":true}', { status: 200 });
    }) as typeof fetch;
    const alerter = new TelegramAlerter(s, journal, fakeFetch, {
      intervalMs: 60000,
      partners: { gateStatus: () => gate(120, 70, true) },
    });
    await alerter.tick();
    expect(sent).toHaveLength(0);
    expect(s.get('alertMilestone:gate.eligible')).toBeFalsy();
    failing = false;
    await alerter.tick();
    expect(sent.filter(t => t.includes('MILESTONE'))).toHaveLength(1);
    expect(s.get('alertMilestone:gate.eligible')).toBe(true);
    s.db.close();
  });
});

test('the daily digest sends once per UTC day at the configured hour', async () => {
  await withEnv(async () => {
    const s = new Store(':memory:'), journal = new DecisionJournal(s);
    const sent: string[] = [];
    const fakeFetch = (async (_url: any, init: any) => { sent.push(JSON.parse(init.body).text); return new Response('{"ok":true}', { status: 200 }); }) as typeof fetch;
    let now = Date.parse('2026-11-07T08:30:00Z'); // inside the digest hour
    const alerter = new TelegramAlerter(s, journal, fakeFetch, {
      intervalMs: 60000, digestHourUtc: 8, now: () => now,
      partners: { digestLines: () => ['Gate: 35/80 graded', 'Vault: all ok'] },
    });
    await alerter.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('daily digest');
    expect(sent[0]).toContain('2026-11-07');
    expect(sent[0]).toContain('Gate: 35/80 graded');
    await alerter.tick(); // same day: latched
    expect(sent).toHaveLength(1);
    now = Date.parse('2026-11-08T08:30:00Z');
    await alerter.tick();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('2026-11-08');
    now = Date.parse('2026-11-08T09:30:00Z'); // outside the digest hour: nothing
    await alerter.tick();
    expect(sent).toHaveLength(2);
    s.db.close();
  });
});

test('without partners, milestones and digest are simply skipped', async () => {
  await withEnv(async () => {
    const s = new Store(':memory:'), journal = new DecisionJournal(s);
    const sent: string[] = [];
    const fakeFetch = (async (_url: any, init: any) => { sent.push(JSON.parse(init.body).text); return new Response('{"ok":true}', { status: 200 }); }) as typeof fetch;
    const alerter = new TelegramAlerter(s, journal, fakeFetch, { intervalMs: 60000, now: () => Date.parse('2026-11-07T08:30:00Z') });
    const result = await alerter.tick();
    expect(result.sent).toBe(0);
    expect(sent).toHaveLength(0);
    s.db.close();
  });
});
