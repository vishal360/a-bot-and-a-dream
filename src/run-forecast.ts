/**
 * Forecast for a running 24h acceptance observation, computed from heartbeat telemetry only.
 *
 * The heartbeat (run.json) does not expose healthy milliseconds, so unhealthy time is estimated
 * from disconnects: every disconnect marks at least one 1s sample interval unhealthy, and past
 * completed runs measured ~3-4.5s of unhealthy time per disconnect (95ffe: 54.1s / 17,
 * 62de: 24s / 6). The forecast is a planning aid, never evidence: only report.json decides.
 */
export const forecastPolicy = Object.freeze({
  requestedMs: 86_400_000, minimumHealthyFraction: 0.99, unhealthyMsPerDisconnect: 4000,
  heartbeatStaleMs: 150_000,
});

export type Heartbeat = {
  startedAt: string; pid: number; requestedSeconds: number; phase: string; observationElapsedMs: number;
  state: string; healthy: boolean; updatedAt: string; complete: boolean; samplePassed: boolean;
  sustainedFeedAccepted: boolean; failures?: string[]; error?: string;
  counts: { connections: number; disconnects: number; gaps: number; stale: number; invalid: number;
    frames: number; accepted: number; tradeFrames: number; recordingFailures: number };
};

/** ln P(X <= k) for X ~ Poisson(lambda), summed in log space so large lambda stays finite. */
export function poissonCdf(k: number, lambda: number): number {
  if (!Number.isFinite(lambda) || lambda < 0 || !Number.isFinite(k)) throw new Error('Invalid Poisson arguments');
  if (k < 0) return 0;
  if (lambda === 0) return 1;
  const n = Math.floor(k);
  let term = -lambda, max = term;
  const logs = [term];
  for (let i = 1; i <= n; i++) { term += Math.log(lambda) - Math.log(i); logs.push(term); if (term > max) max = term; }
  const sum = logs.reduce((s, l) => s + Math.exp(l - max), 0);
  return Math.min(1, Math.exp(max + Math.log(sum)));
}

export type Forecast = ReturnType<typeof forecastRun>;

export function forecastRun(hb: Heartbeat, nowMs: number, policy = forecastPolicy) {
  const requestedMs = (hb.requestedSeconds || 86400) * 1000;
  const elapsedMs = Math.max(0, Math.min(hb.observationElapsedMs, requestedMs));
  const remainingMs = requestedMs - elapsedMs;
  const heartbeatAgeMs = nowMs - Date.parse(hb.updatedAt);
  const disconnects = hb.counts.disconnects;
  const budgetMs = requestedMs * (1 - policy.minimumHealthyFraction);           // 864s for 24h
  const maxDisconnects = Math.floor(budgetMs / policy.unhealthyMsPerDisconnect); // ~216 for 24h
  const estimatedUnhealthyMs = disconnects * policy.unhealthyMsPerDisconnect;
  const estimatedHealthyFraction = elapsedMs > 0 ? Math.max(0, 1 - estimatedUnhealthyMs / elapsedMs) : 1;
  // Rate with a weak prior (1 disconnect per 10 min, weighted as 1h) so the first minutes don't swing wildly.
  const priorHours = 1, priorRatePerHour = 6;
  const hours = elapsedMs / 3_600_000;
  const ratePerHour = (disconnects + priorRatePerHour * priorHours) / (hours + priorHours);
  const projectedDisconnects = disconnects + ratePerHour * remainingMs / 3_600_000;
  const stalled = heartbeatAgeMs > policy.heartbeatStaleMs;
  const hardFail = hb.counts.recordingFailures > 0 || hb.phase === 'failed' || (hb.complete && !hb.samplePassed);
  let feedProbability = disconnects > maxDisconnects ? 0 : poissonCdf(maxDisconnects - disconnects, ratePerHour * remainingMs / 3_600_000);
  if (hardFail || stalled) feedProbability = 0;
  if (hb.complete && hb.samplePassed) feedProbability = 1;
  let status: 'PASSED' | 'FAILED' | 'STALLED' | 'AT RISK' | 'ON TRACK';
  if (hb.complete) status = hb.samplePassed ? 'PASSED' : 'FAILED';
  else if (hardFail) status = 'FAILED';
  else if (stalled) status = 'STALLED';
  else status = feedProbability < 0.8 || !hb.healthy ? 'AT RISK' : 'ON TRACK';
  return {
    status, elapsedMs, remainingMs, progress: elapsedMs / requestedMs,
    etaIso: new Date(Date.parse(hb.updatedAt) + remainingMs).toISOString(),
    heartbeatAgeMs, stalled, disconnects, maxDisconnects, ratePerHour, projectedDisconnects,
    estimatedHealthyFraction, estimatedUnhealthyMs, budgetMs, feedProbability,
    minutesPerDisconnect: disconnects ? elapsedMs / 60000 / disconnects : null,
  };
}

export const formatDuration = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 3600)}h ${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}m ${String(s % 60).padStart(2, '0')}s`;
};
