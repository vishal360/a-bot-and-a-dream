import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store';
import { DecisionJournal } from '../src/journal';
import { TelegramAlerter, type TelegramAlerterOptions } from '../src/alerts';
import { AlertOutbox } from '../src/alert-outbox';

const TOKEN = '123456:ABCDEF-test-token', CHAT = '99999999';
async function configured(run: () => Promise<void>) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  process.env.TELEGRAM_BOT_TOKEN = TOKEN; process.env.TELEGRAM_CHAT_ID = CHAT;
  try { await run(); } finally {
    if (token === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = token;
    if (chat === undefined) delete process.env.TELEGRAM_CHAT_ID; else process.env.TELEGRAM_CHAT_ID = chat;
  }
}
const record = (journal: DecisionJournal, decision: 'health-alert' | 'bot-halt' | 'guard-pause' | 'agent-outcome' = 'health-alert', rationale = 'critical') =>
  journal.record({ time: '2026-11-10T12:00:00Z', botId: 'test-bot', strategyId: 'test-strategy', symbol: 'BTC', decision, rationale });
const fake = (sent: string[]) => (async (_url: any, init: any) => {
  sent.push(JSON.parse(init.body).text); return new Response('{"ok":true}');
}) as typeof fetch;
const alerter = (s: Store, j: DecisionJournal, fetcher: typeof fetch, options: TelegramAlerterOptions = {}) =>
  new TelegramAlerter(s, j, fetcher, { intervalMs: 60000, ...options });

test('critical ingestion runs without credentials; later configuration delivers pending exactly once', async () => configured(async () => {
  const s = new Store(':memory:'), j = new DecisionJournal(s, 100, null), sent: string[] = [];
  try {
    delete process.env.TELEGRAM_BOT_TOKEN; delete process.env.TELEGRAM_CHAT_ID;
    const a = alerter(s, j, fake(sent));
    record(j); record(j, 'bot-halt'); record(j, 'guard-pause');
    expect((await a.tick()).skipped).toBe('not configured');
    expect(a.status().outbox.pending).toBe(3);
    expect(a.status().outbox.cursor).toBe(3);
    process.env.TELEGRAM_BOT_TOKEN = TOKEN; process.env.TELEGRAM_CHAT_ID = CHAT;
    expect((await a.tick()).sent).toBe(3);
    expect((await a.tick()).sent).toBe(0);
    expect(a.status().outbox.delivered).toBe(3);
    expect(a.status().outbox.pending).toBe(0);
    expect(sent).toHaveLength(3);
  } finally { s.db.close(); }
}));

test('restart persists ingestion, delivery ack and exponential retry schedule on disk', async () => configured(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abad-outbox-')), path = join(dir, 'state.sqlite');
  let s = new Store(path), now = 1000;
  try {
    let j = new DecisionJournal(s, 100, null);
    record(j, 'bot-halt');
    let a = alerter(s, j, (async () => { throw new Error(`fetch https://api.telegram.org/bot${TOKEN}/sendMessage ${CHAT}`); }) as unknown as typeof fetch,
      { now: () => now, retryBaseMs: 100, retryMaxMs: 1000 });
    await a.tick();
    expect(a.status().outbox.retrying).toBe(1);
    expect(a.status().outbox.nextAttemptAt).toBe(1100);
    const serialized = JSON.stringify(a.status()) + JSON.stringify(s.snapshot().audit);
    expect(serialized).not.toContain(TOKEN); expect(serialized).not.toContain(CHAT);
    s.db.close(); s = new Store(path); j = new DecisionJournal(s, 100, null);
    let calls = 0;
    a = alerter(s, j, (async () => { calls++; return new Response('{"ok":false,"description":"secret details"}'); }) as unknown as typeof fetch,
      { now: () => now, retryBaseMs: 100, retryMaxMs: 1000 });
    await a.tick(); expect(calls).toBe(0);
    now = 1100; await a.tick(); expect(calls).toBe(1);
    expect(a.status().outbox.nextAttemptAt).toBe(1300);
    expect((s.db.query('SELECT attempts FROM alert_outbox').get() as any).attempts).toBe(2);
    s.db.close(); s = new Store(path); j = new DecisionJournal(s, 100, null);
    const sent: string[] = [];
    a = alerter(s, j, fake(sent), { now: () => now });
    now = 1300; await a.tick(); expect(sent).toHaveLength(1);
    s.db.close(); s = new Store(path); j = new DecisionJournal(s, 100, null);
    a = alerter(s, j, fake(sent), { now: () => now });
    await a.tick(); expect(sent).toHaveLength(1);
    expect(a.status().outbox.delivered).toBe(1);
  } finally { s.db.close(); rmSync(dir, { recursive: true, force: true }); }
}));

test('initial historical scan and post-installation ring eviction recover bounded batches from history', async () => configured(async () => {
  const s = new Store(':memory:'), j = new DecisionJournal(s, 100, null), sent: string[] = [];
  try {
    record(j, 'health-alert', 'old critical');
    for (let i = 0; i < 120; i++) record(j, 'agent-outcome', `noise ${i}`);
    expect(j.listSinceId(0, 1000).some(e => e.rationale === 'old critical')).toBe(false);
    let a = alerter(s, j, fake(sent), { ingestBatchSize: 25 });
    await a.tick(); expect(sent).toHaveLength(1); expect(a.status().outbox.cursor).toBe(25);
    // Restart from a partially ingested initial history, then evict another new critical event.
    record(j, 'guard-pause', 'new evicted critical');
    for (let i = 0; i < 120; i++) record(j, 'agent-outcome');
    a = alerter(s, j, fake(sent), { ingestBatchSize: 25 });
    for (let i = 0; i < 10; i++) await a.tick();
    expect(sent.filter(t => t.includes('old critical'))).toHaveLength(1);
    expect(sent.filter(t => t.includes('new evicted critical'))).toHaveLength(1);
    expect(a.status().outbox.cursor).toBe(j.lastId());
    expect(a.status().outbox.delivered).toBe(2);
  } finally { s.db.close(); }
}));

