import { test, expect } from 'bun:test';
import { copyFileSync, mkdtempSync, rmSync, mkdirSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LighterAcceptance, acceptanceCriteria } from '../src/lighter-acceptance';
import { replayCapture } from '../src/lighter-evidence';
import { lighterStreamUrl } from '../src/lighter-stream';
import { AcceptanceProgress } from '../scripts/lighter-acceptance-progress';
import { inspectAcceptance } from '../scripts/inspect-lighter-acceptance';
import { clockPolicy, evaluateWindowsClock } from '../scripts/lighter-acceptance-clock';
import { acceptanceSourceFiles, hashAcceptanceSources, hashEvidenceFile, readEvidenceFile, sha256 } from '../scripts/lighter-acceptance-evidence';

const market = { symbol: 'BTC', market_id: 1, supported_price_decimals: 2, supported_size_decimals: 5 };
const wall = 1800000000000;
const clockCommand = { exitCode: 0, stderr: '', stdout: [
  'Leap Indicator: 0(no warning)', 'Stratum: 2 (secondary reference)', 'Source: time.windows.com,0x9',
  'Time since Last Good Sync Time: 30s', 'Last Sync Error: 0 (Success)',
  'Phase Offset: 0.001s', 'Root Delay: 0.02s', 'Root Dispersion: 0.03s',
].join('\n') };

async function fixture(duration = 60000, metadata = [market], captured = metadata) {
  const dir = mkdtempSync(join(tmpdir(), 'dream-acceptance-inspection-'));
  const frames = metadata.flatMap(m => [
    { type: 'subscribed/order_book', channel: `order_book:${m.market_id}`, timestamp: wall,
      order_book: { code: 0, nonce: 1, bids: [{ price: '100', size: '1' }], asks: [{ price: '101', size: '1' }] } },
    { type: 'subscribed/market_stats', channel: `market_stats:${m.market_id}`, timestamp: wall,
      market_stats: { ...m, mark_price: '100', index_price: '100', last_trade_price: '100', funding_rate: '0', current_funding_rate: '0', funding_timestamp: wall - 3600000 } },
  ]).map((f, i) => ({ sequence: i + 1, clock: { wall, mono: i }, raw: JSON.stringify(f) }));
  const manifest = { version: 1 as const, id: 'fixture', source: lighterStreamUrl, markets: captured, staleMs: 5000, marketStats: true,
    startedMs: wall, endedMs: wall, state: 'closed' as const, reason: 'Stopped', frames: frames.length,
    bytes: frames.reduce((n, f) => n + Buffer.byteLength(f.raw), 0) };
  const capture = { manifest, frames, sha256: sha256(JSON.stringify({ manifest, frames })) }, replay = replayCapture(capture);
  const a = new LighterAcceptance();
  for (let mono = 0; mono <= duration; mono += 1000) a.sample({ wall: wall + mono, mono, healthy: true,
    recordingFailures: 0, accepted: mono + 1, tradeFrames: mono + 1, disconnects: 0 });
  const report: Record<string, any> = { ...a.report(duration, [{ id: 'fixture', snapshotRooted: true, statsCovered: true, frames: frames.length, stateSha256: replay.stateSha256, error: null }],
    metadata.map(m => ({ marketId: m.market_id, tradesObserved: true }))), metadata, metadataResolved: true,
    observation: { startedMono: 0, endedMono: duration }, endedAt: new Date(wall + duration).toISOString(),
    metadataSource: 'https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails', sourcesStable: true,
    sources: acceptanceSourceFiles.map(file => ({ file, bytes: 1, sha256: 'a'.repeat(64) })),
    clocks: Array.from({ length: Math.ceil(duration / clockPolicy.recheckMs) + 1 }, (_, i) => {
      const observedMono = Math.min(i * clockPolicy.recheckMs, duration);
      return { ...evaluateWindowsClock('win32', { ...clockCommand }), observedMono,
        phase: i === 0 ? 'starting' : observedMono === duration ? 'finalizing' : 'observing', observedAt: new Date(wall + observedMono).toISOString() };
    }) };
  await Bun.write(join(dir, 'fixture.json'), JSON.stringify(capture));
  await Bun.write(join(dir, 'metadata.json'), JSON.stringify({ code: 200, order_book_details: metadata.map(m => ({ ...m, status: 'active', market_type: 'perp' })) }));
  report.artifacts = await Promise.all(['fixture.json', 'metadata.json'].map(file => hashEvidenceFile(dir, file)));
  const progress = new AcceptanceProgress(pathToFileURL(`${dir}/`), { startedAt: new Date(wall).toISOString(), pid: 123, requestedSeconds: duration / 1000, symbols: metadata.map(m => m.symbol) });
  const publish = () => progress.finish(report as any);
  await publish();
  return { dir, report, publish, close: () => rmSync(dir, { recursive: true, force: true }) };
}

