import { test, expect } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { currentReviewSources, reviewStageArguments, reviewStages, verifyReviewBundle } from '../scripts/lighter-review-bundle';
import { evaluateObservationPair, inspectFoundationGate } from '../scripts/lighter-foundation-gate';
import { evaluateWindowsClock } from '../scripts/lighter-acceptance-clock';
import { acceptanceSourceFiles, sha256, type EvidenceHash } from '../scripts/lighter-acceptance-evidence';

const safety = { automationAuthorized: false, agentsEnabled: false, executionEnabled: false, liveSigningEnabled: false };
const root = resolve(import.meta.dir, '..');
const shortId = '11111111-1111-1111-1111-111111111111', sustainedId = '22222222-2222-2222-2222-222222222222';

async function bundleFixture() {
  const base = mkdtempSync(join(tmpdir(), 'dream-foundation-')), working = join(base, 'working'), bundle = join(base, 'bundle');
  mkdirSync(working); mkdirSync(bundle);
  const original = await currentReviewSources(root);
  for (const source of original.sources) {
    const target = join(working, source.file); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(root, source.file), target);
  }
  for (const command of [
    ['git', 'init', '--quiet'], ['git', 'add', '.'],
    ['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'isolated fixture'],
  ]) {
    const result = Bun.spawnSync(command, { cwd: working });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  }
  const state = await currentReviewSources(working);
  const manifest: any = { version: 1, complete: true, ...safety, timestampScope: 'Uncertified local host time',
    gitHead: state.gitHead, sourceFingerprint: state.fingerprint, included: [],
    runtimeSources: state.sources.filter(entry => acceptanceSourceFiles.includes(entry.file)),
    validation: { typecheck: true, helperTypecheck: true, build: true, trackedWhitespace: true,
      changedAndUntrackedWhitespace: true, sourcesStable: true, unitTests: 2, targetedTests: 2, helperTests: 2, browserWorkflows: 2, feedDrills: 9 },
    operational: { clockPassed: false } };
  const put = async (file: string, contents: string | Uint8Array) => {
    const target = join(bundle, file); mkdirSync(dirname(target), { recursive: true }); await Bun.write(target, contents);
    const bytes = new Uint8Array(await Bun.file(target).arrayBuffer());
    manifest.included = manifest.included.filter((entry: EvidenceHash) => entry.file !== file);
    manifest.included.push({ file, bytes: bytes.byteLength, sha256: sha256(bytes) });
  };
  const save = () => Bun.write(join(bundle, 'manifest.json'), JSON.stringify(manifest));
  for (const source of state.sources) await put(`source/${source.file}`, new Uint8Array(await Bun.file(join(working, source.file)).arrayBuffer()));
  for (const stage of reviewStages) {
    const stdout = stage === 'browser' ? '2 passed\n' : stage === 'preflight' ? JSON.stringify(evaluateWindowsClock('win32', {
      exitCode: 38, stdout: 'The service has not been started. (0x80070426)', stderr: '',
    })) : ['legacy', 'failedShort'].includes(stage) ? JSON.stringify({ ...safety, samplePassed: false, sustainedFeedAccepted: false }) : '';
    const stderr = ['unit', 'targeted', 'helperTests'].includes(stage) ? '2 pass\n0 fail\n' : '';
    const exitCode = ['preflight', 'legacy', 'failedShort'].includes(stage) ? 1 : 0;
    await put(`validation/${stage}-out.log`, stdout); await put(`validation/${stage}-err.log`, stderr);
    await put(`validation/${stage}-result.json`, JSON.stringify({ complete: true, sourcesStable: true, sourceState: state,
      finalSourceFingerprint: state.fingerprint, exitCode, childExitCode: exitCode,
      startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:00:01Z',
      command: [stage === 'whitespace' ? 'git' : process.execPath, ...reviewStageArguments[stage]],
      logHashes: { stdout: { bytes: Buffer.byteLength(stdout), sha256: sha256(stdout) }, stderr: { bytes: Buffer.byteLength(stderr), sha256: sha256(stderr) } } }));
  }
  const browser = await Bun.file(join(bundle, 'validation/browser-result.json')).json();
  browser.startedAt = '2026-01-01T00:00:02Z'; browser.endedAt = '2026-01-01T00:00:03Z';
  await put('validation/browser-result.json', JSON.stringify(browser));
  await put('validation/feed-drills-report.json', JSON.stringify({ complete: true, passed: true, ...safety,
    samplePassed: false, sustainedFeedAccepted: false, results: Array.from({ length: 9 }, () => ({ passed: true })), sources: state.sources.slice(0, 10) }));
  const processSnapshot = [{ ProcessId: 123, CommandLine: 'fixture observer', CreationDate: 'fixture process identity' }];
  await put('validation/processes-resumed.json', JSON.stringify(processSnapshot));
  await put('validation/processes-final.json', JSON.stringify(processSnapshot));
  await put('validation/time-service-final.json', JSON.stringify({ Name: 'W32Time', State: 'Stopped', StartMode: 'Manual' }));
  await save();
  return { base, working, bundle, manifest, state, put, save, close: () => rmSync(base, { recursive: true, force: true }) };
}

