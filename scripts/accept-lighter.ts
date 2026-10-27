import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store';
import { LighterStream } from '../src/lighter-stream';
import { lighterHosts } from '../src/lighter';
import { replayCapture } from '../src/lighter-evidence';
import { LighterAcceptance, type CaptureCheck } from '../src/lighter-acceptance';
import { AcceptanceProgress } from './lighter-acceptance-progress';
import { observeAcceptance } from './lighter-acceptance-observation';
import { clockPolicy, observeHostClock, type ClockObservation } from './lighter-acceptance-clock';
import { hashAcceptanceSources, hashEvidenceFile, type EvidenceHash } from './lighter-acceptance-evidence';
import type { StreamMarket } from '../src/lighter-book';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log('Usage: bun run scripts/accept-lighter.ts [--seconds 60..86400] [--symbols BTC,ETH]\nRead-only mainnet sample; isolated evidence under data/acceptance. No orders.\nFails closed before network access without recent Windows Time synchronization. No clock override.\nOnly a completed 24-hour run can satisfy sustained feed criteria; never strategy/automation approval.');
} else {
  let seconds = 60, symbols = ['BTC', 'ETH'];
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === '--seconds' && /^\d+$/.test(args[i + 1] ?? '')) seconds = Number(args[i + 1]);
    else if (args[i] === '--symbols' && /^[A-Za-z0-9._/-]+(?:,[A-Za-z0-9._/-]+)*$/.test(args[i + 1] ?? '')) symbols = args[i + 1].split(',');
    else throw new Error('Invalid arguments; use --help');
  }
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 86400 || symbols.length > 4 || new Set(symbols).size !== symbols.length || symbols.some(s => s.length > 80)) throw new Error('Use 60..86400 seconds and 1..4 unique symbols');
  const directory = new URL(`../data/acceptance/${crypto.randomUUID()}/`, import.meta.url);
  mkdirSync(directory, { recursive: true });
  const store = new Store(fileURLToPath(new URL('evidence.sqlite', directory)));
  async function observe() {
  const stream = new LighterStream(store, { marketStats: true, tradeEvidence: true });
  const acceptance = new LighterAcceptance();
  let error: string | null = null, markets: StreamMarket[] = [], final: ReturnType<LighterStream['status']> | null = null;
  let warmupMs = 0;
  const startedAt = new Date().toISOString();
  const lifecycle = new AcceptanceProgress(directory, { startedAt, pid: process.pid, requestedSeconds: seconds, symbols });
  const root = fileURLToPath(new URL('../', import.meta.url));
  const clocks: ClockObservation[] = [], artifacts: EvidenceHash[] = [];
  let sources: EvidenceHash[] = [], sourcesStable = false, lastClockCheck = 0;
  const checkClock = async (phase: ClockObservation['phase']) => {
    const clock = await observeHostClock(phase);
    clocks.push(clock); lastClockCheck = performance.now();
    if (!clock.passed) throw new Error(`Host clock preflight failed: ${clock.failures.join('; ')}`);
  };
  let observationStart: number | null = null;
  let observationEnd: number | null = null;
  let observationElapsedMs = 0;
  const progress = async (phase: 'starting' | 'observing' | 'finalizing') => {
    if (phase === 'observing' && performance.now() - lastClockCheck >= clockPolicy.recheckMs) await checkClock('observing');
    const status = stream.status();
    await lifecycle.update({ phase, observationElapsedMs,
      warmupMs, state: status.state, healthy: status.healthy, counts: status.counts });
  };
  const sample = () => {
    const status = stream.status(), mono = performance.now();
    acceptance.sample({ wall: Date.now(), mono, healthy: status.healthy,
      recordingFailures: status.counts.recordingFailures, accepted: status.counts.accepted,
      tradeFrames: status.counts.tradeFrames, disconnects: status.counts.disconnects });
    final = status;
    observationEnd = mono;
    observationElapsedMs = observationStart === null ? 0 : mono - observationStart;
    if (status.counts.recordingFailures) throw new Error('Recording failed; acceptance stopped');
    return mono;
  };
  try {
    await progress('starting');
    console.log(`Observation started; acceptance pending\n${fileURLToPath(directory)}`);
    sources = await hashAcceptanceSources(root);
    await checkClock('starting');
    const metadataSource = `${lighterHosts.mainnet}/api/v1/orderBookDetails`;
    const response = await fetch(metadataSource, { redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Public metadata HTTP ${response.status}`);
    const reader = response.body!.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      bytes += value.length;
      if (bytes > 4 * 1024 * 1024) { await reader.cancel(); throw new Error('Public metadata exceeds evidence limit'); }
      chunks.push(value);
    }
    const raw = Buffer.concat(chunks);
    await Bun.write(new URL('metadata.json', directory), raw);
    artifacts.push(await hashEvidenceFile(fileURLToPath(directory), 'metadata.json'));
    const body = JSON.parse(raw.toString('utf8'));
    if (body.code !== 200 || !Array.isArray(body.order_book_details)) throw new Error('Invalid public metadata response');
    const resolved = symbols.map(symbol => {
      const matches = body.order_book_details.filter((m: any) => m.symbol === symbol && m.status === 'active' && m.market_type === 'perp');
      if (matches.length !== 1) throw new Error(`Unique active perpetual metadata required for ${symbol}`);
      const m = matches[0];
      if (!Number.isSafeInteger(m.market_id) || m.market_id < 0 ||
          [m.supported_price_decimals, m.supported_size_decimals].some(n => !Number.isSafeInteger(n) || n < 0 || n > 8)) throw new Error('Invalid streaming metadata');
      return { symbol, market_id: m.market_id, supported_price_decimals: m.supported_price_decimals, supported_size_decimals: m.supported_size_decimals };
    });
    if (new Set(resolved.map(m => m.market_id)).size !== resolved.length) throw new Error('Duplicate resolved market identity');
    markets = resolved;
    stream.watch(markets); stream.start();
    const warming = performance.now();
    while (!stream.status().healthy) {
      if (stream.status().counts.recordingFailures) throw new Error('Recording failed during warmup');
      if (performance.now() - warming > 30000) throw new Error('Healthy snapshot/stats warmup timed out');
      await Bun.sleep(100);
    }
    warmupMs = performance.now() - warming;
    await observeAcceptance(seconds * 1000, { now: () => performance.now(), sample, sleep: ms => Bun.sleep(ms),
      progress: async start => { observationStart = start; await progress('observing'); } });
  } catch (e) { error = (e as Error).message; }
  // Preserve pre-stop diagnostics even on warmup failure; stop invalidates live books.
  finally {
    try {
      final = stream.status(); stream.stop();
      if (stream.status().counts.recordingFailures) throw new Error('Durable feed recording failed during shutdown');
    } catch (e) { error = [error, (e as Error).message].filter(Boolean).join('; '); }
  }
  try {
    await progress('finalizing');
    try {
      sourcesStable = sources.length > 0 && JSON.stringify(sources) === JSON.stringify(await hashAcceptanceSources(root));
      if (!sourcesStable) throw new Error('Observer source/dependency files changed during the run');
      if (clocks[0]?.passed) await checkClock('finalizing');
    } catch (e) { error = [error, (e as Error).message].filter(Boolean).join('; '); }
    const checks: CaptureCheck[] = [];
    for (const manifest of stream.evidence!.list()) {
      try {
        const capture = stream.evidence!.export(manifest.id), result = replayCapture(capture);
        await Bun.write(new URL(`${manifest.id}.json`, directory), JSON.stringify(capture));
        artifacts.push(await hashEvidenceFile(fileURLToPath(directory), `${manifest.id}.json`));
        checks.push({ id: manifest.id, snapshotRooted: result.snapshotRooted, statsCovered: result.statsCovered,
          frames: result.frames, stateSha256: result.stateSha256, error: null });
      } catch (e) { checks.push({ id: manifest.id, snapshotRooted: false, statsCovered: false, frames: 0, stateSha256: '', error: (e as Error).message }); }
    }
    const observed = markets.map(m => ({ marketId: m.market_id, tradesObserved: stream.evidence!.recentTrades(m.market_id).length > 0 }));
    // Metadata failures still produce a failed report, not a missing evidence record.
    const report = acceptance.report(seconds * 1000, checks, observed.length ? observed : [{ marketId: 0, tradesObserved: false }], error);
    const diagnostics = store.db.query("SELECT received_ms,kind,payload FROM lighter_feed_journal WHERE kind!='frame' ORDER BY id DESC LIMIT 20").all();
    await lifecycle.finish({ ...report, startedAt, endedAt: new Date().toISOString(), symbols,
      sources, sourcesStable, artifacts, clocks, runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
      observation: { startedMono: observationStart, endedMono: observationEnd },
      metadataSource: `${lighterHosts.mainnet}/api/v1/orderBookDetails`,
      metadata: markets, metadataResolved: markets.length > 0, warmupMs, warmupLimitMs: 30000, finalState: final?.state ?? null, finalError: final?.error ?? null,
      finalCounts: final?.counts ?? null, latencyMs: final?.latencyMs ?? null, diagnostics });
    console.log(`${report.samplePassed ? 'SAMPLE PASS' : 'SAMPLE FAIL'}; sustained feed accepted=${report.sustainedFeedAccepted}; automation authorized=false\n${fileURLToPath(new URL('report.json', directory))}`);
    if (report.failures.length) console.error(report.failures.join('\n'));
    process.exitCode = report.samplePassed ? 0 : 1;
  } catch (e) {
    process.exitCode = 1;
    try { await lifecycle.fail((e as Error).message); } catch {}
    console.error(`Acceptance finalization failed: ${(e as Error).message}`);
  }
  }
  try { await observe(); } catch (e) {
    process.exitCode = 1;
    console.error(`Acceptance initialization failed: ${(e as Error).message}`);
  } finally { store.db.close(); }
}