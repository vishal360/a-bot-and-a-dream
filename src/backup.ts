import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { Store } from './store';
import type { DecisionJournal } from './journal';

export type DbBackupOptions = {
  dbPath?: string;
  localDir?: string;
  driveDir?: string | null;
  keep?: number;
  intervalMs?: number;
  /** First snapshot runs this long after start() instead of waiting a full interval. */
  firstRunMs?: number;
  /** If NO successful backup exists this long after boot, raise a health alert once. */
  noSuccessAlertMs?: number;
  now?: () => number;
};

/** Durable off-machine backup of the evidence database (docs/DATA_ENGINE.md):
 *  `VACUUM INTO` produces a compacted, transactionally consistent snapshot of
 *  terminal.sqlite WITHOUT blocking the live writers for more than the moment the
 *  statement runs — the live database is never modified. Each snapshot lands locally
 *  (data/backups/db) and, when the Drive root exists, is copied to the mirror's
 *  drive folder; the newest `keep` (default 7) are kept in both places.
 *
 *  Quiet success, loud failure: a good backup only bumps status + an audit line;
 *  a failed backup journals `health-alert` so the Telegram alerter pushes it. The
 *  database contains no secrets (the Gemini key lives in .env, never in sqlite). */
export class DbBackup {
  private timer: ReturnType<typeof setInterval> | null = null;
  private firstTimer: ReturnType<typeof setTimeout> | null = null;
  private startedAt = 0;
  private noSuccessAlerted = false;
  private busy = false;
  private readonly dbPath: string;
  private readonly localDir: string;
  private readonly driveDir: string | null;
  private readonly keep: number;
  private readonly intervalMs: number;
  private readonly firstRunMs: number;
  private readonly noSuccessAlertMs: number;
  private readonly now: () => number;
  private lastRunAt: string | null = null;
  private lastResult: { ok: boolean; file?: string; error?: string } | null = null;
  private successCount = 0;

