import { lstatSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptanceSourceFiles, sha256, type EvidenceHash } from './lighter-acceptance-evidence';
import { evaluateWindowsClock } from './lighter-acceptance-clock';

const safety = Object.freeze({ automationAuthorized: false, agentsEnabled: false, executionEnabled: false, liveSigningEnabled: false });
const helperFiles = [
  'data/resumption/acceptance-hardening-check.ts', 'data/resumption/acceptance-hardening-state.ts',
  'data/resumption/acceptance-hardening-package.ts', 'data/resumption/acceptance-hardening-helpers.test.ts',
];
export const reviewStages = Object.freeze(['typecheck', 'helperTypecheck', 'helperTests', 'targeted', 'unit',
  'build', 'browser', 'drills', 'whitespace', 'preflight', 'legacy', 'failedShort']);
export const reviewStageArguments: Readonly<Record<string, readonly string[]>> = Object.freeze({
  typecheck: ['run', 'typecheck'],
  helperTypecheck: ['node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022',
    '--module', 'ESNext', '--moduleResolution', 'Bundler', '--esModuleInterop', '--types', 'bun', ...helperFiles],
  helperTests: ['test', './data/resumption/acceptance-hardening-helpers.test.ts'],
  targeted: ['test', './tests/lighter-acceptance-clock.test.ts', './tests/lighter-acceptance-inspection.test.ts',
    './tests/lighter-acceptance-progress.test.ts', './tests/lighter-acceptance-observation.test.ts',
    './tests/lighter-acceptance.test.ts', './tests/lighter-feed-drills.test.ts', './tests/lighter-foundation-gate.test.ts'],
  unit: ['run', 'test'], build: ['run', 'build'], browser: ['node_modules/@playwright/test/cli.js', 'test'],
  drills: ['run', 'scripts/drill-lighter-feed.ts'], whitespace: ['diff', '--check'],
  preflight: ['run', 'scripts/lighter-acceptance-clock.ts'],
  legacy: ['run', 'scripts/inspect-lighter-acceptance.ts', 'a8923e7b-c22a-42a8-9cfd-98789e28f7db'],
  failedShort: ['run', 'scripts/inspect-lighter-acceptance.ts', '4b7bb361-1c97-41f2-bfcc-46893bf47c44'],
});
const rootFiles = ['.dockerignore', '.gitignore', 'Dockerfile', 'README.md', 'bun.lock', 'index.html',
  'package.json', 'tsconfig.json', 'playwright.config.ts', 'vite.config.ts', 'uptill.txt', 'AGENTS.md'];
const sourceAllowed = (file: string) => rootFiles.includes(file) || helperFiles.includes(file) ||
  /^(?:src|scripts|tests|e2e|docs|\.github\/workflows)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|css|md|ps1|sh|yml|yaml|py|txt|toml)$|^research\/[A-Za-z0-9_./-]+\.(?:py|txt|toml|json)$/.test(file);
const safePath = (file: string) => typeof file === 'string' && /^[A-Za-z0-9._/-]+$/.test(file) &&
  file.split('/').every(part => part && part !== '.' && part !== '..');
const validHash = (record: any): record is EvidenceHash => record && safePath(record.file) &&
  Number.isSafeInteger(record.bytes) && record.bytes >= 0 && /^[a-f0-9]{64}$/.test(record.sha256);
const disabled = (record: any) => record && Object.keys(safety).every(key => record[key] === false);
const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

/** Refuse links in every component, traversal, special files and oversized reads. */
async function readBounded(directory: string, file: string, limit = 16 * 1024 * 1024) {
  if (!safePath(file)) throw new Error(`Unsafe relative path: ${file}`);
  const base = resolve(directory);
  let path = base;
  while (true) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Linked or non-directory evidence ancestor refused');
    const parent = resolve(path, '..');
    if (parent === path) break;
    path = parent;
  }
  path = base;
  for (const part of file.split('/')) {
    path = resolve(path, part);
    if (lstatSync(path).isSymbolicLink()) throw new Error(`Linked file path refused: ${file}`);
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > limit) throw new Error(`Unbounded or non-file evidence: ${file}`);
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  if (bytes.byteLength > limit) throw new Error(`Read byte limit exceeded: ${file}`);
  return bytes;
}

export async function currentReviewSources(root: string) {
  const files = Bun.spawnSync(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root });
  const head = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root });
  if (files.exitCode !== 0 || head.exitCode !== 0) throw new Error('Cannot determine working-tree source state');
  const paths = [...new Set([...files.stdout.toString('utf8').split('\0').filter(Boolean), ...helperFiles])].sort();
  const sources = await Promise.all(paths.map(async file => {
    if (!safePath(file) || !sourceAllowed(file)) throw new Error(`Non-source path refused: ${file}`);
    const bytes = await readBounded(root, file, 4 * 1024 * 1024);
    return { file, bytes: bytes.byteLength, sha256: sha256(bytes) };
  }));
  const gitHead = head.stdout.toString('utf8').trim();
  return { gitHead, fingerprint: sha256(JSON.stringify({ gitHead, sources })), sources };
}

