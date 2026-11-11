import { existsSync, readFileSync } from 'node:fs';
import type { Strategy } from './strategies/types';
import { artifactHash } from './strategies/registry';
import { REPLAY_SIMULATOR_VERSION } from './backtest-replay';

/** PAPER configuration allowlist, not production research authorization.
 *  A single-capture SPA/StepM screen is NOT independent holdout evidence. Existing
 *  v2 manifests can restrict PAPER experimentation to exact configurations, but
 *  neither their hashes nor user-supplied evidence claims prove research approval.
 *  scripts/research-promote.ts archives screens and cannot install approval.
 *
 *  Ratchet semantics (fail-closed once research exists):
 *  - unverified: no manifest installed. Bots run as before; /api/fleet labels the mode.
 *  - strict: a valid manifest is installed. Only its exact (strategy id, resolved
 *    params, artifact hash) entries are allowed; a strategy whose code changed
 *    invalidates its entry.
 *  - refusing: a manifest exists but is malformed, or was produced by a different
 *    verifier version. Every config is refused until research re-runs. */

export type PromotionMode = 'unverified' | 'strict' | 'refusing';

export type PromotedEntry = {
  strategyId: string;
  params: Record<string, number>;
  artifactHash: string;
  spaPvalue: number;
};

export type PromotionManifest = {
  version: 2;
  generatedAt: string;
  capture: { sha256: string; market: string; frames: number };
  alpha: number;
  reps: number;
  samples: number;
  /** The replay simulator version that produced the evidence (review P0-10). */
  simulatorVersion: string;
  /** The authorization EXPIRES: a promotion is a review window, not a permanent right. */
  expiresAt: string;
  /** Maximum approved per-order notional for promoted bots (capital envelope). */
  maxNotionalPerOrderUsd: number;
  verifierSha256: string;
  verdictSha256: string;
  entries: PromotedEntry[];
};

const HEX64 = /^[a-f0-9]{64}$/;
const ID = /^[a-z0-9-]{2,60}$/;

/** Canonical parameter form: sorted keys, finite numbers only. The gate compares bots
 *  against manifest entries in this form, so key order can never smuggle a config past
 *  a verdict. */
