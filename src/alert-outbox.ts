import type { Store } from './store';
import type { DecisionJournal } from './journal';

export const CRITICAL_ALERT_KINDS = ['health-alert', 'bot-halt', 'guard-pause'] as const;
export const isCriticalAlert = (kind: string) => (CRITICAL_ALERT_KINDS as readonly string[]).includes(kind);
export type OutboxItem = {
  event_key: string; journal_id: number; text: string; attempts: number;
  next_attempt_at: number; last_error: string | null; delivered_at: number | null;
};

/** Durable Telegram delivery queue, not an operator incident acknowledgement system.
 * Delivery is at-least-once: a crash after Telegram accepts a message but before
 * delivered_at commits can cause a duplicate. Pending rows never expire or drop.
 * A new installation scans existing authoritative history in bounded batches;
 * ingestion and its cursor commit together, independently of channel configuration.
 */
export class AlertOutbox {
  constructor(private store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS alert_outbox_cursor (
      channel TEXT PRIMARY KEY, journal_id INTEGER NOT NULL);
      INSERT OR IGNORE INTO alert_outbox_cursor VALUES ('telegram-critical', 0);
      CREATE TABLE IF NOT EXISTS alert_outbox (
        event_key TEXT PRIMARY KEY, journal_id INTEGER NOT NULL UNIQUE, text TEXT NOT NULL,
        created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL, last_error TEXT, delivered_at INTEGER);
      CREATE INDEX IF NOT EXISTS alert_outbox_due ON alert_outbox (delivered_at, next_attempt_at, journal_id);`);
  }

  cursor(): number {
    return (this.store.db.query("SELECT journal_id FROM alert_outbox_cursor WHERE channel='telegram-critical'").get() as { journal_id: number }).journal_id;
  }

  ingest(journal: DecisionJournal, now: number, format: (entry: any) => string, batchSize = 200): number {
    // Read inside the write transaction: two alerters cannot regress the cursor.
    return this.store.db.transaction(() => {
      const entries = journal.historySinceId(this.cursor(), batchSize);
      for (const entry of entries) {
        if (!isCriticalAlert(entry.decision)) continue;
        this.store.db.query(`INSERT OR IGNORE INTO alert_outbox
          (event_key,journal_id,text,created_at,next_attempt_at) VALUES (?,?,?,?,?)`)
          .run(`telegram:decision:${entry.id}`, entry.id, format(entry), now, now);
      }
      if (entries.length) this.store.db.query("UPDATE alert_outbox_cursor SET journal_id=? WHERE channel='telegram-critical'").run(entries[entries.length - 1].id);
      return entries.length;
    }).immediate();
  }

  due(now: number, limit: number): OutboxItem[] {
    return this.store.db.query(`SELECT * FROM alert_outbox WHERE delivered_at IS NULL
      AND next_attempt_at<=? ORDER BY journal_id LIMIT ?`).all(now, limit) as OutboxItem[];
  }

  delivered(key: string, now: number) {
    this.store.db.query('UPDATE alert_outbox SET delivered_at=?, attempts=attempts+1, last_error=NULL WHERE event_key=? AND delivered_at IS NULL').run(now, key);
  }

  /** error must be channel-secret-free; the caller deliberately uses generic errors. */
  failed(item: OutboxItem, now: number, error: string, retryBaseMs: number, retryMaxMs: number) {
    const delay = Math.min(retryMaxMs, retryBaseMs * 2 ** Math.min(item.attempts, 30));
    this.store.db.query(`UPDATE alert_outbox SET attempts=attempts+1, next_attempt_at=?, last_error=?
      WHERE event_key=? AND delivered_at IS NULL`).run(now + delay, error, item.event_key);
  }

  status() {
    const counts = this.store.db.query(`SELECT COUNT(*) AS total,
      COALESCE(SUM(delivered_at IS NULL),0) AS pending,
      COALESCE(SUM(delivered_at IS NOT NULL),0) AS delivered,
      COALESCE(SUM(delivered_at IS NULL AND attempts>0),0) AS retrying,
      MIN(CASE WHEN delivered_at IS NULL THEN created_at END) AS oldestPendingAt,
      MIN(CASE WHEN delivered_at IS NULL THEN next_attempt_at END) AS nextAttemptAt
      FROM alert_outbox`).get() as { total: number; pending: number; delivered: number; retrying: number; oldestPendingAt: number | null; nextAttemptAt: number | null };
    const recentFailures = this.store.db.query(`SELECT event_key, attempts, next_attempt_at, last_error
      FROM alert_outbox WHERE delivered_at IS NULL AND last_error IS NOT NULL ORDER BY journal_id DESC LIMIT 3`).all();
    return { ...counts, cursor: this.cursor(), recentFailures, deliverySemantics: 'at-least-once',
      acknowledgement: 'Telegram delivery only; not operator acknowledgement', expiry: 'none' };
  }
}
