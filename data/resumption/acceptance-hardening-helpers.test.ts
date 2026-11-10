import { test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { captureValidationState, readValidationArtifact, readValidationSource, validateStageResult } from './acceptance-hardening-state';

test('validation source snapshot is reproducible and includes every ignored helper', async () => {
  const root = resolve(import.meta.dir, '../..'), state = await captureValidationState(root);
  expect(await captureValidationState(root)).toEqual(state);
  expect(state.sources.filter(s => s.file.startsWith('data/'))).toHaveLength(4);
  expect(state.sources.some(s => s.file === 'bun.lock')).toBe(true);
  expect(state.sources.some(s => s.file === 'scripts/inspect-lighter-acceptance.ts')).toBe(true);
});

test('validation source readers refuse private, operational, linked and out-of-root files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-validation-source-'));
  try {
    await Bun.write(join(dir, 'README.md'), '# Fixture\n');
    expect(new TextDecoder().decode(await readValidationSource(dir, 'README.md'))).toBe('# Fixture\n');
    for (const file of ['.env', '.env.local', 'data/terminal.sqlite', 'node_modules/package.json', '../README.md',
      'src/../../README.md', 'src//index.ts', 'src/secret.json', 'C:/private.md', 'src\\index.ts'])
      await expect(readValidationSource(dir, file)).rejects.toThrow();
    mkdirSync(join(dir, 'ordinary'));
    await Bun.write(join(dir, 'ordinary/index.ts'), 'export {};\n');
    symlinkSync(join(dir, 'ordinary'), join(dir, 'src'), 'junction');
    await expect(readValidationSource(dir, 'src/index.ts')).rejects.toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stage result gates reject incomplete, drifted, malformed and unexpected exit evidence', () => {
  const state = { gitHead: 'fixture', fingerprint: 'f'.repeat(64), sources: [] };
  const valid = { complete: true, sourcesStable: true, exitCode: 0, childExitCode: 0,
    startedAt: '2026-10-13T00:00:00Z', endedAt: '2026-10-13T00:01:00Z', sourceState: state, finalSourceFingerprint: state.fingerprint };
  expect(() => validateStageResult('unit', valid, state)).not.toThrow();
  for (const change of [{ complete: false }, { sourcesStable: false }, { exitCode: 1 }, { childExitCode: 1 },
    { startedAt: 'invalid' }, { endedAt: '2026-10-12T00:00:00Z' }, { finalSourceFingerprint: 'other' },
    { sourceState: { ...state, sources: [{ file: 'substituted' }] } }])
    expect(() => validateStageResult('unit', { ...valid, ...change }, state)).toThrow();
  const failed = { ...valid, exitCode: 1, childExitCode: 1 };
  for (const stage of ['legacy', 'failedShort']) {
    expect(() => validateStageResult(stage, failed, state)).not.toThrow();
    expect(() => validateStageResult(stage, valid, state)).toThrow();
  }
  for (const result of [valid, failed]) expect(() => validateStageResult('preflight', result, state)).not.toThrow();
  expect(() => validateStageResult('preflight', { ...valid, exitCode: 38, childExitCode: 38 }, state)).toThrow();
});

test('nested drill artifacts are readable but traversal and linked directories remain refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-validation-artifact-'));
  try {
    mkdirSync(join(dir, 'slow-heartbeat'));
    await Bun.write(join(dir, 'slow-heartbeat/report.json'), '{}');
    expect(new TextDecoder().decode(await readValidationArtifact(dir, 'slow-heartbeat/report.json'))).toBe('{}');
    for (const file of ['../report.json', '/report.json', 'slow-heartbeat/../report.json', 'slow-heartbeat\\report.json',
      '.env', 'slow-heartbeat/report.ts', 'slow-heartbeat//report.json'])
      await expect(readValidationArtifact(dir, file)).rejects.toThrow();
    symlinkSync(join(dir, 'slow-heartbeat'), join(dir, 'linked'), 'junction');
    await expect(readValidationArtifact(dir, 'linked/report.json')).rejects.toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});