test('independent verifier checks twelve source/log-bound stages without promoting failed clock or fixture drills', async () => {
  const f = await bundleFixture();
  try {
    const result = await verifyReviewBundle(f.bundle, f.working);
    expect(result).toMatchObject({ ...safety, passed: true, workingSourcesMatch: true, failures: [], verifiedSources: f.state.sources.length });
    expect(result.verifiedFiles).toBe(f.manifest.included.length); expect(result.stages).toHaveLength(12);
    expect(result.stages.filter(stage => stage.exitCode === 1).map(stage => stage.stage)).toEqual(['preflight', 'legacy', 'failedShort']);
  } finally { f.close(); }
});

test('review verifier rejects tampering, false authority, wrong commands/counts, wrong exits, source and log rebinding faults', async () => {
  const scenarios: Record<string, (f: Awaited<ReturnType<typeof bundleFixture>>) => Promise<any>> = {
    'file hash': f => Bun.write(join(f.bundle, 'validation/unit-err.log'), 'forged'),
    authority: async f => { f.manifest.automationAuthorized = true; await f.save(); },
    traversal: async f => { f.manifest.included[0].file = 'source/../package.json'; await f.save(); },
    duplicate: async f => { f.manifest.included.push(f.manifest.included[0]); await f.save(); },
    fingerprint: async f => { f.manifest.sourceFingerprint = '0'.repeat(64); await f.save(); },
    summary: async f => { f.manifest.validation.unitTests = 999; await f.save(); },
    command: async f => { const r = await Bun.file(join(f.bundle, 'validation/unit-result.json')).json(); r.command = [process.execPath, 'run', 'build']; await f.put('validation/unit-result.json', JSON.stringify(r)); await f.save(); },
    'stage log binding': async f => { await f.put('validation/unit-err.log', '3 pass\n0 fail\n'); f.manifest.validation.unitTests = 3; await f.save(); },
    'failed stage': async f => { const r = await Bun.file(join(f.bundle, 'validation/unit-result.json')).json(); r.exitCode = 1; r.childExitCode = 1; await f.put('validation/unit-result.json', JSON.stringify(r)); await f.save(); },
    'browser ordering': async f => { const r = await Bun.file(join(f.bundle, 'validation/browser-result.json')).json(); r.startedAt = '2025-12-31T23:59:00Z'; await f.put('validation/browser-result.json', JSON.stringify(r)); await f.save(); },
    'new current source': f => Bun.write(join(f.working, 'scripts/new-source.ts'), 'export const changed = true;\n'),
    'modified current source': f => Bun.write(join(f.working, 'scripts/accept-lighter.ts'), '// changed\n'),
    'clock mislabel': async f => { f.manifest.operational.clockPassed = true; await f.save(); },
    'process identity': async f => { await f.put('validation/processes-final.json', '[]'); await f.save(); },
  };
  for (const [scenario, mutate] of Object.entries(scenarios)) {
    const f = await bundleFixture();
    try { await mutate(f); const result = await verifyReviewBundle(f.bundle, f.working); expect({ scenario, passed: result.passed }).toEqual({ scenario, passed: false }); expect(result.failures.length).toBeGreaterThan(0); }
    finally { f.close(); }
  }
}, 120000);