test('inspector distinguishes a verified short sample from sustained evidence without granting authority', async () => {
  const f = await fixture();
  try {
    expect(await inspectAcceptance(f.dir)).toMatchObject({ status: 'verified-completed', complete: true, samplePassed: true,
      sustainedFeedAccepted: false, automationAuthorized: false, agentsEnabled: false, executionEnabled: false, liveSigningEnabled: false });
  } finally { f.close(); }
});

test('capture markets ordered by market_id still bind to requested-symbol report metadata', async () => {
  // Regression: run 560e457b requested BTC,ETH while the stream captured ETH(0),BTC(1).
  const eth = { symbol: 'ETH', market_id: 0, supported_price_decimals: 2, supported_size_decimals: 4 };
  const requested = [market, eth], streamOrder = [eth, market];
  const f = await fixture(60000, requested, streamOrder);
  try {
    expect(await inspectAcceptance(f.dir)).toMatchObject({ status: 'verified-completed', samplePassed: true, sustainedFeedAccepted: false,
      automationAuthorized: false, executionEnabled: false, artifactChecks: [{ file: 'fixture.json', passed: true }, { file: 'metadata.json', passed: true }] });
  } finally { f.close(); }
  // Order is the only tolerated difference: dropped, extra, altered-precision or duplicate-ID markets still fail the capture binding.
  for (const metadata of [[market], [market, { ...eth, supported_size_decimals: 5 }], [market, eth, { ...eth, symbol: 'SOL', market_id: 2 }],
    [market, { ...eth, market_id: 1 }], [market, { ...eth, symbol: 'ETH2' }]]) {
    const g = await fixture(60000, requested, streamOrder);
    try {
      g.report.metadata = metadata; await g.publish();
      const result = await inspectAcceptance(g.dir);
      expect(result.samplePassed).toBe(false);
      expect(result.failures).toContain('fixture.json: Capture replay mismatch');
    } finally { g.close(); }
  }
});

test('a full-duration fixture validates inspector arithmetic, never real mainnet acceptance', async () => {
  const f = await fixture(acceptanceCriteria.sustainedMs);
  try { expect((await inspectAcceptance(f.dir)).sustainedFeedAccepted).toBe(true); }
  finally { f.close(); }
});

