export const acceptanceCriteria = Object.freeze({
  version: 1, sustainedMs: 24 * 60 * 60 * 1000, minimumHealthyFraction: 0.99,
  maximumUnhealthyMs: 30000, maximumClockDriftMs: 2000, maximumSampleGapMs: 2500,
});
export type AcceptanceSample = {
  wall: number; mono: number; healthy: boolean; recordingFailures: number;
  accepted: number; tradeFrames: number; disconnects: number;
};
export type CaptureCheck = { id: string; snapshotRooted: boolean; statsCovered: boolean; frames: number; stateSha256: string; error: string | null };

/** Bounded aggregate telemetry, not strategy P&L, a venue guarantee or order authority. */
export class LighterAcceptance {
  private samples = 0;
  private healthyMs = 0;
  private unhealthyMs = 0;
  private longestUnhealthyMs = 0;
  private currentUnhealthyMs = 0;
  private maximumSampleGapMs = 0;
  private maximumClockDriftMs = 0;
  private recordingFailures = 0;
  private accepted = 0;
  private tradeFrames = 0;
  private previous: AcceptanceSample | null = null;
  private first: AcceptanceSample | null = null;
  private invalidClock = false;
  sample(s: AcceptanceSample) {
    if (![s.wall, s.recordingFailures, s.accepted, s.tradeFrames, s.disconnects].every(n => Number.isSafeInteger(n) && n >= 0) ||
      !Number.isFinite(s.mono) || s.mono < 0 || typeof s.healthy !== 'boolean') throw new Error('Invalid acceptance sample');
    if (this.previous) {
      const elapsed = s.mono - this.previous.mono;
      if (elapsed < 0 || s.accepted < this.previous.accepted || s.tradeFrames < this.previous.tradeFrames || s.recordingFailures < this.previous.recordingFailures || s.disconnects < this.previous.disconnects) this.invalidClock = true;
      const interval = Math.max(0, elapsed);
      this.maximumSampleGapMs = Math.max(this.maximumSampleGapMs, interval);
      // A delayed observer cannot claim the unobserved interval was healthy.
      const healthy = s.healthy && this.previous.healthy && s.disconnects === this.previous.disconnects && interval <= acceptanceCriteria.maximumSampleGapMs;
      if (healthy) { this.healthyMs += interval; this.currentUnhealthyMs = 0; }
      else { this.unhealthyMs += interval; this.currentUnhealthyMs += interval; this.longestUnhealthyMs = Math.max(this.longestUnhealthyMs, this.currentUnhealthyMs); }
    }
    this.first ??= { ...s };
    this.maximumClockDriftMs = Math.max(this.maximumClockDriftMs, Math.abs((s.wall - this.first.wall) - (s.mono - this.first.mono)));
    this.recordingFailures = Math.max(this.recordingFailures, s.recordingFailures);
    this.accepted = s.accepted; this.tradeFrames = s.tradeFrames;
    this.previous = { ...s }; this.samples++;
  }
  report(requestedMs: number, captures: CaptureCheck[], markets: { marketId: number; tradesObserved: boolean }[], error: string | null = null) {
    if (!Number.isSafeInteger(requestedMs) || requestedMs < 1000 || requestedMs > acceptanceCriteria.sustainedMs || captures.length > 4 || markets.length < 1 || markets.length > 32 ||
      new Set(markets.map(m => m.marketId)).size !== markets.length || markets.some(m => !Number.isSafeInteger(m.marketId) || m.marketId < 0 || typeof m.tradesObserved !== 'boolean')) throw new Error('Invalid acceptance report bounds');
    const elapsedMs = this.healthyMs + this.unhealthyMs, healthyFraction = elapsedMs ? this.healthyMs / elapsedMs : 0;
    const failures: string[] = [];
    if (error) failures.push(error);
    if (elapsedMs < requestedMs || this.samples < 2) failures.push('Requested observation duration not completed');
    if (healthyFraction < acceptanceCriteria.minimumHealthyFraction) failures.push('Insufficient observed healthy time');
    if (this.longestUnhealthyMs > acceptanceCriteria.maximumUnhealthyMs) failures.push('Unhealthy interval exceeded policy');
    if (this.maximumSampleGapMs > acceptanceCriteria.maximumSampleGapMs) failures.push('Observer sampling gap exceeded policy');
    if (this.invalidClock || this.maximumClockDriftMs > acceptanceCriteria.maximumClockDriftMs) failures.push('Clock/counter integrity failed');
    if (this.recordingFailures) failures.push('Durable recording failure observed');
    if (!this.accepted || !this.tradeFrames || markets.some(m => !m.tradesObserved)) failures.push('Book/stats/trade coverage not observed for every market');
    if (!captures.length || captures.some(c => c.error || !c.snapshotRooted || !c.statsCovered || !c.frames || !/^[a-f0-9]{64}$/.test(c.stateSha256))) failures.push('Snapshot-rooted replay evidence incomplete');
    const samplePassed = failures.length === 0;
    return { version: 1, source: 'Lighter mainnet read-only', criteria: acceptanceCriteria,
      requestedMs, elapsedMs, samples: this.samples, healthyMs: this.healthyMs, unhealthyMs: this.unhealthyMs,
      healthyFraction, longestUnhealthyMs: this.longestUnhealthyMs, maximumSampleGapMs: this.maximumSampleGapMs,
      maximumClockDriftMs: this.maximumClockDriftMs, recordingFailures: this.recordingFailures,
      acceptedFrames: this.accepted, tradeFrames: this.tradeFrames, markets, captures, failures,
      samplePassed, sustainedFeedAccepted: samplePassed && elapsedMs >= acceptanceCriteria.sustainedMs,
      tradeContinuity: 'unproven', strategyValidated: false, automationAuthorized: false, executionEnabled: false };
  }
}