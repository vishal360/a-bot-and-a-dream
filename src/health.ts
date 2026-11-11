import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from './store';
import type { DecisionJournal } from './journal';

export type HealthCheckResult = {
  check: string; state: 'ok' | 'alert' | 'unavailable';
  detail: string; alertedAt: string | null; cooldownUntil: string | null;
};

export type HealthMonitorOptions = {
  intervalMs?: number;
  archiveRoot?: string;
  mirrorLogPath?: string;
  driveRoot?: string;
  diskFreeFloorBytes?: number;
  captureStallMs?: number;
  mirrorStaleMs?: number;
  cooldownMs?: number;
  feedStatus?: () => { state?: string } | any;
  durabilityStatus?: () => { archive?: { retentionBlocked?: boolean; diskPressure?: boolean }; backup?: { retentionBlocked?: boolean; diskPressure?: boolean } };
  now?: () => number;
};

type CheckFn = { name: string; run: (nowMs: number) => { state: 'ok' | 'alert' | 'unavailable'; detail: string } };

/** Vault-health monitoring (docs/DATA_ENGINE.md): the recorder's own watchdog. Four
 *  checks — disk floor under the archive, capture stall while the feed streams, a
 *  stale Drive mirror log, and (via DbBackup failures) backup errors — each journaled
 *  as `health-alert` (the Telegram alerter pushes them) with a per-check alert
 *  cooldown so a continuing problem warns once, not every minute.
 *
 *  Fail-quiet philosophy: a check that CANNOT run (statfs unsupported, drive absent,
 *  no captures yet) reports `unavailable` and alerts nobody — only positive evidence
 *  of trouble raises an alert. Local-first: nothing here phones home. */
