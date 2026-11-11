import type { Store } from './store';
import type { DecisionJournal } from './journal';
import { AlertOutbox, isCriticalAlert } from './alert-outbox';

/** The promotion-gate snapshot the alerter needs for milestone detection. */
export type AlertGateStatus = {
  eligible: boolean;
  unlocked: boolean;
  stats: { graded: number; correct: number; hitRate: number | null; distinctDays: number };
};
/** Optional integrations the alerter reads from the server (milestones + digest). */
export type AlerterPartners = {
  gateStatus?: () => AlertGateStatus;
  digestLines?: () => string[];
};

export type TelegramAlerterOptions = {
  intervalMs?: number;
  kinds?: string[];
  rejectStreakAlert?: number;
  maxPerTick?: number;
  /** UTC hour (0-23) at which the daily digest is sent. */
  digestHourUtc?: number;
  now?: () => number;
  partners?: AlerterPartners;
  /** Critical history ingestion is bounded per tick, including while unconfigured. */
  ingestBatchSize?: number;
  sendTimeoutMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
};

const DEFAULT_KINDS = ['agent-outcome', 'agent-order', 'health-alert', 'guard-pause', 'guard-resume', 'bot-pause', 'bot-halt'];

/** Telegram alerting (docs/AGENT_SETUP.md): pushes noteworthy journal events to the
 *  operator's phone — graded agent outcomes, feed-guard transitions, bot pauses, the
 *  daily-cap wall, and a "persona may be dark" warning when one analyst rejects
 *  repeatedly (the exact failure that silently killed two personas for two days).
 *
 *  Critical events use a durable, at-least-once SQLite outbox fed by authoritative
 *  history, even without credentials. Pending deliveries never expire. Informational
 *  events retain their current-head, best-effort cursor and flood dropping semantics.
 *  Delivery acknowledgement is NOT operator acknowledgement of an incident. */
