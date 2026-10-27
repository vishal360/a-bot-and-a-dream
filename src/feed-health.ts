import type { Store } from './store';

export type FeedPolicy = {
  /** Book/stats age beyond this is stale. Should match the stream's own staleMs. */
  staleMs: number;
  /** A single unhealthy interval longer than this is flagged over-policy in the episode record. */
  maxUnhealthyIntervalMs: number;
  /** Continuous healthy time required before bots may open exposure again. */
  healthyResumeMs: number;
  /** Rolling window used for the healthy-fraction estimate. */
  fractionWindowMs: number;
  /** Minimum fraction required inside the rolling window for 'healthy' verdicts. */
  minimumHealthyFraction: number;
};

export const feedPolicyDefaults: FeedPolicy = {
  staleMs: 5000, maxUnhealthyIntervalMs: 30000, healthyResumeMs: 60000, fractionWindowMs: 3600000, minimumHealthyFraction: 0.99
};

export type FeedEpisode = { start: string; end: string | null; healthy: boolean; reason: string | null; overPolicy: boolean };
export type FeedHealthSnapshot = {
  state: 'healthy' | 'degraded' | 'unhealthy'; since: string; reason: string | null;
  openSinceMs: number; healthyFraction: { windowMs: number; fraction: number; samples: number } | null;
  episodes: FeedEpisode[]; counters: { disconnects: number; gaps: number; stale: number; invalid: number; recordingFailures: number; epochs: number };
  integrityFailed: boolean; lastSampleAt: string | null; streamState: string | null;
};

type Interval = { startMs: number; endMs: number; healthy: boolean };
type StreamStatus = ReturnType<import('./lighter-stream').LighterStream['status']>;

/** Fail-closed feed verdict for automated exposure. A bot may open exposure only while
 *  the guard is continuously healthy; reductions stay governed by the paper executor.
 *  Feed counter regression or a durable recording failure latches integrity failure until restart. */
export class FeedHealthGuard {
  private policy: FeedPolicy;
  private intervals: Interval[] = [];
  private episodes: FeedEpisode[] = [];
  private lastSampleMono: number | null = null;
  private lastCounts: { disconnects: number; gaps: number; stale: number; invalid: number; recordingFailures: number } | null = null;
  private epochCount = 0;
  private lastEpoch: string | null = null;
  private currentState: 'healthy' | 'degraded' | 'unhealthy' = 'unhealthy';
  private stateSinceMs = 0;
  private reason: string | null = 'No feed sample yet';
  private integrityFailed = false;
  private lastSampleAt: string | null = null;
  private streamState: string | null = null;
  private dirty = false;

  constructor(private store: Store, policy: Partial<FeedPolicy> = {}) {
    this.policy = { ...feedPolicyDefaults, ...policy };
    const p = this.policy;
    if (!Number.isInteger(p.staleMs) || p.staleMs < 250 || !Number.isInteger(p.maxUnhealthyIntervalMs) || p.maxUnhealthyIntervalMs < 1000 ||
        !Number.isInteger(p.healthyResumeMs) || p.healthyResumeMs < 1000 || !Number.isInteger(p.fractionWindowMs) || p.fractionWindowMs < 60000 ||
        !Number.isFinite(p.minimumHealthyFraction) || p.minimumHealthyFraction <= 0 || p.minimumHealthyFraction > 1) throw new Error('Invalid feed health policy');
    store.db.exec(`CREATE TABLE IF NOT EXISTS feed_health_summary (id INTEGER PRIMARY KEY CHECK (id=1), payload TEXT NOT NULL)`);
  }