  constructor(private store: Store, private journal: DecisionJournal, options: DbBackupOptions = {}) {
    this.dbPath = options.dbPath ?? 'data/terminal.sqlite';
    this.localDir = options.localDir ?? 'data/backups/db';
    this.driveDir = options.driveDir === undefined ? 'G:/My Drive/ABAD-archive/db-backups' : options.driveDir;
    this.keep = options.keep ?? 7;
    this.intervalMs = options.intervalMs ?? 6 * 3600 * 1000;
    this.firstRunMs = options.firstRunMs ?? 5 * 60 * 1000;
    this.noSuccessAlertMs = options.noSuccessAlertMs ?? 12 * 3600 * 1000;
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(this.keep) || this.keep < 1 || this.keep > 60) throw new Error('Invalid backup keep count');
    if (!Number.isInteger(this.intervalMs) || this.intervalMs < 60000) throw new Error('Invalid backup interval');
    if (!Number.isInteger(this.firstRunMs) || this.firstRunMs < 1000) throw new Error('Invalid backup firstRunMs (min 1000ms)');
    if (!Number.isInteger(this.noSuccessAlertMs) || this.noSuccessAlertMs < 60000) throw new Error('Invalid noSuccessAlertMs (min 60s)');
  }

  start() {
    if (this.timer) return;
    this.startedAt = this.now();
    // The first snapshot must not wait a full interval: a crash in the first hours
    // would otherwise lose the day's evidence before the first backup ever ran.
    this.firstTimer = setTimeout(() => { this.run().catch(() => {}); }, this.firstRunMs);
    this.timer = setInterval(() => {
      try { this.checkNoSuccess(); } catch { /* the watchdog must never break the tick */ }
      this.run().catch(() => {});
    }, this.intervalMs);
  }
  stop() {
    if (this.timer) clearInterval(this.timer); this.timer = null;
    if (this.firstTimer) clearTimeout(this.firstTimer); this.firstTimer = null;
  }

  /** Raise ONE health-alert if the process has been up noSuccessAlertMs with zero
   *  successful backups — the Drive mount or the database path is probably wrong. */
  private checkNoSuccess() {
    if (this.successCount > 0 || this.noSuccessAlerted) return;
    if (this.now() - this.startedAt < this.noSuccessAlertMs) return;
    this.noSuccessAlerted = true;
    const message = `db-backup: no successful backup ${Math.round(this.noSuccessAlertMs / 3600000)}h after boot; check the Drive mount and the database path`;
    try {
      this.journal.record({
        time: new Date(this.now()).toISOString(), botId: 'system-health', strategyId: 'system-health', symbol: 'all',
        decision: 'health-alert', rationale: message.slice(0, 500),
        riskChecks: [{ check: 'db-backup', pass: false, detail: message.slice(0, 300) }],
      });
    } catch { /* journaling must never mask the watchdog */ }
    this.store.audit('DB_BACKUP_NEVER_RAN', message.slice(0, 300));
  }

  /** One snapshot. Never throws: failures are journaled + returned. */
  async run(): Promise<{ ok: boolean; file?: string; error?: string }> {
    if (this.busy) return { ok: false, error: 'backup already in flight' };
    this.busy = true;
    try {
      if (!existsSync(this.dbPath)) return this.fail(`database missing at ${this.dbPath}`);
      mkdirSync(this.localDir, { recursive: true });
      const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-');
      const file = join(this.localDir, `terminal-${stamp}.sqlite`);
      // VACUUM INTO from a read-only source connection: the live db is untouched,
      // and a corrupt source fails here instead of producing a bad snapshot.
      const source = new Database(this.dbPath, { readonly: true });
      try { source.run('VACUUM INTO ?', [file]); } finally { source.close(); }
      if (!existsSync(file) || statSync(file).size < 4096) return this.fail('snapshot missing or implausibly small after VACUUM INTO');
      if (this.driveDir) {
        try {
          // The drive path is configured, so a copy is REQUIRED: create it and copy.
          // A failure (Drive unmounted, permissions) is a loud failure, not silent local-only.
          mkdirSync(this.driveDir, { recursive: true });
          copyFileSync(file, join(this.driveDir, `terminal-${stamp}.sqlite`));
        } catch (error) {
          return this.fail(`local snapshot ok but Drive copy failed: ${(error as Error).message}`.slice(0, 400), file);
        }
      }
      this.prune(this.localDir);
      if (this.driveDir && existsSync(this.driveDir)) this.prune(this.driveDir);
      this.successCount++;
      this.lastRunAt = new Date(this.now()).toISOString();
      this.lastResult = { ok: true, file };
      this.store.audit('DB_BACKUP_OK', `snapshot ${file} (+ Drive copy)`);
      return this.lastResult;
    } catch (error) {
      return this.fail((error as Error).message);
    } finally { this.busy = false; }
  }

  private fail(message: string, file?: string): { ok: boolean; file?: string; error?: string } {
    this.lastRunAt = new Date(this.now()).toISOString();
    this.lastResult = { ok: false, error: message };
    try {
      this.journal.record({
        time: this.lastRunAt, botId: 'system-health', strategyId: 'system-health', symbol: 'all',
        decision: 'health-alert', rationale: `db-backup: ${message}`.slice(0, 500),
        riskChecks: [{ check: 'db-backup', pass: false, detail: message.slice(0, 300) }],
      });
    } catch { /* journaling must never mask the original failure */ }
    this.store.audit('DB_BACKUP_FAILURE', message.slice(0, 300));
    return file ? { ok: false, file, error: message } : { ok: false, error: message };
  }

  private prune(dir: string) {
    const files = readdirSync(dir).filter(f => /^terminal-\d{4}-\d{2}-\d{2}T.*\.sqlite$/.test(f)).sort();
    while (files.length > this.keep) unlinkSync(join(dir, files.shift()!));
  }

  status() {
    return {
      dbPath: this.dbPath, localDir: this.localDir, driveDir: this.driveDir, keep: this.keep,
      intervalMs: this.intervalMs, firstRunMs: this.firstRunMs, noSuccessAlertMs: this.noSuccessAlertMs,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      noSuccessAlerted: this.noSuccessAlerted,
      lastRunAt: this.lastRunAt, lastResult: this.lastResult, successCount: this.successCount,
    };
  }
}
