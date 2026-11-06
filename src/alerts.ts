import type { Store } from './store';
import type { DecisionJournal } from './journal';

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
};

const DEFAULT_KINDS = ['agent-outcome', 'agent-order', 'health-alert', 'guard-pause', 'guard-resume', 'bot-pause', 'bot-halt'];

/** Telegram alerting (docs/AGENT_SETUP.md): pushes noteworthy journal events to the
 *  operator's phone — graded agent outcomes, feed-guard transitions, bot pauses, the
 *  daily-cap wall, and a "persona may be dark" warning when one analyst rejects
 *  repeatedly (the exact failure that silently killed two personas for two days).
 *
 *  Fail-closed and polite: without TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID in .env the
 *  alerter is idle; send failures never crash anything (audited, surfaced in status);
 *  the cursor starts at the CURRENT journal head so history is never replayed; a flood
 *  drops the overflow quietly instead of spamming. */
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
    if (!this.configured()) return { sent: 0, skipped: 'not configured' };
    this.busy = true;
    try {
      const entries = this.journal.listSinceId(this.cursor, 200);
      let sent = 0;
      for (const e of entries) {
        this.cursor = e.id;
        if (sent >= this.maxPerTick) continue; // flood protection: drop the overflow quietly
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
          text = `[ABAD] ${e.decision} · ${e.bot_id} · ${e.symbol}: ${(e.rationale ?? '').slice(0, 220)}`;
        }
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
   *  100 graded outcomes (calibration becomes reliable) and once when every
   *  threshold is met. Latched in the store; a failed send is retried next tick. */
  private async checkMilestones() {
    if (!this.partners?.gateStatus) return;
    const g = this.partners.gateStatus();
    const hit = g.stats.hitRate === null ? 'n/a' : `${(g.stats.hitRate * 100).toFixed(1)}%`;
    const milestones: { key: string; fired: boolean; text: string }[] = [
      {
        key: 'gate.n100', fired: g.stats.graded >= 100,
        text: `[ABAD] Milestone: the ensemble record reached ${g.stats.graded} graded outcomes (hit rate ${hit}). Conformal calibration widths are now statistically reliable.`,
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

  private async send(text: string) {
    const token = this.token()!, chat = this.chatId()!;
    const response = await this.fetcher(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text }),
    });
    if (!response.ok) throw new Error(`Telegram HTTP ${response.status}: ${(await response.text()).slice(0, 120)}`);
  }
}