export class TelegramAlerter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private cursor: number;
  private sent = 0;
  private failures: string[] = [];
  private busy = false;
  private rejectStreak = new Map<string, number>();
  private readonly kinds: string[];
  private readonly intervalMs: number;
  private readonly rejectStreakAlert: number;
  private readonly maxPerTick: number;
  private readonly digestHourUtc: number;
  private readonly now: () => number;
  private readonly partners: AlerterPartners | undefined;
  private lastDigestDay: string | null = null;
  private readonly outbox: AlertOutbox;
  private readonly ingestBatchSize: number;
  private readonly sendTimeoutMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;

  constructor(
    private store: Store,
    private journal: DecisionJournal,
    private fetcher: typeof fetch,
    private options: TelegramAlerterOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 20000;
    this.kinds = options.kinds ?? DEFAULT_KINDS;
    this.rejectStreakAlert = options.rejectStreakAlert ?? 5;
    this.maxPerTick = options.maxPerTick ?? 20;
    this.digestHourUtc = options.digestHourUtc ?? 8;
    this.now = options.now ?? Date.now;
    this.partners = options.partners;
    if (!Number.isInteger(this.intervalMs) || this.intervalMs < 5000) throw new Error('Invalid alert interval');
    if (!Number.isInteger(this.rejectStreakAlert) || this.rejectStreakAlert < 1) throw new Error('Invalid rejectStreakAlert');
    if (!Number.isInteger(this.digestHourUtc) || this.digestHourUtc < 0 || this.digestHourUtc > 23) throw new Error('Invalid digestHourUtc');
    this.ingestBatchSize = options.ingestBatchSize ?? 200;
    this.sendTimeoutMs = options.sendTimeoutMs ?? 10000;
    this.retryBaseMs = options.retryBaseMs ?? 20000;
    this.retryMaxMs = options.retryMaxMs ?? 3600000;
    if (!Number.isInteger(this.maxPerTick) || this.maxPerTick < 1 || this.maxPerTick > 1000) throw new Error('Invalid maxPerTick');
    if (!Number.isInteger(this.ingestBatchSize) || this.ingestBatchSize < 1 || this.ingestBatchSize > 1000) throw new Error('Invalid ingestBatchSize');
    for (const value of [this.sendTimeoutMs, this.retryBaseMs, this.retryMaxMs]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new Error('Invalid alert timeout/backoff');
    }
    if (this.retryMaxMs < this.retryBaseMs) throw new Error('Invalid alert retry range');
    this.outbox = new AlertOutbox(store);
    this.cursor = this.journal.lastId();
  }

  private token(): string | null { const v = process.env.TELEGRAM_BOT_TOKEN; return typeof v === 'string' && v.trim().length > 20 ? v.trim() : null; }
  private chatId(): string | null { const v = process.env.TELEGRAM_CHAT_ID; return typeof v === 'string' && v.trim().length > 3 ? v.trim() : null; }
  configured(): boolean { return !!(this.token() && this.chatId()); }

  start() { if (this.timer) return; this.timer = setInterval(() => { this.tick().catch(() => {}); }, this.intervalMs); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  status() {
    return {
      configured: this.configured(), sent: this.sent, cursor: this.cursor, kinds: this.kinds,
      rejectStreakAlert: this.rejectStreakAlert, failures: this.failures.slice(-3),
      digestHourUtc: this.digestHourUtc, lastDigestDay: this.lastDigestDay,
      outbox: this.outbox.status(),
    };
  }

  /** Send a test message regardless of the cursor (the operator's wiring check). */
  async test(): Promise<{ ok: boolean; error?: string }> {
    if (!this.configured()) return { ok: false, error: 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing in .env' };
    try {
      await this.send('ABAD test alert — Telegram wiring works.');
      this.store.audit('TELEGRAM_TEST', 'Test alert sent');
      return { ok: true };
    } catch (error) {
      const message = `test failed: ${(error as Error).message}`;
      this.failures.push(message);
      return { ok: false, error: message };
    }
  }

  async tick(): Promise<{ sent: number; skipped?: string }> {
    if (this.busy) return { sent: 0, skipped: 'tick already in flight' };
    this.busy = true;
    try {
      this.outbox.ingest(this.journal, this.now(), e => this.eventText(e), this.ingestBatchSize);
      if (!this.configured()) return { sent: 0, skipped: 'not configured' };
      let sent = 0;
      // Reserve the delivery budget for critical items before best-effort traffic.
      const critical = this.outbox.due(this.now(), this.maxPerTick);
      for (const item of critical) {
        try {
          await this.send(item.text);
          this.outbox.delivered(item.event_key, this.now());
          sent++;
          this.sent++;
        } catch (error) {
          const message = (error as Error).message;
          this.outbox.failed(item, this.now(), message, this.retryBaseMs, this.retryMaxMs);
          this.recordFailure(message);
        }
      }
      // Attempts, not just successful sends, consume the bounded per-tick budget.
      let attempts = critical.length;
      const entries = this.journal.listSinceId(this.cursor, 200);
      for (const e of entries) {
        this.cursor = e.id;
        if (isCriticalAlert(e.decision)) continue; // only the durable queue delivers these
        if (attempts >= this.maxPerTick) continue; // only informational overflow is dropped
        if (e.decision === 'agent-proposal') this.rejectStreak.set(e.bot_id, 0);
        const allow = this.kinds.includes(e.decision);
        const capHit = e.decision === 'skip' && (e.rationale ?? '').includes('cap reached');
        const isReject = e.decision === 'agent-reject' && e.bot_id.startsWith('agent-');
        if (!allow && !capHit && !isReject) continue;
        let text: string;
        if (isReject) {
          const streak = (this.rejectStreak.get(e.bot_id) ?? 0) + 1;
          this.rejectStreak.set(e.bot_id, streak);
          if (streak % this.rejectStreakAlert !== 0) continue;
          text = `[ABAD] ${e.bot_id} may be dark: ${streak} consecutive rejected proposals. Last: ${(e.rationale ?? '').slice(0, 200)}`;
        } else {
          if (e.decision === 'agent-proposal') this.rejectStreak.set(e.bot_id, 0);
          text = this.eventText(e);
        }
        attempts++;
        try {
          await this.send(text);
          sent++;
          this.sent++;
        } catch (error) {
          this.failures.push(`send failed: ${(error as Error).message}`);
          while (this.failures.length > 10) this.failures.shift();
          this.store.audit('TELEGRAM_ALERT_FAILURE', (error as Error).message);
        }
      }
      await this.checkMilestones();
      await this.checkDigest();
      return { sent };
    } finally { this.busy = false; }
  }

  /** Promotion-gate milestones: fire ONCE when the ensemble record first crosses
   *  100 graded outcomes (sample-count milestone only) and once when every
   *  threshold is met. Latched in the store; a failed send is retried next tick. */
  private async checkMilestones() {
    if (!this.partners?.gateStatus) return;
    const g = this.partners.gateStatus();
    const hit = g.stats.hitRate === null ? 'n/a' : `${(g.stats.hitRate * 100).toFixed(1)}%`;
    const milestones: { key: string; fired: boolean; text: string }[] = [
      {
        key: 'gate.n100', fired: g.stats.graded >= 100,
        text: `[ABAD] Milestone: the ensemble record reached ${g.stats.graded} graded outcomes (hit rate ${hit}). Sample count alone does not establish calibrated confidence, independent outcomes or profitable trading.`,
      },
      {
        key: 'gate.eligible', fired: g.eligible === true,
        text: `[ABAD] MILESTONE: the ensemble's shadow record now meets every promotion threshold (${g.stats.correct}/${g.stats.graded}, hit ${hit}, ${g.stats.distinctDays} day(s)). Unlocking is the operator's call on the Agents tab; journal-only until then.`,
      },
    ];
    for (const m of milestones) {
      if (!m.fired || this.store.get(`alertMilestone:${m.key}`)) continue;
      try {
        await this.send(m.text);
        this.store.set(`alertMilestone:${m.key}`, true);
        this.store.audit('TELEGRAM_MILESTONE', m.key);
      } catch (error) {
        this.failures.push(`milestone ${m.key}: ${(error as Error).message}`);
        while (this.failures.length > 10) this.failures.shift();
        // not latched: the next tick retries until the message lands
      }
    }
  }

  /** One digest per UTC day at digestHourUtc: gate progress, vault health, backup
   *  status, AI budget. Composed by the server via digestLines so the alerter
   *  itself stays storage-agnostic. */
  private async checkDigest() {
    if (!this.partners?.digestLines) return;
    const nowMs = this.now();
    const day = new Date(nowMs).toISOString().slice(0, 10);
    if (new Date(nowMs).getUTCHours() !== this.digestHourUtc) return;
    if (this.lastDigestDay === day || this.store.get(`alertDigest:${day}`)) return;
    const lines = this.partners.digestLines();
    if (!lines.length) return;
    try {
      await this.send(`[ABAD] daily digest — ${day}\n\n${lines.map(l => `• ${l}`).join('\n')}`);
      this.lastDigestDay = day;
      this.store.set(`alertDigest:${day}`, true);
      this.store.audit('TELEGRAM_DIGEST', day);
    } catch (error) {
      this.failures.push(`digest: ${(error as Error).message}`);
      while (this.failures.length > 10) this.failures.shift();
    }
  }

  private eventText(e: any): string {
    let text = `[ABAD] ${e.decision} · ${e.bot_id} · ${e.symbol}: ${(e.rationale ?? '').slice(0, 220)}`;
    // Queue contains event content only, never channel configuration or token URLs.
    text = text.replace(/https?:\/\/api\.telegram\.org\/bot[^\s]+/gi, '[redacted Telegram URL]');
    for (const secret of [this.token(), this.chatId()]) if (secret) text = text.split(secret).join('[redacted]');
    return text;
  }

  private recordFailure(message: string) {
    this.failures.push(`send failed: ${message}`);
    while (this.failures.length > 10) this.failures.shift();
    this.store.audit('TELEGRAM_ALERT_FAILURE', message);
  }

  private async send(text: string) {
    const token = this.token(), chat = this.chatId();
    if (!token || !chat) throw new Error('Telegram not configured');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const request = async () => {
      let response: Response;
      try {
        response = await this.fetcher(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST', signal: controller.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chat, text }),
        });
      } catch {
        // Fetch exceptions often include the request URL (and therefore bot token).
        throw new Error('Telegram transport failed');
      }
      if (!response.ok) throw new Error(`Telegram HTTP ${response.status}`);
      let payload: any;
      try { payload = await response.json(); } catch { throw new Error('Telegram invalid response'); }
      if (payload?.ok !== true) throw new Error('Telegram API rejected message');
    };
    try {
      await Promise.race([request(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Telegram request timed out'));
        }, this.sendTimeoutMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
}
