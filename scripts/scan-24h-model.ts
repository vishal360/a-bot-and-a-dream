/**
 * Pure model behind `scan` (scripts/scan-24h.ts). No I/O, fully unit-tested.
 * The success probability is a transparent heuristic, not a guarantee.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { acceptanceCriteria } from '../src/lighter-acceptance';

export type Heartbeat = {
  startedAt: string; pid: number; requestedSeconds: number; phase: string; observationElapsedMs: number; warmupMs?: number;
  state?: string; healthy?: boolean; complete: boolean; samplePassed: boolean; sustainedFeedAccepted: boolean;
  updatedAt: string; error?: string; failures?: string[];
  counts?: { connections: number; disconnects: number; gaps: number; stale: number; invalid: number; frames: number; accepted: number; tradeFrames: number; recordingFailures: number };
};

/** Measured on this PC: 95ffe 17 disconnects -> 54.1s unhealthy, 62de 6 -> 24.0s => ~3.5s each. */
export const UNHEALTHY_MS_PER_DISCONNECT = 3500;
/** Observed local interruptions (power cuts / shutdowns): roughly one per ~3 days of attempts. */
export const DEFAULT_MTBI_HOURS = 72;
export const CLOCK_RECHECK_MS = 15 * 60 * 1000;
/** Prior used until 30 minutes of evidence exist: one disconnect per 10 minutes. */
const PRIOR_RATE_PER_HOUR = 6, PRIOR_HOURS = 0.5;

export function poissonCdf(k: number, lambda: number) {
  if (k < 0) return 0;
  if (lambda <= 0) return 1;
  let term = Math.exp(-lambda), sum = term;
  for (let i = 1; i <= k; i++) { term *= lambda / i; sum += term; if (term < 1e-15 && i > lambda) break; }
  return Math.min(1, sum);
}

/**
 * P(success) = P(feed budget holds) x P(no power/process interruption) x P(clock gate holds).
 * - feed: disconnects are Poisson at the observed rate (blended with a prior early on); each costs
 *   ~3.5s unhealthy, so the 1% budget (864s per 24h) allows floor(864/3.5) = 246 disconnects in total.
 * - uptime: exponential survival over the remaining hours.
 * - clock: 0.995 per remaining 15-minute recheck while green, halved when currently red.
 */
export function estimateSuccess(hb: Heartbeat, opts: { now?: number; clockGreen?: boolean; alive?: boolean; mtbiHours?: number } = {}) {
  const { now = Date.now(), clockGreen = true, alive = true, mtbiHours = DEFAULT_MTBI_HOURS } = opts;
  const requestedMs = hb.requestedSeconds * 1000;
  const elapsedMs = Math.min(Math.max(0, hb.observationElapsedMs), requestedMs), remainingMs = requestedMs - elapsedMs;
  const disconnects = hb.counts?.disconnects ?? 0;
  const budgetMs = requestedMs * (1 - acceptanceCriteria.minimumHealthyFraction);
  const allowedDisconnects = Math.floor(budgetMs / UNHEALTHY_MS_PER_DISCONNECT);
  const observedHours = elapsedMs / 3_600_000, priorHours = Math.max(0, PRIOR_HOURS - observedHours);
  const ratePerHour = (disconnects + priorHours * PRIOR_RATE_PER_HOUR) / Math.max(1e-9, observedHours + priorHours);
  const expectedMore = ratePerHour * remainingMs / 3_600_000;
  const pFeed = poissonCdf(allowedDisconnects - disconnects, expectedMore);
  const pUptime = alive ? Math.exp(-(remainingMs / 3_600_000) / mtbiHours) : 0;
  const pClock = (clockGreen ? 1 : 0.5) * Math.pow(0.995, remainingMs / CLOCK_RECHECK_MS);
  const stalled = !hb.complete && now - Date.parse(hb.updatedAt) > 120_000;
  const failed = hb.phase === 'failed' || (hb.complete && !hb.sustainedFeedAccepted);
  const probability = hb.complete ? (hb.sustainedFeedAccepted ? 1 : 0) : failed || stalled || !alive ? 0 : pFeed * pUptime * pClock;
  return { probability, pFeed, pUptime, pClock, ratePerHour, projectedDisconnects: disconnects + expectedMore, allowedDisconnects,
    estimatedUnhealthyMs: disconnects * UNHEALTHY_MS_PER_DISCONNECT, budgetMs, stalled, failed };
}

export function describeStatus(hb: Heartbeat, alive: boolean, stalled: boolean) {
  if (hb.complete) return hb.sustainedFeedAccepted ? 'PASSED - sustained feed accepted' : hb.samplePassed ? 'SAMPLE PASSED (shorter than 24h)' : 'FAILED';
  if (hb.phase === 'failed') return 'FAILED during finalization';
  if (!alive) return 'DEAD - observer process gone (power cut, shutdown or window closed)';
  if (stalled) return 'STALLED - no heartbeat for over 2 minutes';
  return hb.healthy ? 'RUNNING - healthy' : 'RUNNING - currently unhealthy (reconnecting)';
}

/** _active.json (written by run-24h.ps1) wins; otherwise the most recently updated run.json. */
export function findActiveRun(dir: string): string | null {
  const activePath = join(dir, '_active.json');
  if (existsSync(activePath)) {
    try {
      const active = JSON.parse(readFileSync(activePath, 'utf8').replace(/^\uFEFF/, ''));
      if (typeof active.runId === 'string' && /^[0-9a-f-]{36}$/.test(active.runId) && existsSync(join(dir, active.runId, 'run.json'))) return active.runId;
    } catch {}
  }
  const runs = readdirSync(dir).filter(n => /^[0-9a-f-]{36}$/.test(n) && existsSync(join(dir, n, 'run.json')))
    .sort((a, b) => statSync(join(dir, b, 'run.json')).mtimeMs - statSync(join(dir, a, 'run.json')).mtimeMs);
  return runs[0] ?? null;
}
