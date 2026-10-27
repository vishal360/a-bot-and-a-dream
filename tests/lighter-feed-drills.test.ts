import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { feedDrillNames, runFeedDrills } from '../scripts/lighter-feed-drills';
import { replayCapture } from '../src/lighter-evidence';

const parent = mkdtempSync(join(tmpdir(), 'dream-feed-drills-'));
const directory = pathToFileURL(join(parent, 'evidence') + '/');
let report: Awaited<ReturnType<typeof runFeedDrills>>;
beforeAll(async () => { report = await runFeedDrills(directory); }, 15000);
afterAll(() => rmSync(parent, { recursive: true, force: true }));

for (const name of feedDrillNames) test(`isolated feed drill: ${name}`, () => {
  const result = report.results.find(r => r.name === name)!;
  expect(result.error).toBeNull();
  expect(result.checks.filter(c => !c.passed)).toEqual([]);
  expect(result.checks.length).toBeGreaterThan(0);
  expect(result.passed).toBe(true);
});

test('published drill report is durable, fixture-labeled and never grants acceptance or order authority', async () => {
  const published = await Bun.file(new URL('report.json', directory)).json();
  expect(published).toEqual(report);
  expect(published).toMatchObject({ complete: true, passed: true, samplePassed: false, sustainedFeedAccepted: false,
    strategyValidated: false, automationAuthorized: false, agentsEnabled: false, executionEnabled: false, liveSigningEnabled: false });
  expect(published.source).toContain('NOT mainnet acceptance');
  expect(published.results.map((r: { name: string }) => r.name)).toEqual([...feedDrillNames]);
  expect(existsSync(fileURLToPath(new URL('report.json.tmp', directory)))).toBe(false);
  expect(published.limitations.length).toBe(4);
});

test('every retained drill artifact and source file reproduces its hash and byte count', async () => {
  expect(report.artifacts.length).toBeGreaterThan(10);
  expect(report.sources.length).toBe(10);
  for (const artifact of [...report.artifacts, ...report.sources]) {
    const url = report.sources.includes(artifact) ? new URL(`../${artifact.file}`, import.meta.url) : new URL(artifact.file, directory);
    const bytes = await Bun.file(url).arrayBuffer();
    expect(bytes.byteLength).toBe(artifact.bytes);
    expect(new Bun.CryptoHasher('sha256').update(bytes).digest('hex')).toBe(artifact.sha256);
  }
});

test('closed-database restore preserves interrupted roots but never resumes book continuity', async () => {
  const before = await Bun.file(new URL('restart-before.json', directory)).json();
  for (const name of ['restart-original', 'restart-restored']) {
    const after = await Bun.file(new URL(`${name}-interrupted.json`, directory)).json();
    expect(after.manifest.id).toBe(before.manifest.id);
    expect(after.manifest.state).toBe('interrupted');
    expect(after.frames).toEqual(before.frames);
    expect(replayCapture(after)).toMatchObject({ snapshotRooted: true, statsCovered: true, executionEnabled: false });
  }
});

test('patched observer recording-failure and slow-heartbeat evidence cannot qualify', async () => {
  const recording = await Bun.file(new URL('recording-failure-acceptance.json', directory)).json();
  const stall = await Bun.file(new URL('slow-heartbeat/report.json', directory)).json();
  const heartbeat = await Bun.file(new URL('slow-heartbeat/run.json', directory)).json();
  expect(recording).toMatchObject({ samplePassed: false, sustainedFeedAccepted: false, recordingFailures: 1, elapsedMs: 1000 });
  expect(recording.failures).toContain('Requested observation duration not completed');
  expect(stall).toMatchObject({ samplePassed: false, sustainedFeedAccepted: false, elapsedMs: 3001, maximumSampleGapMs: 3001, samples: 2 });
  expect(stall.failures).toContain('Observer sampling gap exceeded policy');
  expect(heartbeat).toMatchObject({ complete: true, samplePassed: false, sustainedFeedAccepted: false, automationAuthorized: false, executionEnabled: false });
});

test('drill output refuses an existing directory without changing its report', async () => {
  const before = await Bun.file(new URL('report.json', directory)).text();
  const files = readdirSync(fileURLToPath(directory));
  await expect(runFeedDrills(directory)).rejects.toThrow();
  expect(await Bun.file(new URL('report.json', directory)).text()).toBe(before);
  expect(readdirSync(fileURLToPath(directory))).toEqual(files);
});

test('drill CLI help and unsafe/unknown arguments are offline and bounded', async () => {
  const cli = fileURLToPath(new URL('../scripts/drill-lighter-feed.ts', import.meta.url));
  for (const [args, code] of [[['--help'], 0], [['--live'], 1], [['--account', '1'], 1], [['--seconds', '86400'], 1]] as const) {
    const child = Bun.spawn([process.execPath, cli, ...args], { stdout: 'pipe', stderr: 'pipe', timeout: 10000 });
    const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit).toBe(code);
    if (code === 0) { expect(out).toContain('No mainnet traffic'); expect(err).toBe(''); }
    else expect(err).toContain('Invalid arguments');
  }
}, 15000);