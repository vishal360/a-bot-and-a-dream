import { closeSync, fsyncSync, openSync, renameSync } from 'node:fs';

type Outcome = { samplePassed: boolean; sustainedFeedAccepted: boolean; failures: string[] };

/** Local lifecycle telemetry only. Completion requires a flushed and published final report. */
export class AcceptanceProgress {
  private latest: Record<string, unknown> = {};
  constructor(private directory: URL, private context: { startedAt: string; pid: number; requestedSeconds: number; symbols: string[] }) {}
  private async write(name: 'run' | 'report', record: unknown) {
    const temporary = new URL(`${name}.json.tmp`, this.directory);
    await Bun.write(temporary, JSON.stringify(record, null, 2));
    const fd = openSync(temporary, 'r+');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, new URL(`${name}.json`, this.directory));
    return new Bun.CryptoHasher('sha256').update(await Bun.file(new URL(`${name}.json`, this.directory)).arrayBuffer()).digest('hex');
  }
  private record(details: Record<string, unknown>) {
    return { version: 1, ...this.context, ...this.latest, ...details, updatedAt: new Date().toISOString(),
      automationAuthorized: false, executionEnabled: false };
  }
  async update(details: { phase: 'starting' | 'observing' | 'finalizing'; observationElapsedMs: number; warmupMs: number;
    state: string; healthy: boolean; counts: Record<string, number> }) {
    this.latest = details;
    await this.write('run', this.record({ complete: false, samplePassed: false, sustainedFeedAccepted: false,
      note: 'Heartbeat only. A final report is required for acceptance.' }));
  }
  async fail(error: string) {
    await this.write('run', this.record({ complete: false, phase: 'failed', error, samplePassed: false, sustainedFeedAccepted: false,
      note: 'Finalization failed. No acceptance may be inferred from this heartbeat.' }));
  }
  async finish(report: Outcome & Record<string, unknown>) {
    try {
      const reportSha256 = await this.write('report', { ...report, ...this.context, automationAuthorized: false, executionEnabled: false });
      await this.write('run', this.record({ complete: true, phase: 'completed', reportFile: 'report.json',
        reportSha256, samplePassed: report.samplePassed, sustainedFeedAccepted: report.sustainedFeedAccepted, failures: report.failures }));
    } catch (e) {
      // Best effort only: broken storage can prevent even the failure marker.
      try { await this.fail((e as Error).message); } catch {}
      throw e;
    }
  }
}