export class HealthMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private last: Map<string, HealthCheckResult> = new Map();
  private readonly checks: CheckFn[];
  private readonly intervalMs: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(
    private store: Store,
    private journal: DecisionJournal,
    private options: HealthMonitorOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 60000;
    this.cooldownMs = options.cooldownMs ?? 6 * 3600 * 1000;
    if (!Number.isInteger(this.intervalMs) || this.intervalMs < 10000) throw new Error('Invalid health interval');
    if (!Number.isInteger(this.cooldownMs) || this.cooldownMs < 60000) throw new Error('Invalid health cooldown');
    this.now = options.now ?? Date.now;
    const archiveRoot = options.archiveRoot ?? 'data/archive';
    const mirrorLogPath = options.mirrorLogPath ?? join(archiveRoot, 'mirror.log');
    const driveRoot = options.driveRoot ?? 'G:/My Drive/ABAD-archive';
    const diskFloor = options.diskFreeFloorBytes ?? 5 * 1024 * 1024 * 1024;
    const stallMs = options.captureStallMs ?? 10 * 60 * 1000;
    const mirrorStale = options.mirrorStaleMs ?? 2 * 3600 * 1000;

    this.checks = [
      ...(options.durabilityStatus ? [{ name: 'durability-retention', run: () => {
        try {
          const status = options.durabilityStatus!();
          const pressured = Object.entries(status).filter(([, value]) => value?.retentionBlocked || value?.diskPressure).map(([name]) => name);
          return pressured.length ? { state: 'alert' as const, detail: `Sole-copy retention blocked or disk pressure: ${pressured.join(', ')}. Verify independent backup and capacity; do not delete the only evidence.` }
            : { state: 'ok' as const, detail: 'No reported durability retention pressure' };
        } catch { return { state: 'alert' as const, detail: 'Durability status unavailable; inspect backup/archive capacity' }; }
      } }] : []),
      {
        name: 'disk-free',
        run: () => {
          try {
            // node:fs statfs — unavailable on some runtimes; then the check is honest-unavailable.
            const statfs = (require('node:fs') as any).statfsSync as ((p: string) => { bavail: number; bsize: number }) | undefined;
            if (typeof statfs !== 'function') return { state: 'unavailable', detail: 'statfs not supported by this runtime' };
            const root = existsSync(archiveRoot) ? archiveRoot : '.';
            const fs = statfs(root);
            const free = fs.bavail * fs.bsize;
            if (!Number.isFinite(free)) return { state: 'unavailable', detail: 'statfs returned no usable numbers' };
            return free < diskFloor
              ? { state: 'alert', detail: `disk free below floor: ${(free / 2 ** 30).toFixed(2)} GiB free, floor ${(diskFloor / 2 ** 30).toFixed(0)} GiB` }
              : { state: 'ok', detail: `${(free / 2 ** 30).toFixed(1)} GiB free` };
          } catch (error) {
            return { state: 'unavailable', detail: `statfs failed: ${(error as Error).message}`.slice(0, 200) };
          }
        },
      },
      {
        name: 'capture-stall',
        run: () => {
          try {
            let feedState = 'unknown';
            try { feedState = String(this.options.feedStatus?.().state ?? 'unknown'); } catch { /* feed not ready */ }
            if (feedState !== 'streaming') return { state: 'ok', detail: `feed ${feedState}; stall check applies only while streaming` };
            const today = new Date(this.now()).toISOString().slice(0, 10);
            const dayDir = join(archiveRoot, today);
            if (!existsSync(dayDir)) return { state: 'alert', detail: `feed streaming but no capture folder for today (${today})` };
            let newest = 0;
            for (const f of readdirSync(dayDir)) {
              if (!f.endsWith('.json')) continue;
              const m = statSync(join(dayDir, f)).mtimeMs;
              if (m > newest) newest = m;
            }
            if (!newest) return { state: 'alert', detail: 'feed streaming but zero capture files today' };
            const age = this.now() - newest;
            return age > stallMs
              ? { state: 'alert', detail: `capture stall: newest capture is ${Math.round(age / 60000)} min old (limit ${Math.round(stallMs / 60000)})` }
              : { state: 'ok', detail: `newest capture ${Math.round(age / 1000)}s old` };
          } catch (error) {
            return { state: 'unavailable', detail: `stall check failed: ${(error as Error).message}`.slice(0, 200) };
          }
        },
      },
      {
        name: 'mirror-stale',
        run: () => {
          try {
            if (!existsSync(driveRoot)) return { state: 'ok', detail: 'Drive root absent; mirror check off' };
            if (!existsSync(mirrorLogPath)) return { state: 'alert', detail: `mirror log missing at ${mirrorLogPath} while Drive root exists` };
            const lines = readFileSync(mirrorLogPath, 'utf8').split(/\r?\n/).filter(Boolean).slice(-8);
            let lastDone: number | null = null;
            for (const line of lines) {
              const m = line.match(/^(\d{4}-\d{2}-\d{2}T[^ ]+)\s+mirror cycle done/);
              if (m) { const t = Date.parse(m[1]); if (Number.isFinite(t)) lastDone = t; }
            }
            if (lastDone === null) return { state: 'unavailable', detail: 'no "mirror cycle done" lines found in the log tail' };
            const age = this.now() - lastDone;
            return age > mirrorStale
              ? { state: 'alert', detail: `Drive mirror stale: last completed cycle ${Math.round(age / 60000)} min ago (limit ${Math.round(mirrorStale / 60000)})` }
              : { state: 'ok', detail: `mirror cycle ${Math.round(age / 60000)} min ago` };
          } catch (error) {
            return { state: 'unavailable', detail: `mirror check failed: ${(error as Error).message}`.slice(0, 200) };
          }
        },
      },
    ];
  }

  start() { if (this.timer) return; this.timer = setInterval(() => { this.tick().catch(() => {}); }, this.intervalMs); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** Run every check once. Returns the results; alerts are journaled + audited,
   *  subject to each check's cooldown. `force` bypasses cooldowns (used by tests
  *  and GET /api/health?force=1... the API intentionally does NOT expose force). */
  async tick(force = false): Promise<HealthCheckResult[]> {
    const nowMs = this.now();
    const out: HealthCheckResult[] = [];
    for (const check of this.checks) {
      const result = check.run(nowMs);
      const cooldownKey = `healthAlertAt:${check.name}`;
      const lastAlert = (this.store.get(cooldownKey) as number | undefined) ?? 0;
      const cooled = nowMs - lastAlert >= this.cooldownMs;
      let alertedAt: string | null = null;
      let cooldownUntil: string | null = lastAlert ? new Date(lastAlert + this.cooldownMs).toISOString() : null;
      if (result.state === 'alert' && (cooled || force)) {
        alertedAt = new Date(nowMs).toISOString();
        cooldownUntil = new Date(nowMs + this.cooldownMs).toISOString();
        this.store.set(cooldownKey, nowMs);
        this.journal.record({
          time: alertedAt, botId: 'system-health', strategyId: 'system-health', symbol: 'all',
          decision: 'health-alert', rationale: `${check.name}: ${result.detail}`.slice(0, 500),
          riskChecks: [{ check: check.name, pass: false, detail: result.detail.slice(0, 300) }],
        });
        this.store.audit('HEALTH_ALERT', `${check.name}: ${result.detail}`.slice(0, 300));
      }
      this.last.set(check.name, { check: check.name, state: result.state, detail: result.detail, alertedAt, cooldownUntil });
      out.push(this.last.get(check.name)!);
    }
    return out;
  }

  status() {
    return { intervalMs: this.intervalMs, cooldownMs: this.cooldownMs, checks: [...this.last.values()] };
  }
}