test('no report means no acceptance even when heartbeat claims completion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-acceptance-pending-'));
  try {
    expect((await inspectAcceptance(dir)).status).toBe('legacy-or-untracked');
    await Bun.write(join(dir, 'run.json'), JSON.stringify({ pid: 6308, complete: true, sustainedFeedAccepted: true }));
    expect(await inspectAcceptance(dir)).toMatchObject({ status: 'pending-or-interrupted', samplePassed: false, sustainedFeedAccepted: false });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('report edits and heartbeat mismatches cannot establish completed acceptance', async () => {
  const f = await fixture();
  try {
    const reportPath = join(f.dir, 'report.json'), runPath = join(f.dir, 'run.json');
    await Bun.write(reportPath, (await Bun.file(reportPath).text()) + ' ');
    expect((await inspectAcceptance(f.dir)).failures).toContain('Completed heartbeat/report binding is missing or mismatched');
    await f.publish();
    const run = await Bun.file(runPath).json(); run.pid = 6308;
    await Bun.write(runPath, JSON.stringify(run));
    expect((await inspectAcceptance(f.dir)).samplePassed).toBe(false);
  } finally { f.close(); }
});

test('missing clocks, source changes and softened health policies are unverifiable even with updated report hashes', async () => {
  for (const mutate of [
    (r: any) => { r.clocks = []; }, (r: any) => { r.clocks[0].command.exitCode = 38; },
    (r: any) => { r.clocks.at(-1).observedMono = 1; },
    (r: any) => { r.sources = []; }, (r: any) => { r.sourcesStable = false; },
    (r: any) => { r.criteria = { ...r.criteria, maximumSampleGapMs: 5000 }; },
    (r: any) => { r.maximumSampleGapMs = 2501; }, (r: any) => { r.healthyMs = -1; },
    (r: any) => { r.markets[0].tradesObserved = false; }, (r: any) => { r.sustainedFeedAccepted = true; },
    (r: any) => { r.captures[0].stateSha256 = 'b'.repeat(64); }, (r: any) => { r.artifacts.push(r.artifacts[0]); },
  ]) {
    const f = await fixture();
    try { mutate(f.report); await f.publish(); expect((await inspectAcceptance(f.dir)).samplePassed).toBe(false); }
    finally { f.close(); }
  }
});

test('modified, missing and path-traversal artifacts fail closed without reading outside the run', async () => {
  for (const action of ['modify', 'missing', 'traversal', 'directory']) {
    const f = await fixture();
    try {
      if (action === 'modify') await Bun.write(join(f.dir, 'fixture.json'), '{}');
      else if (action === 'missing') rmSync(join(f.dir, 'fixture.json'));
      else if (action === 'directory') { rmSync(join(f.dir, 'fixture.json')); mkdirSync(join(f.dir, 'fixture.json')); }
      else { f.report.artifacts[0].file = '../fixture.json'; await f.publish(); }
      expect((await inspectAcceptance(f.dir)).samplePassed).toBe(false);
    } finally { f.close(); }
  }
});

test('source fingerprints cover the observer and runtime dependencies reproducibly', async () => {
  const root = new URL('../', import.meta.url);
  const sources = await hashAcceptanceSources(fileURLToPath(root));
  expect(sources.map(s => s.file)).toEqual([...acceptanceSourceFiles]);
  expect(sources.every(s => s.bytes > 0 && /^[a-f0-9]{64}$/.test(s.sha256))).toBe(true);
  expect(await hashAcceptanceSources(fileURLToPath(root))).toEqual(sources);
  const visited = new Set<string>();
  const visit = async (file: string) => {
    if (visited.has(file)) return;
    visited.add(file); expect(acceptanceSourceFiles).toContain(file);
    const text = await Bun.file(new URL(file, root)).text();
    for (const match of text.matchAll(/(?:import|export)\s+(?!type\b)[^;\n]*?\bfrom\s+['"]([^'"]+)['"]/g)) {
      if (match[1].startsWith('.')) {
        const url = new URL(`${match[1]}.ts`, new URL(file, root));
        await visit(url.href.slice(root.href.length));
      }
    }
  };
  await visit('scripts/accept-lighter.ts');
});

test('linked evidence directories and invalid UTF-8 records are refused', async () => {
  const f = await fixture(), parent = mkdtempSync(join(tmpdir(), 'dream-evidence-link-'));
  try {
    const link = join(parent, 'run');
    symlinkSync(f.dir, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect((await inspectAcceptance(link)).samplePassed).toBe(false);
    await Bun.write(join(f.dir, 'bad.json'), new Uint8Array([0x22, 0xff, 0x22]));
    await expect(readEvidenceFile(f.dir, 'bad.json')).rejects.toThrow();
  } finally { rmSync(parent, { recursive: true, force: true }); f.close(); }
});

test('malformed report, heartbeat and nested evidence fail closed with structured diagnostics', async () => {
  for (const mutate of [
    (r: any) => { r.clocks = [null, null]; }, (r: any) => { r.clocks[0].command = { stdout: 42 }; },
    (r: any) => { r.captures = [null]; }, (r: any) => { r.artifacts = [null]; },
    (r: any) => { r.metadata = {}; }, (r: any) => { r.markets = [null]; },
  ]) {
    const f = await fixture();
    try { mutate(f.report); await f.publish(); expect(await inspectAcceptance(f.dir)).toMatchObject({ status: 'failed-or-unverifiable', samplePassed: false }); }
    finally { f.close(); }
  }
  for (const file of ['report.json', 'run.json']) {
    for (const raw of ['{', 'null', '[]', '42']) {
      const f = await fixture();
      try {
        await Bun.write(join(f.dir, file), raw);
        const result = await inspectAcceptance(f.dir);
        expect(result.samplePassed).toBe(false); expect(result.failures.length).toBeGreaterThan(0);
        expect(result.executionEnabled).toBe(false);
      } finally { f.close(); }
    }
  }
});

test('clock coverage binds the actual sample window, periodic gaps, phases and wall/monotonic agreement', async () => {
  const duration = 1800000;
  for (const mutate of [
    (r: any) => { delete r.observation; },
    (r: any) => { r.observation.startedMono = -1; },
    (r: any) => { r.observation.startedMono = 1; r.observation.endedMono = duration + 1; },
    (r: any) => { r.observation.endedMono--; },
    (r: any) => { r.clocks.splice(1, 1); },
    (r: any) => { r.clocks[1].phase = 'starting'; },
    (r: any) => { r.clocks[1].observedMono = -1; },
    (r: any) => { r.clocks[1].observedAt = new Date(wall + 900000 + 2001).toISOString(); },
    (r: any) => { r.clocks[0].policy = { ...clockPolicy, maximumSyncAgeSeconds: 86400 }; },
    (r: any) => { r.samples = 2; }, (r: any) => { r.longestUnhealthyMs = 1; },
    (r: any) => { r.endedAt = new Date(wall).toISOString(); },
  ]) {
    const f = await fixture(duration);
    try { mutate(f.report); await f.publish(); expect((await inspectAcceptance(f.dir)).samplePassed).toBe(false); }
    finally { f.close(); }
  }
  const f = await fixture(duration);
  try {
    // The declared scheduling/query allowance is inclusive; one millisecond more is refused.
    f.report.clocks[1].observedMono = clockPolicy.recheckMs + 75000;
    f.report.clocks[1].observedAt = new Date(wall + f.report.clocks[1].observedMono).toISOString();
    await f.publish(); expect((await inspectAcceptance(f.dir)).failures).toEqual([]);
    f.report.clocks[1].observedMono++;
    f.report.clocks[1].observedAt = new Date(wall + f.report.clocks[1].observedMono).toISOString();
    await f.publish(); expect((await inspectAcceptance(f.dir)).samplePassed).toBe(false);
  } finally { f.close(); }
});

test('rebound hashes cannot hide disabled stats, weakened replay freshness or substituted capture identity', async () => {
  for (const change of ['stats', 'freshness', 'identity']) {
    const f = await fixture();
    try {
      const capture = await Bun.file(join(f.dir, 'fixture.json')).json();
      if (change === 'stats') {
        capture.manifest.marketStats = false;
        capture.frames.pop(); capture.manifest.frames = capture.frames.length;
        capture.manifest.bytes = capture.frames.reduce((n: number, frame: any) => n + Buffer.byteLength(frame.raw), 0);
        f.report.captures[0].frames = capture.frames.length;
      }
      else if (change === 'freshness') capture.manifest.staleMs = 5001;
      else capture.manifest.id = 'different';
      capture.sha256 = sha256(JSON.stringify({ manifest: capture.manifest, frames: capture.frames }));
      f.report.captures[0].stateSha256 = replayCapture(capture).stateSha256;
      await Bun.write(join(f.dir, 'fixture.json'), JSON.stringify(capture));
      f.report.artifacts[0] = await hashEvidenceFile(f.dir, 'fixture.json');
      await f.publish(); expect((await inspectAcceptance(f.dir)).samplePassed).toBe(false);
    } finally { f.close(); }
  }
});

test('unsafe evidence filenames and invalid inspector CLI arguments are rejected offline', async () => {
  for (const file of ['../report.json', 'C:/report.json', '/report.json', 'sub/report.json', 'report.json:stream'])
    await expect(readEvidenceFile('.', file)).rejects.toThrow('Unsafe evidence filename');
  const path = new URL('../scripts/inspect-lighter-acceptance.ts', import.meta.url);
  for (const [args, exit] of [[['--help'], 0], [['../'], 1], [['--live'], 1]] as const) {
    const child = Bun.spawn([process.execPath, fileURLToPath(path), ...args], { stdout: 'pipe', stderr: 'pipe' });
    await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(await child.exited).toBe(exit);
  }
});

test('acceptance CLI publishes a bound failed report and closes its DB before any network access when clock preflight fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-clock-preflight-cli-'));
  try {
    const root = fileURLToPath(new URL('../', import.meta.url));
    for (const file of acceptanceSourceFiles) {
      mkdirSync(dirname(join(dir, file)), { recursive: true }); copyFileSync(join(root, file), join(dir, file));
    }
    await Bun.write(join(dir, 'guard.ts'), `
Bun.spawn = ((command: string[], options: any) => {
  if (command[0] !== 'w32tm') throw new Error('Unexpected subprocess');
  return { stdout: new Blob(['The service has not been started. (0x80070426)']).stream(),
    stderr: new Blob(['']).stream(), exited: Promise.resolve(38) };
}) as any;
globalThis.fetch = (async () => { await Bun.write('network-attempted', 'fetch'); throw new Error('Network forbidden'); }) as any;
globalThis.WebSocket = class { constructor() { Bun.write('network-attempted', 'socket'); throw new Error('Network forbidden'); } } as any;
`);
    const child = Bun.spawn([process.execPath, '--preload', join(dir, 'guard.ts'), join(dir, 'scripts/accept-lighter.ts'), '--seconds', '60'],
      { cwd: dir, stdout: 'pipe', stderr: 'pipe', timeout: 10000 });
    await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(await child.exited).toBe(1); expect(existsSync(join(dir, 'network-attempted'))).toBe(false);
    const runs = readdirSync(join(dir, 'data/acceptance')); expect(runs).toHaveLength(1);
    const runDir = join(dir, 'data/acceptance', runs[0]);
    const report = await Bun.file(join(runDir, 'report.json')).json(), heartbeat = await Bun.file(join(runDir, 'run.json')).json();
    expect(report).toMatchObject({ samplePassed: false, sustainedFeedAccepted: false, sourcesStable: true, acceptedFrames: 0,
      metadataResolved: false, automationAuthorized: false, executionEnabled: false });
    expect(report.failures.some((f: string) => f.includes('Host clock preflight failed'))).toBe(true);
    expect(report.clocks[0].command.exitCode).toBe(38);
    expect(heartbeat.complete).toBe(true); expect(heartbeat.reportSha256).toBe((await hashEvidenceFile(runDir, 'report.json')).sha256);
    expect((await inspectAcceptance(runDir)).samplePassed).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('observer metadata, source-change, shutdown and finalization failures remain isolated and close their DB', async () => {
  for (const scenario of ['duplicate-metadata', 'invalid-metadata', 'source-change', 'shutdown', 'shutdown-recording', 'final-clock', 'finalization', 'initialization']) {
    const dir = mkdtempSync(join(tmpdir(), 'dream-acceptance-failure-cli-'));
    try {
      const root = fileURLToPath(new URL('../', import.meta.url));
      for (const file of acceptanceSourceFiles) {
        mkdirSync(dirname(join(dir, file)), { recursive: true }); copyFileSync(join(root, file), join(dir, file));
      }
      // Instrument copied sources, not the project or the legacy observer. Bun preloads
      // can have a distinct module identity from the CLI on Windows.
      const cli = join(dir, 'scripts/accept-lighter.ts');
      await Bun.write(cli, (await Bun.file(cli).text()).replace('store.db.close();',
        "store.db.close(); require('node:fs').writeFileSync('db-closed', 'closed');"));
      const streamPath = join(dir, 'src/lighter-stream.ts');
      if (scenario === 'initialization') await Bun.write(streamPath, (await Bun.file(streamPath).text()).replace(
        'constructor(private store: Store, private options: Options = {}) {',
        "constructor(private store: Store, private options: Options = {}) { throw new Error('Fixture stream initialization failed');"));
      if (scenario === 'shutdown') await Bun.write(streamPath, (await Bun.file(streamPath).text()).replace(
        'stop() {', "stop() { throw new Error('Fixture shutdown failed');"));
      if (scenario === 'shutdown-recording') await Bun.write(streamPath, (await Bun.file(streamPath).text()).replace(
        'stop() {', 'stop() { this.counts.recordingFailures++;'));
      await Bun.write(join(dir, 'guard.ts'), `
const scenario = ${JSON.stringify(scenario)};
let queries = 0;
Bun.spawn = (() => {
  const failed = scenario === 'final-clock' && ++queries > 1;
  return { stdout: new Blob([failed ? 'Service unavailable' : ${JSON.stringify(clockCommand.stdout)}]).stream(),
    stderr: new Blob(['']).stream(), exited: Promise.resolve(failed ? 38 : 0) };
}) as any;
globalThis.WebSocket = class { constructor() { require('node:fs').writeFileSync('network-attempted', 'socket'); throw new Error('Network forbidden'); } } as any;
globalThis.fetch = (async () => {
  if (scenario === 'source-change') { await Bun.write('src/lighter.ts', (await Bun.file('src/lighter.ts').text()) + '\\n// isolated change\\n'); throw new Error('Fixture metadata refused'); }
  if (scenario === 'duplicate-metadata' || scenario === 'invalid-metadata') {
    const markets = [{ symbol: 'BTC', market_id: 1, status: 'active', market_type: 'perp', supported_price_decimals: 2, supported_size_decimals: 5 },
      { symbol: 'ETH', market_id: 1, status: 'active', market_type: 'perp', supported_price_decimals: 2, supported_size_decimals: scenario === 'invalid-metadata' ? 9 : 5 }];
    return Response.json({ code: 200, order_book_details: markets });
  }
  throw new Error('Fixture metadata refused');
}) as any;
const write = Bun.write;
Bun.write = ((path, contents, ...rest) => {
  if (scenario === 'finalization' && String(path).endsWith('run.json.tmp') && typeof contents === 'string' && JSON.parse(contents).phase === 'finalizing') throw new Error('Fixture finalization write failed');
  return write(path, contents, ...rest);
}) as any;
`);
      const child = Bun.spawn([process.execPath, '--preload', join(dir, 'guard.ts'), join(dir, 'scripts/accept-lighter.ts'), '--seconds', '60'],
        { cwd: dir, stdout: 'pipe', stderr: 'pipe', timeout: 10000 });
      const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(await child.exited).toBe(1); expect(existsSync(join(dir, 'network-attempted'))).toBe(false);
      expect({ scenario, stdout, stderr, closed: existsSync(join(dir, 'db-closed')) }).toMatchObject({ closed: true });
      const runs = readdirSync(join(dir, 'data/acceptance')); expect(runs).toHaveLength(1);
      const runDir = join(dir, 'data/acceptance', runs[0]);
      const result = await inspectAcceptance(runDir); expect(result.samplePassed).toBe(false);
      if (scenario === 'initialization') {
        expect(stderr).toContain('Fixture stream initialization failed');
        expect(existsSync(join(runDir, 'run.json'))).toBe(false);
        expect(existsSync(join(runDir, 'report.json'))).toBe(false);
      } else if (scenario === 'finalization') {
        const heartbeat = await Bun.file(join(runDir, 'run.json')).json();
        expect(heartbeat).toMatchObject({ complete: false, phase: 'failed' });
        expect(existsSync(join(runDir, 'report.json'))).toBe(false);
      } else {
        const report = await Bun.file(join(runDir, 'report.json')).json();
        expect(report).toMatchObject({ samplePassed: false, sustainedFeedAccepted: false, metadataResolved: false });
        const reason = scenario === 'source-change' ? 'Observer source/dependency files changed' :
          scenario === 'shutdown' ? 'Fixture shutdown failed' : scenario === 'shutdown-recording' ? 'Durable feed recording failed during shutdown' :
          scenario === 'final-clock' ? 'Host clock preflight failed' : scenario === 'duplicate-metadata' ? 'Duplicate resolved market identity' : 'Invalid streaming metadata';
        expect(report.failures.some((f: string) => f.includes(reason))).toBe(true);
        const heartbeat = await Bun.file(join(runDir, 'run.json')).json();
        expect(heartbeat.complete).toBe(true); expect(heartbeat.reportSha256).toBe((await hashEvidenceFile(runDir, 'report.json')).sha256);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});