import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store';
import { LighterStream } from '../src/lighter-stream';
import { lighterHosts } from '../src/lighter';
import { replayCapture } from '../src/lighter-evidence';
import { LighterAcceptance, type CaptureCheck } from '../src/lighter-acceptance';
import type { StreamMarket } from '../src/lighter-book';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log('Usage: bun run scripts/accept-lighter.ts [--seconds 60..86400] [--symbols BTC,ETH]\nRead-only mainnet sample; isolated evidence under data/acceptance. No orders.\nOnly a completed 24-hour run can satisfy sustained feed criteria; never strategy/automation approval.');
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
  const stream = new LighterStream(store, { marketStats: true, tradeEvidence: true });
  const acceptance = new LighterAcceptance();
  let error: string | null = null, markets: StreamMarket[] = [], final: ReturnType<LighterStream['status']> | null = null;
  let warmupMs = 0;
  const startedAt = new Date().toISOString();
  const sample = () => {
    const status = stream.status();
    acceptance.sample({ wall: Date.now(), mono: performance.now(), healthy: status.healthy,
      recordingFailures: status.counts.recordingFailures, accepted: status.counts.accepted,
      tradeFrames: status.counts.tradeFrames, disconnects: status.counts.disconnects });
    return status;
  };
  try {
    const response = await fetch(`${lighterHosts.mainnet}/api/v1/orderBookDetails`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Public metadata HTTP ${response.status}`);
    const body = await response.json();
    if (body.code !== 200 || !Array.isArray(body.order_book_details)) throw new Error('Invalid public metadata response');
    markets = symbols.map(symbol => {
      const matches = body.order_book_details.filter((m: any) => m.symbol === symbol && m.status === 'active' && m.market_type === 'perp');
      if (matches.length !== 1) throw new Error(`Unique active perpetual metadata required for ${symbol}`);
      const m = matches[0];
      return { symbol, market_id: m.market_id, supported_price_decimals: m.supported_price_decimals, supported_size_decimals: m.supported_size_decimals };
    });
    stream.watch(markets); stream.start();
    const warming = performance.now();
    while (!stream.status().healthy) {
      if (stream.status().counts.recordingFailures) throw new Error('Recording failed during warmup');
      if (performance.now() - warming > 30000) throw new Error('Healthy snapshot/stats warmup timed out');
      await Bun.sleep(100);
    }
    warmupMs = performance.now() - warming;
    sample();
    const start = performance.now();
    while (performance.now() - start < seconds * 1000) {
      await Bun.sleep(Math.min(1000, Math.max(1, seconds * 1000 - (performance.now() - start))));
      final = sample();
      if (final.counts.recordingFailures) throw new Error('Recording failed; acceptance stopped');
    }
  } catch (e) { error = (e as Error).message; }
  // Preserve pre-stop diagnostics even on warmup failure; stop invalidates live books.
  finally { final = stream.status(); stream.stop(); }
  try {
    const checks: CaptureCheck[] = [];
    for (const manifest of stream.evidence!.list()) {
      try {
        const capture = stream.evidence!.export(manifest.id), result = replayCapture(capture);
        await Bun.write(new URL(`${manifest.id}.json`, directory), JSON.stringify(capture));
        checks.push({ id: manifest.id, snapshotRooted: result.snapshotRooted, statsCovered: result.statsCovered,
          frames: result.frames, stateSha256: result.stateSha256, error: null });
      } catch (e) { checks.push({ id: manifest.id, snapshotRooted: false, statsCovered: false, frames: 0, stateSha256: '', error: (e as Error).message }); }
    }
    const observed = markets.map(m => ({ marketId: m.market_id, tradesObserved: stream.evidence!.recentTrades(m.market_id).length > 0 }));
    // Metadata failures still produce a failed report, not a missing evidence record.
    const report = acceptance.report(seconds * 1000, checks, observed.length ? observed : [{ marketId: 0, tradesObserved: false }], error);
    const diagnostics = store.db.query("SELECT received_ms,kind,payload FROM lighter_feed_journal WHERE kind!='frame' ORDER BY id DESC LIMIT 20").all();
    await Bun.write(new URL('report.json', directory), JSON.stringify({ ...report, startedAt, endedAt: new Date().toISOString(), symbols,
      metadata: markets, metadataResolved: markets.length > 0, warmupMs, warmupLimitMs: 30000, finalState: final?.state ?? null, finalError: final?.error ?? null,
      finalCounts: final?.counts ?? null, latencyMs: final?.latencyMs ?? null, diagnostics }, null, 2));
    console.log(`${report.samplePassed ? 'SAMPLE PASS' : 'SAMPLE FAIL'}; sustained feed accepted=${report.sustainedFeedAccepted}; automation authorized=false\n${fileURLToPath(new URL('report.json', directory))}`);
    if (report.failures.length) console.error(report.failures.join('\n'));
    process.exitCode = report.samplePassed ? 0 : 1;
  } finally { store.db.close(); }
}