export function canonicalParams(params: unknown): string {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('params must be an object');
  const keys = Object.keys(params as Record<string, unknown>).sort();
  const clean: Record<string, number> = Object.create(null);
  for (const key of keys) {
    const value = (params as Record<string, unknown>)[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Non-finite parameter: ${key}`);
    clean[key] = value;
  }
  return JSON.stringify(clean);
}

/** Stable research config id: strategy id plus a short hash of its canonical params. */
export function configId(strategyId: string, params: Record<string, number>): string {
  if (!ID.test(strategyId)) throw new Error(`Invalid strategy id: ${strategyId}`);
  const suffix = new Bun.CryptoHasher('sha256').update(canonicalParams(params)).digest('hex').slice(0, 8);
  return `${strategyId}:${suffix}`;
}

/** Structural validation. Returns every problem found; an empty list means usable. */
export function manifestErrors(raw: unknown): string[] {
  const errors: string[] = [];
  const m = raw as Partial<PromotionManifest> | null;
  if (!m || typeof m !== 'object' || Array.isArray(m)) return ['manifest is not an object'];
  if (m.version !== 2) errors.push('unsupported manifest version');
  if (typeof m.generatedAt !== 'string' || Number.isNaN(Date.parse(m.generatedAt))) errors.push('invalid generatedAt');
  const capture = m.capture as PromotionManifest['capture'] | undefined;
  if (!capture || typeof capture !== 'object' || (typeof capture.sha256 !== 'string' || !HEX64.test(capture.sha256)) ||
      typeof capture.market !== 'string' || !capture.market ||
      !Number.isSafeInteger(capture.frames) || capture.frames < 1) errors.push('invalid capture block');
  if (typeof m.alpha !== 'number' || !(m.alpha > 0 && m.alpha < 1)) errors.push('invalid alpha');
  if (typeof m.reps !== 'number' || !Number.isSafeInteger(m.reps) || m.reps < 100) errors.push('invalid reps');
  if (typeof m.samples !== 'number' || !Number.isSafeInteger(m.samples) || m.samples < 101) errors.push('insufficient samples');
  if (typeof m.verifierSha256 !== 'string' || !HEX64.test(m.verifierSha256)) errors.push('invalid verifierSha256');
  if (typeof m.verdictSha256 !== 'string' || !HEX64.test(m.verdictSha256)) errors.push('invalid verdictSha256');
  if (m.simulatorVersion !== REPLAY_SIMULATOR_VERSION) errors.push('unsupported simulatorVersion');
  if (typeof m.expiresAt !== 'string' || Number.isNaN(Date.parse(m.expiresAt))) errors.push('invalid expiresAt');
  if (typeof m.generatedAt === 'string' && typeof m.expiresAt === 'string' &&
      Date.parse(m.expiresAt) <= Date.parse(m.generatedAt)) errors.push('expiresAt must follow generatedAt');
  if (typeof m.maxNotionalPerOrderUsd !== 'number' || !Number.isFinite(m.maxNotionalPerOrderUsd) || m.maxNotionalPerOrderUsd < 10) errors.push('invalid maxNotionalPerOrderUsd');
  if (!Array.isArray(m.entries) || !m.entries.length) { errors.push('entries must be a non-empty array'); return errors; }
  const seen = new Set<string>();
  m.entries.forEach((entry, index) => {
    const at = `entries[${index}]`;
    if (!entry || typeof entry !== 'object') { errors.push(`${at} is not an object`); return; }
    if (typeof entry.strategyId !== 'string' || !ID.test(entry.strategyId)) errors.push(`${at} has an invalid strategyId`);
    let canonical: string;
    try { canonical = canonicalParams(entry.params); } catch { errors.push(`${at} has invalid params`); return; }
    if (typeof entry.artifactHash !== 'string' || !HEX64.test(entry.artifactHash)) errors.push(`${at} has an invalid artifactHash`);
    if (typeof entry.spaPvalue !== 'number' || !Number.isFinite(entry.spaPvalue) || entry.spaPvalue < 0 ||
        (typeof m.alpha === 'number' && m.alpha > 0 && m.alpha < 1 && entry.spaPvalue > m.alpha)) errors.push(`${at} spaPvalue invalid or above alpha`);
    const key = `${entry.strategyId}:${canonical}`;
    if (seen.has(key)) errors.push(`${at} duplicates an earlier config`);
    seen.add(key);
  });
  return errors;
}

export class PromotionGate {
  private hashes = new WeakMap<Strategy, string>();

  private constructor(readonly mode: PromotionMode, private manifest: PromotionManifest | null, readonly reasons: string[] = []) {}

  static unverified(reasons: string[] = []): PromotionGate { return new PromotionGate('unverified', null, reasons); }

  static refusing(reasons: string[]): PromotionGate { return new PromotionGate('refusing', null, reasons); }

  /** Install a manifest: strict only when structurally valid and produced by the
   *  verifier version currently on disk. */
  static install(raw: unknown, currentVerifierSha256: string): PromotionGate {
    const errors = manifestErrors(raw);
    if (errors.length) return PromotionGate.refusing(errors);
    const manifest = raw as PromotionManifest;
    if (manifest.verifierSha256 !== currentVerifierSha256) {
      return PromotionGate.refusing([`verifier changed since promotion (manifest ${manifest.verifierSha256.slice(0, 12)}, current ${currentVerifierSha256.slice(0, 12)}); re-run scripts/research-promote.ts`]);
    }
    // A promotion is a review window, not a permanent right (review P0-01): expired
    // authorization must never admit new exposure. Protective reductions are unaffected —
    // close proposals never required alpha authorization in the first place.
    if (Date.parse(manifest.generatedAt) > Date.now()) return PromotionGate.refusing(['promotion generatedAt is in the future']);
    if (Date.parse(manifest.expiresAt) <= Date.now()) {
      return PromotionGate.refusing([`promotion expired at ${manifest.expiresAt}; re-run scripts/research-promote.ts (protective reductions remain allowed — closes never needed alpha authorization)`]);
    }
    // Own the validated snapshot: later caller mutations cannot change authorization.
    return new PromotionGate('strict', JSON.parse(JSON.stringify(manifest)) as PromotionManifest);
  }

  private hash(strategy: Strategy): string {
    let hash = this.hashes.get(strategy);
    if (!hash) { hash = artifactHash(strategy); this.hashes.set(strategy, hash); }
    return hash;
  }

  allows(strategy: Strategy, params: Record<string, number>): boolean {
    if (this.mode === 'unverified') return true;
    if (this.mode !== 'strict' || !this.manifest || Date.parse(this.manifest.expiresAt) <= Date.now()) return false;
    let canonical: string;
    try { canonical = canonicalParams(params); } catch { return false; }
    const artifact = this.hash(strategy);
    return this.manifest.entries.some(entry =>
      entry.strategyId === strategy.id && entry.artifactHash === artifact && canonicalParams(entry.params) === canonical);
  }

  describe(): { mode: PromotionMode; paperOnly: true; researchApproved: false; independentHoldout: false; reasons?: string[]; generatedAt?: string; capture?: PromotionManifest['capture']; alpha?: number; reps?: number; samples?: number; simulatorVersion?: string; expiresAt?: string; expired?: boolean; maxNotionalPerOrderUsd?: number; promoted?: { strategyId: string; spaPvalue: number }[] } {
    if (this.mode === 'strict' && this.manifest) {
      return {
        mode: this.mode,
        paperOnly: true,
        researchApproved: false,
        independentHoldout: false,
        generatedAt: this.manifest.generatedAt,
        capture: { ...this.manifest.capture },
        alpha: this.manifest.alpha,
        reps: this.manifest.reps,
        samples: this.manifest.samples,
        simulatorVersion: this.manifest.simulatorVersion,
        expiresAt: this.manifest.expiresAt,
        expired: Date.parse(this.manifest.expiresAt) <= Date.now(),
        maxNotionalPerOrderUsd: this.manifest.maxNotionalPerOrderUsd,
        promoted: this.manifest.entries.map(entry => ({ strategyId: entry.strategyId, spaPvalue: entry.spaPvalue })),
      };
    }
    return { mode: this.mode, paperOnly: true, researchApproved: false, independentHoldout: false, reasons: [...this.reasons] };
  }
}

export function sha256File(path: string): string {
  return new Bun.CryptoHasher('sha256').update(readFileSync(path)).digest('hex');
}

/** Startup loader for src/server.ts: an absent manifest means unverified; anything
 *  else that is not a valid current-verifier manifest means refusing. */
export function loadPromotionGate(manifestPath: string, verifierPath: string): PromotionGate {
  if (!existsSync(manifestPath)) {
    return PromotionGate.unverified(['No research/promotions.json installed yet; strategy configs are not SPA-verified.']);
  }
  let verifierSha: string;
  try { verifierSha = sha256File(verifierPath); } catch {
    return PromotionGate.refusing(['research/spa_verify.py is missing or unreadable; cannot validate the promotion manifest']);
  }
  try {
    return PromotionGate.install(JSON.parse(readFileSync(manifestPath, 'utf8')), verifierSha);
  } catch (error) {
    return PromotionGate.refusing([`manifest unreadable: ${(error as Error).message}`]);
  }
}