  /** Feed one LighterStream.status() snapshot plus the monotonic clock used to read it. */
  sample(status: StreamStatus, monoMs: number, wallMs: number) {
    if (!Number.isFinite(monoMs) || monoMs < 0 || !(wallMs > 0)) throw new Error('Invalid feed health clock');
    if (this.lastSampleMono !== null && monoMs < this.lastSampleMono) throw new Error('Feed health clock regression');
    if (this.lastSampleMono !== null) {
      this.intervals.push({ startMs: this.lastSampleMono, endMs: monoMs, healthy: this.currentState === 'healthy' });
      this.prune(monoMs);
    }
    this.lastSampleMono = monoMs;
    this.lastSampleAt = new Date(wallMs).toISOString();
    this.streamState = status.state ?? null;

    const counts = { ...status.counts };
    if (this.lastCounts) {
      for (const key of ['disconnects', 'gaps', 'stale', 'invalid', 'recordingFailures'] as const) {
        if (counts[key] < this.lastCounts[key]) this.integrityFailed = true;
      }
    }
    this.lastCounts = counts;
    if (status.epoch && status.epoch !== this.lastEpoch) { this.epochCount++; this.lastEpoch = status.epoch; }

    let healthy = true, reason: string | null = null;
    if (this.integrityFailed) { healthy = false; reason = 'Feed counter/recording integrity failed'; }
    else if (status.state !== 'streaming') { healthy = false; reason = `Stream state ${status.state}`; }
    else if (!status.books.length) { healthy = false; reason = 'No watched markets'; }
    else {
      for (const book of status.books) {
        if (book.status !== 'healthy') { healthy = false; reason = `Market ${book.market.symbol} book ${book.status}`; break; }
        const fresh = status.stats.find(s => s.marketId === book.market.market_id)?.stats ?? null;
        if (!fresh) { healthy = false; reason = `Market ${book.market.symbol} has no fresh market stats`; break; }
      }
    }

    if (healthy !== (this.currentState === 'healthy')) {
      const durationMs = monoMs - this.stateSinceMs;
      const prior = this.currentState;
      const open = this.episodes.find(e => e.end === null);
      if (open) {
        open.end = new Date(wallMs).toISOString();
        open.overPolicy = !open.healthy && durationMs > this.policy.maxUnhealthyIntervalMs;
      }
      this.episodes.push({ start: new Date(wallMs).toISOString(), end: null, healthy, reason: healthy ? null : reason, overPolicy: false });
      if (this.episodes.length > 200) this.episodes = this.episodes.slice(-100);
      this.currentState = healthy ? 'healthy' : 'unhealthy';
      this.stateSinceMs = monoMs;
      this.reason = healthy ? null : reason;
      this.dirty = true;
      return { transition: { from: prior, to: this.currentState, reason: this.reason } };
    }
    if (!healthy && this.reason !== reason) { this.reason = reason; this.dirty = true; }
    return { transition: null };
  }

  private prune(nowMs: number) {
    const cutoff = nowMs - this.policy.fractionWindowMs * 2;
    this.intervals = this.intervals.filter(i => i.endMs >= cutoff);
  }

  /** Continuous healthy time since the last unhealthy state, in ms. */
  healthyStreakMs(monoMs: number) { return this.currentState === 'healthy' && this.lastSampleMono !== null ? monoMs - this.stateSinceMs : 0; }

  verdict(monoMs: number): { allowed: boolean; state: FeedHealthSnapshot['state']; reason: string | null } {
    const fraction = this.healthyFraction();
    const streak = this.healthyStreakMs(monoMs);
    if (this.integrityFailed) return { allowed: false, state: 'unhealthy', reason: 'Feed counter/recording integrity failed; restart review required' };
    if (this.currentState !== 'healthy') return { allowed: false, state: this.currentState, reason: this.reason ?? 'Feed unhealthy' };
    if (streak < this.policy.healthyResumeMs) return { allowed: false, state: 'degraded', reason: `Recovery dwell ${Math.max(0, Math.round((this.policy.healthyResumeMs - streak) / 1000))}s remaining` };
    if (fraction && fraction.samples > 0 && fraction.fraction < this.policy.minimumHealthyFraction) return { allowed: false, state: 'degraded', reason: `Rolling healthy fraction ${(fraction.fraction * 100).toFixed(2)}% below ${(this.policy.minimumHealthyFraction * 100).toFixed(0)}%` };
    return { allowed: true, state: 'healthy', reason: null };
  }

  healthyFraction() {
    if (this.lastSampleMono === null) return null;
    const cutoff = this.lastSampleMono - this.policy.fractionWindowMs;
    let healthy = 0, total = 0;
    for (const interval of this.intervals) {
      const start = Math.max(interval.startMs, cutoff), end = Math.min(interval.endMs, this.lastSampleMono);
      if (end <= start) continue;
      total += end - start;
      if (interval.healthy) healthy += end - start;
    }
    return { windowMs: this.policy.fractionWindowMs, fraction: total ? healthy / total : this.currentState === 'healthy' ? 1 : 0, samples: this.intervals.length };
  }

  status(): FeedHealthSnapshot {
    const openSinceMs = this.lastSampleMono === null ? 0 : Math.max(0, this.lastSampleMono - this.stateSinceMs);
    return {
      state: this.currentState, since: new Date(Date.now() - openSinceMs).toISOString(), reason: this.reason, openSinceMs,
      healthyFraction: this.healthyFraction(), episodes: this.episodes.slice(-20),
      counters: { ...this.lastCounts ?? { disconnects: 0, gaps: 0, stale: 0, invalid: 0, recordingFailures: 0 }, epochs: this.epochCount },
      integrityFailed: this.integrityFailed, lastSampleAt: this.lastSampleAt, streamState: this.streamState
    };
  }

  /** Persist a bounded summary for post-restart inspection; never auto-restores verdicts. */
  persist() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      this.store.db.query('INSERT OR REPLACE INTO feed_health_summary VALUES (1,?)').run(JSON.stringify({ savedAt: new Date().toISOString(), status: this.status() }));
    } catch { /* Summary persistence never blocks the guard. */ }
  }
}