test('review verifier refuses symlinked directory ancestors and oversized manifests', async () => {
  const f = await bundleFixture();
  try {
    const link = join(f.base, 'linked'); symlinkSync(f.bundle, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect((await verifyReviewBundle(link, f.working)).passed).toBe(false);
    await Bun.write(join(f.bundle, 'manifest.json'), ' '.repeat(16 * 1024 * 1024 + 1));
    expect((await verifyReviewBundle(f.bundle, f.working)).passed).toBe(false);
  } finally { f.close(); }
});

const sources: EvidenceHash[] = [{ file: 'scripts/accept-lighter.ts', bytes: 1, sha256: 'a'.repeat(64) }];
function run(seconds: number, id: string, start: number) {
  return { id, inspection: { ...safety, status: 'verified-completed', complete: true, samplePassed: true,
    sustainedFeedAccepted: seconds === 86400, reportSha256: (seconds === 60 ? 'b' : 'c').repeat(64), failures: [], artifactChecks: [] },
    report: { automationAuthorized: false, executionEnabled: false, requestedSeconds: seconds, requestedMs: seconds * 1000, sources,
      symbols: ['BTC'], metadata: [{ symbol: 'BTC', market_id: 1, supported_price_decimals: 2, supported_size_decimals: 5 }],
      startedAt: new Date(start).toISOString(), endedAt: new Date(start + seconds * 1000).toISOString() } };
}

test('pair policy permits only separate ordered current-source short/sustained inspected evidence', () => {
  const short = run(60, shortId, 1800000000000), sustained = run(86400, sustainedId, 1800000060000);
  expect(evaluateObservationPair(short, sustained, sources)).toEqual({ passed: true, failures: [] });
  expect(evaluateObservationPair(null, null, sources).passed).toBe(false);
  for (const mutate of [
    (s: typeof sustained) => { s.id = shortId; },
    (s: typeof sustained) => { s.inspection.reportSha256 = short.inspection.reportSha256; },
    (s: typeof sustained) => { s.inspection.samplePassed = false; },
    (s: typeof sustained) => { s.report.requestedSeconds = 60; },
    (s: typeof sustained) => { s.report.sources[0].sha256 = 'd'.repeat(64); },
    (s: typeof sustained) => { s.report.metadata[0].market_id = 2; },
    (s: typeof sustained) => { s.report.metadata[0].supported_size_decimals = 4; },
    (s: typeof sustained) => { s.report.startedAt = short.report.startedAt; },
    (s: typeof sustained) => { s.report.endedAt = 'not-time'; },
    (s: typeof sustained) => { s.inspection.automationAuthorized = true; },
  ]) {
    const changed = structuredClone(sustained); mutate(changed); expect(evaluateObservationPair(short, changed, sources).passed).toBe(false);
  }
});

test('foundation missing evidence and failed clock stays structured and disabled without observers', async () => {
  let calls = 0;
  const result = await inspectFoundationGate(root, {}, async () => {
    calls++; return { ...evaluateWindowsClock('win32', { exitCode: 38, stdout: 'service stopped', stderr: '' }),
      phase: 'starting', observedAt: new Date().toISOString(), observedMono: 1 };
  });
  expect(calls).toBe(1); expect(result).toMatchObject({ ...safety, foundationEvidencePassed: false });
  expect(result.failures).toHaveLength(4); expect(result.remainingGates).toHaveLength(6);
});

test('unsafe foundation IDs fail before clock queries and cannot select arbitrary evidence paths', async () => {
  for (const options of [{ bundle: '../outside' }, { short: '../outside' }, { sustained: 'not-a-uuid' }]) {
    let called = false;
    const result = await inspectFoundationGate(root, options, async () => { called = true; throw new Error('Forbidden query'); });
    expect(called).toBe(false); expect(result.foundationEvidencePassed).toBe(false);
  }
});

test('new read-only CLIs provide offline help and reject duplicate/unknown flags', async () => {
  for (const file of ['lighter-foundation-gate.ts', 'lighter-review-bundle.ts']) {
    const child = Bun.spawn([process.execPath, join(root, 'scripts', file), '--help'], { stdout: 'pipe', stderr: 'pipe' });
    const text = await new Response(child.stdout).text(); expect(await child.exited).toBe(0); expect(text).toContain('Read-only');
  }
  const child = Bun.spawn([process.execPath, join(root, 'scripts/lighter-foundation-gate.ts'), '--short', shortId, '--short', shortId], { stdout: 'pipe', stderr: 'pipe' });
  await new Response(child.stderr).text(); expect(await child.exited).toBe(1);
});