/** Independent read-only verification, not a packager and never a trading permission. */
export async function verifyReviewBundle(directory: string, root: string) {
  const failures: string[] = [];
  const stages: { stage: string; exitCode: number }[] = [];
  let manifestSha256: string | null = null, sourceFingerprint: string | null = null;
  let verifiedFiles = 0, verifiedSources = 0, workingSourcesMatch = false;
  try {
    const manifestBytes = await readBounded(directory, 'manifest.json');
    manifestSha256 = sha256(manifestBytes);
    const manifest = JSON.parse(decode(manifestBytes));
    if (manifest?.version !== 1 || manifest.complete !== true || !disabled(manifest) ||
        manifest.timestampScope !== 'Uncertified local host time' || !/^[a-f0-9]{40}$/.test(manifest.gitHead) ||
        !/^[a-f0-9]{64}$/.test(manifest.sourceFingerprint) || !Array.isArray(manifest.included) ||
        manifest.included.length < 1 || manifest.included.length > 512 ||
        manifest.included.some((entry: any) => !validHash(entry) || entry.bytes > 16 * 1024 * 1024 ||
          !(entry.file.startsWith('source/') && sourceAllowed(entry.file.slice(7)) ||
            /^validation\/[A-Za-z0-9._-]+\.(?:json|log)$/.test(entry.file))) ||
        new Set(manifest.included.map((entry: EvidenceHash) => entry.file)).size !== manifest.included.length ||
        manifest.included.reduce((sum: number, entry: EvidenceHash) => sum + entry.bytes, 0) > 64 * 1024 * 1024)
      throw new Error('Invalid, unsafe or unbounded review manifest');
    sourceFingerprint = manifest.sourceFingerprint;
    const retained = new Map<string, Uint8Array>();
    for (const entry of manifest.included as EvidenceHash[]) {
      const bytes = await readBounded(directory, entry.file, entry.file.startsWith('source/') ? 4 * 1024 * 1024 : undefined);
      if (bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.sha256) throw new Error(`Bundle file hash mismatch: ${entry.file}`);
      retained.set(entry.file, bytes); verifiedFiles++;
    }
    const json = (file: string) => JSON.parse(decode(required(file)));
    const required = (file: string) => {
      const bytes = retained.get(`validation/${file}`);
      if (!bytes) throw new Error(`Missing bundled evidence: ${file}`);
      return bytes;
    };
    const sources: EvidenceHash[] = manifest.included.filter((entry: EvidenceHash) => entry.file.startsWith('source/'))
      .map((entry: EvidenceHash) => ({ ...entry, file: entry.file.slice(7) })).sort((a: EvidenceHash, b: EvidenceHash) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
    const state = { gitHead: manifest.gitHead, fingerprint: manifest.sourceFingerprint, sources };
    if (sha256(JSON.stringify({ gitHead: state.gitHead, sources })) !== state.fingerprint) throw new Error('Source fingerprint mismatch');
    for (const entry of sources) {
      const bytes = await readBounded(root, entry.file, 4 * 1024 * 1024);
      if (bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.sha256) failures.push(`Current source differs: ${entry.file}`);
      else verifiedSources++;
    }
    const current = await currentReviewSources(root);
    workingSourcesMatch = current.fingerprint === state.fingerprint;
    if (!workingSourcesMatch) failures.push('Current source set/HEAD differs; rerun validation and packaging');
    const runtime = sources.filter(entry => acceptanceSourceFiles.includes(entry.file));
    if (runtime.length !== acceptanceSourceFiles.length || JSON.stringify(runtime) !== JSON.stringify(manifest.runtimeSources))
      throw new Error('Runtime source subset mismatch');
    const results = new Map<string, any>();
    for (const stage of reviewStages) {
      const result = json(`${stage}-result.json`);
      const expectedExit = ['legacy', 'failedShort'].includes(stage) ? 1 : stage === 'preflight' ? result?.exitCode : 0;
      if (result?.complete !== true || result.sourcesStable !== true || ![0, 1].includes(expectedExit) ||
          result.exitCode !== expectedExit || result.childExitCode !== expectedExit ||
          result.finalSourceFingerprint !== state.fingerprint || JSON.stringify(result.sourceState) !== JSON.stringify(state) ||
          !Number.isFinite(Date.parse(result.startedAt)) || !Number.isFinite(Date.parse(result.endedAt)) ||
          Date.parse(result.endedAt) < Date.parse(result.startedAt) || !Array.isArray(result.command) ||
          typeof result.command[0] !== 'string' ||
          !(stage === 'whitespace' ? ['git', 'git.exe'] : ['bun', 'bun.exe']).includes(basename(result.command[0]).toLowerCase()) ||
          JSON.stringify(result.command.slice(1)) !== JSON.stringify(reviewStageArguments[stage]))
        throw new Error(`Incomplete, failed or source-mismatched stage: ${stage}`);
      for (const [stream, suffix] of [['stdout', 'out'], ['stderr', 'err']]) {
        const bytes = required(`${stage}-${suffix}.log`);
        if (result.logHashes?.[stream]?.bytes !== bytes.byteLength || result.logHashes?.[stream]?.sha256 !== sha256(bytes))
          throw new Error(`Stage log binding mismatch: ${stage}/${stream}`);
      }
      results.set(stage, result); stages.push({ stage, exitCode: result.exitCode });
    }
    if (Date.parse(results.get('browser').startedAt) < Date.parse(results.get('build').endedAt)) throw new Error('Browser stage precedes build completion');
    for (const [stage, field, suffix, pattern] of [
      ['unit', 'unitTests', 'err', /(\d+) pass\b/], ['targeted', 'targetedTests', 'err', /(\d+) pass\b/],
      ['helperTests', 'helperTests', 'err', /(\d+) pass\b/], ['browser', 'browserWorkflows', 'out', /(\d+) passed\b/],
    ] as const) {
      const text = decode(required(`${stage}-${suffix}.log`)), count = Number(pattern.exec(text)?.[1]);
      if (!Number.isSafeInteger(count) || count < 1 || count !== manifest.validation?.[field] ||
          (stage !== 'browser' && !/\b0 fail\b/.test(text))) throw new Error(`Invalid test summary: ${stage}`);
    }
    for (const field of ['typecheck', 'helperTypecheck', 'build', 'trackedWhitespace', 'changedAndUntrackedWhitespace', 'sourcesStable'])
      if (manifest.validation?.[field] !== true) throw new Error(`Missing software validation: ${field}`);
    const clock = json('preflight-out.log'), clockPassed = evaluateWindowsClock(clock.platform, clock.command).passed;
    if (clock.passed !== clockPassed || clockPassed !== (results.get('preflight').exitCode === 0) ||
        clockPassed !== manifest.operational?.clockPassed || clock.automationAuthorized !== false || clock.executionEnabled !== false)
      throw new Error('Clock preflight evidence mismatch');
    for (const stage of ['legacy', 'failedShort']) {
      const inspection = json(`${stage}-out.log`);
      if (!disabled(inspection) || inspection.samplePassed !== false || inspection.sustainedFeedAccepted !== false)
        throw new Error(`Unsafe or inconsistent historical inspection: ${stage}`);
    }
    const drill = json('feed-drills-report.json');
    if (drill.complete !== true || drill.passed !== true || !disabled(drill) || drill.samplePassed !== false || drill.sustainedFeedAccepted !== false ||
        !Array.isArray(drill.results) || drill.results.length !== 9 || drill.results.some((r: any) => r.passed !== true) ||
        manifest.validation.feedDrills !== drill.results.length || !Array.isArray(drill.sources) || drill.sources.length !== 10 ||
        new Set(drill.sources.map((entry: EvidenceHash) => entry.file)).size !== drill.sources.length ||
        drill.sources.some((entry: EvidenceHash) => !validHash(entry) || !sources.some(s => s.file === entry.file && s.bytes === entry.bytes && s.sha256 === entry.sha256)))
      throw new Error('Incomplete, unsafe or source-mismatched fixture drills');
    const before = json('processes-resumed.json'), after = json('processes-final.json'), service = json('time-service-final.json');
    if (!Array.isArray(before) || !Array.isArray(after) || !before.length ||
        before.some((p: any) => !Number.isSafeInteger(p.ProcessId) || typeof p.CommandLine !== 'string' || typeof p.CreationDate !== 'string' ||
          !after.some((q: any) => q.ProcessId === p.ProcessId && q.CommandLine === p.CommandLine && q.CreationDate === p.CreationDate)) ||
        service.Name !== 'W32Time' || typeof service.State !== 'string' || typeof service.StartMode !== 'string')
      throw new Error('Unreadable or changed process/service snapshot evidence');
    if ((await currentReviewSources(root)).fingerprint !== current.fingerprint) throw new Error('Working sources changed during verification');
  } catch (e) { failures.push(`Unverifiable review bundle: ${(e as Error).message}`); }
  return { version: 1, ...safety, passed: failures.length === 0, manifestSha256, sourceFingerprint,
    verifiedFiles, verifiedSources, workingSourcesMatch, stages, failures,
    scope: 'Local source/software review only; hashes are not attestations, fixture drills are not runtime recovery, timestamps are uncertified host time' };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') console.log('Usage: bun run scripts/lighter-review-bundle.ts review-<uuid>\nRead-only independent review under data/resumption/acceptance-hardening/packages. No orders or readiness writes.');
  else {
    if (args.length !== 1 || !/^review-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(args[0])) throw new Error('One review bundle ID required; use --help');
    const root = fileURLToPath(new URL('../', import.meta.url));
    const result = await verifyReviewBundle(resolve(root, 'data/resumption/acceptance-hardening/packages', args[0]), root);
    console.log(JSON.stringify(result, null, 2)); process.exitCode = result.passed ? 0 : 1;
  }
}