import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { acceptanceSourceFiles, sha256 } from '../../scripts/lighter-acceptance-evidence';
import { captureValidationState, readValidationArtifact, readValidationSource, validateStageResult } from './acceptance-hardening-state';

const root = resolve(import.meta.dir, '../..');
const evidence = resolve(import.meta.dir, 'acceptance-hardening');
const state = await captureValidationState(root);
const stages = ['typecheck', 'helperTypecheck', 'helperTests', 'targeted', 'unit', 'build', 'browser', 'drills', 'whitespace', 'preflight', 'legacy', 'failedShort'];
const validations: Record<string, any> = {};
const retained = new Map<string, Uint8Array>();
const read = async (file: string) => {
  const bytes = await readValidationArtifact(evidence, file);
  retained.set(file, bytes);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
};
for (const stage of stages) {
  const result = JSON.parse(await read(`${stage}-result.json`));
  validateStageResult(stage, result, state);
  validations[stage] = result;
  await read(`${stage}-out.log`); await read(`${stage}-err.log`);
  for (const [stream, suffix] of [['stdout', 'out'], ['stderr', 'err']]) {
    const bytes = retained.get(`${stage}-${suffix}.log`)!;
    if (result.logHashes?.[stream]?.bytes !== bytes.byteLength || result.logHashes?.[stream]?.sha256 !== sha256(bytes))
      throw new Error(`Validation log binding mismatch: ${stage}/${stream}`);
  }
}
if (Date.parse(validations.browser.startedAt) < Date.parse(validations.build.endedAt)) throw new Error('Browser validation must follow the final build');

const clock = JSON.parse(new TextDecoder().decode(retained.get('preflight-out.log')));
const legacy = JSON.parse(new TextDecoder().decode(retained.get('legacy-out.log')));
const short = JSON.parse(new TextDecoder().decode(retained.get('failedShort-out.log')));
if (clock.passed !== (validations.preflight.exitCode === 0) || clock.automationAuthorized !== false || clock.executionEnabled !== false ||
    [legacy, short].some(record => record.samplePassed !== false || record.sustainedFeedAccepted !== false ||
      record.automationAuthorized !== false || record.executionEnabled !== false || record.agentsEnabled !== false || record.liveSigningEnabled !== false))
  throw new Error('Operational gate evidence is inconsistent');

// Include only ordinary source files identified by git and the explicitly named helpers.
// Never copy data/ databases, credentials, node_modules, dist or browser runtime state.
const sourceCopies = new Map<string, Uint8Array>();
const changedOutput = Bun.spawnSync(['git', 'diff', '--name-only', 'HEAD', '-z'], { cwd: root });
const newOutput = Bun.spawnSync(['git', 'ls-files', '--others', '--exclude-standard', '-z'], { cwd: root });
if (changedOutput.exitCode !== 0 || newOutput.exitCode !== 0) throw new Error('Cannot inspect changed deliverables');
const changed = [...new Set([...changedOutput.stdout.toString('utf8').split('\0'), ...newOutput.stdout.toString('utf8').split('\0'),
  ...state.sources.filter(s => s.file.startsWith('data/resumption/')).map(s => s.file)])].filter(Boolean).sort();
const whitespaceFailures: string[] = [];
for (const source of state.sources) {
  const bytes = await readValidationSource(root, source.file);
  if (bytes.byteLength !== source.bytes || sha256(bytes) !== source.sha256) throw new Error(`Source changed while packaging: ${source.file}`);
  if (/^(?:\.env(?:\.|$)|data\/)/.test(source.file) && !source.file.startsWith('data/resumption/acceptance-hardening-'))
    throw new Error(`Non-source file refused: ${source.file}`);
  sourceCopies.set(source.file, bytes);
  if (changed.includes(source.file)) {
    const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split(/\r?\n/);
    lines.forEach((line, i) => {
      if (/[\t ]+$/.test(line) || /^\s*(?:<{7}|={7}|>{7})(?:\s|$)/.test(line)) whitespaceFailures.push(`${source.file}:${i + 1}`);
    });
  }
}
if (whitespaceFailures.length) throw new Error(`Whitespace/conflict-marker checks failed: ${whitespaceFailures.join(', ')}`);
if (changed.some(file => !sourceCopies.has(file))) throw new Error('Changed deliverables missing from source snapshot');

const drillLog = new TextDecoder().decode(retained.get('drills-out.log'));
const drillId = /feed-drills[\\/]([a-f0-9-]{36})[\\/]report\.json/.exec(drillLog)?.[1];
if (!drillId) throw new Error('Missing retained drill report');
const drillDirectory = resolve(root, 'data/feed-drills', drillId);
const drillBytes = await readValidationArtifact(drillDirectory, 'report.json');
const drill = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(drillBytes));
if (drill.complete !== true || drill.passed !== true || !Array.isArray(drill.results) || drill.results.length !== 9 || drill.results.some((r: any) => r.passed !== true) ||
    !Array.isArray(drill.sources) || drill.sources.length !== 10 || new Set(drill.sources.map((s: any) => s.file)).size !== 10 ||
    !Array.isArray(drill.artifacts) || drill.artifacts.length < 9 || new Set(drill.artifacts.map((a: any) => a.file)).size !== drill.artifacts.length ||
    drill.automationAuthorized !== false || drill.agentsEnabled !== false || drill.executionEnabled !== false ||
    drill.liveSigningEnabled !== false || drill.samplePassed !== false || drill.sustainedFeedAccepted !== false) throw new Error('Incomplete or unsafe drill report');
