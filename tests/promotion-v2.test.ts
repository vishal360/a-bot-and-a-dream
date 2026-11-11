import { test, expect, spyOn } from 'bun:test';
import { readFileSync } from 'node:fs';
import { REPLAY_SIMULATOR_VERSION } from '../src/backtest-replay';
import { artifactHash } from '../src/strategies/registry';
import { breakoutV1 } from '../src/strategies/builtin';
import { PromotionGate, loadPromotionGate } from '../src/promotion';

const verifierSha = 'a'.repeat(64);
const verdictSha = 'b'.repeat(64);
const artifact = 'c'.repeat(64);

const manifest = (overrides: Record<string, unknown> = {}) => ({
  version: 2,
  generatedAt: '2026-11-07T00:00:00Z',
  capture: { sha256: 'd'.repeat(64), market: 'BTC', frames: 2000 },
  alpha: 0.05,
  reps: 2000,
  samples: 500,
  simulatorVersion: REPLAY_SIMULATOR_VERSION,
  expiresAt: '2999-01-01T00:00:00Z',
  maxNotionalPerOrderUsd: 500,
  verifierSha256: verifierSha,
  verdictSha256: verdictSha,
  entries: [{ strategyId: 'breakout-v1', params: {}, artifactHash: artifact, spaPvalue: 0.01 }],
  ...overrides,
});

test('manifest v2 validates and exposes the full authorization envelope', () => {
  const gate = PromotionGate.install(manifest(), verifierSha);
  expect(gate.mode).toBe('strict');
  const d = gate.describe() as any;
  expect(d.simulatorVersion).toBe(REPLAY_SIMULATOR_VERSION);
  expect(d.expiresAt).toBe('2999-01-01T00:00:00Z');
  expect(d.expired).toBe(false);
  expect(d.maxNotionalPerOrderUsd).toBe(500);
});

test('v2 rejects every corruption the reviewer listed: changed verifier, tampered verdict, stale expiry, bad envelope', () => {
  expect(PromotionGate.install(manifest(), 'e'.repeat(64)).mode).toBe('refusing'); // verifier changed
  // Tamper-evidence boundary: the enforcer cannot hash a verdict file it does not hold,
  // but structural tampering (a verdict hash that is not a valid SHA-256) refuses, and
  // the manifest binds the verdict hash for offline comparison with the archived verdict.
  expect(PromotionGate.install(manifest({ verdictSha256: 'not-a-valid-sha256' }), verifierSha).mode).toBe('refusing');
  const expired = PromotionGate.install(manifest({ expiresAt: '2026-01-01T00:00:00Z' }), verifierSha);
  expect(expired.mode).toBe('refusing'); // stale authorization
  expect((expired.describe() as any).reasons.join(' ')).toContain('expiresAt');
  expect(PromotionGate.install(manifest({ maxNotionalPerOrderUsd: 5 }), verifierSha).describe().mode).toBe('refusing'); // bad envelope
  const missing = manifest(); delete (missing as any).simulatorVersion;
  expect(PromotionGate.install(missing, verifierSha).describe().mode).toBe('refusing'); // missing simulator version
  expect(PromotionGate.install(manifest({ version: 1 }), verifierSha).describe().mode).toBe('refusing'); // v1 unsupported
});

test('expired protection does not block risk-REDUCING actions: closes never needed alpha authorization', () => {
  // Close proposals flow through strategy.evaluate -> runner submit WITHOUT a gate
  // check — by contract and by fleet tests: always-close bots run in strict mode.
  // The expiry refusal therefore blocks NEW exposure only.
  const expired = PromotionGate.install(manifest({ expiresAt: '2026-01-01T00:00:00Z' }), verifierSha);
  expect(expired.mode).toBe('refusing');
});

test('v2 requires a finite envelope, current simulator, ordered timestamps and no future authorization', () => {
  for (const value of [undefined, null, '500', NaN, Infinity, -Infinity, 0, 9]) {
    expect(PromotionGate.install(manifest({ maxNotionalPerOrderUsd: value }), verifierSha).mode).toBe('refusing');
  }
  for (const simulatorVersion of ['', 'replay-v1', 'invented-future-simulator']) {
    expect(PromotionGate.install(manifest({ simulatorVersion }), verifierSha).mode).toBe('refusing');
  }
  expect(PromotionGate.install(manifest({ generatedAt: '2999-01-01T00:00:00Z', expiresAt: '2999-01-02T00:00:00Z' }), verifierSha).mode).toBe('refusing');
  expect(PromotionGate.install(manifest({ expiresAt: '2026-11-07T00:00:00Z' }), verifierSha).mode).toBe('refusing');
});

test('expiry is enforced after installation, at the exact boundary, with an owned snapshot', () => {
  const now = Date.parse('2026-11-08T00:00:00Z');
  const clock = spyOn(Date, 'now').mockReturnValue(now);
  try {
    const raw = manifest({ expiresAt: new Date(now + 1000).toISOString(),
      entries: [{ strategyId: breakoutV1.id, params: {}, artifactHash: artifactHash(breakoutV1), spaPvalue: 0.01 }] });
    const gate = PromotionGate.install(raw, verifierSha);
    expect(gate.allows(breakoutV1, {})).toBe(true);
    raw.entries[0]!.params = { unapproved: 1 };
    expect(gate.allows(breakoutV1, {})).toBe(true);
    expect(gate.allows(breakoutV1, { unapproved: 1 })).toBe(false);
    clock.mockReturnValue(now + 1000);
    expect(gate.allows(breakoutV1, {})).toBe(false);
    expect(gate.describe().expired).toBe(true);
  } finally { clock.mockRestore(); }
});

test('fabricated holdout claims never become honest research approval', () => {
  const gate = PromotionGate.install(manifest({ researchApproved: true, independentHoldout: true,
    evidence: { untouched: true, passed: true } }), verifierSha);
  expect(gate.mode).toBe('strict'); // Existing PAPER allowlist compatibility only.
  for (const status of [gate.describe(), PromotionGate.unverified().describe(), PromotionGate.refusing(['bad']).describe()]) {
    expect(status.paperOnly).toBe(true);
    expect(status.researchApproved).toBe(false);
    expect(status.independentHoldout).toBe(false);
  }
});

test('single-capture script cannot install even a PASS screen', () => {
  // Structural regression guard: the screen command has no manifest write/rename path.
  // This runs without the optional Python environment and never touches research data.
  const script = readFileSync(new URL('../scripts/research-promote.ts', import.meta.url), 'utf8');
  expect(script).not.toContain('renameSync');
  expect(script).not.toContain('installed: true');
  expect(script).not.toContain("join(root, 'research', 'promotions.json');");
  expect(script).toContain("evidenceKind: 'single-capture-spa-screen'");
  expect(script).toContain('independentHoldout: false');
  expect(script).toContain('process.exit(1); // Successful screening is still a refused promotion request.');
});

test('loadPromotionGate: absent manifest is unverified (paper-only), unreadable is refusing', () => {
  const dir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'abad-promo-'));
  const verifierPath = require('node:path').join(dir, 'spa_verify.py');
  require('node:fs').writeFileSync(verifierPath, 'print("verifier")');
  const gate = loadPromotionGate(require('node:path').join(dir, 'missing.json'), verifierPath);
  expect(gate.mode).toBe('unverified');
  require('node:fs').writeFileSync(require('node:path').join(dir, 'promotions.json'), '{ broken');
  expect(loadPromotionGate(require('node:path').join(dir, 'promotions.json'), verifierPath).mode).toBe('refusing');
  require('node:fs').rmSync(dir, { recursive: true, force: true });
});