test('critical flood is prioritized over information and never dropped by maxPerTick or kinds', async () => configured(async () => {
  const s = new Store(':memory:'), j = new DecisionJournal(s, 100, null), sent: string[] = [];
  try {
    const a = alerter(s, j, fake(sent), { maxPerTick: 2, kinds: ['agent-outcome'] });
    for (let i = 0; i < 10; i++) record(j, 'agent-outcome', 'informational');
    for (let i = 0; i < 7; i++) record(j, 'health-alert', `urgent ${i}`);
    expect((await a.tick()).sent).toBe(2);
    expect(sent.every(t => t.includes('urgent'))).toBe(true);
    expect(a.status().outbox.pending).toBe(5);
    for (let i = 0; i < 3; i++) await a.tick();
    expect(sent).toHaveLength(7);
    expect(new Set(sent).size).toBe(7);
    expect(a.status().outbox.pending).toBe(0);
  } finally { s.db.close(); }
}));

test('HTTP 200 ok:false is failed, no ack; successful subsequent retry acknowledges', async () => configured(async () => {
  const s = new Store(':memory:'), j = new DecisionJournal(s, 100, null);
  let now = 0, good = false;
  try {
    const a = alerter(s, j, (async () => new Response(JSON.stringify({ ok: good, description: TOKEN }))) as unknown as typeof fetch,
      { now: () => now, retryBaseMs: 100 });
    record(j); expect((await a.tick()).sent).toBe(0);
    expect(a.status().outbox.retrying).toBe(1);
    expect(JSON.stringify(a.status())).not.toContain(TOKEN);
    expect((await a.test()).ok).toBe(false);
    good = true; now = 100;
    expect((await a.tick()).sent).toBe(1);
    expect(a.status().outbox.delivered).toBe(1);
  } finally { s.db.close(); }
}));

test('transport timeout bounds tick even when fake transport ignores abort', async () => configured(async () => {
  const s = new Store(':memory:'), j = new DecisionJournal(s, 100, null);
  try {
    const a = alerter(s, j, (() => new Promise(() => {})) as unknown as typeof fetch, { sendTimeoutMs: 5 });
    record(j); expect((await a.tick()).sent).toBe(0);
    expect(a.status().outbox.retrying).toBe(1);
    expect(JSON.stringify(a.status())).toContain('timed out');
  } finally { s.db.close(); }
}));

test('enqueue and cursor advance roll back together; repeated scan deduplicates event keys', () => {
  const s = new Store(':memory:'), j = new DecisionJournal(s, 100, null), queue = new AlertOutbox(s);
  try {
    record(j); record(j, 'bot-halt');
    let calls = 0;
    expect(() => queue.ingest(j, 0, () => { if (++calls === 2) throw new Error('format failed'); return 'text'; })).toThrow('format failed');
    expect(queue.cursor()).toBe(0); expect(queue.status().total).toBe(0);
    queue.ingest(j, 0, () => 'text');
    // Simulate a replayed scan (e.g. recovery tooling): event identity is stable.
    s.db.exec("UPDATE alert_outbox_cursor SET journal_id=0 WHERE channel='telegram-critical'");
    queue.ingest(j, 0, () => 'text');
    expect(queue.status().total).toBe(2); expect(queue.cursor()).toBe(2);
    expect(queue.status().deliverySemantics).toBe('at-least-once');
    expect(queue.status().acknowledgement).toContain('not operator');
  } finally { s.db.close(); }
});

test('send accepted before acknowledgement failure remains pending and may duplicate on retry', async () => configured(async () => {
  const s = new Store(':memory:'), j = new DecisionJournal(s, 100, null), sent: string[] = [];
  let now = 0;
  try {
    const a = alerter(s, j, fake(sent), { now: () => now, retryBaseMs: 100 });
    record(j);
    s.db.exec(`CREATE TRIGGER prevent_delivery_ack BEFORE UPDATE OF delivered_at ON alert_outbox
      WHEN NEW.delivered_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'simulated ack failure'); END;`);
    await a.tick();
    expect(sent).toHaveLength(1); expect(a.status().outbox.pending).toBe(1);
    s.db.exec('DROP TRIGGER prevent_delivery_ack');
    now = 100; await a.tick();
    expect(sent).toHaveLength(2); expect(sent[0]).toBe(sent[1]);
    expect(a.status().outbox.delivered).toBe(1);
  } finally { s.db.close(); }
}));

test('event content does not persist configured channel secrets or Telegram token URLs', async () => configured(async () => {
  const s = new Store(':memory:'), j = new DecisionJournal(s, 100, null);
  try {
    const a = alerter(s, j, fake([]));
    record(j, 'health-alert', `failure https://api.telegram.org/bot${TOKEN}/sendMessage token ${TOKEN} chat ${CHAT}`);
    await a.tick();
    const stored = JSON.stringify(s.db.query('SELECT * FROM alert_outbox').all());
    expect(stored).not.toContain(TOKEN); expect(stored).not.toContain(CHAT);
    expect(stored).toContain('[redacted');
  } finally { s.db.close(); }
}));