for (const source of drill.sources) {
  if (sourceCopies.get(source.file)?.byteLength !== source.bytes || sha256(sourceCopies.get(source.file)!) !== source.sha256)
    throw new Error(`Drill source mismatch: ${source.file}`);
}
for (const artifact of drill.artifacts) {
  const bytes = await readValidationArtifact(drillDirectory, artifact.file);
  if (bytes.byteLength !== artifact.bytes || sha256(bytes) !== artifact.sha256) throw new Error(`Drill artifact mismatch: ${artifact.file}`);
}
retained.set('feed-drills-report.json', drillBytes); // Keep report/hashes, not fixture databases, in the bundle.
for (const file of ['processes-resumed.json', 'time-service-resumed.json', 'processes-final.json', 'time-service-final.json']) await read(file);
const parseRetained = (file: string) => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(retained.get(file)));
const previousProcesses = parseRetained('processes-resumed.json'), finalProcesses = parseRetained('processes-final.json');
for (const pid of [6308, 22500]) {
  const before = previousProcesses.find((p: any) => p.ProcessId === pid), after = finalProcesses.find((p: any) => p.ProcessId === pid);
  if (!before || !after || before.CommandLine !== after.CommandLine || before.CreationDate !== after.CreationDate)
    throw new Error(`Existing process identity changed or missing: ${pid}`);
}
const service = parseRetained('time-service-final.json');
if (service.Name !== 'W32Time' || typeof service.State !== 'string' || typeof service.StartMode !== 'string')
  throw new Error('Missing final Windows Time service snapshot');

const directory = resolve(evidence, 'packages', `review-${crypto.randomUUID()}`);
mkdirSync(directory, { recursive: true });
const included: { file: string; bytes: number; sha256: string }[] = [];
const publish = async (file: string, bytes: Uint8Array) => {
  const path = resolve(directory, file); mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, bytes);
  const actual = new Uint8Array(await Bun.file(path).arrayBuffer());
  if (sha256(actual) !== sha256(bytes)) throw new Error(`Package copy mismatch: ${file}`);
  included.push({ file, bytes: actual.byteLength, sha256: sha256(actual) });
};
for (const [file, bytes] of sourceCopies) await publish(`source/${file}`, bytes);
for (const [file, bytes] of retained) await publish(`validation/${file}`, bytes);
if ((await captureValidationState(root)).fingerprint !== state.fingerprint) throw new Error('Source state changed before package completion');
const count = (file: string, pattern: RegExp) => {
  const match = pattern.exec(new TextDecoder().decode(retained.get(file)));
  if (!match) throw new Error(`Missing test summary: ${file}`);
  return Number(match[1]);
};
const manifest = { version: 1, complete: true, createdAt: new Date().toISOString(), timestampScope: 'Uncertified local host time',
  sourceFingerprint: state.fingerprint, gitHead: state.gitHead, changed, included,
  runtimeSources: state.sources.filter(s => acceptanceSourceFiles.includes(s.file)),
  validation: { typecheck: true, helperTypecheck: true, helperTests: count('helperTests-err.log', /(\d+) pass\b/),
    unitTests: count('unit-err.log', /(\d+) pass\b/), targetedTests: count('targeted-err.log', /(\d+) pass\b/),
    browserWorkflows: count('browser-out.log', /(\d+) passed\b/), build: true, feedDrills: drill.results.length,
    trackedWhitespace: true, changedAndUntrackedWhitespace: true, sourcesStable: true },
  operational: { clockPassed: clock.passed, clockFailures: clock.failures, legacyStatus: legacy.status, failedShortStatus: short.status,
    genuineShortObservation: 'not run in this continuation', sustainedObservation: 'not accepted', existingProcesses: 'left untouched' },
  blockers: ['Administrator-approved host-clock repair and successful preflight', 'Separate verified genuine 60-second and 24-hour observations',
    'Funding/accounting contracts and overnight evidence', 'Strategy validation and paper-forward evidence', 'Explicit future live authorization'],
  automationAuthorized: false, agentsEnabled: false, executionEnabled: false, liveSigningEnabled: false,
  scope: 'Local working-tree source and software-validation review bundle; no commit, publication or mainnet acceptance' };
await Bun.write(resolve(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
await Bun.write(resolve(evidence, 'package-result.json'), JSON.stringify({ complete: true, directory, manifestSha256: sha256(await Bun.file(resolve(directory, 'manifest.json')).arrayBuffer().then(b => new Uint8Array(b))),
  sourceFingerprint: state.fingerprint, validation: manifest.validation, operational: manifest.operational,
  automationAuthorized: false, agentsEnabled: false, executionEnabled: false, liveSigningEnabled: false }, null, 2));
console.log(`Validated local review bundle: ${directory}`);